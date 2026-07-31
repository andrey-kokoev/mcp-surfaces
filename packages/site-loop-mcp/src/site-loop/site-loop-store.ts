import { resolve } from 'node:path';
import {
  acquireTaskLifecycleWriteLock,
  openTaskLifecycleStoreForLogicalLock,
  openTaskLifecycleStoreWithDiscipline,
  releaseTaskLifecycleWriteLock,
  type TaskLifecycleSqliteOptions,
  type TaskLifecycleWriteLock,
} from '../task-lifecycle/sqlite-discipline.js';
import {
  getSiteOperatingLoopRuntimeHost as getCanonicalSiteOperatingLoopRuntimeHost,
} from '@narada2/site-operating-loop/site-loop-store';
import {
  assertSiteLoopStorageSchema,
  ensureSiteLoopTables,
  type SiteLoopDatabase,
} from '../site-operating-loop/site-loop-store.js';
import { createSiteLoopEvidenceStore } from '../site-operating-loop/site-loop-evidence.js';

export * from '../site-operating-loop/site-loop-store.js';

interface OpenSiteLoopStoreOptions {
  write?: boolean;
  storeMode?: 'prepare' | 'runtime';
}

type OpenLifecycleStore = typeof openTaskLifecycleStoreWithDiscipline;

function ensureRuntimeHostTables(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_loop_runtime_events (
      event_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      event TEXT NOT NULL,
      run_id TEXT,
      cycle_index INTEGER,
      status TEXT,
      occurred_at TEXT NOT NULL,
      event_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_site_loop_runtime_events_loop_time
      ON site_loop_runtime_events(loop_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS site_loop_runtime_hosts (
      loop_id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      authority_epoch INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      runtime_host_state TEXT NOT NULL,
      lifecycle_json TEXT NOT NULL,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      stopped_at TEXT,
      updated_at TEXT NOT NULL,
      metadata_json TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_site_loop_runtime_hosts_runtime
      ON site_loop_runtime_hosts(runtime_id);
  `);
}

function openSiteLoopStoreInternal(cwd: any, options: OpenSiteLoopStoreOptions, openLifecycleStore: OpenLifecycleStore) {
  const write = options.write !== false;
  const siteRoot = resolve(cwd);
  const lifecycleStore = openLifecycleStore(siteRoot, {
    write,
    storeMode: options.storeMode,
  });
  try {
    const db = lifecycleStore.db as unknown as SiteLoopDatabase;
    const evidenceStore = createSiteLoopEvidenceStore(siteRoot);
    let processWriteLock: TaskLifecycleWriteLock | null = null;
    if (write) {
      ensureSiteLoopTables(db);
      ensureRuntimeHostTables(db);
    }
    assertSiteLoopStorageSchema(db);
    return {
      db,
      siteRoot,
      evidenceStore,
      acquireProcessWriteLock(lockOptions: TaskLifecycleSqliteOptions = {}) {
        if (!write || processWriteLock) return;
        processWriteLock = acquireTaskLifecycleWriteLock(siteRoot, lockOptions);
      },
      close() {
        try {
          lifecycleStore.db.close();
        } finally {
          if (processWriteLock) {
            releaseTaskLifecycleWriteLock(processWriteLock);
            processWriteLock = null;
          }
        }
      },
    };
  } catch (error) {
    lifecycleStore.db.close();
    throw error;
  }
}

export function openSiteLoopStore(cwd: any, options: OpenSiteLoopStoreOptions = {}) {
  return openSiteLoopStoreInternal(cwd, options, openTaskLifecycleStoreWithDiscipline);
}

/**
 * Open the Site Loop store before its persisted logical lock is acquired.
 * The caller must acquire that lock immediately and attach the returned
 * process lock before performing any Site Loop domain write.
 */
export function openSiteLoopStoreForLogicalLock(cwd: any, options: OpenSiteLoopStoreOptions = {}) {
  return openSiteLoopStoreInternal(cwd, options, openTaskLifecycleStoreForLogicalLock);
}
