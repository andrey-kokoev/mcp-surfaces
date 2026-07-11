import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitScheduledSopTriggers } from '../src/site-loop/scheduled-sop-triggers.js';
import { operatingLayerAlertSignals } from '../src/site-loop/site-loop-engine.js';

const root = mkdtempSync(join(tmpdir(), 'site-loop-scheduled-sop-'));
const config = {
  loop_id: 'andrey-user.maintenance',
  scheduled_sops: [{
    id: 'provider-model-catalog-audit',
    sop_id: 'provider-model-catalog-reconciliation',
    title: 'Reconcile provider model catalogs',
    instructions: 'Start the referenced SOP through SOP MCP. Produce proposals only.',
    interval_days: 14,
    anchor_at: '2026-07-10T00:00:00.000Z',
    target_role: 'operator',
    preferred_agent_id: 'andrey-user.operator',
    mutation_posture: 'proposal_only',
  }],
};

const idleWithoutWork = operatingLayerAlertSignals({
  resident: { status: 'blocked' },
  dbHealth: { status: 'ok' },
  health: { consecutive_failures: 0 },
  pending: { pending_count: 0 },
  stalePending: [],
});
assert.equal(idleWithoutWork.some((item) => item.kind === 'no_available_resident'), false);

const blockedWork = operatingLayerAlertSignals({
  resident: { status: 'blocked' },
  dbHealth: { status: 'ok' },
  health: { consecutive_failures: 0 },
  pending: { pending_count: 1 },
  stalePending: [],
});
assert.equal(blockedWork.some((item) => item.kind === 'no_available_resident'), true);

try {
  const before = emitScheduledSopTriggers(root, config as never, { now: '2026-07-09T23:59:59.000Z' });
  assert.equal(before.not_due, 1);

  const dryRun = emitScheduledSopTriggers(root, config as never, { now: '2026-07-10T00:00:00.000Z', dryRun: true });
  assert.equal(dryRun.planned, 1);
  assert.equal(existsSync(dryRun.results[0].path!), false);

  const created = emitScheduledSopTriggers(root, config as never, { now: '2026-07-10T00:00:00.000Z' });
  assert.equal(created.created, 1);
  const envelope = JSON.parse(readFileSync(created.results[0].path!, 'utf8'));
  assert.equal(envelope.payload.sop_id, 'provider-model-catalog-reconciliation');
  assert.equal(envelope.payload.mutation_posture, 'proposal_only');

  const duplicate = emitScheduledSopTriggers(root, config as never, { now: '2026-07-20T00:00:00.000Z' });
  assert.equal(duplicate.existing, 1);

  const next = emitScheduledSopTriggers(root, config as never, { now: '2026-07-24T00:00:00.000Z' });
  assert.equal(next.created, 1);
  assert.notEqual(next.results[0].envelope_id, created.results[0].envelope_id);
} finally {
  rmSync(root, { recursive: true, force: true });
}
