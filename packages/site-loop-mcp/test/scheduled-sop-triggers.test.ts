import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(envelope.kind, 'command_request');
  assert.equal(envelope.target_role, 'operator');
  assert.equal(envelope.title, 'Reconcile provider model catalogs');
  assert.equal(envelope.summary, 'Start the referenced SOP through SOP MCP. Produce proposals only.');
  assert.equal(envelope.payload.sop_id, 'provider-model-catalog-reconciliation');
  assert.deepEqual(Object.keys(envelope.payload).sort(), [
    'cadence',
    'preferred_agent_id',
    'recommendation',
    'sop_id',
    'trigger_kind',
    'trigger_source_ref',
  ]);

  const duplicate = emitScheduledSopTriggers(root, config as never, { now: '2026-07-20T00:00:00.000Z' });
  assert.equal(duplicate.existing, 1);

  const next = emitScheduledSopTriggers(root, config as never, { now: '2026-07-24T00:00:00.000Z' });
  assert.equal(next.created, 1);
  assert.notEqual(next.results[0].envelope_id, created.results[0].envelope_id);

  const legacyRoot = mkdtempSync(join(tmpdir(), 'site-loop-legacy-scheduled-sop-'));
  try {
    const legacyDir = join(legacyRoot, '.ai', 'inbox-envelopes');
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'scheduled-sop-provider-model-catalog-audit-20260710.json');
    writeFileSync(legacyPath, JSON.stringify({
      schema: 'narada.inbox_envelope.v1',
      envelope_id: 'env_scheduled_sop_provider-model-catalog-audit_20260710',
      kind: 'request',
      payload: {
        target_role: 'operator',
        sop_id: 'provider-model-reconciliation',
        preferred_agent_id: 'andrey-user.operator',
      },
    }), 'utf8');
    const replaced = emitScheduledSopTriggers(legacyRoot, config as never, { now: '2026-07-10T00:00:00.000Z' });
    assert.equal(replaced.created, 1);
    assert.equal(replaced.results[0].supersedes_envelope_id, 'env_scheduled_sop_provider-model-catalog-audit_20260710');
    assert.match(replaced.results[0].envelope_id!, /_canonical$/);
    const replacement = JSON.parse(readFileSync(replaced.results[0].path!, 'utf8'));
    assert.equal(replacement.kind, 'command_request');
    assert.equal(replacement.target_role, 'operator');
    assert.equal(replacement.payload.target_role, undefined);
    assert.equal(replacement.mutation_posture, undefined);
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
