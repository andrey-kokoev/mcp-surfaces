import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleTaskLifecycleMcpRequest } from '../src/task-lifecycle/task-mcp-server.js';

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
assert.equal(names.includes('mcp_output_show'), false);
const payloadCreateTool = tools.result.tools.find((tool) => tool.name === 'mcp_payload_create');
assert.equal(Boolean(payloadCreateTool?.inputSchema?.properties?.payload_json), true);
assert.equal(tools.result.tools.find((tool) => tool.name === 'mcp_payload_validate')?.annotations?.readOnlyHint, true);

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
