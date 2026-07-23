import assert from 'node:assert/strict';
import { parseSiteLoopSupervisorArgs } from '../src/site-loop/site-loop-supervisor-runner.js';

const parsed = parseSiteLoopSupervisorArgs([
  '--site-root', 'D:/code/example-site',
  '--source-sync',
  '--ensure-resident',
  '--cycles', '3',
  '--interval-ms', '1000',
  '--jitter-ms', '25',
  '--supervisor-heartbeat-path', 'D:/tmp/heartbeat.json',
  '--supervisor-heartbeat-interval-ms', '5000',
  '--source-sync-timeout-ms', '120000',
  '--ticket-task-reconciliation-timeout-ms', '120000',
  '--limit', '10',
  '--threshold', '2',
  '--owner-id', 'site:supervisor',
  '--runtime-id', 'runtime-1',
  '--runtime-lease-ttl-ms', '90000',
]);

assert.equal(parsed.cwd, 'D:/code/example-site');
assert.equal(parsed.supervise, true);
assert.equal(parsed.sourceSync, true);
assert.equal(parsed.ensureResident, true);
assert.equal(parsed.cycles, 3);
assert.equal(parsed.intervalMs, 1000);
assert.equal(parsed.jitterMs, 25);
assert.equal(parsed.supervisorHeartbeatPath, 'D:/tmp/heartbeat.json');
assert.equal(parsed.supervisorHeartbeatIntervalMs, 5000);
assert.equal(parsed.sourceSyncTimeoutMs, 120000);
assert.equal(parsed.ticketTaskReconciliationTimeoutMs, 120000);
assert.equal(parsed.limit, 10);
assert.equal(parsed.threshold, 2);
assert.equal(parsed.ownerId, 'site:supervisor');
assert.equal(parsed.runtimeId, 'runtime-1');
assert.equal(parsed.runtimeLeaseTtlMs, 90000);
console.log('site-loop supervisor runner args ok');
