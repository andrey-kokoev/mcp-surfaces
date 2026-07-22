import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SITE_LOOP_CONFIG, SITE_LOOP_CONFIG_SCHEMA } from '../src/site-loop/site-loop-config.js';
import {
  acknowledgeLoopAttention,
  getLoopEscalation,
  openSiteLoopStore,
} from '../src/site-loop/site-loop-store.js';
import { reconcileLoopEscalations } from '../src/site-loop/site-loop-engine.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-escalation-reconciliation-'));
mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  ...DEFAULT_SITE_LOOP_CONFIG,
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'ack.suppression.loop',
  site_id: 'ack-suppression-site',
  display_name: 'Acknowledgement suppression test loop',
  resident: {
    ...DEFAULT_SITE_LOOP_CONFIG.resident,
    agent_id: 'resident',
    role: 'resident',
  },
}, null, 2), 'utf8');

const store = openSiteLoopStore(siteRoot);
const directiveId = 'directive-ack-suppression';
const baseClassification = {
  directive_id: directiveId,
  task_id: 'task-ack-suppression',
  reason: 'controlled stale fixture',
  status: 'delivery_stale',
};

function reconcile(status, at) {
  return reconcileLoopEscalations(
    siteRoot,
    store,
    { classifications: [{ ...baseClassification, status }] },
    { runId: `run-${at}`, nowIso: at },
  );
}

const initialRuns = [
  reconcile('delivery_stale', '2026-07-22T02:00:00.000Z'),
  reconcile('delivery_stale', '2026-07-22T02:01:00.000Z'),
  reconcile('delivery_stale', '2026-07-22T02:02:00.000Z'),
];
assert.deepEqual(initialRuns.map((run) => run.created_count), [0, 0, 1]);

let escalation = getLoopEscalation(store, {
  loopId: 'ack.suppression.loop',
  directiveId,
  classification: 'delivery_stale',
});
assert.equal(escalation?.status, 'opened');
assert.ok(escalation?.envelope_id);

const acknowledged = acknowledgeLoopAttention(store, {
  attentionId: escalation.envelope_id,
  acknowledgedBy: 'operator',
  reason: 'Historical controlled stale fixture acknowledged for regression coverage.',
  at: '2026-07-22T02:03:00.000Z',
});
assert.equal(acknowledged.status, 'acknowledged');

const ongoingStaleRuns = [
  reconcile('delivery_stale', '2026-07-22T02:04:00.000Z'),
  reconcile('delivery_stale', '2026-07-22T02:05:00.000Z'),
  reconcile('delivery_stale', '2026-07-22T02:06:00.000Z'),
];
assert.deepEqual(ongoingStaleRuns.map((run) => run.created_count), [0, 0, 0]);
escalation = getLoopEscalation(store, {
  loopId: 'ack.suppression.loop',
  directiveId,
  classification: 'delivery_stale',
});
assert.equal(escalation?.status, 'acknowledged');

assert.equal(reconcile('reported', '2026-07-22T02:07:00.000Z').cleared_count, 0);

const recoveredStaleRuns = [
  reconcile('delivery_stale', '2026-07-22T02:08:00.000Z'),
  reconcile('delivery_stale', '2026-07-22T02:09:00.000Z'),
  reconcile('delivery_stale', '2026-07-22T02:10:00.000Z'),
];
assert.deepEqual(recoveredStaleRuns.map((run) => run.created_count), [0, 0, 1]);
escalation = getLoopEscalation(store, {
  loopId: 'ack.suppression.loop',
  directiveId,
  classification: 'delivery_stale',
});
assert.equal(escalation?.status, 'opened');

store.close();
console.log('site-loop-escalation-reconciliation.test: ok');
