import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonRecord } from '@narada-core/mcp-runtime-client';
import {
  runSopActionDispatcher,
  type SopActionFabricCaller,
} from '../src/action-dispatcher.js';

const action: JsonRecord = {
  schema: 'narada.sop.action.v1',
  action_id: 'action-1',
  run_id: 'run-1',
  step_id: 'sync',
  occurrence_key: 'sop_action_occurrence_1',
  surface_id: 'mailbox',
  tool_name: 'mailbox_sync_generation',
  arguments: { generation_key: 'sop_action_occurrence_1' },
  status: 'pending',
};

type Call = { surface: string; tool: string; args: JsonRecord };

class ActionFabric implements SopActionFabricCaller {
  calls: Call[] = [];
  action: JsonRecord = action;
  domainResult: JsonRecord = {
    schema: 'narada.domain_operation.v1',
    operation_ref: 'mailbox-sync:1',
    outcome: 'completed',
    result: { generation_id: 'generation-1' },
  };
  failResolution = false;

  async call(surface: string, tool: string, args: JsonRecord = {}): Promise<JsonRecord> {
    this.calls.push({ surface, tool, args });
    if (tool === 'sop_action_list') return { items: [{ action_id: 'action-1' }], count: 1 };
    if (tool === 'sop_action_show') return this.action;
    if (surface === this.action.surface_id && tool === this.action.tool_name) return this.domainResult;
    if (tool === 'sop_action_resolve') {
      if (this.failResolution) throw new Error('lost_after_domain_commit');
      return { schema: 'narada.sop.action.v1', status: 'completed' };
    }
    throw new Error(`unexpected_tool:${surface}:${tool}`);
  }
}

const options = { siteRoot: 'D:\\site', maxActions: 10 };

test('dispatches only the persisted target and resolves from a typed domain operation receipt', async () => {
  const fabric = new ActionFabric();
  const report = await runSopActionDispatcher(options, fabric);
  assert.equal(report.status, 'completed');
  assert.equal(report.actions_resolved, 1);
  const domain = fabric.calls.find((call) => call.surface === 'mailbox')!;
  assert.equal(domain.tool, 'mailbox_sync_generation');
  assert.deepEqual(domain.args, { generation_key: 'sop_action_occurrence_1' });
  const resolve = fabric.calls.find((call) => call.tool === 'sop_action_resolve')!;
  assert.equal(resolve.args.completion_key, 'mailbox-sync:1');
  assert.equal(resolve.args.operation_ref, 'mailbox-sync:1');
  assert.deepEqual(resolve.args.result, { generation_id: 'generation-1' });
});

test('refuses untyped domain output and leaves the SOP action pending', async () => {
  const fabric = new ActionFabric();
  fabric.domainResult = { status: 'ok', generation_id: 'generation-1' };
  const report = await runSopActionDispatcher(options, fabric);
  assert.equal(report.status, 'completed_with_errors');
  assert.equal(report.actions_resolved, 0);
  assert.match(String(report.errors[0]?.error), /domain_operation_schema_invalid/);
  assert.equal(fabric.calls.some((call) => call.tool === 'sop_action_resolve'), false);
});

test('replays the same idempotent domain request after loss between effect and SOP acknowledgement', async () => {
  const fabric = new ActionFabric();
  fabric.failResolution = true;
  const first = await runSopActionDispatcher(options, fabric);
  assert.equal(first.actions_resolved, 0);

  fabric.failResolution = false;
  const second = await runSopActionDispatcher(options, fabric);
  assert.equal(second.actions_resolved, 1);
  const domainCalls = fabric.calls.filter((call) => call.surface === 'mailbox');
  assert.equal(domainCalls.length, 2);
  assert.deepEqual(domainCalls[0]!.args, domainCalls[1]!.args);
});

test('records a typed terminal domain failure as the SOP action outcome', async () => {
  const fabric = new ActionFabric();
  fabric.domainResult = {
    schema: 'narada.domain_operation.v1',
    operation_ref: 'mailbox-sync:failed-1',
    outcome: 'failed',
    result: {},
    error_message: 'mailbox_generation_rejected',
  };
  const report = await runSopActionDispatcher(options, fabric);
  assert.equal(report.status, 'completed');
  const resolve = fabric.calls.find((call) => call.tool === 'sop_action_resolve')!;
  assert.equal(resolve.args.outcome, 'failed');
  assert.equal(resolve.args.error_message, 'mailbox_generation_rejected');
});

test('fails closed when a completed domain operation omits its result', async () => {
  const fabric = new ActionFabric();
  fabric.domainResult = {
    schema: 'narada.domain_operation.v1',
    operation_ref: 'mailbox-sync:missing-result',
    outcome: 'completed',
  };
  const report = await runSopActionDispatcher(options, fabric);
  assert.equal(report.status, 'completed_with_errors');
  assert.match(String(report.errors[0]?.error), /domain_operation_result_missing/);
  assert.equal(fabric.calls.some((call) => call.tool === 'sop_action_resolve'), false);
});

test('fails closed when a completed domain operation exceeds the inline result bound without a reference', async () => {
  const fabric = new ActionFabric();
  fabric.domainResult = {
    schema: 'narada.domain_operation.v1',
    operation_ref: 'mailbox-sync:oversized-without-ref',
    outcome: 'completed',
    result: { generation_id: 'generation-1', observed_message_refs: ['x'.repeat(17_000)] },
  };
  const report = await runSopActionDispatcher(options, fabric);
  assert.equal(report.status, 'completed_with_errors');
  assert.match(String(report.errors[0]?.error), /domain_operation_result_too_large_without_ref/);
  assert.equal(fabric.calls.some((call) => call.tool === 'sop_action_resolve'), false);
});

test('preserves a bounded result, domain operation_ref, and immutable result_ref', async () => {
  const fabric = new ActionFabric();
  const resultRef = {
    ref: 'mailbox-generation-receipt:generation-1',
    sha256: 'a'.repeat(64),
    byte_length: 90_081,
    media_type: 'application/json',
  };
  fabric.domainResult = {
    schema: 'narada.domain_operation.v1',
    operation_ref: 'mailbox-sync:generation-1',
    outcome: 'completed',
    result: {
      schema: 'narada.mailbox.sync_generation_receipt.v1',
      generation_id: 'generation-1',
      status: 'no_change',
      observed_message_refs_omitted: true,
    },
    result_ref: resultRef,
  };
  const report = await runSopActionDispatcher(options, fabric);
  assert.equal(report.status, 'completed');
  const resolve = fabric.calls.find((call) => call.tool === 'sop_action_resolve')!;
  assert.equal(resolve.args.completion_key, 'mailbox-sync:generation-1');
  assert.equal(resolve.args.operation_ref, 'mailbox-sync:generation-1');
  assert.deepEqual(resolve.args.result_ref, resultRef);
  assert.deepEqual(resolve.args.result, fabric.domainResult.result);
});

test('fails closed when a Graph draft receipt is incomplete', async () => {
  const fabric = new ActionFabric();
  fabric.action = {
    ...action,
    surface_id: 'graph-mail',
    tool_name: 'graph_mail_ticket_draft_upsert',
  };
  fabric.domainResult = {
    schema: 'narada.domain_operation.v1',
    operation_ref: 'graph-mail-ticket-draft:incomplete',
    outcome: 'completed',
    result: {
      schema: 'narada.graph_mail.ticket_draft_receipt.v1',
      receipt_id: 'receipt-1',
      draft_ref: { draft_id: 'draft-1' },
    },
  };
  const report = await runSopActionDispatcher(options, fabric);
  assert.equal(report.status, 'completed_with_errors');
  assert.match(String(report.errors[0]?.error), /domain_operation_draft_id_missing/);
  assert.equal(fabric.calls.some((call) => call.tool === 'sop_action_resolve'), false);
});
