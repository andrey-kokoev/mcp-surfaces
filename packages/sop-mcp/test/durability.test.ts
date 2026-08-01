import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeServerState, createServerState, handleRequest } from '../src/main.js';

type JsonRecord = Record<string, unknown>;
type RpcResponse = { result?: { structuredContent?: JsonRecord }; error?: { data?: { code?: string } } };

const root = mkdtempSync(join(tmpdir(), 'sop-mcp-durability-'));
let state = createServerState({ sopRoot: root, sopsDirs: [] });

async function call(name: string, args: JsonRecord): Promise<RpcResponse> {
  return await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as RpcResponse;
}

function view(response: RpcResponse): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.ok(response.result?.structuredContent);
  return response.result.structuredContent;
}

function errorCode(response: RpcResponse): string {
  assert.ok(response.error, `Expected error, received ${JSON.stringify(response.result)}`);
  return String(response.error.data?.code ?? '');
}

try {
  const startAt = '2000-01-01T00:00:00.000Z';
  const schedulerA = view(await call('sop_outbox_consumer_register', { consumer_id: 'scheduler:a', start_at: startAt }));
  const schedulerB = view(await call('sop_outbox_consumer_register', { consumer_id: 'scheduler:b', start_at: startAt }));
  assert.equal(schedulerA.registration_replayed, false);
  assert.equal(schedulerB.registration_replayed, false);
  assert.equal(view(await call('sop_outbox_consumer_register', { consumer_id: 'scheduler:a', start_at: startAt })).registration_replayed, true);
  assert.equal(errorCode(await call('sop_outbox_consumer_register', { consumer_id: 'scheduler:a', start_at: '2001-01-01T00:00:00.000Z' })), 'sop_outbox_consumer_registration_conflict');

  view(await call('sop_template_create', {
    sop_id: 'durable-handoff',
    title: 'Durable handoff',
    input_schema: {
      type: 'object',
      properties: { ticket_id: { type: 'string' } },
      required: ['ticket_id'],
      additionalProperties: false,
    },
    output: {
      outcome: { $ref: 'steps.process.result.disposition' },
      disposition: { $ref: 'steps.process.result.disposition' },
    },
    steps: [{
      id: 'process',
      executor: 'agent',
      blocking: true,
      title: 'Process ticket',
      instructions: 'Process {{input.ticket_id}}.',
      input: { ticket_id: { $ref: 'input.ticket_id' } },
      depends_on: [],
      result_schema: {
        type: 'object',
        properties: { disposition: { type: 'string' } },
        required: ['disposition'],
        additionalProperties: false,
      },
    }],
  }));

  const admitted = view(await call('sop_run_start', {
    sop_id: 'durable-handoff',
    occurrence_key: 'ticket:t-1:event:e-1',
    input: { ticket_id: 't-1' },
    triggered_by: 'scheduler:test',
    trigger_source_kind: 'domain_event',
    trigger_source_ref: 'work-event:e-1',
  }));
  const runId = String(admitted.run_id);
  const handoffId = String(((admitted.next_steps as JsonRecord[])[0].result as JsonRecord).handoff_id);
  assert.match(handoffId, /^soh_/);
  assert.equal(view(await call('sop_handoff_show', { handoff_id: handoffId })).lease_token, undefined);

  const firstClaimEnvelope = view(await call('sop_handoff_claim', { consumer_id: 'agent-runner:a', lease_ms: 60_000 }));
  const firstClaim = firstClaimEnvelope.handoff as JsonRecord;
  const firstToken = String(firstClaim.lease_token);
  assert.equal(firstClaim.run_id, runId);
  assert.equal(firstClaim.status, 'leased');
  assert.equal(firstClaim.attempt_count, 1);

  closeServerState(state);
  state = createServerState({ sopRoot: root, sopsDirs: [] });
  const afterRestart = view(await call('sop_handoff_show', { handoff_id: handoffId }));
  assert.equal(afterRestart.status, 'leased');
  assert.equal(afterRestart.lease_owner, 'agent-runner:a');

  const dbPath = join(root, '.sop', 'sop.db');
  const expiryDb = new DatabaseSync(dbPath);
  expiryDb.prepare('UPDATE sop_handoffs SET lease_expires_at = ? WHERE handoff_id = ?').run('2000-01-01T00:00:00.000Z', handoffId);
  expiryDb.close();

  const recoveredEnvelope = view(await call('sop_handoff_claim', { consumer_id: 'agent-runner:b', lease_ms: 60_000 }));
  const recovered = recoveredEnvelope.handoff as JsonRecord;
  const recoveredToken = String(recovered.lease_token);
  assert.equal(recovered.handoff_id, handoffId);
  assert.equal(recovered.lease_owner, 'agent-runner:b');
  assert.equal(recovered.attempt_count, 2);
  assert.notEqual(recoveredToken, firstToken);
  assert.equal(errorCode(await call('sop_run_advance', {
    handoff_id: handoffId,
    run_id: runId,
    step_id: 'process',
    consumer_id: 'agent-runner:a',
    lease_token: firstToken,
    completion_key: 'agent-result:t-1',
    outcome: 'completed',
    principal: 'agent:test',
    result: { disposition: 'respond' },
  })), 'sop_handoff_lease_mismatch');

  const released = view(await call('sop_handoff_release', {
    handoff_id: handoffId,
    consumer_id: 'agent-runner:b',
    lease_token: recoveredToken,
    error_message: 'carrier restarted before completion',
  }));
  assert.equal(released.status, 'pending');
  assert.equal(released.last_error, 'carrier restarted before completion');

  const finalClaim = (view(await call('sop_handoff_claim', { consumer_id: 'agent-runner:c', lease_ms: 60_000 })).handoff as JsonRecord);
  const finalToken = String(finalClaim.lease_token);
  const renewed = view(await call('sop_handoff_renew', {
    handoff_id: handoffId,
    consumer_id: 'agent-runner:c',
    lease_token: finalToken,
    lease_ms: 120_000,
  }));
  assert.equal(renewed.status, 'leased');
  assert.equal(renewed.attempt_count, 3);

  const completionArgs = {
    handoff_id: handoffId,
    run_id: runId,
    step_id: 'process',
    consumer_id: 'agent-runner:c',
    lease_token: finalToken,
    completion_key: 'agent-result:t-1',
    outcome: 'completed',
    principal: 'agent:test',
    result: { disposition: 'respond' },
  };
  const completed = view(await call('sop_run_advance', completionArgs));
  assert.equal(completed.status, 'completed');
  assert.equal((completed.handoff as JsonRecord).status, 'completed');
  assert.equal(view(await call('sop_run_advance', completionArgs)).completion_replayed, true);

  const eventsA = view(await call('sop_outbox_list', { consumer_id: 'scheduler:a' }));
  const eventsB = view(await call('sop_outbox_list', { consumer_id: 'scheduler:b' }));
  assert.equal(eventsA.count, 1);
  assert.equal(eventsB.count, 1);
  const terminalEvent = (eventsA.items as JsonRecord[])[0];
  assert.equal(terminalEvent.run_id, runId);
  assert.equal(terminalEvent.outcome, 'completed');
  const terminalPayload = terminalEvent.payload as JsonRecord;
  assert.equal(terminalPayload.schema, 'narada.sop.run_terminal.v2');
  assert.equal(terminalPayload.run_outcome, 'completed');
  assert.equal(terminalPayload.outcome, 'respond');
  assert.deepEqual(terminalPayload.output, { outcome: 'respond', disposition: 'respond' });

  const eventId = String(terminalEvent.event_id);
  const ackA = { activation_id: 'activation:a', outcome: 'admitted' };
  assert.equal(view(await call('sop_outbox_ack', { event_id: eventId, consumer_id: 'scheduler:a', receipt: ackA })).acknowledgement_replayed, false);
  assert.equal(view(await call('sop_outbox_ack', { event_id: eventId, consumer_id: 'scheduler:a', receipt: ackA })).acknowledgement_replayed, true);
  assert.equal(errorCode(await call('sop_outbox_ack', { event_id: eventId, consumer_id: 'scheduler:a', receipt: { activation_id: 'different' } })), 'sop_outbox_receipt_conflict');
  assert.equal(view(await call('sop_outbox_compact', { before: '2999-01-01T00:00:00.000Z' })).compacted, 0);
  view(await call('sop_outbox_ack', { event_id: eventId, consumer_id: 'scheduler:b', receipt: { activation_id: 'activation:b', outcome: 'admitted' } }));
  assert.equal(view(await call('sop_outbox_compact', { before: '2999-01-01T00:00:00.000Z' })).compacted, 1);
  assert.equal(errorCode(await call('sop_outbox_consumer_register', { consumer_id: 'scheduler:late', start_at: startAt })), 'sop_outbox_registration_history_compacted');

  const cancellation = view(await call('sop_run_start', {
    sop_id: 'durable-handoff',
    occurrence_key: 'ticket:t-2:event:e-2',
    input: { ticket_id: 't-2' },
    triggered_by: 'scheduler:test',
  }));
  const cancellationRunId = String(cancellation.run_id);
  const cancellationHandoffId = String(((cancellation.next_steps as JsonRecord[])[0].result as JsonRecord).handoff_id);
  assert.equal(view(await call('sop_run_cancel', { run_id: cancellationRunId, reason: 'operator cancelled' })).status, 'cancelled');
  assert.equal(view(await call('sop_handoff_show', { handoff_id: cancellationHandoffId })).status, 'cancelled');

  const invariantDb = new DatabaseSync(dbPath);
  const missingOutbox = invariantDb.prepare(`
    SELECT COUNT(*) AS count FROM sop_runs run
    LEFT JOIN sop_outbox outbox ON outbox.run_id = run.run_id
    WHERE run.status IN ('completed', 'failed', 'cancelled') AND outbox.event_id IS NULL
  `).get() as JsonRecord;
  assert.equal(Number(missingOutbox.count), 0);
  const compactedPayload = invariantDb.prepare('SELECT payload_json FROM sop_outbox WHERE event_id = ?').get(eventId) as JsonRecord;
  assert.equal(compactedPayload.payload_json, '{}');
  invariantDb.close();

  console.log('sop-mcp durability ok');
} finally {
  closeServerState(state);
  rmSync(root, { recursive: true, force: true });
}
