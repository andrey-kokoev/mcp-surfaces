import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createTemporaryE2eRoot,
  readMcpOutputText,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  structured,
  tomlPath,
  type JsonlMcpClient,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';
import { prepareTaskLifecycleMcpSite } from '@narada2/task-lifecycle-mcp/task-lifecycle-mcp-server';

type AnyRecord = Record<string, any>;
type JsonLine = AnyRecord;

const TEST_ID = 'site-loop-task-executability-live-e2e';
const buildRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(buildRoot, '..');
const naradaRoot = resolve(process.env.NARADA_E2E_NARADA_ROOT ?? 'D:/code/narada');
const lifecycleServerPath = resolve(packageRoot, '..', 'task-lifecycle-mcp', 'dist', 'src', 'task-lifecycle', 'task-mcp-server.js');
const siteLoopRunnerPath = join(buildRoot, 'src', 'site-loop', 'site-loop-engine.js');
const runtimeServerPath = process.env.NARADA_E2E_RUNTIME_SERVER_ENTRYPOINT
  ?? join(naradaRoot, 'packages', 'agent-runtime-server', 'dist', 'bin', 'narada-agent-runtime-server.js');
const dispatchModulePath = join(naradaRoot, 'packages', 'agent-runtime-server', 'dist', 'src', 'task-executability-dispatch.js');

assert.equal(existsSync(lifecycleServerPath), true, 'the built Task Lifecycle MCP entrypoint is required');
assert.equal(existsSync(siteLoopRunnerPath), true, 'the built Site Loop runner entrypoint is required');
assert.equal(existsSync(runtimeServerPath), true, 'the built NARS runtime entrypoint is required');
assert.equal(existsSync(dispatchModulePath), true, 'the built NARS dispatch hook is required');

const testSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
assert.equal(testSource.includes(['TaskExecutability', 'Orchestrator'].join('')), false, 'the E2E must not inject an orchestrator');
assert.equal(testSource.includes(['SqliteTaskLifecycle', 'Store'].join('')), false, 'the E2E must not mutate the lifecycle database directly');
assert.equal(testSource.includes(['handle', 'Request'].join('')), false, 'the E2E must use MCP/process boundaries');
assert.equal(testSource.includes(['fixture', '-delegated'].join('')), false, 'the E2E must not fabricate delegated identities');
assert.equal(testSource.includes(['spawn', 'Sync'].join('')), false, 'the E2E must not block a live runtime event loop around dispatch');

const siteRoot = createTemporaryE2eRoot(TEST_ID);
const siteSlug = 'site-loop-e2e-' + Date.now();
const siteId = 'site:' + siteSlug;
const agentId = siteSlug + '.producer';
const contextPath = join(siteRoot, '.narada', 'intelligence-launch-context.json');
const hookLogPath = join(siteRoot, '.ai', 'runtime', 'nars-task-executability-hook.jsonl');
const providerRequestLogPath = join(siteRoot, '.ai', 'runtime', 'provider-requests.jsonl');
const lifecycleFabricPath = join(siteRoot, '.ai', 'mcp', 'task-lifecycle.json');
const providerModel = 'live-site-loop-e2e-model';
const raceProviderDelayMs = 5_000;
let lifecycleServer: ReturnType<typeof spawnJsonlMcpServer> | null = null;
let provider: ProviderFixture | null = null;

function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NARADA_SITE_ROOT: siteRoot,
    NARADA_WORKSPACE_ROOT: siteRoot,
    NARADA_SITE_ID: siteId,
    NARADA_INTELLIGENCE_CONTEXT_PATH: contextPath,
    NARADA_INTELLIGENCE_REGISTRY_DB: join(siteRoot, '.ai', 'intelligence-registry.db'),
    NARADA_INTELLIGENCE_TARGET_SITE: siteId,
    NARADA_INTELLIGENCE_USER_SITE: siteId + '-user',
    NARADA_INTELLIGENCE_HOST_SITE: siteId + '-host',
    NARADA_INTELLIGENCE_PRINCIPAL_ID: 'principal:andrey',
    NARADA_INTELLIGENCE_PRINCIPAL_BINDING: JSON.stringify({
      schema: 'narada.intelligence.principal_binding.v1',
      actor: { principal_id: 'principal:andrey', auth_type: 'user-site-session' },
      memberships: [{ registry: 'site-roster', site_id: siteId, role: 'resident', evidence_ref: 'test:site-loop-task-executability-live-e2e' }],
    }),
    NARADA_INTELLIGENCE_PROVIDER: 'kimi-code-api',
    NARADA_MCP_SCOPE: 'none',
    KIMI_CODE_API_KEY: 'live-site-loop-e2e-key',
    KIMI_CODE_MODEL: providerModel,
    ...(provider ? {
      KIMI_CODE_API_BASE_URL: provider.baseUrl,
      NARADA_AI_BASE_URL: provider.baseUrl,
      NARADA_AI_API_KEY: 'live-site-loop-e2e-key',
      NARADA_AI_MODEL: providerModel,
    } : {}),
    ...extra,
  };
}

function taskServer(): ReturnType<typeof spawnJsonlMcpServer> {
  return spawnJsonlMcpServer(process.execPath, [lifecycleServerPath, '--site-root', siteRoot], {
    cwd: siteRoot,
    env: siteFabricChildEnv(siteRoot, {
      NARADA_AGENT_ID: 'live-site-loop.control',
      NARADA_SITE_ID: siteId,
    }),
    label: 'live Site Loop Task Lifecycle MCP',
    timeoutMs: 180_000,
  });
}

async function openLifecycleServer(): Promise<ReturnType<typeof spawnJsonlMcpServer>> {
  const server = taskServer();
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'narada-task-lifecycle-mcp',
    requiredTools: [
      'mcp_payload_create',
      'task_lifecycle_create',
      'task_lifecycle_executability_status',
    ],
  });
  lifecycleServer = server;
  return server;
}

async function closeLifecycleServer(): Promise<void> {
  if (!lifecycleServer) return;
  await lifecycleServer.close();
  lifecycleServer = null;
}

async function toolJson(client: JsonlMcpClient, id: number | string, name: string, args: JsonRecord): Promise<JsonRecord> {
  const first = structured(await client.request(id, 'tools/call', { name, arguments: args }));
  if (typeof first.output_ref !== 'string') return first;
  const materialized = await readMcpOutputText(
    first,
    async ({ offset, limit, pageNumber }) => structured(await client.request(String(id) + '-' + pageNumber, 'tools/call', {
      name: 'mcp_output_show',
      arguments: { ref: first.output_ref, offset, limit },
    })),
    { pageSize: 8_000, maxPages: 16, maxTextChars: 500_000 },
  );
  return JSON.parse(materialized.text) as JsonRecord;
}

async function createTask(
  client: JsonlMcpClient,
  id: number,
  key: string,
  title: string,
  requiredWork: string,
): Promise<{ taskId: string; taskNumber: number; followUp: AnyRecord }> {
  const payload = await toolJson(client, id, 'mcp_payload_create', {
    payload_id: 'live-site-loop-' + key,
    payload: {
      title,
      goal: requiredWork,
      required_work: [requiredWork],
      acceptance_criteria: ['The task is executable after the live provider assessment.'],
    },
  });
  const payloadRef = String(payload.ref ?? payload.payload_ref ?? '');
  assert.match(payloadRef, /^mcp_payload:/, JSON.stringify(payload));
  const created = await toolJson(client, id + 1, 'task_lifecycle_create', { payload_ref: payloadRef });
  const followUp = created.follow_up as AnyRecord;
  assert.equal(followUp?.schema, 'narada.task.executability.follow_up.v1', JSON.stringify(created));
  const taskNumber = Number(created.task_number);
  const taskId = String(created.task_id ?? followUp.task_id);
  assert.ok(Number.isInteger(taskNumber) && taskNumber > 0, JSON.stringify(created));
  assert.ok(taskId, JSON.stringify(created));
  return { taskId, taskNumber, followUp };
}

function writeSiteDocuments(): void {
  mkdirSync(join(siteRoot, '.narada'), { recursive: true });
  mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
  mkdirSync(join(siteRoot, '.ai', 'agents'), { recursive: true });
  mkdirSync(join(siteRoot, '.ai', 'mcp'), { recursive: true });
  mkdirSync(join(siteRoot, '.ai', 'runtime'), { recursive: true });
  writeFileSync(providerRequestLogPath, '', 'utf8');
  writeFileSync(join(siteRoot, '.narada', 'site.json'), JSON.stringify({
    schema: 'narada.site.v0',
    site_id: siteId,
  }), 'utf8');
  writeFileSync(join(siteRoot, '.narada', 'task-lifecycle.toml'), '[roster]\nroles_are_obligation_targets = true\n', 'utf8');
  writeFileSync(join(siteRoot, '.narada', 'worker-policy.toml'), [
    '[worker]',
    'default_runtime = "narada-agent-runtime-server"',
    'default_authority = "read"',
    'default_cognition = "low"',
    `run_root = "${tomlPath(join(siteRoot, '.ai', 'runtime', 'worker-delegation'))}"`,
    '',
    '[worker.policy]',
    'allowed_runtimes = ["narada-agent-runtime-server"]',
    'allowed_authorities = ["read"]',
    'allowed_sandboxes = ["read-only"]',
    'allowed_narada_agent_runtime_providers = ["kimi-code-api"]',
    'max_run_ms = 120000',
    'max_output_bytes = 200000',
    '',
    '[worker.runtimes.narada_agent_runtime_server]',
    `command = "${tomlPath(process.execPath)}"`,
    `command_args = ["${tomlPath(runtimeServerPath)}"]`,
    'default_sandbox = "read-only"',
    'ephemeral = true',
    'json_events = true',
  ].join('\n'), 'utf8');
  writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
    schema: 'narada.site_loop.config.v2',
    loop_id: 'live.site.loop.e2e',
    site_id: siteId,
    display_name: 'Live Site Loop task executability E2E',
    resident: { agent_id: agentId, role: 'resident' },
    refs: { ticket_projection: { kind: 'ticket_projection', ref: 'live-site-loop-e2e' } },
    mcp: {
      task_lifecycle_config_path: '.ai/mcp/task-lifecycle.json',
      task_lifecycle_server_key: 'narada-task-lifecycle',
      task_lifecycle_entrypoint_hint: lifecycleServerPath,
    },
  }, null, 2), 'utf8');
  writeFileSync(join(siteRoot, '.ai', 'task-executability-policy.json'), JSON.stringify({
    schema: 'narada.task_executability_policy.v1',
    enforcement: 'strict',
    evaluator_profile: 'shoshin-v1',
  }), 'utf8');
  writeFileSync(join(siteRoot, '.ai', 'agents', 'roster.json'), JSON.stringify({
    schema: 'narada.agent_roster.v1',
    agents: [{ agent_id: agentId, role: 'resident', status: 'active', capabilities: [] }],
  }, null, 2), 'utf8');
  writeFileSync(contextPath, JSON.stringify({
    schema: 'narada.intelligence.launch_context.v1',
    registry_db_path: '.ai\\intelligence-registry.db',
    target_site_id: siteId,
    user_site_id: siteId + '-user',
    host_site_id: siteId + '-host',
    principal_id: 'principal:andrey',
    invocation_plan_ref: 'plan:live-site-loop-e2e',
    principal_binding: {
      schema: 'narada.intelligence.principal_binding.v1',
      actor: { principal_id: 'principal:andrey', auth_type: 'user-site-session' },
      memberships: [{
        registry: 'site-roster',
        site_id: siteId,
        role: 'resident',
        evidence_ref: 'test:site-loop-task-executability-live-e2e',
      }],
    },
  }, null, 2), 'utf8');
  writeFileSync(lifecycleFabricPath, JSON.stringify({
    mcpServers: {
      'narada-task-lifecycle': {
        command: process.execPath,
        args: [lifecycleServerPath, '--site-root', siteRoot],
        env: { NARADA_SITE_ID: siteId },
        startup_timeout_sec: 15,
        request_timeout_ms: 30_000,
      },
    },
  }, null, 2), 'utf8');
}

async function seedCanonicalIntelligenceRegistry(endpointBaseUrl: string): Promise<void> {
  const contract = await import(pathToFileURL(join(naradaRoot, 'packages', 'invokable-intelligence-contract', 'dist', 'index.js')).href);
  const registry = await import(pathToFileURL(join(naradaRoot, 'packages', 'invokable-intelligence-registry', 'dist', 'index.js')).href);
  const now = new Date().toISOString();
  const validUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const seed = contract.buildCanonicalLocalTestSeed({
    endpointBaseUrl,
    endpointUrl: endpointBaseUrl + '/v1/chat/completions',
    adapterProtocol: { family: 'openai', operation: 'chat-completions', version: '1' },
    credentialStore: 'env',
    credentialReference: 'KIMI_CODE_API_KEY',
    invocationModelKey: providerModel,
    now,
    validUntil,
  });
  const replacements = new Map([
    ['site:narada', siteId],
    ['site:user', siteId + '-user'],
    ['site:pc', siteId + '-host'],
    ['inference-provider:remote-api', 'inference-provider:kimi-code-api'],
  ]);
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return [...replacements.entries()].reduce((current, [from, to]) => current.replaceAll(from, to), value);
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)])) as AnyRecord;
    if (result.schema === 'narada.invokable-intelligence.adapter.v1') {
      result.protocol = { family: 'openai', operation: 'chat-completions', version: '1' };
    }
    if (result.schema === 'narada.invokable-intelligence.access-grant.v1') {
      const scope = (result.scope && typeof result.scope === 'object' ? result.scope : {}) as AnyRecord;
      result.scope = {
        ...scope,
        purposes: [...new Set([...(Array.isArray(scope.purposes) ? scope.purposes : []), 'carrier-turn'])],
      };
    }
    if (result.schema === 'narada.invokable-intelligence.data-governance-requirement.v1') {
      result.purposes = [...new Set([...(Array.isArray(result.purposes) ? result.purposes : []), 'carrier-turn'])];
    }
    if (result.schema === 'narada.invokable-intelligence.invocation-route-candidate.v1'
      && result.topology && typeof result.topology === 'object') {
      const topology = result.topology as AnyRecord;
      result.topology = {
        ...topology,
        nodes: Array.isArray(topology.nodes)
          ? topology.nodes.map((node: AnyRecord) => ({ ...node, required_feasibility: [] }))
          : topology.nodes,
        edges: Array.isArray(topology.edges)
          ? topology.edges.map((edge: AnyRecord) => ({ ...edge, required_feasibility: [] }))
          : topology.edges,
      };
    }
    return result;
  };
  const rewritten = {
    ...seed,
    id: 'catalog-seed:site-loop-task-executability-live-e2e',
    records: seed.records.map((record: AnyRecord) => {
      const rewrittenRecord = rewrite(record) as AnyRecord;
      const document = rewrittenRecord.document as AnyRecord;
      return {
        ...rewrittenRecord,
        record_id: document.id,
        document,
        source: {
          ...rewrittenRecord.source,
          reference: 'test:site-loop-task-executability-live-e2e',
          digest: contract.canonicalSha256(document),
        },
      };
    }),
  };
  const store = await registry.SqliteRegistryStore.open(join(siteRoot, '.ai', 'intelligence-registry.db'));
  try {
    await store.loadCatalogSeed(rewritten);
  } finally {
    await store.close();
  }
}

type ProviderFixture = {
  baseUrl: string;
  requests: JsonRecord[];
  close: () => Promise<void>;
};

async function startProviderFixture(childPayloadRef: string): Promise<ProviderFixture> {
  const requests: JsonRecord[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const body = JSON.parse(await readRequestBody(request)) as JsonRecord;
    requests.push(body);
    appendFileSync(providerRequestLogPath, JSON.stringify(body) + '\n', 'utf8');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const serializedMessages = JSON.stringify(messages);
    if (serializedMessages.includes('Assess executability of task 3.')
      || serializedMessages.includes('Assess executability of task 4.')) {
      // Hold the real Site Loop lock while the second real process reaches
      // SQLite, making the cross-process contention assertion deterministic.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, raceProviderDelayMs));
    }
    const producerTurn = serializedMessages.includes('live-site-loop-nars-producer');
    const hasToolResult = messages.some((message) => {
      const item = message && typeof message === 'object' ? message as AnyRecord : {};
      return item.role === 'tool' || item.type === 'tool_result';
    });
    if (producerTurn && !hasToolResult) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'live-site-loop-provider-' + requests.length,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: providerModel,
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'live-site-loop-create-task',
              type: 'function',
              function: {
                name: 'task_lifecycle_create',
                arguments: JSON.stringify({ payload_ref: childPayloadRef }),
              },
            }],
          },
        }],
      }));
      return;
    }
    const assessment = {
      schema: 'narada.task.executability.assessment.v1',
      version: 1,
      dimensions: [{
        id: 'task_scope',
        status: 'clear',
        summary: 'The canonical task packet has a bounded assessment scope.',
      }],
      first_actions: [{
        order: 1,
        action: 'Inspect the canonical task packet and declared environment.',
      }],
      findings: [],
      required_decisions: [],
      reference_resolutions: [],
      acceptance_mappings: [{
        criterion: 'The task is executable after the live provider assessment.',
        mapped: true,
        status: 'mapped',
      }],
      evaluator_provenance: {
        schema: 'narada.task.executability.evaluator_provenance.v1',
        runtime: 'narada-agent-runtime-server',
        provider: 'kimi-code-api',
        model: providerModel,
        cognition: 'low',
        profile_version: 'shoshin-task-executability-v1',
      },
    };
    const content = {
      summary: 'The controlled HTTP provider returned a live executable assessment.',
      deliverables: [],
      open_questions: [],
      next_actions: [],
      edits_performed: false,
      target_state_changed: false,
      changes: [],
      verification: [{
        tool: 'controlled-http-provider-boundary',
        command: null,
        status: 'passed',
        summary: 'The provider boundary returned a valid worker assessment contract.',
        command_classification: 'not_applicable',
      }],
      verification_budget_respected: true,
      broad_unrelated_failures: [],
      exit_interview: null,
      review_verdict: 'accepted',
      acceptance_verdict: 'passed',
      completion_state: 'complete',
      structured_outputs: {
        task_executability_assessment_v1: assessment,
      },
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'live-site-loop-provider-' + requests.length,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: providerModel,
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(content) },
      }],
    }));
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('live_site_loop_provider_address_missing');
  return {
    baseUrl: 'http://127.0.0.1:' + address.port,
    requests,
    close: () => closeServer(server),
  };
}

function readRequestBody(request: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function writeHookModule(): void {
  const loopPath = JSON.stringify(siteLoopRunnerPath);
  const root = JSON.stringify(siteRoot);
  const log = JSON.stringify(hookLogPath);
  const dispatch = JSON.stringify(pathToFileURL(dispatchModulePath).href);
  const hookPath = join(siteRoot, '.ai', 'runtime', 'nars-task-executability-hook.mjs');
  writeFileSync(hookPath, [
    "import { appendFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "import { createNarsTaskExecutabilityDispatchHook } from " + dispatch + ";",
    "const siteRoot = " + root + ";",
    "const loopPath = " + loopPath + ";",
    "const logPath = " + log + ";",
    "const append = (value) => appendFileSync(logPath, JSON.stringify({ timestamp: new Date().toISOString(), ...value }) + '\\n');",
    "const hook = createNarsTaskExecutabilityDispatchHook({",
    "  emit: (event) => append({ kind: 'dispatch_event', event }),",
    "  schedule: (callback) => callback(),",
    "  dispatch: ({ follow_up }) => new Promise((resolve) => {",
    "    const child = spawn(process.execPath, [loopPath, '--site-root', siteRoot, '--limit', '1'], {",
    "      cwd: siteRoot,",
    "      env: { ...process.env, NARADA_MCP_SCOPE: 'none' },",
    "      stdio: ['ignore', 'pipe', 'pipe'],",
    "      windowsHide: true,",
    "    });",
    "    let stdout = '';",
    "    let stderr = '';",
    "    let settled = false;",
    "    const finish = (result) => {",
    "      if (settled) return;",
    "      settled = true;",
    "      clearTimeout(timer);",
    "      append({ kind: 'dispatch_result', result });",
    "      resolve(result);",
    "    };",
    "    const timer = setTimeout(() => {",
    "      try { child.kill(); } catch {}",
    "      finish({ follow_up, status: 'failed', exit_code: null, stdout: stdout.slice(-50000), stderr: stderr.slice(-10000), error: 'site_loop_dispatch_timeout' });",
    "    }, 120000);",
    "    child.stdout.setEncoding('utf8');",
    "    child.stderr.setEncoding('utf8');",
    "    child.stdout.on('data', (chunk) => { stdout += String(chunk); });",
    "    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-10000); });",
    "    child.on('error', (error) => finish({ follow_up, status: 'failed', exit_code: null, stdout: stdout.slice(-50000), stderr: stderr.slice(-10000), error: String(error?.message ?? error) }));",
    "    child.on('close', (status, signal) => finish({ follow_up, status: status === 0 ? 'completed' : 'failed', exit_code: status, signal, stdout: stdout.slice(-50000), stderr: stderr.slice(-10000), error: status === 0 ? null : 'site_loop_dispatch_exit' }));",
    "  }),",
    "});",
    "export const hooks = [{ onToolResult: (payload) => hook.onToolResult(payload) }];",
  ].join('\n'), 'utf8');
  process.env.NARADA_LIFECYCLE_HOOK_MODULE = hookPath;
}

type RuntimeProcess = {
  child: ChildProcessWithoutNullStreams;
  events: JsonLine[];
  stdout: string;
  stderr: string;
  send: (request: JsonRecord) => void;
  waitFor: (predicate: (event: JsonLine) => boolean, timeoutMs?: number) => Promise<JsonLine>;
  close: () => Promise<void>;
};

function spawnRuntime(): RuntimeProcess {
  const events: JsonLine[] = [];
  let stdout = '';
  let stderr = '';
  let buffer = '';
  const sessionId = 'live-site-loop-nars-' + Date.now();
  const child = spawn(process.execPath, [
    runtimeServerPath,
    '--raw-jsonl',
    '--authority', 'read',
    '--identity', agentId,
    '--session', sessionId,
  ], {
    cwd: siteRoot,
    env: childEnvironment({
      NARADA_MCP_SCOPE: 'local-site',
      NARADA_AGENT_ID: agentId,
      NARADA_CARRIER_SESSION_ID: sessionId,
      NARADA_LIFECYCLE_HOOK_MODULE: join(siteRoot, '.ai', 'runtime', 'nars-task-executability-hook.mjs'),
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    stdout += text;
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as JsonLine;
        if (event && typeof event === 'object') events.push(event);
      } catch {
        // Keep non-JSON diagnostics in stdout for a failure report.
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-30_000);
  });
  const send = (request: JsonRecord) => {
    assert.equal(child.stdin.destroyed, false, 'NARS stdin is unavailable: ' + JSON.stringify(request));
    child.stdin.write(JSON.stringify(request) + '\n');
  };
  const waitFor = async (predicate: (event: JsonLine) => boolean, timeoutMs = 180_000): Promise<JsonLine> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = events.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error('live_nars_event_timeout:' + JSON.stringify({
      stdout: stdout.slice(-8_000),
      stderr,
      events: events.slice(-30),
      provider_requests: readJsonLines(providerRequestLogPath),
    }));
  };
  const close = async () => {
    if (child.exitCode !== null) return;
    try {
      send({ id: 'live-site-loop-nars-close', method: 'session.close', params: {} });
    } catch {}
    await waitForExit(child, 20_000);
    if (child.exitCode === null) child.kill();
  };
  return { child, events, get stdout() { return stdout; }, get stderr() { return stderr; }, send, waitFor, close };
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    child.once('exit', finish);
    setTimeout(finish, timeoutMs);
  });
}

type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parsed: JsonRecord | null;
};

async function runSiteLoopProcess(): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [
      siteLoopRunnerPath,
      '--site-root', siteRoot,
      '--limit', '1',
    ], {
      cwd: siteRoot,
      env: childEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-30_000); });
    child.once('exit', (exitCode) => {
      let parsed: JsonRecord | null = null;
      try { parsed = JSON.parse(stdout.trim()) as JsonRecord; } catch {}
      resolvePromise({ exitCode, stdout, stderr, parsed });
    });
  });
}

async function waitForExecutable(
  client: JsonlMcpClient,
  taskNumber: number,
  requestId: number,
): Promise<{ status: JsonRecord; runs: ProcessResult[] }> {
  const runs: ProcessResult[] = [];
  let latestStatus: JsonRecord = {};
  for (let attempt = 0; attempt < 30; attempt += 1) {
    runs.push(await runSiteLoopProcess());
    latestStatus = await toolJson(client, requestId + attempt, 'task_lifecycle_executability_status', { task_number: taskNumber });
    if (latestStatus.currency === 'current' && latestStatus.verdict === 'executable') return { status: latestStatus, runs };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.fail(JSON.stringify({ task_number: taskNumber, latest_status: latestStatus, runs }));
}

function readPersistedAssessment(taskNumber: number): { row: AnyRecord; evaluator: AnyRecord } {
  const db = new DatabaseSync(join(siteRoot, '.ai', 'task-lifecycle.db'), { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT a.*, r.state AS request_state, r.assessment_id AS request_assessment_id,
             at.delegated_task_id, at.worker_run_id
      FROM task_executability_assessments a
      JOIN task_executability_requests r ON r.request_id = a.request_id
      LEFT JOIN task_executability_attempts at ON at.request_id = a.request_id
      WHERE a.task_number = ?
      ORDER BY a.created_at DESC
      LIMIT 1
    `).get(taskNumber) as AnyRecord | undefined;
    assert.ok(row, JSON.stringify({ task_number: taskNumber }));
    return { row, evaluator: JSON.parse(String(row.evaluator_json)) as AnyRecord };
  } finally {
    db.close();
  }
}

function readJsonLines(path: string): JsonLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === 'object' ? [parsed as JsonLine] : [];
    } catch {
      return [];
    }
  });
}

async function waitForHookDispatch(timeoutMs = 180_000): Promise<AnyRecord> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = readJsonLines(hookLogPath).find((entry) => entry.kind === 'dispatch_result') as AnyRecord | undefined;
    if (result) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error('live_site_loop_hook_dispatch_timeout:' + JSON.stringify({
    hook_events: readJsonLines(hookLogPath).slice(-20),
    provider_requests: readJsonLines(providerRequestLogPath),
  }));
}

function findFiles(root: string, name: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(path, name));
    else if (entry.name === name) found.push(path);
  }
  return found;
}

async function main(): Promise<void> {
  writeSiteDocuments();
  const preparation = prepareTaskLifecycleMcpSite(siteRoot);
  assert.equal(preparation.preparation.status, 'prepared', JSON.stringify(preparation));
  const controlServer = await openLifecycleServer();

  const childPayload = await toolJson(controlServer.client, 10, 'mcp_payload_create', {
    payload_id: 'live-site-loop-nars-child-payload',
    payload: {
      title: 'Task created by the live NARS MCP turn',
      goal: 'Verify that a real NARS MCP completion can enqueue a real Task Lifecycle request.',
      required_work: ['Run the live Site Loop executability assessment.'],
      acceptance_criteria: ['The child task has current executable assessment evidence.'],
    },
  });
  const childPayloadRef = String(childPayload.ref ?? childPayload.payload_ref ?? '');
  assert.match(childPayloadRef, /^mcp_payload:/, JSON.stringify(childPayload));
  const mainTask = await createTask(
    controlServer.client,
    20,
    'main',
    'Live Site Loop main assessment',
    'Assess the canonical task packet through the real delegated worker.',
  );
  writeHookModule();
  provider = await startProviderFixture(childPayloadRef);
  await seedCanonicalIntelligenceRegistry(provider.baseUrl);

  const nars = spawnRuntime();
  let hookResult: AnyRecord;
  try {
    await nars.waitFor((event) => event.event === 'session_started', 30_000);
    nars.send({
      id: 'live-site-loop-nars-producer-turn',
      method: 'session.submit',
      params: {
        content: 'live-site-loop-nars-producer: create the child task with the task_lifecycle_create MCP tool.',
      },
    });
    await nars.waitFor((event) => event.event === 'carrier_tool_completed'
      && event.tool_name === 'task_lifecycle_create'
      && event.status === 'completed'
      && Object.hasOwn(event, 'result'), 120_000);
    await nars.waitFor((event) => event.event === 'carrier_turn_completed', 120_000);
    hookResult = await waitForHookDispatch();
    await nars.close();
  } finally {
    if (nars.child.exitCode === null) nars.child.kill();
  }

  const hookEvents = readJsonLines(hookLogPath);
  const dispatchEvents = hookEvents.filter((entry) => entry.kind === 'dispatch_event').map((entry) => entry.event);
  assert.deepEqual(dispatchEvents.map((event) => event.event), [
    'task_executability_assessment_accepted',
    'task_executability_assessment_dispatched',
    'task_executability_assessment_completed',
  ], JSON.stringify(hookEvents));
  assert.equal((hookResult.result as AnyRecord).status, 'completed', JSON.stringify(hookResult));
  const hookLoopOutput = JSON.parse(String((hookResult.result as AnyRecord).stdout ?? '{}')) as AnyRecord;
  const hookTaskExecutabilityStep = (Array.isArray(hookLoopOutput.steps) ? hookLoopOutput.steps : [])
    .find((step: AnyRecord) => step.step_id === 'task_executability_reconciliation') as AnyRecord | undefined;
  assert.equal(hookTaskExecutabilityStep?.evidence?.status, 'ok', JSON.stringify(hookResult));
  assert.equal(nars.events.some((event) => event.event === 'carrier_tool_completed'
    && event.tool_name === 'task_lifecycle_create'
    && event.status === 'completed'
    && Object.hasOwn(event, 'result')), true, JSON.stringify(nars.events));
  assert.equal(nars.events.some((event) => event.event === 'item.completed'), false, JSON.stringify(nars.events));

  const mainCompletion = await waitForExecutable(controlServer.client, mainTask.taskNumber, 30);
  const mainStatus = mainCompletion.status;
  assert.equal(mainStatus.executable, true, JSON.stringify(mainStatus));
  assert.equal(mainStatus.currency, 'current', JSON.stringify(mainStatus));
  assert.equal(mainStatus.verdict, 'executable', JSON.stringify(mainStatus));
  assert.equal((mainStatus.request as AnyRecord | undefined)?.state, 'completed', JSON.stringify(mainStatus));
  // Status is intentionally compact; verify the full evaluator provenance
  // through the canonical persisted assessment row.
  const persistedMain = readPersistedAssessment(mainTask.taskNumber);
  const compactMainAssessment = mainStatus.assessment as AnyRecord | undefined;
  assert.equal(typeof compactMainAssessment?.assessment_id, 'string', JSON.stringify(mainStatus));
  assert.equal(persistedMain.row.assessment_id, compactMainAssessment?.assessment_id, JSON.stringify({ mainStatus, persistedMain }));
  assert.equal(persistedMain.row.request_state, 'completed', JSON.stringify(persistedMain));
  assert.equal(persistedMain.row.verdict, 'executable', JSON.stringify(persistedMain));
  assert.equal(persistedMain.evaluator.schema, 'narada.task_executability_evaluator_provenance.v1', JSON.stringify(persistedMain));
  assert.equal(persistedMain.evaluator.provider, 'kimi-code-api', JSON.stringify(persistedMain));
  assert.equal(persistedMain.evaluator.model, providerModel, JSON.stringify(persistedMain));
  assert.equal(persistedMain.evaluator.cognition, 'low', JSON.stringify(persistedMain));

  const childCreated = await toolJson(controlServer.client, 35, 'task_lifecycle_list', { limit: 50 });
  const childTask = (Array.isArray(childCreated.tasks) ? childCreated.tasks : []).find((task) => String((task as AnyRecord).title ?? '').includes('created by the live NARS'));
  assert.ok(childTask, JSON.stringify(childCreated));
  const childTaskNumber = Number((childTask as AnyRecord).task_number);
  assert.ok(Number.isInteger(childTaskNumber) && childTaskNumber > 0, JSON.stringify(childCreated));
  const childCompletion = await waitForExecutable(controlServer.client, childTaskNumber, 40);
  assert.equal(childCompletion.runs.some((run) => run.parsed?.status === 'ok'), true, JSON.stringify(childCompletion.runs));
  assert.equal(JSON.stringify(childCompletion.runs.at(-1)?.parsed).includes('task_executability_reconciliation'), true, JSON.stringify(childCompletion.runs));
  const childStatus = childCompletion.status;
  assert.equal((childStatus.request as AnyRecord | undefined)?.state, 'completed', JSON.stringify(childStatus));
  // The child may already be current when the polling call observes it. In
  // that case the latest run packet is the intentional idle response, while
  // status remains the authoritative compact readback of the persisted
  // assessment. Full evaluator provenance is asserted through the canonical
  // persisted assessment row below, not by widening the compact status.
  const childAssessment = childStatus.assessment as AnyRecord | undefined;
  assert.equal(typeof childAssessment?.assessment_id, 'string', JSON.stringify(childStatus));
  assert.equal(childAssessment?.verdict, 'executable', JSON.stringify(childStatus));
  const persistedChild = readPersistedAssessment(childTaskNumber);
  assert.equal(persistedChild.evaluator.schema, 'narada.task_executability_evaluator_provenance.v1', JSON.stringify(persistedChild));
  assert.equal(persistedChild.evaluator.provider, 'kimi-code-api', JSON.stringify(persistedChild));
  assert.equal(persistedChild.evaluator.model, providerModel, JSON.stringify(persistedChild));
  assert.equal(persistedChild.evaluator.cognition, 'low', JSON.stringify(persistedChild));

  const raceA = await createTask(controlServer.client, 50, 'race-a', 'Live Site Loop race A', 'Assess race A through the real worker.');
  const raceB = await createTask(controlServer.client, 60, 'race-b', 'Live Site Loop race B', 'Assess race B through the real worker.');
  const [raceResultA, raceResultB] = await Promise.all([runSiteLoopProcess(), runSiteLoopProcess()]);
  const raceResults = [raceResultA, raceResultB];
  assert.equal(raceResults.filter((result) => result.parsed?.status === 'ok').length, 1, JSON.stringify(raceResults));
  assert.equal(raceResults.filter((result) => result.parsed?.status === 'locked').length, 1, JSON.stringify(raceResults));
  assert.equal(raceResults.every((result) => result.parsed !== null), true, JSON.stringify(raceResults));
  await waitForExecutable(controlServer.client, raceA.taskNumber, 70);
  await waitForExecutable(controlServer.client, raceB.taskNumber, 100);

  const narsEventFiles = findFiles(join(siteRoot, '.narada', 'crew', 'nars-sessions'), 'events.jsonl');
  const persistedNarsEvents = narsEventFiles.flatMap(readJsonLines);
  assert.equal(persistedNarsEvents.some((event) => event.event === 'carrier_tool_completed'
    && event.tool_name === 'task_lifecycle_create'
    && Object.hasOwn(event, 'result')), true, JSON.stringify({ narsEventFiles, persistedNarsEvents }));
  assert.equal(persistedNarsEvents.some((event) => event.event === 'item.completed'), false, JSON.stringify({ narsEventFiles, persistedNarsEvents }));
  assert.equal(provider.requests.length >= 4, true, JSON.stringify(provider.requests));
  assert.equal(provider.requests.every((request) => request.model === providerModel), true, JSON.stringify(provider.requests));

  console.log(JSON.stringify({
    schema: 'narada.task_executability.cross_surface_e2e.v2',
    status: 'passed',
    topology: {
      control_surface: 'task-lifecycle-mcp-child-process',
      producer: 'narada-agent-runtime-server-child-process',
      assessment: 'site-loop-runner -> delegated-task -> worker-mcp -> narada-agent-runtime-server',
      hook: 'compiled-nars-task-executability-dispatch',
      provider_boundary: 'controlled_http_provider_boundary',
    },
    live_mcp_tool_completion: true,
    live_site_loop_hook_dispatch: true,
    live_persisted_assessment: true,
    concurrent_loop_lock: { completed: 1, locked: 1 },
    task_numbers: {
      main: mainTask.taskNumber,
      child: childTaskNumber,
      race_a: raceA.taskNumber,
      race_b: raceB.taskNumber,
    },
    provider_request_count: provider.requests.length,
    nars_event_files: narsEventFiles,
  }));
}

let testPassed = false;
try {
  await main();
  testPassed = true;
} finally {
  await closeLifecycleServer();
  const cleanupProvider = provider as ProviderFixture | null;
  if (cleanupProvider) await cleanupProvider.close();
  if (testPassed) assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}
