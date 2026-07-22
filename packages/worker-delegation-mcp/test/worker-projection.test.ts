import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServerState } from '../src/main.js';
import { workerEditRunArgs } from '../src/tool-handlers/edit.js';
import { listTools } from '../src/tool-list.js';
import { writeWorkerSessionRecord } from '../src/run-record.js';
import { callWorkerTool } from '../src/worker-tools.js';
import { loadIntelligenceLaunchContext, projectIntelligenceLaunchContext } from '../src/intelligence-launch-context.js';

type RpcResponse = {
  result?: Record<string, any>;
  error?: Record<string, any>;
};

const root = mkdtempSync(join(testTempRoot(), 'worker-projection-'));
mkdirSync(join(root, '.narada'), { recursive: true });
mkdirSync(join(root, '.ai'), { recursive: true });
writeFileSync(join(root, '.narada', 'site.json'), JSON.stringify({ schema: 'narada.site.v0', site_id: 'projection-site' }), 'utf8');
writeFileSync(join(root, '.ai', 'intelligence-registry.db'), 'fixture', 'utf8');
writeFileSync(join(root, '.narada', 'intelligence-launch-context.json'), JSON.stringify({
  schema: 'narada.intelligence.launch_context.v1',
  user_site_id: 'site:projection-user',
  host_site_id: 'site:projection-host',
  principal_id: 'principal:projection',
  registry_db_path: '.ai\\intelligence-registry.db',
  principal_binding: {
    schema: 'narada.intelligence.principal_binding.v1',
    actor: { principal_id: 'principal:projection', auth_type: 'test' },
    memberships: [{ registry: 'site-roster', site_id: 'site:projection-user', role: 'resident', evidence_ref: 'test:projection' }],
  },
}), 'utf8');
const providerRegistryPath = join(root, 'provider-registry.json');
writeFileSync(providerRegistryPath, JSON.stringify({
  schema: 'narada.carrier.provider_registry.v1',
  default_provider: 'kimi-code-api',
  providers: {
    'kimi-code-api': {
      base_url: 'https://example.invalid/coding/',
      default_model: 'projection-test-model',
      available_models: ['projection-test-model'],
      cognition_defaults: {
        low: { model: 'projection-test-model', reasoning_effort: 'low' },
        medium: { model: 'projection-test-model', reasoning_effort: 'medium' },
        high: { model: 'projection-test-model', reasoning_effort: 'high' },
      },
      adapter_kind: 'openai-compatible-chat-completions',
      base_url_env_names: ['KIMI_CODE_API_BASE_URL'],
      model_env_names: ['KIMI_CODE_MODEL'],
      credential_env_names: ['KIMI_CODE_API_KEY'],
      credential_requirement: { kind: 'api_key_secret', secret_ref: 'projection/test', env_names: ['KIMI_CODE_API_KEY'] },
    },
  },
}), 'utf8');
const env = {
  ...process.env,
  PATH: process.env.PATH ?? '',
  NARADA_PROVIDER_SECRET_STORE: 'disabled',
  NARADA_INTELLIGENCE_PROVIDER: 'kimi-code-api',
  NARADA_AI_API_KEY: 'projection-test-key',
  NARADA_AI_BASE_URL: 'https://example.invalid/coding/',
  NARADA_AI_MODEL: 'projection-test-model',
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
  providerRegistryPath,
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
      constraints: { cwd: root, authority: 'read', cognition: 'low', required_mcp_tools: ['mailbox_messages_list'], overrides: { model: 'projection-test-model', reasoning_effort: 'low' } },
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
  providerRegistryPath,
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
      constraints: { cwd: root, authority: 'read', cognition: 'low', provider: 'kimi-code-api', required_mcp_tools: ['mailbox_messages_list'], overrides: { runtime: 'narada-agent-runtime-server' } },
    },
  },
}, narsState);
assert.equal(narsProjection.error, undefined, JSON.stringify(narsProjection));
assert.equal(narsProjection.result?.structuredContent.launchable, true, JSON.stringify(Object.keys(narsProjection.result?.structuredContent ?? {})));
assert.deepEqual(narsProjection.result?.structuredContent.resolved_worker_config.required_mcp_tools, ['mailbox_messages_list']);
assert.deepEqual(narsProjection.result?.structuredContent.resolved_worker_config.worker_mcp_projection.mcp_tool_allowlist, ['mailbox_messages_list']);
assert.equal(narsProjection.result?.structuredContent.resolved_worker_config.environment_keys.includes('NARADA_WORKER_MCP_CONFIG'), true);
assert.equal(narsProjection.result?.structuredContent.resolved_worker_config.intelligence_context.status, 'ready');
assert.equal(narsProjection.result?.structuredContent.resolved_worker_config.intelligence_context.principal_binding_present, true);
assert.equal(narsProjection.result?.structuredContent.resolved_worker_config.environment_keys.includes('NARADA_INTELLIGENCE_REGISTRY_DB'), true);

const staleConfigState = createServerState({
  allowedRoot: root,
  runRoot: join(root, 'stale-config-runs'),
  defaultRuntime: 'narada-agent-runtime-server',
  agentRuntimeServerCommand: process.execPath,
  providerRegistryPath,
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
      constraints: { cwd: root, authority: 'read', cognition: 'low', provider: 'kimi-code-api', overrides: { runtime: 'narada-agent-runtime-server' } },
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

const incompleteRoot = mkdtempSync(join(testTempRoot(), 'worker-intelligence-context-incomplete-'));
mkdirSync(join(incompleteRoot, '.narada'), { recursive: true });
writeFileSync(join(incompleteRoot, '.narada', 'site.json'), JSON.stringify({ site_id: 'incomplete-site' }), 'utf8');
const incompleteContext = loadIntelligenceLaunchContext({ sessionSiteRoot: incompleteRoot, userSiteRoot: incompleteRoot, processEnv: {} });
assert.equal(incompleteContext.status, 'blocked');
assert.equal(incompleteContext.missing.includes('host_site_id'), true);
assert.equal(incompleteContext.missing.includes('principal_binding'), true);
assert.throws(() => projectIntelligenceLaunchContext(incompleteContext), (error: any) => error.codeName === 'worker_intelligence_context_required');

const malformedRoot = mkdtempSync(join(testTempRoot(), 'worker-intelligence-context-malformed-'));
mkdirSync(join(malformedRoot, '.narada'), { recursive: true });
writeFileSync(join(malformedRoot, '.narada', 'intelligence-launch-context.json'), '{"schema":"wrong"}', 'utf8');
assert.throws(() => loadIntelligenceLaunchContext({ sessionSiteRoot: malformedRoot, userSiteRoot: malformedRoot, processEnv: {} }), (error: any) => error.codeName === 'worker_intelligence_context_invalid');
