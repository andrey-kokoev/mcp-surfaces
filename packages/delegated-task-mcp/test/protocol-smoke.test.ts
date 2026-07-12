import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asRecord, runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'delegated-task-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--task-root', root, '--allowed-root', root], { label: 'delegated-task-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'delegated-task-mcp' });
  const tools = protocol.tools.tools as Record<string, any>[];
  const unsupportedMethodResponse = await server.client.request(3, 'delegated/unknown', {});
  assert.equal(asRecord(asRecord(unsupportedMethodResponse.error).data).code, 'unsupported_mcp_method');
  const unknownToolResponse = await server.client.request(4, 'tools/call', { name: 'delegated_task_not_real', arguments: {} });
  assert.equal(asRecord(asRecord(unknownToolResponse.error).data).code, 'unknown_tool');
  const invalidValidationResponse = await server.client.request(5, 'tools/call', { name: 'delegated_task_validate', arguments: { objective: 'Invalid protocol graph', workflow: { steps: [{ id: 'a', kind: 'worker', depends_on: ['missing'], if: 'all(step:a:completed)' }] }, acceptance: { residual_risk_policy: 'invalid-policy' } } });
  const invalidValidation = asRecord(asRecord(invalidValidationResponse.result).structuredContent);
  assert.equal(invalidValidation.status, 'rejected');
  assert.equal(Array.isArray(invalidValidation.diagnostics) && invalidValidation.diagnostics.some((item) => asRecord(item).code === 'unknown_dependency'), true);
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), [
    'delegated_task_guidance',
    'delegated_task_policy_inspect',
    'delegated_task_template_catalog',
    'delegated_task_validate',
    'delegated_task_run',
    'delegated_task_status',
    'delegated_task_advance',
    'delegated_task_wait',
    'delegated_tasks_list',
    'delegated_task_result',
    'delegated_task_summary',
    'delegated_task_events',
    'delegated_task_cancel',
    'delegated_task_acknowledge',
    'delegated_task_parent_takeover',
  ]);

  const policyTool = tools.find((tool: { name: string; annotations: Record<string, unknown> }) => tool.name === 'delegated_task_policy_inspect');
  assert.equal(policyTool.annotations.readOnlyHint, true);

  const validateTool = tools.find((tool: { name: string; annotations: Record<string, unknown> }) => tool.name === 'delegated_task_validate');
  assert.equal(validateTool.annotations.readOnlyHint, true);

  const templateCatalogTool = tools.find((tool: { name: string; inputSchema: { properties: Record<string, unknown> }; annotations: Record<string, unknown> }) => tool.name === 'delegated_task_template_catalog');
  assert.equal(templateCatalogTool.annotations.readOnlyHint, true);
  assert.equal(typeof templateCatalogTool.description, 'string');
  assert.ok(templateCatalogTool.inputSchema.properties.template_id);

  const runTool = tools.find((tool: { name: string; inputSchema: { properties: Record<string, unknown> }; annotations: Record<string, unknown> }) => tool.name === 'delegated_task_run');
  assert.equal(runTool.annotations.readOnlyHint, false);
  assert.ok(runTool.inputSchema.properties.objective);
  assert.ok(runTool.inputSchema.properties.intent);
  assert.ok(runTool.inputSchema.properties.constraints);
  assert.ok(runTool.inputSchema.properties.workflow);
  assert.ok(runTool.inputSchema.properties.acceptance);
  assert.ok(runTool.inputSchema.properties.result_policy);
  assert.ok(runTool.inputSchema.properties.execution);
  assert.ok(runTool.inputSchema.properties.idempotency_key);
  const constraints = runTool.inputSchema.properties.constraints as Record<string, any>;
  assert.equal(constraints.additionalProperties, false);
  assert.ok(constraints.properties.authority_gates);
  assert.ok(constraints.properties.provider);
  assert.ok(constraints.properties.required_mcp_tools);
  assert.ok(constraints.properties.preflight_paths);
  assert.equal(constraints.properties.overrides.additionalProperties, false);
  assert.ok(constraints.properties.overrides.properties.skip_git_repo_check);
  const acceptance = runTool.inputSchema.properties.acceptance as Record<string, any>;
  assert.equal(acceptance.additionalProperties, false);
  const resultPolicy = (runTool.inputSchema.properties.result_policy as Record<string, any>).properties;
  assert.ok(resultPolicy.max_worker_refs);
  assert.ok(resultPolicy.max_result_items);
  assert.ok(resultPolicy.compact_completed_worker_refs);
  assert.equal((runTool.inputSchema.properties.result_policy as Record<string, any>).additionalProperties, false);
  const workflow = runTool.inputSchema.properties.workflow as Record<string, any>;
  assert.ok(workflow.properties.template_id);
  assert.ok(workflow.properties.instruction);
  assert.ok(workflow.properties.work_order);
  assert.ok(workflow.properties.imports);

  const waitTool = tools.find((tool: { name: string; inputSchema: { properties: Record<string, unknown> } }) => tool.name === 'delegated_task_wait');
  assert.ok(waitTool.inputSchema.properties.task_id);
  assert.ok(waitTool.inputSchema.properties.timeout_ms);
  assert.ok(waitTool.inputSchema.properties.poll_ms);

  const listTool = tools.find((tool: { name: string; inputSchema: { properties: Record<string, unknown> } }) => tool.name === 'delegated_tasks_list');
  assert.ok(listTool.inputSchema.properties.limit);
  assert.ok(listTool.inputSchema.properties.include_terminal);
  assert.ok(listTool.inputSchema.properties.include_active);

  const resultTool = tools.find((tool: { name: string; inputSchema: { properties: Record<string, unknown> } }) => tool.name === 'delegated_task_result');
  assert.ok(resultTool.inputSchema.properties.task_id);
  assert.ok(resultTool.inputSchema.properties.include_diagnostics);

  const summaryTool = tools.find((tool: { name: string; inputSchema: { properties: Record<string, unknown> } }) => tool.name === 'delegated_task_summary');
  assert.ok(summaryTool.inputSchema.properties.task_id);

  const eventsTool = tools.find((tool: { name: string; inputSchema: { properties: Record<string, unknown> } }) => tool.name === 'delegated_task_events');
  assert.ok(eventsTool.inputSchema.properties.limit);
  assert.ok(eventsTool.inputSchema.properties.offset);

  const cancelTool = tools.find((tool: { name: string; inputSchema: { properties: Record<string, unknown> } }) => tool.name === 'delegated_task_cancel');
  assert.ok(cancelTool.inputSchema.properties.reason);

  console.log('delegated-task-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
