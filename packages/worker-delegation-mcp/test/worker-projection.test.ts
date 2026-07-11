import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createServerState } from '../src/main.js';
import { workerEditRunArgs } from '../src/tool-handlers/edit.js';
import { listTools } from '../src/tool-list.js';
import { writeWorkerSessionRecord } from '../src/run-record.js';
import { callWorkerTool } from '../src/worker-tools.js';

type RpcResponse = {
  result?: Record<string, any>;
  error?: Record<string, any>;
};

const root = mkdtempSync(join(testTempRoot(), 'worker-projection-'));
mkdirSync(join(root, '.narada'), { recursive: true });
const env = {
  ...process.env,
  PATH: process.env.PATH ?? '',
  NARADA_PROVIDER_SECRET_STORE: 'disabled',
  KIMI_CODE_API_KEY: 'projection-test-key',
};

async function rpc(request: Record<string, unknown>, state: any): Promise<RpcResponse> {
  const params = request.params as Record<string, any>;
  const value = await callWorkerTool(String(params.name), params.arguments ?? {}, state);
  return { result: { structuredContent: value } };
}

function testTempRoot(): string {
  return process.env.TEMP ?? process.env.TMP ?? rootFallback();
}

function rootFallback(): string {
  return 'D:\\tmp';
}

const tools = listTools();
const editTool = tools.find((tool) => tool.name === 'worker_edit');
const editProperties = (editTool?.inputSchema as any)?.properties as Record<string, any> | undefined;
assert.equal(editProperties?.required_mcp_tools?.type, 'array');
const configTool = tools.find((tool) => tool.name === 'worker_config_resolve');
const configOutputProperties = (configTool?.outputSchema as any)?.properties as Record<string, any> | undefined;
assert.equal(configOutputProperties?.launchable?.type, 'boolean');
assert.deepEqual((workerEditRunArgs({ cwd: root, instruction: 'edit with scoped MCP', required_mcp_tools: ['mailbox_messages_list'] }) as any).constraints.required_mcp_tools, ['mailbox_messages_list']);
assert.deepEqual((workerEditRunArgs({ cwd: root, instruction: 'edit with explicit no MCP tools', required_mcp_tools: [] }) as any).constraints.required_mcp_tools, []);

const codexState = createServerState({
  allowedRoot: root,
  runRoot: join(root, 'codex-runs'),
  defaultRuntime: 'codex',
  codexCommand: process.execPath,
  maxOutputBytes: 2 * 1024 * 1024,
}, env);
const codexPreview = await rpc({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'worker_config_resolve',
    arguments: {
      intent: { instruction: 'preview unprojectable MCP tools' },
      constraints: { cwd: root, authority: 'read', cognition: 'low', required_mcp_tools: ['mailbox_messages_list'] },
    },
  },
}, codexState);
assert.equal(codexPreview.error, undefined);
assert.equal(codexPreview.result?.structuredContent.launchable, false);
assert.equal(codexPreview.result?.structuredContent.launchability.launchable, false);
assert.equal(codexPreview.result?.structuredContent.launchability.code, 'worker_required_mcp_tools_unprojectable');
assert.equal(codexPreview.result?.structuredContent.launchability.reason, 'Codex runtime cannot project requested MCP tools');
const narsState = createServerState({
  allowedRoot: root,
  runRoot: join(root, 'nars-runs'),
  defaultRuntime: 'narada-agent-runtime-server',
  agentRuntimeServerCommand: process.execPath,
  maxOutputBytes: 2 * 1024 * 1024,
}, env);
const narsProjection = await rpc({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'worker_config_resolve',
    arguments: {
      intent: { instruction: 'preview projected MCP tools' },
      constraints: { cwd: root, authority: 'read', cognition: 'low', required_mcp_tools: ['mailbox_messages_list'], overrides: { runtime: 'narada-agent-runtime-server' } },
    },
  },
}, narsState);
assert.equal(narsProjection.error, undefined, JSON.stringify(narsProjection));
assert.equal(narsProjection.result?.structuredContent.launchable, true, JSON.stringify(Object.keys(narsProjection.result?.structuredContent ?? {})));
assert.deepEqual(narsProjection.result?.structuredContent.resolved_worker_config.required_mcp_tools, ['mailbox_messages_list']);
assert.deepEqual(narsProjection.result?.structuredContent.resolved_worker_config.worker_mcp_projection.mcp_tool_allowlist, ['mailbox_messages_list']);
assert.equal(narsProjection.result?.structuredContent.resolved_worker_config.environment_keys.includes('NARADA_WORKER_MCP_CONFIG'), true);

const staleConfigState = createServerState({
  allowedRoot: root,
  runRoot: join(root, 'stale-config-runs'),
  defaultRuntime: 'narada-agent-runtime-server',
  agentRuntimeServerCommand: process.execPath,
  maxOutputBytes: 2 * 1024 * 1024,
}, { ...env, NARADA_WORKER_MCP_CONFIG: JSON.stringify({ schema: 'stale.worker.mcp_projection.v1', mcp_tool_allowlist: ['stale-tool'] }) });
const staleConfig = await rpc({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'worker_config_resolve',
    arguments: {
      intent: { instruction: 'clear stale MCP projection' },
      constraints: { cwd: root, authority: 'read', cognition: 'low', overrides: { runtime: 'narada-agent-runtime-server' } },
    },
  },
}, staleConfigState);
assert.deepEqual(staleConfig.result?.structuredContent.resolved_worker_config.required_mcp_tools, []);
assert.equal(staleConfig.result?.structuredContent.resolved_worker_config.worker_mcp_projection, undefined);
assert.equal(staleConfig.result?.structuredContent.resolved_worker_config.environment_keys.includes('NARADA_WORKER_MCP_CONFIG'), false);

const projection = {
  schema: 'narada.worker.mcp_projection.v1',
  native_mcp_mode: 'scoped',
  mcp_tool_allowlist: ['mailbox_messages_list'],
  include_startup_tools: true,
  include_output_readback_tools: false,
  full_site_mcp_requires_explicit_mode: true,
};
writeWorkerSessionRecord(narsState.policy, {
  schema: 'narada.worker.session.v1',
  worker_session_id: 'session-with-mcp-projection',
  origin_tool: 'worker_run',
  created_run_id: 'run-projection',
  updated_run_id: 'run-projection',
  resolved_worker_config: {
    runtime: 'narada-agent-runtime-server',
    authority: 'read',
    cognition: 'low',
    provider: 'kimi-code-api',
    required_mcp_tools: ['mailbox_messages_list'],
    worker_mcp_projection: projection,
    sandbox: 'read-only',
    model: 'kimi-k2.7',
    reasoning_effort: 'low',
    config: {},
  } as any,
  updated_at: new Date().toISOString(),
} as any);
const inheritedProjection = await rpc({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'worker_config_resolve',
    arguments: {
      worker_session_id: 'session-with-mcp-projection',
      intent: { instruction: 'inherit the existing MCP projection' },
      constraints: { cwd: root, authority: 'read' },
    },
  },
}, narsState);
assert.deepEqual(inheritedProjection.result?.structuredContent.resolved_worker_config.required_mcp_tools, ['mailbox_messages_list']);
assert.deepEqual(inheritedProjection.result?.structuredContent.resolved_worker_config.worker_mcp_projection.mcp_tool_allowlist, ['mailbox_messages_list']);
const clearedProjection = await rpc({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: {
    name: 'worker_config_resolve',
    arguments: {
      worker_session_id: 'session-with-mcp-projection',
      intent: { instruction: 'clear the existing MCP projection' },
      constraints: { cwd: root, authority: 'read', required_mcp_tools: [] },
    },
  },
}, narsState);
assert.deepEqual(clearedProjection.result?.structuredContent.resolved_worker_config.required_mcp_tools, []);
assert.equal(clearedProjection.result?.structuredContent.resolved_worker_config.worker_mcp_projection, undefined);
assert.equal(clearedProjection.result?.structuredContent.resolved_worker_config.environment_keys.includes('NARADA_WORKER_MCP_CONFIG'), false);
