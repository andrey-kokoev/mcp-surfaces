import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada-core/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'sop-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--sop-root', root], { label: 'sop-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'sop-mcp' });
  const tools = protocol.tools.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] }; annotations: Record<string, unknown> }>;
  const expectedTools = [
    'sop_guidance',
    'sop_doctor',
    'sop_template_create',
    'sop_template_show',
    'sop_template_export',
    'sop_template_list',
    'sop_template_search',
    'sop_template_candidate_list',
    'sop_template_candidate_show',
    'sop_template_update',
    'sop_template_deprecate',
    'sop_template_unimport',
    'sop_template_import_yaml',
    'sop_run_start',
    'sop_run_status',
    'sop_run_refresh',
    'sop_run_advance',
    'sop_handoff_list',
    'sop_handoff_show',
    'sop_handoff_claim',
    'sop_handoff_renew',
    'sop_handoff_release',
    'sop_action_list',
    'sop_action_show',
    'sop_action_resolve',
    'sop_run_list',
    'sop_run_coverage_since',
    'sop_run_cancel',
    'sop_run_events',
    'sop_outbox_consumer_register',
    'sop_outbox_list',
    'sop_outbox_ack',
    'sop_outbox_compact',
  ];
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), expectedTools);

  const createTool = tools.find((tool) => tool.name === 'sop_template_create')!;
  assert.equal(createTool.annotations.readOnlyHint, false);

  const showTool = tools.find((tool) => tool.name === 'sop_template_show')!;
  assert.equal(showTool.annotations.readOnlyHint, true);
  assert.ok(showTool.inputSchema.properties.sop_id);

  const runTool = tools.find((tool) => tool.name === 'sop_run_start')!;
  assert.equal(runTool.annotations.readOnlyHint, false);
  assert.ok(runTool.inputSchema.properties.sop_id);
  assert.ok(runTool.inputSchema.properties.occurrence_key);
  assert.ok(runTool.inputSchema.properties.input);
  assert.ok(runTool.inputSchema.properties.input_ref);
  assert.ok(runTool.inputSchema.properties.triggered_by);
  assert.equal(runTool.annotations.idempotentHint, true);
  assert.equal(runTool.inputSchema.required?.includes('occurrence_key'), true);

  const advanceTool = tools.find((tool) => tool.name === 'sop_run_advance')!;
  assert.ok(advanceTool.inputSchema.properties.handoff_id);
  assert.ok(advanceTool.inputSchema.properties.run_id);
  assert.ok(advanceTool.inputSchema.properties.step_id);
  assert.ok(advanceTool.inputSchema.properties.consumer_id);
  assert.ok(advanceTool.inputSchema.properties.lease_token);
  assert.ok(advanceTool.inputSchema.properties.result);
  assert.ok(advanceTool.inputSchema.properties.result_ref);
  assert.ok(advanceTool.inputSchema.properties.completion_key);
  assert.ok(advanceTool.inputSchema.properties.outcome);
  assert.ok(advanceTool.inputSchema.properties.principal);
  assert.equal(advanceTool.inputSchema.required?.includes('lease_token'), true);

  const handoffClaimTool = tools.find((tool) => tool.name === 'sop_handoff_claim')!;
  assert.ok(handoffClaimTool.inputSchema.properties.consumer_id);
  assert.ok(handoffClaimTool.inputSchema.properties.lease_ms);
  assert.equal(handoffClaimTool.annotations.readOnlyHint, false);

  const outboxListTool = tools.find((tool) => tool.name === 'sop_outbox_list')!;
  assert.ok(outboxListTool.inputSchema.properties.consumer_id);
  assert.equal(outboxListTool.annotations.readOnlyHint, true);

  const outboxAckTool = tools.find((tool) => tool.name === 'sop_outbox_ack')!;
  assert.ok(outboxAckTool.inputSchema.properties.event_id);
  assert.ok(outboxAckTool.inputSchema.properties.receipt);
  assert.equal(outboxAckTool.annotations.idempotentHint, true);

  const actionResolveTool = tools.find((tool) => tool.name === 'sop_action_resolve');
  assert.ok(actionResolveTool?.inputSchema.properties.action_id);
  assert.ok(actionResolveTool?.inputSchema.properties.operation_ref);
  assert.ok(actionResolveTool?.inputSchema.properties.completion_key);
  assert.equal(actionResolveTool?.annotations.idempotentHint, true);

  const refreshTool = tools.find((tool) => tool.name === 'sop_run_refresh')!;
  assert.equal(refreshTool.annotations.readOnlyHint, false);
  assert.ok(refreshTool.inputSchema.properties.run_id);

  const eventsTool = tools.find((tool) => tool.name === 'sop_run_events')!;
  assert.ok(eventsTool.inputSchema.properties.limit);
  assert.ok(eventsTool.inputSchema.properties.offset);

  console.log('sop-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
