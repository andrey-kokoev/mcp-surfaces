import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonRecord } from './protocol.js';

export type AudibleOutputState = {
  audibleOutputLockDir: string;
  audibleOutputLockStaleMs: number;
  audibleOutputQueue: Promise<void>;
};

export async function withAudibleOutput<T extends JsonRecord>(state: AudibleOutputState, event: JsonRecord, operation: () => Promise<T> | T): Promise<T> {
  const queued = state.audibleOutputQueue.then(() => withHostAudibleOutputLock(state, event, operation));
  state.audibleOutputQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

async function withHostAudibleOutputLock<T extends JsonRecord>(state: AudibleOutputState, event: JsonRecord, operation: () => Promise<T> | T): Promise<T> {
  await acquireHostAudibleOutputLock(state);
  try {
    const result = await operation();
    return { ...result, audible_output: { serialized: true, lock_scope: 'host', lock_dir: state.audibleOutputLockDir, event } } as T;
  } finally {
    releaseHostAudibleOutputLock(state);
  }
}

async function acquireHostAudibleOutputLock(state: AudibleOutputState): Promise<void> {
  while (true) {
    try {
      mkdirSync(state.audibleOutputLockDir);
      writeFileSync(join(state.audibleOutputLockDir, 'owner.json'), JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }) + '\n', 'utf8');
      return;
    } catch {
      clearStaleAudibleOutputLock(state);
      await sleep(25);
    }
  }
}

function clearStaleAudibleOutputLock(state: AudibleOutputState): void {
  try {
    const ownerPath = join(state.audibleOutputLockDir, 'owner.json');
    const owner = asRecord(JSON.parse(readFileSync(ownerPath, 'utf8')));
    const acquiredAt = Date.parse(String(owner.acquired_at ?? ''));
    if (Number.isFinite(acquiredAt) && Date.now() - acquiredAt > state.audibleOutputLockStaleMs) {
      rmSync(state.audibleOutputLockDir, { recursive: true, force: true });
    }
  } catch {
    // If the lock is malformed or races with another process, leave it for the next retry.
  }
}

function releaseHostAudibleOutputLock(state: AudibleOutputState): void {
  try { rmSync(state.audibleOutputLockDir, { recursive: true, force: true }); } catch { /* already released */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
