import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';

type AnyRecord = Record<string, any>;

const heldLocks = new Map();

export function openTaskLifecycleStoreWithDiscipline(cwd, options: AnyRecord = {}) {
  const siteRoot = resolve(cwd);
  const write = options.write !== false;
  const lock = write ? acquireWriteLock(siteRoot, options) : null;
  let store = null;
  try {
    store = openTaskLifecycleStore(siteRoot);
    applyDbPragmas(store.db, options);
    if (lock && !lock.reentrant) refreshWriteLock(lock);
    const originalClose = store.db.close.bind(store.db);
    store.db.close = () => {
      let finalizeError = null;
      let closeError = null;
      let closeResult;
      try {
        if (lock && !lock.reentrant) {
          try {
            finalizeWriteConnection(store.db);
          } catch (error) {
            finalizeError = error;
          }
        }
        try {
          closeResult = originalClose();
        } catch (error) {
          closeError = error;
        }
      } finally {
        if (lock) releaseWriteLock(lock);
      }
      if (closeError) throw closeError;
      if (finalizeError && process.env.NARADA_TASK_LIFECYCLE_STRICT_FINALIZE === '1') throw finalizeError;
      return closeResult;
    };
    return store;
  } catch (error) {
    if (lock) releaseWriteLock(lock);
    throw error;
  }
}

export function taskLifecycleDbHealth(cwd) {
  let store = null;
  try {
    store = openTaskLifecycleStoreWithDiscipline(cwd, { write: false });
    const integrity = store.db.prepare('PRAGMA integrity_check').get();
    const wal = store.db.prepare('PRAGMA journal_mode').get();
    const busyTimeout = store.db.prepare('PRAGMA busy_timeout').get();
    return {
      schema: 'narada.sonar.task_lifecycle_db_health.v1',
      status: String(Object.values(integrity ?? {})[0] ?? '') === 'ok' ? 'ok' : 'attention_needed',
      integrity_check: Object.values(integrity ?? {})[0] ?? null,
      journal_mode: Object.values(wal ?? {})[0] ?? null,
      busy_timeout_ms: Number(Object.values(busyTimeout ?? {})[0] ?? 0),
      repair_command: String(Object.values(integrity ?? {})[0] ?? '') === 'ok'
        ? null
        : 'pnpm cli -- task db repair-indexes --ack-repair',
    };
  } catch (error) {
    return {
      schema: 'narada.sonar.task_lifecycle_db_health.v1',
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    store?.db?.close();
  }
}

export function repairTaskLifecycleDbIndexes(cwd, options: AnyRecord = {}) {
  const siteRoot = resolve(cwd);
  if (options.ackRepair !== true) {
    return {
      schema: 'narada.sonar.task_lifecycle_db_repair.v1',
      status: 'refused',
      reason: 'ack_repair_required',
      required_flag: '--ack-repair',
      db_path: join(siteRoot, '.ai', 'task-lifecycle.db'),
    };
  }
  const dbPath = join(siteRoot, '.ai', 'task-lifecycle.db');
  const backupDir = join(siteRoot, '.ai', `db-repair-${timestampForPath(new Date())}`);
  const lock = acquireWriteLock(siteRoot, options);
  let store = null;
  try {
    mkdirSync(backupDir, { recursive: true });
    store = openTaskLifecycleStore(siteRoot);
    applyDbPragmas(store.db, options);
    try {
      store.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // A repair backup must continue even if SQLite cannot checkpoint.
    }
    copyTaskLifecycleDbFiles(siteRoot, backupDir);
    const before = String(Object.values(store.db.prepare('PRAGMA integrity_check').get() ?? {})[0] ?? '');
    store.db.exec('REINDEX');
    store.db.exec('ANALYZE');
    let after = String(Object.values(store.db.prepare('PRAGMA integrity_check').get() ?? {})[0] ?? '');
    let vacuumPerformed = false;
    if (after !== 'ok') {
      store.db.exec('VACUUM');
      store.db.exec('ANALYZE');
      vacuumPerformed = true;
      after = String(Object.values(store.db.prepare('PRAGMA integrity_check').get() ?? {})[0] ?? '');
    }
    return {
      schema: 'narada.sonar.task_lifecycle_db_repair.v1',
      status: after === 'ok' ? 'repaired' : 'attention_needed',
      db_path: dbPath,
      backup_dir: backupDir,
      before_integrity_check: before,
      after_integrity_check: after,
      vacuum_performed: vacuumPerformed,
      mutation_performed: true,
    };
  } finally {
    try {
      store?.db?.close();
    } finally {
      releaseWriteLock(lock);
    }
  }
}

function applyDbPragmas(db, options: AnyRecord = {}) {
  db.pragma(`busy_timeout = ${Number(options.busyTimeoutMs ?? 10_000)}`);
  if (process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE !== '1') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
}

function finalizeWriteConnection(db) {
  if (process.env.NARADA_TASK_LIFECYCLE_AUTO_REPAIR_INDEXES !== '0') {
    const quick = String(Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0] ?? '');
    if (quick !== 'ok') {
      db.exec('REINDEX');
      const after = String(Object.values(db.prepare('PRAGMA integrity_check').get() ?? {})[0] ?? '');
      if (after !== 'ok') {
        throw new Error(`task_lifecycle_integrity_after_reindex:${after}`);
      }
    }
  }
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Checkpoint is best effort; close must still release the Site write lock.
  }
}

function copyTaskLifecycleDbFiles(siteRoot, backupDir) {
  const dbPath = join(siteRoot, '.ai', 'task-lifecycle.db');
  for (const [source, target] of [
    [dbPath, 'task-lifecycle.db.before-reindex'],
    [`${dbPath}-wal`, 'task-lifecycle.db-wal.before-reindex'],
    [`${dbPath}-shm`, 'task-lifecycle.db-shm.before-reindex'],
  ]) {
    if (existsSync(source)) copyFileSync(source, join(backupDir, target));
  }
}


function acquireWriteLock(siteRoot, options: AnyRecord = {}) {
  const lockDir = join(siteRoot, '.ai', 'task-lifecycle.write.lock');
  const staleMs = Number(options.staleMs ?? 10 * 60_000);
  const timeoutMs = Number(options.timeoutMs ?? 30_000);
  const pollMs = Number(options.pollMs ?? 50);
  const existing = heldLocks.get(lockDir);
  if (existing) {
    existing.depth += 1;
    return { lockDir, reentrant: true };
  }
  const deadline = Date.now() + timeoutMs;
  mkdirSync(join(siteRoot, '.ai'), { recursive: true });
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        schema: 'narada.sonar.task_lifecycle_write_lock.v1',
        pid: process.pid,
        acquired_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      }, null, 2), 'utf8');
      heldLocks.set(lockDir, { depth: 1 });
      return { lockDir, reentrant: false };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (lockIsStale(lockDir, staleMs)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`task_lifecycle_write_lock_timeout:${lockDir}`);
      }
      sleepProcess(pollMs);
    }
  }
}

function releaseWriteLock(lock) {
  const state = heldLocks.get(lock.lockDir);
  if (!state) return;
  state.depth -= 1;
  if (state.depth > 0) return;
  heldLocks.delete(lock.lockDir);
  rmSync(lock.lockDir, { recursive: true, force: true });
}

function lockIsStale(lockDir, staleMs) {
  try {
    const owner = readLockOwner(lockDir);
    const heartbeatMs = Date.parse(owner?.heartbeat_at ?? owner?.acquired_at ?? '');
    const ageMs = Date.now() - (Number.isFinite(heartbeatMs) ? heartbeatMs : statSync(lockDir).mtimeMs);
    if (ageMs <= staleMs) return false;
    if (owner?.pid && processIsLive(Number(owner.pid))) return false;
    return true;
  } catch {
    return true;
  }
}

function refreshWriteLock(lock) {
  const ownerPath = join(lock.lockDir, 'owner.json');
  const owner = readLockOwner(lock.lockDir) ?? {};
  writeFileSync(ownerPath, JSON.stringify({
    ...owner,
    schema: 'narada.sonar.task_lifecycle_write_lock.v1',
    pid: process.pid,
    heartbeat_at: new Date().toISOString(),
  }, null, 2), 'utf8');
}

function readLockOwner(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function processIsLive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { 'live' }`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 2000 });
    return String(result.stdout ?? '').trim() === 'live';
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepProcess(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (process.platform === 'win32') {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${Math.max(1, Math.floor(ms))}`], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: Math.max(1000, Math.floor(ms) + 1000),
    });
    return;
  }
  spawnSync('sleep', [String(seconds)], { stdio: 'ignore', timeout: (seconds + 1) * 1000 });
}

function timestampForPath(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
