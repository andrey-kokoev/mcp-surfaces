import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonRecord } from '@narada-core/mcp-runtime-client';
import {
  completeSopOperatorHandoff,
  runSopAgentHandoffConsumerPass,
  type SopHandoffFabricCaller,
} from '../src/handoff-consumer.js';

type Call = { surface: string; tool: string; args: JsonRecord };

function handoff(executor: 'agent' | 'operator'): JsonRecord {
  return {
    schema: 'narada.sop.handoff.v1',
    handoff_id: `handoff-${executor}-1`,
    run_id: 'sop-run-1',
    step_id: `${executor}-step`,
    occurrence_key: `sop_handoff_${executor}_1`,
    sop_id: 'ticket-process',
    sop_version: 1,
    executor,
    title: `${executor} decision`,
    instructions: 'Choose a typed disposition from the supplied evidence.',
    input: { ticket_id: 'ticket-1' },
    input_ref: null,
    result_schema: {
      type: 'object',
      properties: { decision: { type: 'string' } },
      required: ['decision'],
      additionalProperties: false,
    },
    status: 'pending',
    lease_owner: null,
    lease_token: null,
    completion_key: null,
    principal: null,
    result: {},
    result_ref: null,
    error_message: null,
  };
}

class HandoffFabric implements SopHandoffFabricCaller {
  calls: Call[] = [];
  record: JsonRecord;
  claimable = true;
  leaseCounter = 0;
  throwAfterAdvanceCommit = false;
  worker: JsonRecord = {
    schema: 'narada.worker.run.v1',
    status: 'running',
    run_id: 'worker-run-1',
    idempotency_replayed: false,
  };

  constructor(executor: 'agent' | 'operator') {
    this.record = handoff(executor);
  }

  expireLease(): void {
    if (this.record.status === 'leased') {
      this.record = { ...this.record, status: 'pending', lease_owner: null, lease_token: null };
      this.claimable = true;
    }
  }

  async call(surface: string, tool: string, args: JsonRecord = {}): Promise<JsonRecord> {
    this.calls.push({ surface, tool, args });
    if (tool === 'sop_handoff_show') return { ...this.record };
    if (tool === 'sop_handoff_claim') {
      if (!this.claimable || this.record.status !== 'pending') {
        return { schema: 'narada.sop.handoff_claim.v1', status: 'empty', handoff: null };
      }
      if (args.executor !== this.record.executor) return { schema: 'narada.sop.handoff_claim.v1', status: 'empty', handoff: null };
      if (args.handoff_id && args.handoff_id !== this.record.handoff_id) return { schema: 'narada.sop.handoff_claim.v1', status: 'empty', handoff: null };
      this.claimable = false;
      this.leaseCounter += 1;
      this.record = {
        ...this.record,
        status: 'leased',
        lease_owner: args.consumer_id,
        lease_token: `lease-${this.leaseCounter}`,
      };
      return { schema: 'narada.sop.handoff_claim.v1', status: 'claimed', handoff: { ...this.record } };
    }
    if (tool === 'worker_run') return { ...this.worker };
    if (tool === 'sop_handoff_release') {
      if (this.record.status !== 'leased') throw new Error('handoff_not_leased');
      this.record = { ...this.record, status: 'pending', lease_owner: null, lease_token: null, last_error: args.error_message };
      this.claimable = true;
      return { ...this.record };
    }
    if (tool === 'sop_run_advance') {
      if (this.record.status !== 'leased') throw new Error('handoff_not_leased');
      this.record = {
        ...this.record,
        status: args.outcome,
        lease_owner: null,
        lease_token: null,
        completion_key: args.completion_key,
        principal: args.principal,
        result: args.result,
        result_ref: args.result_ref ?? null,
        error_message: args.error_message ?? null,
      };
      if (this.throwAfterAdvanceCommit) throw new Error('lost_after_sop_commit');
      return { schema: 'narada.sop.run.v2', status: args.outcome, handoff: { ...this.record }, completion_replayed: false };
    }
    throw new Error(`unexpected_tool:${surface}:${tool}`);
  }
}

const agentOptions = {
  siteRoot: 'D:\\site',
  invocationPlanRef: 'invocation-plan:test',
  requiredMcpTools: ['work_lifecycle_ticket_show', 'mailbox_message_show'],
  maxHandoffs: 1,
};

test('agent handoff survives a consumer boundary and reuses one idempotent worker run', async () => {
  const fabric = new HandoffFabric('agent');
  const first = await runSopAgentHandoffConsumerPass(agentOptions, fabric);
  assert.equal(first.status, 'completed');
  assert.equal(first.handoffs_deferred, 1);
  const firstWorkerCall = fabric.calls.find((call) => call.tool === 'worker_run')!;
  assert.equal(firstWorkerCall.args.idempotency_key, 'sop_handoff_agent_1');
  assert.equal((firstWorkerCall.args.constraints as JsonRecord).authority, 'read');
  assert.equal((firstWorkerCall.args.constraints as JsonRecord).invocation_plan_ref, 'invocation-plan:test');
  assert.equal(((firstWorkerCall.args.intent as JsonRecord).output_contract as JsonRecord).structured_output_key, 'sop_handoff_result');

  fabric.expireLease();
  fabric.worker = {
    schema: 'narada.worker.run.v1',
    status: 'completed',
    run_id: 'worker-run-1',
    idempotency_replayed: true,
    structured_outputs: { sop_handoff_result: { decision: 'draft' } },
  };
  const second = await runSopAgentHandoffConsumerPass(agentOptions, fabric);
  assert.equal(second.status, 'completed');
  assert.equal(second.handoffs_completed, 1);
  assert.equal(second.worker_runs_replayed, 1);
  const workerCalls = fabric.calls.filter((call) => call.tool === 'worker_run');
  assert.equal(workerCalls.length, 2);
  assert.deepEqual(workerCalls[0]!.args, workerCalls[1]!.args);
  const advance = fabric.calls.find((call) => call.tool === 'sop_run_advance')!;
  assert.equal(advance.args.completion_key, 'worker:worker-run-1');
  assert.equal(advance.args.lease_token, 'lease-2');
  assert.deepEqual(advance.args.result, { decision: 'draft' });
});

test('terminal worker output that violates the handoff contract fails the SOP step instead of spinning', async () => {
  const fabric = new HandoffFabric('agent');
  fabric.worker = {
    schema: 'narada.worker.run.v1',
    status: 'completed',
    run_id: 'worker-run-invalid',
    idempotency_replayed: false,
    structured_outputs: { sop_handoff_result: { wrong: true } },
  };
  const report = await runSopAgentHandoffConsumerPass(agentOptions, fabric);
  assert.equal(report.status, 'completed');
  assert.equal(report.handoffs_failed, 1);
  const advance = fabric.calls.find((call) => call.tool === 'sop_run_advance')!;
  assert.equal(advance.args.outcome, 'failed');
  assert.match(String(advance.args.error_message), /schema_mismatch/);
  assert.equal((advance.args.result as JsonRecord).failure_kind, 'result_contract_invalid');
});

test('loss after SOP completion does not launch or complete the agent handoff twice', async () => {
  const fabric = new HandoffFabric('agent');
  fabric.worker = {
    schema: 'narada.worker.run.v1',
    status: 'completed',
    run_id: 'worker-run-commit-gap',
    idempotency_replayed: true,
    structured_outputs: { sop_handoff_result: { decision: 'resolved' } },
  };
  fabric.throwAfterAdvanceCommit = true;
  const first = await runSopAgentHandoffConsumerPass(agentOptions, fabric);
  assert.equal(first.status, 'completed_with_errors');
  fabric.throwAfterAdvanceCommit = false;
  const second = await runSopAgentHandoffConsumerPass(agentOptions, fabric);
  assert.equal(second.handoffs_claimed, 0);
  assert.equal(fabric.calls.filter((call) => call.tool === 'worker_run').length, 1);
  assert.equal(fabric.calls.filter((call) => call.tool === 'sop_run_advance').length, 1);
});

test('operator completion claims one exact handoff and replays after response loss', async () => {
  const fabric = new HandoffFabric('operator');
  const options = {
    siteRoot: 'D:\\site',
    handoffId: 'handoff-operator-1',
    principal: 'operator:andrey',
    outcome: 'completed' as const,
    completionKey: 'operator-decision:ticket-1',
    result: { decision: 'approve' },
  };
  fabric.throwAfterAdvanceCommit = true;
  await assert.rejects(() => completeSopOperatorHandoff(options, fabric), /lost_after_sop_commit/);
  fabric.throwAfterAdvanceCommit = false;
  const replay = await completeSopOperatorHandoff(options, fabric);
  assert.equal(replay.completion_replayed, true);
  const claims = fabric.calls.filter((call) => call.tool === 'sop_handoff_claim');
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.args.handoff_id, 'handoff-operator-1');
  assert.equal(fabric.calls.filter((call) => call.tool === 'sop_run_advance').length, 1);
});
