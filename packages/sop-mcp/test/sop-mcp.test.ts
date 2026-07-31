import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeServerState, createServerState, handleRequest } from '../src/main.js';

type JsonRecord = Record<string, unknown>;
type RpcResponse = { result?: { structuredContent?: JsonRecord }; error?: { data?: { code?: string } } };

const root = mkdtempSync(join(tmpdir(), 'sop-mcp-behavior-'));
const sopsDir = join(root, 'test-sops');
mkdirSync(sopsDir, { recursive: true });
let state = createServerState({ sopRoot: root, sopsDirs: [sopsDir] });

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

function steps(response: RpcResponse): JsonRecord[] {
  return view(response).step_states as JsonRecord[];
}

const valueRef = { ref: 'artifact:fixture/result', sha256: 'a'.repeat(64), byte_length: 250, media_type: 'application/json' };

try {
  const doctor = view(await call('sop_doctor', {}));
  assert.equal(doctor.server_version, '0.2.0');
  assert.equal((doctor.execution_posture as JsonRecord).direct_command_execution, 'unsupported');
  assert.equal((doctor.execution_posture as JsonRecord).activation_owner, 'scheduler_or_event_caller');
  assert.equal((doctor.execution_posture as JsonRecord).effect_owner, 'domain_mcp_surfaces');

  const guidance = view(await call('sop_guidance', {}));
  assert.equal(guidance.surface_id, 'sop');

  // Conditional routing and idempotent occurrence admission.
  view(await call('sop_template_create', {
    sop_id: 'conditional-procedure',
    title: 'Conditional procedure',
    input_schema: {
      type: 'object',
      properties: { admitted: { type: 'boolean' }, message_id: { type: 'string' } },
      required: ['admitted', 'message_id'],
      additionalProperties: false,
    },
    steps: [
      { id: 'admission_recorded', executor: 'engine', blocking: false, title: 'Admission recorded', instructions: 'Record {{input.message_id}}.', depends_on: [] },
      {
        id: 'process', executor: 'agent', blocking: true, title: 'Process admitted message', instructions: 'Process {{input.message_id}}.', depends_on: ['admission_recorded'],
        when: { ref: 'input.admitted', op: 'equals', value: true },
        result_schema: { type: 'object', properties: { disposition: { type: 'string' } }, required: ['disposition'], additionalProperties: false },
      },
      {
        id: 'processed_only', executor: 'engine', blocking: false, title: 'Processed-only branch', instructions: 'Record processing.', depends_on: ['process'],
        when: { ref: 'steps.process.status', op: 'equals', value: 'completed' },
      },
      { id: 'finish', executor: 'engine', blocking: false, title: 'Finish', instructions: 'Finish.', depends_on: ['process'] },
    ],
  }));

  const skippedRun = await call('sop_run_start', {
    sop_id: 'conditional-procedure', occurrence_key: 'mail:skip-1', input: { admitted: false, message_id: 'm-skip' }, triggered_by: 'scheduler:mail-admission', trigger_source_kind: 'event', trigger_source_ref: 'mail:m-skip',
  });
  assert.equal(view(skippedRun).status, 'completed');
  assert.equal(steps(skippedRun).find((step) => step.step_id === 'process')?.status, 'skipped');
  assert.equal(steps(skippedRun).find((step) => step.step_id === 'processed_only')?.status, 'skipped');
  assert.equal(steps(skippedRun).find((step) => step.step_id === 'finish')?.status, 'completed');

  const admittedArgs = {
    sop_id: 'conditional-procedure', occurrence_key: 'mail:admit-1', input: { admitted: true, message_id: 'm-1' }, triggered_by: 'scheduler:mail-admission', trigger_source_kind: 'event', trigger_source_ref: 'mail:m-1',
  };
  const admitted = await call('sop_run_start', admittedArgs);
  const admittedRunId = String(view(admitted).run_id);
  assert.equal(view(admitted).admission, 'created');
  assert.equal(view(admitted).status, 'awaiting_confirmation');
  assert.equal((view(admitted).next_steps as JsonRecord[]).length, 1);
  const replayed = await call('sop_run_start', admittedArgs);
  assert.equal(view(replayed).admission, 'replayed');
  assert.equal(view(replayed).run_id, admittedRunId);
  assert.equal(errorCode(await call('sop_run_start', { ...admittedArgs, input: { admitted: true, message_id: 'different' } })), 'sop_occurrence_conflict');

  assert.equal(errorCode(await call('sop_run_advance', {
    run_id: admittedRunId, step_id: 'process', completion_key: 'agent:m-1:done', outcome: 'completed', principal: 'agent:test', result: { wrong: true },
  })), 'sop_step_result_schema_mismatch');
  const completedManual = await call('sop_run_advance', {
    run_id: admittedRunId, step_id: 'process', completion_key: 'agent:m-1:done', outcome: 'completed', principal: 'agent:test', result: { disposition: 'responded' }, result_ref: valueRef,
  });
  assert.equal(view(completedManual).status, 'completed');
  assert.deepEqual(steps(completedManual).find((step) => step.step_id === 'process')?.result, { disposition: 'responded' });
  const completedManualReplay = await call('sop_run_advance', {
    run_id: admittedRunId, step_id: 'process', completion_key: 'agent:m-1:done', outcome: 'completed', principal: 'agent:test', result: { disposition: 'responded' }, result_ref: valueRef,
  });
  assert.equal(view(completedManualReplay).completion_replayed, true);
  assert.equal(errorCode(await call('sop_run_advance', {
    run_id: admittedRunId, step_id: 'process', completion_key: 'different', outcome: 'completed', principal: 'agent:test', result: { disposition: 'responded' }, result_ref: valueRef,
  })), 'sop_step_completion_conflict');

  // Failure receipts are not forced through a success-result schema.
  const failedHandoff = await call('sop_run_start', {
    sop_id: 'conditional-procedure', occurrence_key: 'mail:fail-1', input: { admitted: true, message_id: 'm-fail' }, triggered_by: 'test',
  });
  const failedHandoffResult = await call('sop_run_advance', {
    run_id: String(view(failedHandoff).run_id), step_id: 'process', completion_key: 'agent:m-fail:failed', outcome: 'failed', principal: 'agent:test', result: {}, error_message: 'processing failed',
  });
  assert.equal(view(failedHandoffResult).status, 'failed');

  // Static safety: cycles, non-predecessor reads, and direct commands are refused.
  assert.equal(errorCode(await call('sop_template_create', {
    sop_id: 'cycle', title: 'Cycle', steps: [
      { id: 'a', executor: 'engine', title: 'A', instructions: 'A', depends_on: ['b'] },
      { id: 'b', executor: 'engine', title: 'B', instructions: 'B', depends_on: ['a'] },
    ],
  })), 'sop_dependency_cycle');
  assert.equal(errorCode(await call('sop_template_create', {
    sop_id: 'future-read', title: 'Future read', steps: [
      { id: 'a', executor: 'engine', title: 'A', instructions: 'A', depends_on: [], when: { ref: 'steps.b.status', op: 'equals', value: 'completed' } },
      { id: 'b', executor: 'engine', title: 'B', instructions: 'B', depends_on: ['a'] },
    ],
  })), 'sop_step_reference_not_dependency');
  assert.equal(errorCode(await call('sop_template_create', {
    sop_id: 'command-refused', title: 'Command refused', steps: [
      { id: 'effect', executor: 'engine', title: 'Effect', instructions: 'No.', command: 'node', args: ['-e', 'process.exit(0)'] },
    ],
  })), 'sop_effect_must_be_governed_action');
  assert.equal(errorCode(await call('sop_template_create', {
    sop_id: 'invalid-instruction-reference', title: 'Invalid instruction reference', steps: [
      { id: 'bad', executor: 'engine', title: 'Bad', instructions: 'Read {{unknown.value}}.', depends_on: [] },
    ],
  })), 'sop_reference_invalid');
  assert.equal(errorCode(await call('sop_template_create', {
    sop_id: 'invalid-trigger', title: 'Invalid trigger', trigger_kind: 'draft', steps: [
      { id: 'noop', executor: 'engine', title: 'No-op', instructions: 'No-op.', depends_on: [] },
    ],
  })), 'sop_invalid_trigger_kind');
  assert.equal(errorCode(await call('sop_template_create', {
    sop_id: 'oversized-definition', title: 'Oversized definition', acceptance_criteria: ['x'.repeat(140_000)], steps: [
      { id: 'noop', executor: 'engine', title: 'No-op', instructions: 'No-op.', depends_on: [] },
    ],
  })), 'sop_template_definition_too_large');

  // Governed action outbox: SOP persists exact intent; a domain surface owns the effect.
  view(await call('sop_template_create', {
    sop_id: 'ticket-admission',
    title: 'Create admitted ticket',
    input_schema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'], additionalProperties: false },
    output: { ticket_id: { $ref: 'steps.create_ticket.result.ticket_id' } },
    output_ref: { $ref: 'steps.create_ticket.result_ref' },
    output_schema: { type: 'object', properties: { ticket_id: { type: 'string' } }, required: ['ticket_id'], additionalProperties: false },
    steps: [
      {
        id: 'create_ticket', executor: 'action', blocking: false, title: 'Create ticket', instructions: 'Create one ticket for {{input.message_id}}.', depends_on: [],
        action: {
          surface_id: 'task-lifecycle', tool_name: 'task_create', idempotency_key_argument: 'occurrence_key',
          arguments: { source_message_id: { $ref: 'input.message_id' }, title: 'Admitted email' },
        },
        result_schema: { type: 'object', properties: { ticket_id: { type: 'string' } }, required: ['ticket_id'], additionalProperties: false },
      },
    ],
  }));
  const actionRun = await call('sop_run_start', { sop_id: 'ticket-admission', occurrence_key: 'message:m-action', input: { message_id: 'm-action' }, triggered_by: 'scheduler:mail' });
  const actionRunId = String(view(actionRun).run_id);
  assert.equal(view(actionRun).status, 'running');
  const actionId = String(steps(actionRun)[0].action_id);
  assert.match(actionId, /^soa_/);
  const action = view(await call('sop_action_show', { action_id: actionId }));
  assert.equal(action.status, 'pending');
  assert.equal(action.surface_id, 'task-lifecycle');
  assert.equal(action.tool_name, 'task_create');
  assert.equal((action.arguments as JsonRecord).source_message_id, 'm-action');
  assert.equal((action.arguments as JsonRecord).occurrence_key, action.occurrence_key);
  const actionReplay = await call('sop_run_start', { sop_id: 'ticket-admission', occurrence_key: 'message:m-action', input: { message_id: 'm-action' }, triggered_by: 'scheduler:mail' });
  assert.equal(view(actionReplay).run_id, actionRunId);
  assert.equal(steps(actionReplay)[0].action_id, actionId);

  // Action keys are scoped to the admitted run, not merely caller occurrence/step names.
  view(await call('sop_template_create', {
    sop_id: 'ticket-admission-shadow', title: 'Shadow ticket admission', steps: [{
      id: 'create_ticket', executor: 'action', blocking: false, title: 'Create ticket', instructions: 'Create shadow ticket.', depends_on: [],
      action: { surface_id: 'task-lifecycle', tool_name: 'task_create', idempotency_key_argument: 'occurrence_key', arguments: {} },
    }],
  }));
  const shadowRun = await call('sop_run_start', { sop_id: 'ticket-admission-shadow', occurrence_key: 'message:m-action', triggered_by: 'scheduler:mail' });
  const shadowRunId = String(view(shadowRun).run_id);
  const shadowActionId = String(steps(shadowRun)[0].action_id);
  const shadowAction = view(await call('sop_action_show', { action_id: shadowActionId }));
  assert.notEqual(shadowAction.occurrence_key, action.occurrence_key);

  // Restart with the handoff pending: one intent survives, no duplicate is admitted.
  closeServerState(state);
  state = createServerState({ sopRoot: root, sopsDirs: [sopsDir] });
  const afterRestart = view(await call('sop_action_show', { action_id: actionId }));
  assert.equal(afterRestart.status, 'pending');
  const pending = view(await call('sop_action_list', { run_id: actionRunId, status: 'pending' }));
  assert.equal(pending.count, 1);

  // Cancellation suppresses future dispatch but a late domain receipt is still durably acknowledged.
  assert.equal(view(await call('sop_run_cancel', { run_id: shadowRunId, reason: 'operator stop' })).status, 'cancelled');
  assert.equal(view(await call('sop_action_show', { action_id: shadowActionId })).status, 'cancelled');
  const lateReceipt = view(await call('sop_action_resolve', {
    action_id: shadowActionId,
    completion_key: 'task-lifecycle:late-shadow',
    outcome: 'completed',
    operation_ref: 'task_event:late-shadow',
    result: { ticket_id: 'shadow-ticket' },
  }));
  assert.equal(lateReceipt.status, 'completed');
  assert.equal(lateReceipt.late_cancellation_acknowledgement, true);
  assert.equal((lateReceipt.run as JsonRecord).status, 'cancelled');

  const actionResolvedArgs = {
    action_id: actionId, completion_key: 'task-lifecycle:event-1', outcome: 'completed', operation_ref: 'task_event:evt-1', result: { ticket_id: 'ticket-1' }, result_ref: valueRef,
  };
  const actionResolved = view(await call('sop_action_resolve', actionResolvedArgs));
  assert.equal(actionResolved.status, 'completed');
  assert.equal((actionResolved.run as JsonRecord).status, 'completed');
  const actionRunCompleted = view(await call('sop_run_status', { run_id: actionRunId }));
  assert.deepEqual(actionRunCompleted.output, { ticket_id: 'ticket-1' });
  assert.deepEqual(actionRunCompleted.output_ref, valueRef);
  assert.equal(view(await call('sop_action_resolve', actionResolvedArgs)).completion_replayed, true);
  assert.equal(errorCode(await call('sop_action_resolve', { ...actionResolvedArgs, operation_ref: 'task_event:different' })), 'sop_action_completion_conflict');

  // Persisted action targets and receipts remain fingerprint-bound after restart or direct storage damage.
  const actionIntegrityDb = new DatabaseSync(join(root, '.sop', 'sop.db'));
  const originalArguments = String((actionIntegrityDb.prepare('SELECT arguments_json FROM sop_actions WHERE action_id = ?').get(actionId) as JsonRecord).arguments_json);
  actionIntegrityDb.prepare('UPDATE sop_actions SET arguments_json = ? WHERE action_id = ?').run(JSON.stringify({ title: 'tampered target' }), actionId);
  assert.equal(errorCode(await call('sop_action_show', { action_id: actionId })), 'sop_action_request_fingerprint_mismatch');
  actionIntegrityDb.prepare('UPDATE sop_actions SET arguments_json = ? WHERE action_id = ?').run(originalArguments, actionId);
  actionIntegrityDb.close();

  // Once a domain operation is acknowledged, downstream validation failure fails the run but never forgets that acknowledgement.
  view(await call('sop_template_create', {
    sop_id: 'action-result-guard', title: 'Action result guard', steps: [{
      id: 'effect', executor: 'action', blocking: false, title: 'Effect', instructions: 'Effect.', depends_on: [],
      action: { surface_id: 'task-lifecycle', tool_name: 'task_create', idempotency_key_argument: 'occurrence_key', arguments: {} },
      result_schema: { type: 'object', properties: { ticket_id: { type: 'string' } }, required: ['ticket_id'], additionalProperties: false },
    }],
  }));
  const guardedRun = await call('sop_run_start', { sop_id: 'action-result-guard', occurrence_key: 'guard:1', triggered_by: 'test' });
  const guardedRunId = String(view(guardedRun).run_id);
  const guardedActionId = String(steps(guardedRun)[0].action_id);
  const guardedResolution = { action_id: guardedActionId, completion_key: 'guard-op:1', outcome: 'completed', operation_ref: 'task_event:guard-1', result: { wrong: true } };
  const guardedResolved = view(await call('sop_action_resolve', guardedResolution));
  assert.equal(guardedResolved.status, 'completed');
  assert.equal((guardedResolved.run as JsonRecord).status, 'failed');
  assert.equal(view(await call('sop_action_show', { action_id: guardedActionId })).status, 'completed');
  assert.equal(view(await call('sop_action_resolve', guardedResolution)).completion_replayed, true);

  // An acknowledged action result that would overflow aggregate run state is retained in the action ledger; the run fails compactly instead of wedging reconciliation.
  const pressureSteps = Array.from({ length: 10 }, (_, index) => ({
    id: `effect_${index}`,
    executor: 'action',
    blocking: false,
    title: `Effect ${index}`,
    instructions: `Run effect ${index}.`,
    depends_on: index === 0 ? [] : [`effect_${index - 1}`],
    action: { surface_id: 'task-lifecycle', tool_name: 'task_create', idempotency_key_argument: 'occurrence_key', arguments: { index } },
  }));
  view(await call('sop_template_create', { sop_id: 'aggregate-result-pressure', title: 'Aggregate result pressure', steps: pressureSteps }));
  let pressureRun = view(await call('sop_run_start', { sop_id: 'aggregate-result-pressure', occurrence_key: 'pressure:1', triggered_by: 'test' }));
  let pressureResolution: JsonRecord | null = null;
  for (let index = 0; index < pressureSteps.length && pressureRun.status === 'running'; index += 1) {
    const pendingActions = view(await call('sop_action_list', { run_id: String(pressureRun.run_id), status: 'pending' })).items as JsonRecord[];
    assert.equal(pendingActions.length, 1);
    pressureResolution = view(await call('sop_action_resolve', {
      action_id: String(pendingActions[0].action_id),
      completion_key: `pressure:${index}`,
      outcome: 'completed',
      operation_ref: `task_event:pressure-${index}`,
      result: { blob: 'x'.repeat(15_500) },
    }));
    pressureRun = pressureResolution.run as JsonRecord;
  }
  assert.ok(pressureResolution);
  assert.equal(pressureRun.status, 'failed');
  assert.equal((pressureResolution.reconciliation as JsonRecord).status, 'completed');
  const overflowStep = (pressureRun.step_states as JsonRecord[]).find((step) => String(step.error_message ?? '').includes('sop_run_state_too_large'));
  assert.ok(overflowStep);
  assert.equal(overflowStep.inline_result_omitted, undefined);
  assert.equal((overflowStep.result as JsonRecord).inline_result_omitted, true);
  assert.equal(view(await call('sop_action_show', { action_id: String(overflowStep.action_id) })).status, 'completed');

  // Child SOP version is pinned before its dependency becomes ready; child completion auto-advances the parent.
  view(await call('sop_template_create', {
    sop_id: 'child-procedure', title: 'Child v1',
    output: { disposition: { $ref: 'steps.confirm.result.disposition' } },
    output_ref: { $ref: 'steps.confirm.result_ref' },
    steps: [{ id: 'confirm', executor: 'operator', blocking: true, title: 'Confirm', instructions: 'Confirm.', depends_on: [], result_schema: { type: 'object', properties: { disposition: { type: 'string' } }, required: ['disposition'], additionalProperties: false } }],
  }));
  view(await call('sop_template_create', {
    sop_id: 'parent-procedure', title: 'Parent',
    output: { child: { $ref: 'steps.child.result.output' } },
    output_ref: { $ref: 'steps.child.result_ref' },
    steps: [
      { id: 'gate', executor: 'operator', blocking: true, title: 'Gate', instructions: 'Open gate.', depends_on: [] },
      { id: 'child', executor: 'sop', blocking: false, title: 'Child', instructions: 'Run child.', depends_on: ['gate'], sop_id: 'child-procedure', input: { source: { $ref: 'input.source' } }, wait_policy: 'wait' },
      { id: 'done', executor: 'engine', blocking: false, title: 'Done', instructions: 'Done.', depends_on: ['child'] },
    ],
  }));
  const parent = await call('sop_run_start', { sop_id: 'parent-procedure', occurrence_key: 'parent:1', input: { source: 'fixture' }, triggered_by: 'test' });
  const parentRunId = String(view(parent).run_id);
  assert.equal(steps(parent).find((step) => step.step_id === 'child')?.sop_version, 1);
  const childPins = ((view(parent).definition_snapshot as JsonRecord).child_pins as JsonRecord[]);
  assert.equal(childPins[0].sop_version, 1);
  assert.match(String(childPins[0].definition_fingerprint), /^[a-f0-9]{64}$/);
  assert.equal(errorCode(await call('sop_template_unimport', { sop_id: 'child-procedure', version: 1, reason: 'must remain pinned', principal: 'test' })), 'sop_template_has_runs');
  view(await call('sop_template_update', { sop_id: 'child-procedure', title: 'Child v2' }));
  const gateCompleted = await call('sop_run_advance', { run_id: parentRunId, step_id: 'gate', completion_key: 'gate:1', outcome: 'completed', principal: 'operator:test', result: {} });
  const childStep = steps(gateCompleted).find((step) => step.step_id === 'child');
  assert.equal(childStep?.status, 'running');
  const childRunId = String(childStep?.child_run_id);
  const childRun = view(await call('sop_run_status', { run_id: childRunId }));
  assert.equal(childRun.sop_version, 1);
  assert.equal(childRun.parent_run_id, parentRunId);
  await call('sop_run_advance', { run_id: childRunId, step_id: 'confirm', completion_key: 'child:1', outcome: 'completed', principal: 'operator:test', result: { disposition: 'respond' }, result_ref: valueRef });
  const parentCompleted = view(await call('sop_run_status', { run_id: parentRunId }));
  assert.equal(parentCompleted.status, 'completed');
  assert.deepEqual(parentCompleted.output, { child: { disposition: 'respond' } });
  assert.deepEqual(parentCompleted.output_ref, valueRef);
  assert.equal((parentCompleted.relationship_reconciliation as JsonRecord).mode, 'automatic');

  // Large inline state is refused in favor of immutable references.
  view(await call('sop_template_create', {
    sop_id: 'bounded-result', title: 'Bounded result', steps: [{ id: 'record', executor: 'agent', blocking: true, title: 'Record', instructions: 'Record.', depends_on: [] }],
  }));
  const boundedRun = view(await call('sop_run_start', { sop_id: 'bounded-result', occurrence_key: 'bounded:1', triggered_by: 'test' }));
  assert.equal(errorCode(await call('sop_run_advance', {
    run_id: String(boundedRun.run_id), step_id: 'record', completion_key: 'large', outcome: 'completed', principal: 'agent:test', result: { blob: 'x'.repeat(20_000) },
  })), 'sop_result_too_large');
  assert.equal(view(await call('sop_run_advance', {
    run_id: String(boundedRun.run_id), step_id: 'record', completion_key: 'ref', outcome: 'completed', principal: 'agent:test', result: { summary: 'stored externally' }, result_ref: valueRef,
  })).status, 'completed');

  // YAML import uses the same v2 contract.
  writeFileSync(join(sopsDir, 'yaml-v2.sop.yaml'), `
sop_id: yaml-v2
title: YAML v2
status: active
steps:
  - id: decide
    executor: engine
    blocking: false
    title: Decide
    instructions: Decide.
    when:
      ref: input.enabled
      op: equals
      value: true
`.trim() + '\n', 'utf8');
  assert.equal(view(await call('sop_template_import_yaml', { sop_id: 'yaml-v2' })).status, 'created');
  assert.equal((view(await call('sop_template_show', { sop_id: 'yaml-v2' })).steps as JsonRecord[])[0].when !== null, true);

  // Startup reconciles each valid run independently and reports a corrupt pinned definition without hiding it.
  const integrityDb = new DatabaseSync(join(root, '.sop', 'sop.db'));
  const pinnedRow = integrityDb.prepare('SELECT definition_json FROM sop_runs WHERE run_id = ?').get(actionRunId) as JsonRecord;
  const tamperedDefinition = JSON.parse(String(pinnedRow.definition_json)) as JsonRecord;
  tamperedDefinition.title = 'tampered after admission';
  integrityDb.prepare("UPDATE sop_runs SET status = 'pending', completed_at = NULL, definition_json = ? WHERE run_id = ?").run(JSON.stringify(tamperedDefinition), actionRunId);
  const guardedStepStates = JSON.parse(String((integrityDb.prepare('SELECT step_states_json FROM sop_runs WHERE run_id = ?').get(guardedRunId) as JsonRecord).step_states_json)) as JsonRecord[];
  guardedStepStates[0].title = 'tampered execution snapshot';
  integrityDb.prepare("UPDATE sop_runs SET status = 'pending', completed_at = NULL, step_states_json = ? WHERE run_id = ?").run(JSON.stringify(guardedStepStates), guardedRunId);
  integrityDb.prepare("UPDATE sop_runs SET status = 'pending', completed_at = NULL WHERE run_id = ?").run(String(boundedRun.run_id));
  integrityDb.close();
  closeServerState(state);
  state = createServerState({ sopRoot: root, sopsDirs: [sopsDir] });
  const startupDoctor = view(await call('sop_doctor', {}));
  assert.equal((startupDoctor.startup_reconciliation as JsonRecord).status, 'partial');
  assert.equal((startupDoctor.startup_reconciliation as JsonRecord).error_count, 2);
  assert.equal(view(await call('sop_run_status', { run_id: String(boundedRun.run_id) })).status, 'completed');
  assert.equal(errorCode(await call('sop_run_status', { run_id: actionRunId })), 'sop_definition_fingerprint_mismatch');
  assert.equal(errorCode(await call('sop_run_status', { run_id: guardedRunId })), 'sop_run_step_definition_mismatch');

  console.log('sop-mcp behavior ok');
} finally {
  closeServerState(state);
  rmSync(root, { recursive: true, force: true });
}
