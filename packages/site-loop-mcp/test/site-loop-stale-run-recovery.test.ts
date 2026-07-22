import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SITE_LOOP_CONFIG, SITE_LOOP_CONFIG_SCHEMA } from '../src/site-loop/site-loop-config.js';
import {
  acquireLoopLock,
  beginLoopRun,
  finishLoopRun,
  getLoopRun,
  openSiteLoopStore,
  reconcileStaleLoopRuns,
  releaseLoopLock,
} from '../src/site-loop/site-loop-store.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-stale-run-recovery-'));
mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  ...DEFAULT_SITE_LOOP_CONFIG,
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'stale-run-recovery.loop',
  site_id: 'stale-run-recovery-site',
  display_name: 'Stale run recovery test loop',
}, null, 2), 'utf8');

const store = openSiteLoopStore(siteRoot);
const loopId = 'stale-run-recovery.loop';
const staleStartedAt = '2026-07-22T01:00:00.000Z';
const recoveryAt = new Date('2026-07-22T01:10:00.000Z');

beginLoopRun(store, {
  run_id: 'stale-run',
  loop_id: loopId,
  status: 'running',
  dry_run: false,
  started_at: staleStartedAt,
});

const lock = acquireLoopLock(store, {
  loopId,
  runId: 'active-run',
  ttlMs: 5 * 60 * 1000,
  now: recoveryAt,
});
assert.equal(lock.status, 'acquired');

const recovery = reconcileStaleLoopRuns(store, {
  loopId,
  activeRunId: 'active-run',
  staleAfterMs: 5 * 60 * 1000,
  now: recoveryAt,
});
assert.equal(recovery.recovered_count, 1);
assert.equal(recovery.recovered_runs[0].run_id, 'stale-run');

const staleRun = getLoopRun(store, 'stale-run');
assert.equal(staleRun?.status, 'abandoned');
assert.equal(staleRun?.finished_at, recoveryAt.toISOString());
assert.equal(staleRun?.error?.kind, 'stale_loop_run_recovered');
assert.equal(staleRun?.summary?.stale_run_recovery?.run_id, 'stale-run');

const secondRecovery = reconcileStaleLoopRuns(store, {
  loopId,
  activeRunId: 'active-run',
  staleAfterMs: 5 * 60 * 1000,
  now: recoveryAt,
});
assert.equal(secondRecovery.recovered_count, 0);

beginLoopRun(store, {
  run_id: 'active-run',
  loop_id: loopId,
  status: 'running',
  dry_run: false,
  started_at: recoveryAt.toISOString(),
});
finishLoopRun(store, 'active-run', {
  status: 'ok',
  finished_at: new Date(recoveryAt.getTime() + 1000).toISOString(),
});
releaseLoopLock(store, { loopId, runId: 'active-run' });

store.close();
console.log('site-loop-stale-run-recovery.test: ok');
