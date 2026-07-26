import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import { requireSiteLoopConfig, schemaName } from '../site-loop/site-loop-config.js';

interface TaskLifecycleSqliteOptions {
  write?: boolean;
  ackRepair?: boolean;
  busyTimeoutMs?: number;
  staleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  mode?: 'fast' | 'deep';
  integrityCheck?: boolean;
}

const heldLocks: any = new Map();

export function openTaskLifecycleStoreWithDiscipline(cwd: any, options: TaskLifecycleSqliteOptions = {}) {
  const siteRoot: any = resolve(cwd);
  const write: any = options.write !== false;
  const lock: any = write ? acquireWriteLock(siteRoot, options) : null;
  let store: any = null;
  try {
    store = openTaskLifecycleStore(siteRoot);
    instrumentTransactionState(store.db);
    applyDbPragmas(store.db, options);
    if (lock && !lock.reentrant) refreshWriteLock(lock);
    const originalClose: any = store.db.close.bind(store.db);
    store.db.close = () => {
      let finalizeError: any = null;
      let closeError: any = null;
      let closeResult: any;
      try {
        if (lock && !lock.reentrant) {
          try {
            finalizeWriteConnection(store.db);
          } catch (error: any) {
            finalizeError = error;
          }
        }
        try {
          closeResult = originalClose();
        } catch (error: any) {
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
  } catch (error: any) {
    if (lock) releaseWriteLock(lock);
    throw error;
  }
}

function instrumentTransactionState(db: any): void {
  let transactionDepth = db.isTransaction === true || db.inTransaction === true ? 1 : 0;
  const originalExec = db.exec.bind(db);
  db.exec = (sql: unknown) => {
    const result = originalExec(sql);
    for (const statement of String(sql).split(';').map((part) => part.trim()).filter(Boolean)) {
      if (/^ROLLBACK\s+TO\b/i.test(statement)) continue;
      if (/^BEGIN\b/i.test(statement)) {
        transactionDepth = Math.max(1, transactionDepth);
      } else if (/^SAVEPOINT\b/i.test(statement)) {
        transactionDepth += 1;
      } else if (/^RELEASE\b/i.test(statement)) {
        transactionDepth = Math.max(0, transactionDepth - 1);
      } else if (/^(COMMIT|END|ROLLBACK)\b/i.test(statement)) {
        transactionDepth = 0;
      }
    }
    return result;
  };
  try {
    Object.defineProperty(db, 'inTransaction', {
      configurable: true,
      enumerable: false,
      get: () => transactionDepth > 0,
    });
  } catch {
    // The underlying adapter may expose a non-configurable transaction flag.
  }
}

function pragmaValue(row: any) {
  return Object.values(row ?? {})[0] ?? null;
}

export function taskLifecycleDbHealth(cwd: any, options: TaskLifecycleSqliteOptions = {}) {
  const siteLoopConfig: any = requireSiteLoopConfig(resolve(cwd));
  const deep: any = options.mode === 'deep' || options.integrityCheck === true;
  let store: any = null;
  try {
    store = openTaskLifecycleStoreWithDiscipline(cwd, { write: false });
    // The Site Loop calls this from its bounded hot path. A full integrity_check
    // scans the entire database and is intentionally opt-in for large task DBs.
    const schemaVersion: any = store.db.prepare('PRAGMA schema_version').get();
    const pageCount: any = store.db.prepare('PRAGMA page_count').get();
    const freelistCount: any = store.db.prepare('PRAGMA freelist_count').get();
    const wal: any = store.db.prepare('PRAGMA journal_mode').get();
    const busyTimeout: any = store.db.prepare('PRAGMA busy_timeout').get();
    const tableProbe: any = store.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'task_lifecycle'").get();
    const integrity: any = deep ? store.db.prepare('PRAGMA integrity_check').get() : null;
    const integrityValue: any = pragmaValue(integrity);
    const tablePresent: any = tableProbe?.present === 1;
    return {
      schema: schemaName(siteLoopConfig, 'task_lifecycle_db_health'),
      status: deep
        ? (String(integrityValue ?? '') === 'ok' ? 'ok' : 'attention_needed')
        : (tablePresent ? 'ok' : 'attention_needed'),
      health_mode: deep ? 'deep' : 'fast',
      integrity_check: deep ? integrityValue : null,
      integrity_check_status: deep ? (String(integrityValue ?? '') === 'ok' ? 'ok' : 'failed') : 'deferred',
      schema_version: Number(pragmaValue(schemaVersion) ?? 0),
      page_count: Number(pragmaValue(pageCount) ?? 0),
      freelist_count: Number(pragmaValue(freelistCount) ?? 0),
      task_lifecycle_table_present: tablePresent,
      journal_mode: pragmaValue(wal),
      busy_timeout_ms: Number(pragmaValue(busyTimeout) ?? 0),
      repair_command: deep && String(integrityValue ?? '') !== 'ok'
        ? 'pnpm cli -- task db repair-indexes --ack-repair'
        : null,
    };
  } catch (error: any) {
    return {
      schema: schemaName(siteLoopConfig, 'task_lifecycle_db_health'),
      status: 'error',
      health_mode: deep ? 'deep' : 'fast',
      integrity_check_status: deep ? 'failed' : 'not_available',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    store?.db?.close();
  }
}

export function repairTaskLifecycleDbIndexes(cwd: any, options: TaskLifecycleSqliteOptions = {}) {
  const siteRoot: any = resolve(cwd);
  const siteLoopConfig: any = requireSiteLoopConfig(siteRoot);
  if (options.ackRepair !== true) {
    return {
      schema: schemaName(siteLoopConfig, 'task_lifecycle_db_repair'),
      status: 'refused',
      reason: 'ack_repair_required',
      required_flag: '--ack-repair',
      db_path: join(siteRoot, '.ai', 'task-lifecycle.db'),
    };
  }
  const dbPath: any = join(siteRoot, '.ai', 'task-lifecycle.db');
  const backupDir: any = join(siteRoot, '.ai', `db-repair-${timestampForPath(new Date())}`);
  const lock: any = acquireWriteLock(siteRoot, options);
  let store: any = null;
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
    const before: any = String(Object.values(store.db.prepare('PRAGMA integrity_check').get() ?? {})[0] ?? '');
    store.db.exec('REINDEX');
    store.db.exec('ANALYZE');
    let after: any = String(Object.values(store.db.prepare('PRAGMA integrity_check').get() ?? {})[0] ?? '');
    let vacuumPerformed: any = false;
    if (after !== 'ok') {
      store.db.exec('VACUUM');
      store.db.exec('ANALYZE');
      vacuumPerformed = true;
      after = String(Object.values(store.db.prepare('PRAGMA integrity_check').get() ?? {})[0] ?? '');
    }
    return {
      schema: schemaName(siteLoopConfig, 'task_lifecycle_db_repair'),
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

function applyDbPragmas(db: any, options: TaskLifecycleSqliteOptions = {}) {
  db.pragma(`busy_timeout = ${Number(options.busyTimeoutMs ?? 10_000)}`);
  if (process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE !== '1') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
}

function finalizeWriteConnection(db: any) {
  // Full quick_check/integrity_check scans the entire task database. It is
  // reserved for explicit repair/diagnostic runs, never for the bounded Site
  // Loop write hot path or ordinary connection close.
  if (process.env.NARADA_TASK_LIFECYCLE_AUTO_REPAIR_INDEXES === '1') {
    const quick: any = String(Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0] ?? '');
    if (quick !== 'ok') {
      db.exec('REINDEX');
      const after: any = String(Object.values(db.prepare('PRAGMA integrity_check').get() ?? {})[0] ?? '');
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

function copyTaskLifecycleDbFiles(siteRoot: any, backupDir: any) {
  const dbPath: any = join(siteRoot, '.ai', 'task-lifecycle.db');
  for (const [source, target] of [
    [dbPath, 'task-lifecycle.db.before-reindex'],
    [`${dbPath}-wal`, 'task-lifecycle.db-wal.before-reindex'],
    [`${dbPath}-shm`, 'task-lifecycle.db-shm.before-reindex'],
  ]) {
    if (existsSync(source)) copyFileSync(source, join(backupDir, target));
  }
}


function acquireWriteLock(siteRoot: any, options: TaskLifecycleSqliteOptions = {}) {
  const siteLoopConfig: any = requireSiteLoopConfig(siteRoot);
  const lockDir: any = join(siteRoot, '.ai', 'task-lifecycle.write.lock');
  const staleMs: any = Number(options.staleMs ?? 10 * 60_000);
  const timeoutMs: any = Number(options.timeoutMs ?? 30_000);
  const pollMs: any = Number(options.pollMs ?? 50);
  const existing: any = heldLocks.get(lockDir);
  if (existing) {
    existing.depth += 1;
    return { lockDir, reentrant: true };
  }
  const deadline: any = Date.now() + timeoutMs;
  mkdirSync(join(siteRoot, '.ai'), { recursive: true });
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        schema: schemaName(siteLoopConfig, 'task_lifecycle_write_lock'),
        pid: process.pid,
        acquired_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      }, null, 2), 'utf8');
      heldLocks.set(lockDir, { depth: 1 });
      return { lockDir, reentrant: false };
    } catch (error: any) {
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

function releaseWriteLock(lock: any) {
  const state: any = heldLocks.get(lock.lockDir);
  if (!state) return;
  state.depth -= 1;
  if (state.depth > 0) return;
  heldLocks.delete(lock.lockDir);
  rmSync(lock.lockDir, { recursive: true, force: true });
}

function lockIsStale(lockDir: any, staleMs: any) {
  try {
    const owner: any = readLockOwner(lockDir);
    const ownerPid: any = Number(owner?.pid);
    // A dead owner is definitive evidence of a stale lock. Do not make every
    // restart wait for the conservative heartbeat TTL before recovering it.
    if (Number.isFinite(ownerPid) && ownerPid > 0
      && (ownerPid === process.pid || !processIsLive(ownerPid))) return true;
    const heartbeatMs: any = Date.parse(owner?.heartbeat_at ?? owner?.acquired_at ?? '');
    const ageMs: any = Date.now() - (Number.isFinite(heartbeatMs) ? heartbeatMs : statSync(lockDir).mtimeMs);
    if (ageMs <= staleMs) return false;
    if (ownerPid > 0 && ownerPid !== process.pid && processIsLive(ownerPid)) return false;
    return true;
  } catch {
    return true;
  }
}

function refreshWriteLock(lock: any) {
  const siteRoot: any = resolve(lock.lockDir, '..', '..');
  const siteLoopConfig: any = requireSiteLoopConfig(siteRoot);
  const ownerPath: any = join(lock.lockDir, 'owner.json');
  const owner: any = readLockOwner(lock.lockDir) ?? {};
  writeFileSync(ownerPath, JSON.stringify({
    ...owner,
    schema: schemaName(siteLoopConfig, 'task_lifecycle_write_lock'),
    pid: process.pid,
    heartbeat_at: new Date().toISOString(),
  }, null, 2), 'utf8');
}

function readLockOwner(lockDir: any) {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function processIsLive(pid: any) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  if (process.platform === 'win32') {
    const result: any = spawnSync('powershell.exe', [
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

function sleepProcess(ms: any) {
  const seconds: any = Math.max(1, Math.ceil(ms / 1000));
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

function timestampForPath(date: any) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}