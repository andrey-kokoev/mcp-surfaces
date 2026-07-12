import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'sop-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--sop-root', root], { label: 'sop-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'sop-mcp' });
  const tools = protocol.tools.tools as Record<string, any>[];
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
    'sop_run_list',
    'sop_run_coverage_since',
    'sop_run_cancel',
    'sop_run_events',
  ];
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), expectedTools);

  const createTool = tools.find((tool: { name: string; annotations: Record<string, unknown> }) => tool.name === 'sop_template_create');
  assert.equal(createTool.annotations.readOnlyHint, false);

  const showTool = tools.find((tool: { name: string; annotations: Record<string, unknown> }) => tool.name === 'sop_template_show');
  assert.equal(showTool.annotations.readOnlyHint, true);
  assert.ok(showTool.inputSchema.properties.sop_id);

  const runTool = tools.find((tool: { name: string; inputSchema: { properties: Record<string, unknown> }; annotations: Record<string, unknown> }) => tool.name === 'sop_run_start');
  assert.equal(runTool.annotations.readOnlyHint, false);
  assert.ok(runTool.inputSchema.properties.sop_id);
  assert.ok(runTool.inputSchema.properties.triggered_by);

  const advanceTool = tools.find((tool: { name: string; inputSchema: { properties: Record<string, unknown> } }) => tool.name === 'sop_run_advance');
  assert.ok(advanceTool.inputSchema.properties.run_id);
  assert.ok(advanceTool.inputSchema.properties.step_id);
  assert.ok(advanceTool.inputSchema.properties.result);
  assert.ok(advanceTool.inputSchema.properties.principal);

  const refreshTool = tools.find((tool: { name: string; annotations: Record<string, unknown>; inputSchema: { properties: Record<string, unknown> } }) => tool.name === 'sop_run_refresh');
  assert.equal(refreshTool.annotations.readOnlyHint, false);
  assert.ok(refreshTool.inputSchema.properties.run_id);

  const eventsTool = tools.find((tool: { name: string; inputSchema: { properties: Record<string, unknown> } }) => tool.name === 'sop_run_events');
  assert.ok(eventsTool.inputSchema.properties.limit);
  assert.ok(eventsTool.inputSchema.properties.offset);

  console.log('sop-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
