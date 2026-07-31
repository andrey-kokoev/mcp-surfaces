import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { openTaskLifecycleStore, prepareTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import type { SqliteTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
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
  /** Runtime callers must observe a prepared store; tests/maintenance may opt into preparation. */
  storeMode?: 'prepare' | 'runtime';
  /** Callers with a stronger domain lock may bypass the coarse process lock. */
  acquireWriteLock?: boolean;
}

type TaskLifecycleDatabase = SqliteTaskLifecycleStore['db'];
type MutableTaskLifecycleDatabase = TaskLifecycleDatabase & {
  isTransaction?: boolean;
  inTransaction?: boolean;
};
type LockState = { depth: number };
type WriteLock = { lockDir: string; reentrant: boolean };
type LockOwner = {
  schema?: string;
  pid?: number;
  acquired_at?: string;
  heartbeat_at?: string;
};

const heldLocks: Map<string, LockState> = new Map();

export function openTaskLifecycleStoreWithDiscipline(cwd: string, options: TaskLifecycleSqliteOptions = {}): SqliteTaskLifecycleStore {
  const siteRoot: string = resolve(cwd);
  const write: boolean = options.write !== false;
  const lock: WriteLock | null = write && options.acquireWriteLock !== false ? acquireWriteLock(siteRoot, options) : null;
  let store: SqliteTaskLifecycleStore | null = null;
  try {
    store = options.storeMode === 'prepare'
      ? prepareTaskLifecycleStore(siteRoot)
      : openTaskLifecycleStore(siteRoot, { mode: 'runtime' });
    const activeStore: SqliteTaskLifecycleStore = store;
    instrumentTransactionState(activeStore.db);
    applyDbPragmas(activeStore.db, options);
    if (lock && !lock.reentrant) refreshWriteLock(lock);
    const originalClose: () => void = activeStore.db.close.bind(activeStore.db);
    activeStore.db.close = () => {
      let finalizeError: unknown = null;
      let closeError: unknown = null;
      try {
        if (lock && !lock.reentrant) {
          try {
            finalizeWriteConnection(activeStore.db);
          } catch (error: unknown) {
            finalizeError = error;
          }
        }
        try {
          originalClose();
        } catch (error: unknown) {
          closeError = error;
        }
      } finally {
        if (lock) releaseWriteLock(lock);
      }
      if (closeError) throw closeError;
      if (finalizeError && process.env.NARADA_TASK_LIFECYCLE_STRICT_FINALIZE === '1') throw finalizeError;
      return undefined;
    };
    return store;
  } catch (error: unknown) {
    if (lock) releaseWriteLock(lock);
    throw error;
  }
}

function instrumentTransactionState(db: MutableTaskLifecycleDatabase): void {
  let transactionDepth = db.isTransaction === true || db.inTransaction === true ? 1 : 0;
  const originalExec = db.exec.bind(db);
  db.exec = (sql: string) => {
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

function pragmaValue(row: unknown): unknown {
  if (!row || typeof row !== 'object') return null;
  return Object.values(row as Record<string, unknown>)[0] ?? null;
}

export function taskLifecycleDbHealth(cwd: string, options: TaskLifecycleSqliteOptions = {}) {
  const siteLoopConfig = requireSiteLoopConfig(resolve(cwd));
  const deep: boolean = options.mode === 'deep' || options.integrityCheck === true;
  let store: SqliteTaskLifecycleStore | null = null;
  try {
    store = openTaskLifecycleStoreWithDiscipline(cwd, { write: false });
    // The Site Loop calls this from its bounded hot path. A full integrity_check
    // scans the entire database and is intentionally opt-in for large task DBs.
    const schemaVersion: unknown = store.db.prepare('PRAGMA schema_version').get();
    const pageCount: unknown = store.db.prepare('PRAGMA page_count').get();
    const freelistCount: unknown = store.db.prepare('PRAGMA freelist_count').get();
    const wal: unknown = store.db.prepare('PRAGMA journal_mode').get();
    const busyTimeout: unknown = store.db.prepare('PRAGMA busy_timeout').get();
    const tableProbe: Record<string, unknown> | undefined = store.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'task_lifecycle'").get() as Record<string, unknown> | undefined;
    const integrity: unknown = deep ? store.db.prepare('PRAGMA integrity_check').get() : null;
    const integrityValue: unknown = pragmaValue(integrity);
    const tablePresent: boolean = tableProbe?.present === 1;
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
  } catch (error: unknown) {
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

export function repairTaskLifecycleDbIndexes(cwd: string, options: TaskLifecycleSqliteOptions = {}) {
  const siteRoot: string = resolve(cwd);
  const siteLoopConfig = requireSiteLoopConfig(siteRoot);
  if (options.ackRepair !== true) {
    return {
      schema: schemaName(siteLoopConfig, 'task_lifecycle_db_repair'),
      status: 'refused',
      reason: 'ack_repair_required',
      required_flag: '--ack-repair',
      db_path: join(siteRoot, '.ai', 'task-lifecycle.db'),
    };
  }
  const dbPath: string = join(siteRoot, '.ai', 'task-lifecycle.db');
  const backupDir: string = join(siteRoot, '.ai', `db-repair-${timestampForPath(new Date())}`);
  const lock: WriteLock = acquireWriteLock(siteRoot, options);
  let store: SqliteTaskLifecycleStore | null = null;
  try {
    mkdirSync(backupDir, { recursive: true });
    store = openTaskLifecycleStore(siteRoot, { mode: 'runtime' });
    applyDbPragmas(store.db, options);
    try {
      store.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // A repair backup must continue even if SQLite cannot checkpoint.
    }
    copyTaskLifecycleDbFiles(siteRoot, backupDir);
    const before: string = String(Object.values((store.db.prepare('PRAGMA integrity_check').get() ?? {}) as Record<string, unknown>)[0] ?? '');
    store.db.exec('REINDEX');
    store.db.exec('ANALYZE');
    let after: string = String(Object.values((store.db.prepare('PRAGMA integrity_check').get() ?? {}) as Record<string, unknown>)[0] ?? '');
    let vacuumPerformed: boolean = false;
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

function applyDbPragmas(db: TaskLifecycleDatabase, options: TaskLifecycleSqliteOptions = {}): void {
  db.pragma(`busy_timeout = ${Number(options.busyTimeoutMs ?? 10_000)}`);
  if (process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE !== '1') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
}

function finalizeWriteConnection(db: TaskLifecycleDatabase): void {
  // Full quick_check/integrity_check scans the entire task database. It is
  // reserved for explicit repair/diagnostic runs, never for the bounded Site
  // Loop write hot path or ordinary connection close.
  if (process.env.NARADA_TASK_LIFECYCLE_AUTO_REPAIR_INDEXES === '1') {
    const quick: string = String(Object.values((db.prepare('PRAGMA quick_check').get() ?? {}) as Record<string, unknown>)[0] ?? '');
    if (quick !== 'ok') {
      db.exec('REINDEX');
      const after: string = String(Object.values((db.prepare('PRAGMA integrity_check').get() ?? {}) as Record<string, unknown>)[0] ?? '');
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

function copyTaskLifecycleDbFiles(siteRoot: string, backupDir: string): void {
  const dbPath: string = join(siteRoot, '.ai', 'task-lifecycle.db');
  for (const [source, target] of [
    [dbPath, 'task-lifecycle.db.before-reindex'],
    [`${dbPath}-wal`, 'task-lifecycle.db-wal.before-reindex'],
    [`${dbPath}-shm`, 'task-lifecycle.db-shm.before-reindex'],
  ]) {
    if (existsSync(source)) copyFileSync(source, join(backupDir, target));
  }
}


function acquireWriteLock(siteRoot: string, options: TaskLifecycleSqliteOptions = {}): WriteLock {
  const siteLoopConfig = requireSiteLoopConfig(siteRoot);
  const lockDir: string = join(siteRoot, '.ai', 'task-lifecycle.write.lock');
  const staleMs: number = Number(options.staleMs ?? 10 * 60_000);
  const timeoutMs: number = Number(options.timeoutMs ?? 30_000);
  const pollMs: number = Number(options.pollMs ?? 50);
  const existing: LockState | undefined = heldLocks.get(lockDir);
  if (existing) {
    existing.depth += 1;
    return { lockDir, reentrant: true };
  }
  const deadline: number = Date.now() + timeoutMs;
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
    } catch (error: unknown) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'EEXIST') throw error;
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

function releaseWriteLock(lock: WriteLock): void {
  const state: LockState | undefined = heldLocks.get(lock.lockDir);
  if (!state) return;
  state.depth -= 1;
  if (state.depth > 0) return;
  heldLocks.delete(lock.lockDir);
  rmSync(lock.lockDir, { recursive: true, force: true });
}

function lockIsStale(lockDir: string, staleMs: number): boolean {
  try {
    const owner: LockOwner | null = readLockOwner(lockDir);
    const ownerPid: number = Number(owner?.pid);
    // A dead owner is definitive evidence of a stale lock. Do not make every
    // restart wait for the conservative heartbeat TTL before recovering it.
    if (Number.isFinite(ownerPid) && ownerPid > 0
      && (ownerPid === process.pid || !processIsLive(ownerPid))) return true;
    const heartbeatMs: number = Date.parse(owner?.heartbeat_at ?? owner?.acquired_at ?? '');
    const ageMs: number = Date.now() - (Number.isFinite(heartbeatMs) ? heartbeatMs : statSync(lockDir).mtimeMs);
    if (ageMs <= staleMs) return false;
    if (ownerPid > 0 && ownerPid !== process.pid && processIsLive(ownerPid)) return false;
    return true;
  } catch {
    return true;
  }
}

function refreshWriteLock(lock: WriteLock): void {
  const siteRoot: string = resolve(lock.lockDir, '..', '..');
  const siteLoopConfig = requireSiteLoopConfig(siteRoot);
  const ownerPath: string = join(lock.lockDir, 'owner.json');
  const owner: LockOwner = readLockOwner(lock.lockDir) ?? {};
  writeFileSync(ownerPath, JSON.stringify({
    ...owner,
    schema: schemaName(siteLoopConfig, 'task_lifecycle_write_lock'),
    pid: process.pid,
    heartbeat_at: new Date().toISOString(),
  }, null, 2), 'utf8');
}

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    return {
      schema: typeof record.schema === 'string' ? record.schema : undefined,
      pid: typeof record.pid === 'number' ? record.pid : Number(record.pid),
      acquired_at: typeof record.acquired_at === 'string' ? record.acquired_at : undefined,
      heartbeat_at: typeof record.heartbeat_at === 'string' ? record.heartbeat_at : undefined,
    };
  } catch {
    return null;
  }
}

function processIsLive(pid: number): boolean {
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

function sleepProcess(ms: number): void {
  const seconds: number = Math.max(1, Math.ceil(ms / 1000));
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

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
