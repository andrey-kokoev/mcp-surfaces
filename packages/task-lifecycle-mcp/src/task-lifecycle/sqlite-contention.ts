import { randomUUID } from 'node:crypto';

type SqliteStore = {
  db: {
    exec(sql: string): void;
  };
};

export const DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS = [25, 75, 150] as const;

export function isSqliteBusyError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const code = typeof record?.code === 'string' ? record.code : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || /\bSQLITE_(?:BUSY|LOCKED)\b|database is (?:busy|locked)/i.test(message);
}

export async function withSqliteBusyRetry<T>(
  action: () => Promise<T> | T,
  options: {
    retryDelaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<{ value: T; attempts: number; retries: number }> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      return { value: await action(), attempts, retries: attempts - 1 };
    } catch (error) {
      const retryIndex = attempts - 1;
      if (!isSqliteBusyError(error) || retryIndex >= retryDelaysMs.length) throw error;
      await sleep(Math.max(0, retryDelaysMs[retryIndex] ?? 0));
    }
  }
}

export async function withStoreSavepoint<T>(store: SqliteStore, action: () => Promise<T> | T): Promise<T> {
  const name = `narada_compatibility_${randomUUID().replaceAll('-', '')}`;
  let savepointOpen = false;
  try {
    store.db.exec(`SAVEPOINT ${name}`);
    savepointOpen = true;
    const result = await action();
    store.db.exec(`RELEASE SAVEPOINT ${name}`);
    savepointOpen = false;
    return result;
  } catch (error) {
    if (savepointOpen) {
      try { store.db.exec(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* preserve the original failure */ }
      try {
        store.db.exec(`RELEASE SAVEPOINT ${name}`);
        savepointOpen = false;
      } catch { /* preserve the original failure */ }
    }
    throw error;
  }
}
