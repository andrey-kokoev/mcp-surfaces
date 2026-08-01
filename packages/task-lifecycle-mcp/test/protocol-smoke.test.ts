import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { assertLiveToolsConform } from '@narada-core/mcp-fabric-contracts';
import {
  handleTaskLifecycleMcpRequest,
  runTaskLifecycleMcpStdioServer,
  taskLifecycleSurfaceDefinition,
} from '../src/task-lifecycle/task-mcp-server.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-mcp-protocol-'));
mkdirSync(join(siteRoot, '.ai'), { recursive: true });

const runtimeOptions = {
  argv: ['--site-root', siteRoot],
  cwd: siteRoot,
  env: { ...process.env, NARADA_AGENT_ID: 'sonar.resident' },
  stdout: { write: () => true },
  stderr: { write: () => true },
};

const cliPreparationRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-mcp-cli-prepare-'));
let cliPreparationOutput = '';
await runTaskLifecycleMcpStdioServer({
  stdin: Readable.from([]),
  stdout: { write: (chunk: unknown) => { cliPreparationOutput += String(chunk); return true; } },
  stderr: { write: () => true },
  argv: ['--prepare', '--site-root', cliPreparationRoot],
  cwd: cliPreparationRoot,
  env: { ...process.env, NARADA_AGENT_ID: 'sonar.resident' },
});
const cliPreparationLines = cliPreparationOutput.trim().split(/\r?\n/).filter(Boolean);
assert.equal(cliPreparationLines.length, 1, cliPreparationOutput);
const cliPreparationResult = JSON.parse(cliPreparationLines[0]);
assert.equal(cliPreparationResult.status, 'prepared');
assert.equal(cliPreparationResult.site_root, cliPreparationRoot);
assert.equal(cliPreparationResult.preparation.status, 'prepared');

const init = await (handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05' },
}, runtimeOptions)) as any;
assert.equal(init.error, undefined);
assert.equal(init.result.serverInfo.name, 'narada-task-lifecycle-mcp');

const tools = await (handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
})) as any;
assert.equal(tools.error, undefined);
const surface = taskLifecycleSurfaceDefinition();
assertLiveToolsConform(surface.descriptor, tools.result.tools);
assert.equal(surface.descriptor.guidance_tool, 'task_lifecycle_guidance');
assert.equal(surface.descriptor.metadata?.codex_startup_timeout_sec, 60);
assert.deepEqual(surface.descriptor.projections[0]?.lifecycle, {
  mode: 'restart_required',
  restart_owner: 'mcp-loader',
  reason: 'Tool and runtime changes require mcp_loader_surface_restart for the bound task-lifecycle surface.',
});
const names = tools.result.tools.map((tool: any) => tool.name);
assert.equal(new Set(names).size, names.length, 'task-lifecycle tools/list must not contain duplicate tool names');
assert.deepEqual(
  tools.result.tools.filter((tool: any) => typeof tool.annotations?.readOnlyHint !== 'boolean').map((tool: any) => tool.name),
  [],
  'every task-lifecycle tool must declare readOnlyHint explicitly',
);
assert.equal(names.includes('task_lifecycle_next'), true);
assert.equal(names.includes('task_lifecycle_doctor'), true);
assert.equal(names.includes('task_lifecycle_chapter_add_task'), true);
assert.equal(names.includes('task_lifecycle_chapter_show'), true);
assert.equal(names.includes('mcp_output_show'), true);
const payloadCreateTool = tools.result.tools.find((tool: any) => tool.name === 'mcp_payload_create');
assert.equal(Boolean(payloadCreateTool?.inputSchema?.properties?.payload_json), true);
assert.equal(tools.result.tools.find((tool: any) => tool.name === 'mcp_payload_validate')?.annotations?.readOnlyHint, true);

const prompts = await (handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 9,
  method: 'prompts/list',
  params: {},
})) as any;
assert.equal(prompts.error, undefined);
assert.equal(prompts.result.prompts[0]?.name, 'task_lifecycle_workflow');

const doctor = await (handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'task_lifecycle_doctor', arguments: {} },
}, runtimeOptions)) as any;
assert.equal(doctor.error, undefined);
assert.equal(doctor.result.structuredContent.fabric_lifecycle.restart_owner, 'mcp-loader');
assert.equal(doctor.result.structuredContent.preparation.status, 'missing');

const notReady = await (handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 10,
  method: 'tools/call',
  params: { name: 'task_lifecycle_list', arguments: {} },
}, runtimeOptions)) as any;
assert.equal(notReady.error?.code, -32000);
assert.match(String(notReady.error?.message), /^task_lifecycle_store_not_prepared:/);
assert.deepEqual(notReady.error?.data, {
  schema: 'narada.task_lifecycle.not_ready.v1',
  code: 'task_lifecycle_store_not_prepared',
  reason: 'database_missing',
  site_root: siteRoot,
  remediation: {
    inspect_tool: 'task_lifecycle_doctor',
    prepare_command: 'task-lifecycle-mcp --prepare --site-root <site-root>',
    after_prepare: 'restart_or_reattach_runtime',
  },
});

const chapterShowBeforePreparation = await (handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 11,
  method: 'tools/call',
  params: { name: 'task_lifecycle_chapter_show', arguments: { chapter_id: 'startup' } },
}, runtimeOptions)) as any;
assert.equal(chapterShowBeforePreparation.error, undefined);
assert.equal(chapterShowBeforePreparation.result?.structuredContent?.chapter_id, 'startup');
assert.equal(chapterShowBeforePreparation.result?.structuredContent?.membership_count, 0);

const guidance = await (handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: {
    name: 'task_lifecycle_guidance',
    arguments: { workflow: 'all' },
  },
}, runtimeOptions)) as any;
assert.equal(guidance.error, undefined);
const guidanceRef = guidance.result?.structuredContent?.output_ref;
assert.match(String(guidanceRef), /^mcp_output:/, JSON.stringify(guidance));
const guidancePage = await (handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: {
    name: 'mcp_output_show',
    arguments: { ref: guidanceRef, offset: 0, limit: 800 },
  },
}, runtimeOptions)) as any;
assert.equal(guidancePage.error, undefined);
assert.equal(guidancePage.result?.structuredContent?.schema, 'narada.mcp_output_page.v1');
assert.equal(guidancePage.result?.structuredContent?.ref, guidanceRef);

const emptyPayloadCreate = await (handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'mcp_payload_create',
    arguments: { payload: {}, allow_empty: true },
  },
}, runtimeOptions)) as any;
assert.equal(
  emptyPayloadCreate.error?.message,
  'task_lifecycle_payload_create_empty_payload_rejected: payload object must include at least one field',
);

const jsonPayloadCreate = await (handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'mcp_payload_create',
    arguments: { payload: {}, payload_json: '{"x":"y"}', payload_id: 'json_payload_ok' },
  },
}, runtimeOptions)) as any;
assert.equal(jsonPayloadCreate.result?.structuredContent?.status, 'created');

const emptyJsonPayloadCreate = await (handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: {
    name: 'mcp_payload_create',
    arguments: { payload_json: '{}' },
  },
}, runtimeOptions)) as any;
assert.equal(
  emptyJsonPayloadCreate.error?.message,
  'task_lifecycle_payload_create_empty_payload_rejected: payload object must include at least one field',
);

console.log('task-lifecycle-mcp protocol smoke ok');
