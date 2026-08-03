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
  activeWorkerRuns: JsonRecord[] = [];
  reapedWorkerRuns: string[] = [];
  worker: JsonRecord = {
    schema: 'narada.worker.run.v1',
    status: 'running',
    run_id: 'worker-run-1',
    idempotency_replayed: false,
    idempotency_key: 'sop_handoff_agent_1',
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
        attempt_count: Number(this.record.attempt_count ?? 0) + 1,
      };
      return { schema: 'narada.sop.handoff_claim.v1', status: 'claimed', handoff: { ...this.record } };
    }
    if (tool === 'worker_runs_list') {
      return {
        schema: 'narada.worker.runs_list.v1',
        status: 'ok',
        count: this.activeWorkerRuns.length,
        runs: this.activeWorkerRuns,
      };
    }
    if (tool === 'worker_run_reap') {
      const runId = String(args.run_id);
      this.reapedWorkerRuns.push(runId);
      this.activeWorkerRuns = this.activeWorkerRuns.filter((run) => run.run_id !== runId);
      return { schema: 'narada.worker.run_reap.v1', status: 'reaped', run_id: runId, reaped: true };
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
  leaseMs: 60_000,
  maxRunMs: 120_000,
  requestTimeoutMs: 15_000,
};

test('agent handoff survives a consumer boundary and reuses one idempotent worker run', async () => {
  const fabric = new HandoffFabric('agent');
  const first = await runSopAgentHandoffConsumerPass(agentOptions, fabric);
  assert.equal(first.status, 'completed');
  assert.equal(first.handoffs_deferred, 1);
  const firstWorkerCall = fabric.calls.find((call) => call.tool === 'worker_run')!;
  const firstClaim = fabric.calls.find((call) => call.tool === 'sop_handoff_claim')!;
  assert.equal(firstClaim.args.lease_ms, 140_000);
  assert.equal(firstWorkerCall.args.idempotency_key, 'sop_handoff_agent_1');
  assert.equal((firstWorkerCall.args.constraints as JsonRecord).authority, 'read');
  assert.equal((firstWorkerCall.args.constraints as JsonRecord).invocation_plan_ref, 'invocation-plan:test');
  assert.equal((firstWorkerCall.args.constraints as JsonRecord).wait_for_completion, true);
  assert.equal(((firstWorkerCall.args.intent as JsonRecord).output_contract as JsonRecord).structured_output_key, 'sop_handoff_result');
  assert.match(String(fabric.record.last_error), /^worker_in_flight:/);
  fabric.worker = {
    schema: 'narada.worker.run.v1',
    status: 'completed',
    run_id: 'worker-run-1',
    idempotency_replayed: true,
    idempotency_key: 'sop_handoff_agent_1',
    structured_outputs: { sop_handoff_result: { decision: 'draft' } },
  };
  const second = await runSopAgentHandoffConsumerPass(agentOptions, fabric);
  assert.equal(second.status, 'completed');
  assert.equal(second.handoffs_completed, 1);
  assert.equal(second.worker_runs_replayed, 1);
  const workerCalls = fabric.calls.filter((call) => call.tool === 'worker_run');
  assert.equal(workerCalls.length, 2);
  assert.equal(workerCalls[0]!.args.idempotency_key, workerCalls[1]!.args.idempotency_key);
  const advance = fabric.calls.find((call) => call.tool === 'sop_run_advance')!;
  assert.equal(advance.args.completion_key, 'worker:worker-run-1');
  assert.equal(advance.args.lease_token, 'lease-2');
  assert.deepEqual(advance.args.result, { decision: 'draft' });
});

test('agent pass defers before claiming while another worker run is live', async () => {
  const fabric = new HandoffFabric('agent');
  fabric.activeWorkerRuns = [{
    run_id: 'run-live',
    status: 'running',
    status_liveness: { state: 'active', stale_for_ms: 0, stale_after_ms: 60_000 },
  }];
  const report = await runSopAgentHandoffConsumerPass(agentOptions, fabric);
  assert.equal(report.status, 'completed');
  assert.equal(report.handoffs_claimed, 0);
  assert.equal(report.handoffs_deferred, 1);
  assert.equal(report.worker_runs_blocked, 1);
  assert.equal(fabric.calls.some((call) => call.tool === 'sop_handoff_claim'), false);
  assert.equal(fabric.calls.some((call) => call.tool === 'worker_run'), false);
});

test('agent pass reaps a sufficiently stale run before claiming work', async () => {
  const fabric = new HandoffFabric('agent');
  fabric.activeWorkerRuns = [{
    run_id: 'run-stale',
    status: 'running',
    status_liveness: { state: 'stale', stale_for_ms: 120_000, stale_after_ms: 60_000 },
  }];
  fabric.worker = {
    schema: 'narada.worker.run.v1',
    status: 'completed',
    run_id: 'worker-run-recovered',
    idempotency_replayed: false,
    idempotency_key: 'sop_handoff_agent_1',
    structured_outputs: { sop_handoff_result: { decision: 'recovered' } },
  };
  const report = await runSopAgentHandoffConsumerPass(agentOptions, fabric);
  assert.equal(report.status, 'completed');
  assert.equal(report.worker_runs_reaped, 1);
  assert.deepEqual(fabric.reapedWorkerRuns, ['run-stale']);
  assert.equal(report.handoffs_claimed, 1);
  assert.equal(report.handoffs_completed, 1);
});

test('terminal worker output that violates the handoff contract fails the SOP step instead of spinning', async () => {
  const fabric = new HandoffFabric('agent');
  fabric.worker = {
    schema: 'narada.worker.run.v1',
    status: 'completed',
    run_id: 'worker-run-invalid',
    idempotency_replayed: false,
    idempotency_key: 'sop_handoff_agent_1',
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

test('worker runtime failure releases the handoff for a fresh idempotent attempt', async () => {
  const fabric = new HandoffFabric('agent');
  fabric.worker = {
    schema: 'narada.worker.run.v1',
    status: 'failed',
    run_id: 'worker-run-failed',
    idempotency_replayed: false,
    idempotency_key: 'sop_handoff_agent_1',
    error: 'worker runtime exited with code 1',
  };
  const report = await runSopAgentHandoffConsumerPass(agentOptions, fabric);
  assert.equal(report.status, 'completed');
  assert.equal(report.handoffs_deferred, 1);
  assert.equal(fabric.calls.some((call) => call.tool === 'sop_run_advance'), false);
  const release = fabric.calls.find((call) => call.tool === 'sop_handoff_release')!;
  assert.match(String(release.args.error_message), /^worker_retryable:/);
});

test('loss after SOP completion does not launch or complete the agent handoff twice', async () => {
  const fabric = new HandoffFabric('agent');
  fabric.worker = {
    schema: 'narada.worker.run.v1',
    status: 'completed',
    run_id: 'worker-run-commit-gap',
    idempotency_replayed: true,
    idempotency_key: 'sop_handoff_agent_1',
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
