import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLiveToolsConform } from '@narada2/mcp-fabric-contracts';
import { handleTaskLifecycleMcpRequest, taskLifecycleSurfaceDefinition } from '../src/task-lifecycle/task-mcp-server.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-mcp-protocol-'));
mkdirSync(join(siteRoot, '.ai'), { recursive: true });

const runtimeOptions = {
  argv: ['--site-root', siteRoot],
  cwd: siteRoot,
  env: { ...process.env, NARADA_AGENT_ID: 'sonar.resident' },
  stdout: { write: () => true },
  stderr: { write: () => true },
};

const init = await handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05' },
}, runtimeOptions);
assert.equal(init.error, undefined);
assert.equal(init.result.serverInfo.name, 'narada-task-lifecycle-mcp');

const tools = await handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
});
assert.equal(tools.error, undefined);
const surface = taskLifecycleSurfaceDefinition();
assertLiveToolsConform(surface.descriptor, tools.result.tools);
assert.equal(surface.descriptor.guidance_tool, 'task_lifecycle_guidance');
assert.deepEqual(surface.descriptor.projections[0]?.lifecycle, {
  mode: 'restart_required',
  restart_owner: 'mcp-loader',
  reason: 'Tool and runtime changes require mcp_loader_surface_restart for the bound task-lifecycle surface.',
});
const names = tools.result.tools.map((tool) => tool.name);
assert.equal(new Set(names).size, names.length, 'task-lifecycle tools/list must not contain duplicate tool names');
assert.deepEqual(
  tools.result.tools.filter((tool) => typeof tool.annotations?.readOnlyHint !== 'boolean').map((tool) => tool.name),
  [],
  'every task-lifecycle tool must declare readOnlyHint explicitly',
);
assert.equal(names.includes('task_lifecycle_next'), true);
assert.equal(names.includes('task_lifecycle_doctor'), true);
assert.equal(names.includes('task_lifecycle_chapter_add_task'), true);
assert.equal(names.includes('task_lifecycle_chapter_show'), true);
assert.equal(names.includes('mcp_output_show'), true);
const payloadCreateTool = tools.result.tools.find((tool) => tool.name === 'mcp_payload_create');
assert.equal(Boolean(payloadCreateTool?.inputSchema?.properties?.payload_json), true);
assert.equal(tools.result.tools.find((tool) => tool.name === 'mcp_payload_validate')?.annotations?.readOnlyHint, true);

const doctor = await handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'task_lifecycle_doctor', arguments: {} },
}, runtimeOptions);
assert.equal(doctor.error, undefined);
assert.equal(doctor.result.structuredContent.fabric_lifecycle.restart_owner, 'mcp-loader');

const guidance = await handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: {
    name: 'task_lifecycle_guidance',
    arguments: { workflow: 'all' },
  },
}, runtimeOptions);
assert.equal(guidance.error, undefined);
const guidanceRef = guidance.result?.structuredContent?.output_ref;
assert.match(String(guidanceRef), /^mcp_output:/, JSON.stringify(guidance));
const guidancePage = await handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: {
    name: 'mcp_output_show',
    arguments: { ref: guidanceRef, offset: 0, limit: 800 },
  },
}, runtimeOptions);
assert.equal(guidancePage.error, undefined);
assert.equal(guidancePage.result?.structuredContent?.schema, 'narada.mcp_output_page.v1');
assert.equal(guidancePage.result?.structuredContent?.ref, guidanceRef);

const emptyPayloadCreate = await handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'mcp_payload_create',
    arguments: { payload: {}, allow_empty: true },
  },
}, runtimeOptions);
assert.equal(
  emptyPayloadCreate.error?.message,
  'task_lifecycle_payload_create_empty_payload_rejected: payload object must include at least one field',
);

const jsonPayloadCreate = await handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'mcp_payload_create',
    arguments: { payload: {}, payload_json: '{"x":"y"}', payload_id: 'json_payload_ok' },
  },
}, runtimeOptions);
assert.equal(jsonPayloadCreate.result?.structuredContent?.status, 'created');

const emptyJsonPayloadCreate = await handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: {
    name: 'mcp_payload_create',
    arguments: { payload_json: '{}' },
  },
}, runtimeOptions);
assert.equal(
  emptyJsonPayloadCreate.error?.message,
  'task_lifecycle_payload_create_empty_payload_rejected: payload object must include at least one field',
);

console.log('task-lifecycle-mcp protocol smoke ok');
