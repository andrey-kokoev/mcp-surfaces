import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createTestProcessScope,
  readMcpOutputText,
  removeTemporaryE2eRoot,
  runBoundedProcess,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnContentLengthMcpServer,
  spawnJsonlMcpServer,
  structured,
  type JsonlMcpClient,
  type JsonRecord,
} from '@narada-core/mcp-e2e-harness';
import { prepareTaskLifecycleMcpSite } from '@narada-core/task-lifecycle-mcp/task-lifecycle-mcp-server';
import { openSiteLoopStore } from '../src/site-loop/site-loop-store.js';

type AnyRecord = Record<string, any>;

export const ISOLATED_E2E_DEADLINE_MS = 180_000;
// Each boundary owns an isolated Site root and fixture. Three workers keep
// the six-boundary matrix inside the contract without sharing SQLite state.
const ISOLATED_E2E_CONCURRENCY = 3;
export const ISOLATED_INTERRUPTION_BOUNDARIES = [
  'mailbox_generation_cursor_committed',
  'mailbox_observation_receipt',
  'ticket_source_projection',
  'scheduler_activation_admitted',
  'agent_decision_receipt',
  'terminal_proposal_projection',
] as const;
type Boundary = typeof ISOLATED_INTERRUPTION_BOUNDARIES[number];

const TEST_ID = 'site-loop.isolated-process-backed-mail-ticket';
const BUILD_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SITE_LOOP_PACKAGE_ROOT = resolve(BUILD_ROOT, '..');
const PACKAGES_ROOT = resolve(SITE_LOOP_PACKAGE_ROOT, '..');
const NARADA_ROOT = resolve(process.env.NARADA_E2E_NARADA_ROOT ?? 'D:/code/narada');
const NARADA_SONAR_ROOT = resolve(process.env.NARADA_E2E_SONAR_ROOT ?? 'D:/code/narada.sonar');
const MAILBOX_ENTRYPOINT = join(PACKAGES_ROOT, 'mailbox-mcp', 'dist', 'src', 'main.js');
const WORK_ENTRYPOINT = join(PACKAGES_ROOT, 'work-lifecycle-mcp', 'dist', 'src', 'main.js');
const SCHEDULER_ENTRYPOINT = join(PACKAGES_ROOT, 'scheduler-mcp', 'dist', 'src', 'main.js');
const TASK_ENTRYPOINT = join(PACKAGES_ROOT, 'task-lifecycle-mcp', 'dist', 'src', 'task-lifecycle', 'task-mcp-server.js');
const SITE_LOOP_ENTRYPOINT = join(BUILD_ROOT, 'src', 'site-loop-mcp-server.js');
const SUPERVISOR_ENTRYPOINT = join(BUILD_ROOT, 'src', 'site-loop', 'site-loop-supervisor-runner.js');
const BRIDGE_ENTRYPOINT = join(BUILD_ROOT, 'test', 'site-loop-mail-ticket-bridge.js');
const NARS_ENTRYPOINT = process.env.NARADA_E2E_RUNTIME_SERVER_ENTRYPOINT
  ?? join(NARADA_ROOT, 'packages', 'agent-runtime-server', 'dist', 'bin', 'narada-agent-runtime-server.js');
const RESULT_PATH = join(SITE_LOOP_PACKAGE_ROOT, '.tmp', 'e2e-results', `${TEST_ID}.json`);
const temporaryScenarioRoots = new Set<string>();

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function narsSessionId(siteId: string, messageId: string): string {
  return `${siteId.replace(/[^a-z0-9_-]+/gi, '_')}-${messageId}`;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) as JsonRecord[] : [];
}

function arrayAt(value: unknown, ...keys: string[]): JsonRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  for (const key of keys) {
    const candidate = (value as JsonRecord)[key];
    if (Array.isArray(candidate)) return records(candidate);
  }
  return [];
}

function stringArrayAt(value: unknown, key: string): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const candidate = (value as JsonRecord)[key];
  return Array.isArray(candidate) ? candidate.map((item) => String(item)).filter(Boolean) : [];
}

function stringAt(value: unknown, key: string): string | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = stringAt(child, key);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    const object = value as JsonRecord;
    if (typeof object[key] === 'string' && String(object[key]).trim()) return String(object[key]);
    for (const child of Object.values(object)) {
      const found = stringAt(child, key);
      if (found) return found;
    }
  }
  return null;
}

function assertEntrypoints(): void {
  for (const path of [MAILBOX_ENTRYPOINT, WORK_ENTRYPOINT, SCHEDULER_ENTRYPOINT, TASK_ENTRYPOINT, SITE_LOOP_ENTRYPOINT, SUPERVISOR_ENTRYPOINT, BRIDGE_ENTRYPOINT, NARS_ENTRYPOINT]) {
    assert.equal(existsSync(path), true, `isolated E2E entrypoint missing: ${path}`);
  }
  assert.equal(existsSync(join(NARADA_SONAR_ROOT, 'node_modules', '@narada-core', 'control-plane', 'package.json')), true,
    'the isolated root must resolve the real control-plane runtime through narada.sonar');
  const sourceRoots = [join(NARADA_ROOT, 'packages', 'agent-runtime-server', 'src'), join(NARADA_ROOT, 'packages', 'agent-runtime-server', 'bin')];
  const latestSource = sourceRoots.reduce((latest, root) => Math.max(latest, latestSourceMtime(root)), 0);
  assert.equal(statSync(NARS_ENTRYPOINT).mtimeMs >= latestSource, true, 'NARS artifact is older than its source');
}

function latestSourceMtime(root: string): number {
  if (!existsSync(root)) return 0;
  return readdirSync(root, { withFileTypes: true }).reduce((latest, entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return Math.max(latest, latestSourceMtime(path));
    return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? Math.max(latest, statSync(path).mtimeMs) : latest;
  }, 0);
}

async function call(client: JsonlMcpClient, name: string, args: JsonRecord = {}, outputShowTool: string | null = null): Promise<JsonRecord> {
  const response = await client.request(`${TEST_ID}:${name}:${Date.now()}:${Math.random()}`, 'tools/call', { name, arguments: args });
  const result = structured(response);
  if (typeof result.output_ref !== 'string') return result;
  if (!outputShowTool) throw new Error(`isolated_e2e_unbounded_output:${name}`);
  const materialized = await readMcpOutputText(
    result,
    async ({ offset, limit, pageNumber }) => structured(await client.request(`${TEST_ID}:${outputShowTool}:${pageNumber}`, 'tools/call', {
      name: outputShowTool,
      arguments: { ref: result.output_ref, offset, limit },
    })),
    { pageSize: 5_000, maxPages: 20, maxTextChars: 100_000 },
  );
  return JSON.parse(materialized.text) as JsonRecord;
}

function readEvidence(siteRoot: string): JsonRecord {
  const path = join(siteRoot, '.ai', 'runtime', 'site-loop-e2e', 'bridge-evidence.json');
  assert.equal(existsSync(path), true, `bridge evidence missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
}

function readPhaseEvidence(siteRoot: string, phase: string): JsonRecord {
  const path = join(siteRoot, '.ai', 'runtime', 'site-loop-e2e', `bridge-${phase}.json`);
  assert.equal(existsSync(path), true, `bridge phase evidence missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
}

function assertDurableBoundaryEvidence(boundary: Boundary, evidence: JsonRecord): void {
  const durable = record(evidence.durable_boundary_evidence);
  assert.equal(Object.keys(durable).length > 0, true, JSON.stringify(evidence));
  switch (boundary) {
    case 'mailbox_generation_cursor_committed': {
      const generation = record(durable.generation);
      const generationRecord = record(generation.generation);
      const cursor = record(durable.cursor);
      assert.equal(generationRecord.status, 'completed', JSON.stringify(evidence));
      assert.equal(typeof generationRecord.next_cursor_sha256, 'string', JSON.stringify(evidence));
      assert.equal(cursor.advanced, true, JSON.stringify(evidence));
      assert.equal(arrayAt(generation, 'records').length, 2, JSON.stringify(evidence));
      return;
    }
    case 'mailbox_observation_receipt':
      assert.equal(record(durable.observation).outcome, 'completed', JSON.stringify(evidence));
      assert.equal(typeof record(durable.observation_result).idempotency_replayed, 'boolean', JSON.stringify(evidence));
      return;
    case 'ticket_source_projection':
      assert.equal(durable.ticket_count, 2, JSON.stringify(evidence));
      assert.equal(new Set(stringArrayAt(durable, 'ticket_ids')).size, 2, JSON.stringify(evidence));
      assert.equal(new Set(stringArrayAt(durable, 'source_ids')).size, 2, JSON.stringify(evidence));
      return;
    case 'scheduler_activation_admitted':
      assert.equal(arrayAt(durable, 'activations').length, 2, JSON.stringify(evidence));
      assert.equal(arrayAt(durable, 'scheduler_event_statuses').length, 2, JSON.stringify(evidence));
      return;
    case 'agent_decision_receipt': {
      const decisions = arrayAt(durable, 'decisions');
      assert.equal(decisions.length, 2, JSON.stringify(evidence));
      assert.equal(new Set(decisions.map((item) => String(item.message_id))).size, 2, JSON.stringify(evidence));
      assert.equal(new Set(decisions.map((item) => String(item.route))).size, 2, JSON.stringify(evidence));
      return;
    }
    case 'terminal_proposal_projection': {
      const proposals = arrayAt(durable, 'proposals');
      assert.equal(proposals.length, 2, JSON.stringify(evidence));
      assert.equal(new Set(proposals.map((item) => String(item.ticket_id))).size, 2, JSON.stringify(evidence));
      return;
    }
  }
}

function readJsonLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: JsonRecord): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

type Fixture = {
  baseUrl: string;
  graphRequests: string[];
  modelRequests: JsonRecord[];
  close: () => Promise<void>;
};

async function startFixture(): Promise<Fixture> {
  const graphRequests: string[] = [];
  const modelRequests: JsonRecord[] = [];
  const messages = [
    {
      id: 'message-response', changeKey: 'change-response', conversationId: 'conversation-response', parentFolderId: 'inbox',
      isRead: false, isDraft: false, hasAttachments: false, subject: 'Response route',
      body: { contentType: 'text', content: 'A deterministic response should be drafted.' },
      from: { emailAddress: { address: 'sender@allowed.test' } },
      toRecipients: [{ emailAddress: { address: 'support@example.test' } }],
      receivedDateTime: '2026-08-03T12:00:00.000Z', sentDateTime: '2026-08-03T12:00:00.000Z',
      internetMessageId: '<message-response@example.test>', flag: { flagStatus: 'notFlagged' },
    },
    {
      id: 'message-followup', changeKey: 'change-followup', conversationId: 'conversation-followup', parentFolderId: 'inbox',
      isRead: false, isDraft: false, hasAttachments: false, subject: 'Follow-up route',
      body: { contentType: 'text', content: 'A deterministic follow-up task should be created.' },
      from: { emailAddress: { address: 'sender@allowed.test' } },
      toRecipients: [{ emailAddress: { address: 'support@example.test' } }],
      receivedDateTime: '2026-08-03T12:01:00.000Z', sentDateTime: '2026-08-03T12:01:00.000Z',
      internetMessageId: '<message-followup@example.test>', flag: { flagStatus: 'notFlagged' },
    },
  ];
  const server = createServer(async (request, response) => {
    const url = String(request.url ?? '');
    if (request.method === 'GET') {
      graphRequests.push(url);
      if (url.toLowerCase().includes('messages/delta')) {
        const replay = url.includes('cursor=1') || url.includes('delta-token');
        sendJson(response, 200, { value: replay ? [] : messages, '@odata.deltaLink': `${fixtureBase}/graph/messages/delta?cursor=1` });
        return;
      }
      sendJson(response, 200, { value: [] });
      return;
    }
    if (request.method === 'POST' && url.includes('/v1/chat/completions')) {
      const body = JSON.parse(await readRequestBody(request)) as JsonRecord;
      modelRequests.push(body);
      const serialized = JSON.stringify(body.messages ?? body);
      const messageId = serialized.includes('message-followup') ? 'message-followup' : 'message-response';
      const route = messageId === 'message-followup' ? 'followup_task' : 'response_draft';
      const content = {
        summary: `Deterministic NARS decision for ${messageId}.`,
        completion_state: 'complete',
        acceptance_verdict: 'passed',
        structured_outputs: {
          site_loop_agent_decision_v1: {
            schema: 'narada.site_loop.agent_decision.v1',
            route,
            message_id: messageId,
            summary: `Deterministic NARS decision for ${messageId}.`,
          },
        },
      };
      sendJson(response, 200, {
        id: `site-loop-e2e-model-${modelRequests.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'site-loop-isolated-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }],
      });
      return;
    }
    sendJson(response, 404, { error: 'fixture_not_found' });
  });
  let fixtureBase = '';
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('isolated_fixture_address_missing'));
      fixtureBase = `http://127.0.0.1:${address.port}`;
      resolvePromise();
    });
  });
  return {
    baseUrl: fixtureBase,
    graphRequests,
    modelRequests,
    close: () => new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

function siteEnvironment(siteRoot: string, siteId: string, fixture: Fixture): NodeJS.ProcessEnv {
  return siteFabricChildEnv(siteRoot, {
    ...process.env,
    NARADA_SITE_ROOT: siteRoot,
    NARADA_WORKSPACE_ROOT: siteRoot,
    NARADA_SITE_ID: siteId,
    NARADA_E2E_GRAPH_FIXTURE_URL: fixture.baseUrl,
    NARADA_E2E_PROVIDER_BASE_URL: fixture.baseUrl,
    NARADA_INTELLIGENCE_CONTEXT_PATH: join(siteRoot, '.narada', 'intelligence-launch-context.json'),
    NARADA_INTELLIGENCE_REGISTRY_DB: join(siteRoot, '.ai', 'intelligence-registry.db'),
    NARADA_INTELLIGENCE_TARGET_SITE: siteId,
    NARADA_INTELLIGENCE_USER_SITE: `${siteId}-user`,
    NARADA_INTELLIGENCE_HOST_SITE: `${siteId}-host`,
    NARADA_INTELLIGENCE_PRINCIPAL_ID: 'principal:andrey',
    NARADA_INTELLIGENCE_PRINCIPAL_BINDING: JSON.stringify({
      schema: 'narada.intelligence.principal_binding.v1',
      actor: { principal_id: 'principal:andrey', auth_type: 'user-site-session' },
      memberships: [{ registry: 'site-roster', site_id: siteId, role: 'resident', evidence_ref: 'test:site-loop-isolated-process-backed' }],
    }),
    NARADA_INTELLIGENCE_PROVIDER: 'kimi-code-api',
    NARADA_MCP_SCOPE: 'none',
    GRAPH_ACCESS_TOKEN: 'site-loop-isolated-graph-token',
    KIMI_CODE_API_BASE_URL: fixture.baseUrl,
    KIMI_CODE_API_KEY: 'site-loop-isolated-model-key',
    KIMI_CODE_MODEL: 'site-loop-isolated-model',
    NARADA_AI_BASE_URL: fixture.baseUrl,
    NARADA_AI_API_KEY: 'site-loop-isolated-model-key',
    NARADA_AI_MODEL: 'site-loop-isolated-model',
  });
}

async function seedIntelligence(siteRoot: string, siteId: string, fixture: Fixture): Promise<void> {
  const contract = await import(pathToFileURL(join(NARADA_ROOT, 'packages', 'invokable-intelligence-contract', 'dist', 'index.js')).href);
  const registry = await import(pathToFileURL(join(NARADA_ROOT, 'packages', 'invokable-intelligence-registry', 'dist', 'index.js')).href);
  const now = new Date().toISOString();
  const seed = contract.buildCanonicalLocalTestSeed({
    endpointBaseUrl: fixture.baseUrl,
    endpointUrl: fixture.baseUrl + '/v1/chat/completions',
    adapterProtocol: { family: 'openai', operation: 'chat-completions', version: '1' },
    credentialStore: 'env',
    credentialReference: 'KIMI_CODE_API_KEY',
    invocationModelKey: 'site-loop-isolated-model',
    now,
    validUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  const replacements = new Map([
    ['site:narada', siteId],
    ['site:user', `${siteId}-user`],
    ['site:pc', `${siteId}-host`],
    ['inference-provider:remote-api', 'inference-provider:kimi-code-api'],
  ]);
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') return [...replacements.entries()].reduce((current, [from, to]) => current.replaceAll(from, to), value);
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)])) as AnyRecord;
    if (result.schema === 'narada.invokable-intelligence.adapter.v1') result.protocol = { family: 'openai', operation: 'chat-completions', version: '1' };
    if (result.schema === 'narada.invokable-intelligence.access-grant.v1') {
      const scope = record(result.scope);
      result.scope = { ...scope, purposes: [...new Set([...(Array.isArray(scope.purposes) ? scope.purposes : []), 'carrier-turn'])] };
    }
    if (result.schema === 'narada.invokable-intelligence.data-governance-requirement.v1') {
      result.purposes = [...new Set([...(Array.isArray(result.purposes) ? result.purposes : []), 'carrier-turn'])];
    }
    if (result.schema === 'narada.invokable-intelligence.invocation-route-candidate.v1' && result.topology && typeof result.topology === 'object') {
      const topology = record(result.topology);
      result.topology = {
        ...topology,
        nodes: Array.isArray(topology.nodes) ? topology.nodes.map((node: AnyRecord) => ({ ...node, required_feasibility: [] })) : topology.nodes,
        edges: Array.isArray(topology.edges) ? topology.edges.map((edge: AnyRecord) => ({ ...edge, required_feasibility: [] })) : topology.edges,
      };
    }
    return result;
  };
  const rewritten = {
    ...seed,
    id: `catalog-seed:${TEST_ID}:${siteId}`,
    records: seed.records.map((entry: AnyRecord) => {
      const rewrittenRecord = rewrite(entry) as AnyRecord;
      const document = record(rewrittenRecord.document);
      return {
        ...rewrittenRecord,
        record_id: document.id,
        document,
        source: { ...record(rewrittenRecord.source), reference: `test:${TEST_ID}`, digest: contract.canonicalSha256(document) },
      };
    }),
  };
  const store = await registry.SqliteRegistryStore.open(join(siteRoot, '.ai', 'intelligence-registry.db'));
  try { await store.loadCatalogSeed(rewritten); } finally { await store.close(); }
}

function writeScenario(siteRoot: string, siteId: string, fixture: Fixture): void {
  mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
  mkdirSync(join(siteRoot, '.narada', 'crew'), { recursive: true });
  mkdirSync(join(siteRoot, '.ai', 'agents'), { recursive: true });
  mkdirSync(join(siteRoot, '.ai', 'inbox-envelopes'), { recursive: true });
  mkdirSync(join(siteRoot, '.ai', 'mcp'), { recursive: true });
  mkdirSync(join(siteRoot, '.ai', 'runtime'), { recursive: true });
  mkdirSync(join(siteRoot, 'config'), { recursive: true });
  writeFileSync(join(siteRoot, 'AGENTS.md'), '# Isolated Site Loop E2E\n', 'utf8');
  writeFileSync(join(siteRoot, 'README.md'), '# Isolated Site Loop E2E\n', 'utf8');
  writeFileSync(join(siteRoot, '.ai', 'mcp', 'site-loop-e2e.json'), JSON.stringify({
    schema: 'narada.mcp.client_config.v0',
    site_id: siteId,
    mcpServers: {
      'narada-site-loop-e2e-mailbox': {
        command: process.execPath,
        args: [MAILBOX_ENTRYPOINT, '--site-root', siteRoot],
        surface_id: 'mailbox',
        tools: ['mailbox_guidance'],
      },
    },
  }, null, 2), 'utf8');
  writeFileSync(join(siteRoot, '.narada', 'intelligence-launch-context.json'), JSON.stringify({
    schema: 'narada.intelligence.launch_context.v1',
    registry_db_path: '.ai/intelligence-registry.db',
    target_site_id: siteId,
    user_site_id: `${siteId}-user`,
    host_site_id: `${siteId}-host`,
    principal_id: 'principal:andrey',
    invocation_plan_ref: 'plan:site-loop-isolated-e2e',
    principal_binding: { schema: 'narada.intelligence.principal_binding.v1', actor: { principal_id: 'principal:andrey', auth_type: 'user-site-session' }, memberships: [{ registry: 'site-roster', site_id: siteId, role: 'resident', evidence_ref: `test:${TEST_ID}` }] },
  }, null, 2), 'utf8');
  writeFileSync(join(siteRoot, 'config', 'config.json'), JSON.stringify({
    root_dir: join(siteRoot, '.ai', 'mailboxes', 'support'),
    scopes: [{
      scope_id: 'support',
      root_dir: join(siteRoot, '.ai', 'mailboxes', 'support'),
      sources: [{ type: 'graph' }],
      graph: { user_id: 'support@example.test', base_url: fixture.baseUrl, prefer_immutable_ids: true },
      scope: { included_container_refs: ['inbox'], included_item_kinds: ['message'] },
      normalize: { attachment_policy: 'metadata_only', body_policy: 'text_only', include_headers: false, tombstones_enabled: true },
      runtime: { polling_interval_ms: 60_000, acquire_lock_timeout_ms: 1_000, cleanup_tmp_on_startup: true, rebuild_views_after_sync: false, rebuild_search_after_sync: false },
      admission: { mail: { included_folder_refs: ['inbox'], allowed_sender_domains: ['allowed.test'], unknown_sender_behavior: 'ignore' } },
      policy: { primary_charter: 'fixture', allowed_actions: ['no_action'], require_human_approval: true },
    }],
  }, null, 2), 'utf8');
  writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
    schema: 'narada.site_loop.config.v2',
    loop_id: 'isolated.site-loop.e2e',
    site_id: siteId,
    display_name: 'Isolated process-backed Site Loop E2E',
    resident: { agent_id: `${siteId}.resident`, role: 'resident' },
    refs: { ticket_projection: { kind: 'work_lifecycle', ref: '.ai/work-lifecycle.db' } },
    docs: [{ path: 'AGENTS.md', description: 'Isolated E2E instructions.' }, { path: 'README.md', description: 'Isolated E2E readme.' }],
    commands: {
      source_sync: { execution: 'direct_spawn', enabled: true, command: process.execPath, args: [BRIDGE_ENTRYPOINT, '--mode', 'source', '--site-root', siteRoot], working_directory: siteRoot },
      ticket_task_reconciliation: { execution: 'direct_spawn', enabled: true, command: process.execPath, args: [BRIDGE_ENTRYPOINT, '--mode', 'tickets', '--site-root', siteRoot], working_directory: siteRoot },
    },
  }, null, 2), 'utf8');
}

async function prepareScenario(siteRoot: string): Promise<void> {
  const lifecycle = prepareTaskLifecycleMcpSite(siteRoot);
  assert.equal(lifecycle.preparation.status, 'prepared', JSON.stringify(lifecycle));
  const siteStore = openSiteLoopStore(siteRoot, { storeMode: 'prepare' });
  siteStore.close();
  const workPreparation = await runBoundedProcess(process.execPath, [WORK_ENTRYPOINT, '--prepare', '--site-root', siteRoot], {
    cwd: siteRoot,
    label: 'isolated Work Lifecycle preparation',
    timeoutMs: 15_000,
    maxOutputBytes: 8_000,
  });
  assert.equal(workPreparation.timedOut, false, JSON.stringify(workPreparation));
  assert.equal(workPreparation.exitCode, 0, JSON.stringify(workPreparation));
}

type ProcessResult = Awaited<ReturnType<typeof runBoundedProcess>>;

async function runSupervisor(siteRoot: string, siteId: string, fixture: Fixture, boundary?: Boundary): Promise<ProcessResult> {
  const scope = createTestProcessScope({ label: `isolated Site Loop supervisor ${boundary ?? 'replay'}`, closeTimeoutMs: 3_000 });
  const environment = siteEnvironment(siteRoot, siteId, fixture);
  if (boundary) environment.NARADA_SITE_LOOP_E2E_INTERRUPT_AFTER = boundary;
  else delete environment.NARADA_SITE_LOOP_E2E_INTERRUPT_AFTER;
  try {
    return await runBoundedProcess(process.execPath, [
      SUPERVISOR_ENTRYPOINT,
      '--site-root', siteRoot,
      '--source-sync',
      '--cycles', '1',
      '--interval-ms', '0',
      '--source-sync-timeout-ms', '35_000',
      '--ticket-task-reconciliation-timeout-ms', '60_000',
      '--limit', '10',
    ], {
      cwd: siteRoot,
      env: environment,
      label: `isolated Site Loop supervisor ${boundary ?? 'replay'}`,
      maxOutputBytes: 60_000,
      scope,
      timeoutMs: 75_000,
    });
  } finally {
    await scope.close();
    scope.assertClean();
  }
}

async function readBack(siteRoot: string, siteId: string, fixture: Fixture, boundary: Boundary): Promise<JsonRecord> {
  const scope = createTestProcessScope({ label: 'isolated E2E MCP readbacks', closeTimeoutMs: 2_000 });
  const servers: Array<{ close: () => Promise<void>; client: JsonlMcpClient }> = [];
  try {
    const site = spawnContentLengthMcpServer(process.execPath, [SITE_LOOP_ENTRYPOINT, '--site-root', siteRoot], {
      cwd: siteRoot, env: siteEnvironment(siteRoot, siteId, fixture), scope, label: 'isolated Site Loop MCP readback', timeoutMs: 15_000, closeTimeoutMs: 2_000,
    });
    servers.push(site);
    await runMcpProtocolSmoke(site.client, { expectedServerName: 'narada-site-loop-mcp', requiredTools: ['site_loop_config_validate', 'site_loop_runs_list', 'site_loop_run_show'] });
    const validation = await call(site.client, 'site_loop_config_validate');
    assert.equal(validation.status, 'ok', JSON.stringify(validation));
    const runs = await call(site.client, 'site_loop_runs_list', { limit: 10 });
    const runRows = arrayAt(runs, 'runs');
    assert.equal(runRows.length > 0, true, JSON.stringify(runs));
    const latestRun = runRows[0];
    const shownRun = await call(site.client, 'site_loop_run_show', { run_id: latestRun.run_id, detail: 'summary' }, 'site_loop_output_show');
    const run = record(shownRun.run);
    const runJson = JSON.stringify(run);
    assert.equal(runJson.includes('source_sync'), true, runJson.slice(-8_000));
    assert.equal(runJson.includes('ticket_task_reconciliation'), true, runJson.slice(-8_000));
    assert.equal(runJson.includes('"status":"skipped"'), false, runJson.slice(-8_000));

    const mailbox = spawnJsonlMcpServer(process.execPath, [MAILBOX_ENTRYPOINT, '--site-root', siteRoot], { cwd: siteRoot, env: siteEnvironment(siteRoot, siteId, fixture), scope, label: 'isolated Mailbox MCP readback', timeoutMs: 15_000, closeTimeoutMs: 2_000 });
    servers.push(mailbox);
    await runMcpProtocolSmoke(mailbox.client, { expectedServerName: 'narada-mailbox-mcp', requiredTools: ['mailbox_generation_show', 'mailbox_outbox_list'] });
    const evidence = readEvidence(siteRoot);
    const sourceEvidence = readPhaseEvidence(siteRoot, 'source_sync');
    assert.equal(sourceEvidence.status, 'ok', JSON.stringify(sourceEvidence));
    assert.equal(sourceEvidence.cursor_advanced, true, JSON.stringify(sourceEvidence));
    const sourceCursor = record(sourceEvidence.cursor);
    assert.equal(sourceCursor.advanced, true, JSON.stringify(sourceEvidence));
    assert.equal(typeof sourceCursor.next_cursor_sha256, 'string', JSON.stringify(sourceEvidence));
    assert.equal(record(sourceEvidence.sync_result).idempotency_replayed, true, `source_sync.sync_replay:${JSON.stringify(sourceEvidence)}`);
    assert.equal(
      record(sourceEvidence.observation_result).idempotency_replayed,
      boundary !== 'mailbox_generation_cursor_committed',
      `source_sync.observation_replay:${boundary}:${JSON.stringify(sourceEvidence)}`,
    );
    const sourceAdmissions = arrayAt(sourceEvidence, 'admissions');
    assert.equal(sourceAdmissions.length, 2, JSON.stringify(sourceEvidence));
    assert.equal(new Set(sourceAdmissions.map((item) => String(item.message_id))).size, 2, JSON.stringify(sourceEvidence));
    assert.equal(new Set(sourceAdmissions.map((item) => String(item.fact_id))).size, 2, JSON.stringify(sourceEvidence));
    assert.equal(new Set(sourceAdmissions.map((item) => String(item.event_id))).size, 2, JSON.stringify(sourceEvidence));
    const sourceProjectionReplayExpected = !boundary.startsWith('mailbox_');
    assert.equal(
      sourceAdmissions.every((item) => record(item.admission_result).idempotency_replayed === sourceProjectionReplayExpected),
      true,
      `source_sync.admission_replay:${boundary}:${JSON.stringify(sourceEvidence)}`,
    );
    assert.equal(
      sourceAdmissions.every((item) => record(item.acknowledgment_result).replayed === sourceProjectionReplayExpected),
      true,
      `source_sync.outbox_ack_replay:${boundary}:${JSON.stringify(sourceEvidence)}`,
    );
    const generationId = String(
      evidence.generation_id
        ?? record(evidence.durable_boundary_evidence).generation_id
        ?? sourceEvidence.generation_id
        ?? record(sourceEvidence.durable_boundary_evidence).generation_id
        ?? '',
    );
    assert.ok(generationId, JSON.stringify(evidence));
    const generation = await call(mailbox.client, 'mailbox_generation_show', { generation_id: generationId });
    assert.equal(String(generation.status ?? record(generation.generation).status), 'completed', JSON.stringify(generation));
    for (const consumerId of ['site-loop-e2e:mail-admission', 'site-loop-e2e:ticket-mail']) {
      const outbox = await call(mailbox.client, 'mailbox_outbox_list', { consumer_id: consumerId, limit: 20 });
      assert.equal(arrayAt(outbox, 'items', 'events').length, 0, JSON.stringify(outbox));
    }

    const work = spawnJsonlMcpServer(process.execPath, [WORK_ENTRYPOINT, '--site-root', siteRoot], { cwd: siteRoot, env: siteEnvironment(siteRoot, siteId, fixture), scope, label: 'isolated Work Lifecycle MCP readback', timeoutMs: 15_000, closeTimeoutMs: 2_000 });
    servers.push(work);
    await runMcpProtocolSmoke(work.client, { expectedServerName: 'work-lifecycle-mcp', requiredTools: ['ticket_list', 'ticket_show', 'ticket_sources_list', 'work_outbox_list'] });
    const ticketsResult = await call(work.client, 'ticket_list', { limit: 20 });
    const tickets = arrayAt(ticketsResult, 'tickets', 'items');
    assert.equal(tickets.length, 2, JSON.stringify(ticketsResult));
    const listedTicketIds = tickets.map((ticket) => String(ticket.ticket_id ?? ticket.id));
    assert.equal(new Set(listedTicketIds).size, 2, JSON.stringify(ticketsResult));
    const routes: JsonRecord[] = [];
    for (const ticket of tickets) {
      const ticketId = String(ticket.ticket_id ?? ticket.id);
      const shown = await call(work.client, 'ticket_show', { ticket_id: ticketId });
      const shownJson = JSON.stringify(shown);
      const messageId = shownJson.includes('message-followup') ? 'message-followup' : 'message-response';
      const hasDraft = arrayAt(shown, 'draft_refs').length === 1;
      const hasTask = arrayAt(shown, 'task_links').length === 1;
      assert.equal(hasDraft !== hasTask, true, shownJson.slice(-8_000));
      assert.equal(messageId === 'message-response' ? hasDraft : hasTask, true, shownJson.slice(-8_000));
      routes.push({ ticket_id: ticketId, message_id: messageId, route: hasDraft ? 'response_draft' : 'followup_task' });
      const sources = await call(work.client, 'ticket_sources_list', { ticket_id: ticketId });
      assert.equal(arrayAt(sources, 'sources', 'items').length, 1, JSON.stringify(sources));
    }
    const ticketEvidence = readPhaseEvidence(siteRoot, 'ticket_task_reconciliation');
    assert.equal(ticketEvidence.status, 'success', JSON.stringify(ticketEvidence));
    assert.equal(ticketEvidence.ticket_count, 2, JSON.stringify(ticketEvidence));
    assert.equal(new Set(arrayAt(ticketEvidence, 'routes').map((item) => `${item.message_id}:${item.route}`)).size, 2, JSON.stringify(ticketEvidence));
    assert.equal(new Set(arrayAt(ticketEvidence, 'routes').map((item) => String(item.route))).size, 2, JSON.stringify(ticketEvidence));
    const ticketReceipts = record(ticketEvidence.receipts);
    assert.equal(ticketReceipts.scheduler_terminal_count, 2, JSON.stringify(ticketEvidence));
    assert.equal(ticketReceipts.work_outbox_ack_count, 2, JSON.stringify(ticketEvidence));
    assert.equal(ticketReceipts.work_outbox_acknowledged, true, JSON.stringify(ticketEvidence));
    assert.equal(ticketReceipts.draft_receipt_count, 1, JSON.stringify(ticketEvidence));
    assert.equal(ticketEvidence.no_duplicate_projection, true, JSON.stringify(ticketEvidence));
    const processingOutbox = await call(work.client, 'work_outbox_list', { consumer_id: 'site-loop-e2e:work-processing', topics: ['work.ticket-work-due.v1'], limit: 20 });
    assert.equal(arrayAt(processingOutbox, 'events', 'items').length, 0, JSON.stringify(processingOutbox));

    const scheduler = spawnJsonlMcpServer(process.execPath, [SCHEDULER_ENTRYPOINT, '--allowed-root', siteRoot], { cwd: siteRoot, env: siteEnvironment(siteRoot, siteId, fixture), scope, label: 'isolated Scheduler MCP readback', timeoutMs: 15_000, closeTimeoutMs: 2_000 });
    servers.push(scheduler);
    await runMcpProtocolSmoke(scheduler.client, { expectedServerName: 'scheduler-mcp', requiredTools: ['scheduler_runtime_status', 'scheduler_activation_list'] });
    const activations = await call(scheduler.client, 'scheduler_activation_list', { limit: 20 });
    const rows = arrayAt(activations, 'activations', 'items');
    assert.equal(rows.length, 2, JSON.stringify(activations));
    assert.equal(rows.every((row) => row.status === 'terminal'), true, JSON.stringify(activations));
    assert.equal(new Set(rows.map((row) => String(row.activation_id))).size, 2, JSON.stringify(activations));
    assert.equal(new Set(rows.map((row) => String(row.sop_run_id))).size, 2, JSON.stringify(activations));

    for (const messageId of ['message-response', 'message-followup']) {
      const sessionPath = join(siteRoot, '.narada', 'crew', 'nars-sessions', narsSessionId(siteId, messageId), 'events.jsonl');
      const text = readJsonLines(sessionPath).join('\n');
      assert.equal(text.includes('narada.site_loop.agent_decision.v1'), true, `NARS decision missing for ${messageId}`);
    }
    assert.equal(fixture.modelRequests.some((request) => JSON.stringify(request).includes('message-response')), true, 'response model request missing');
    assert.equal(fixture.modelRequests.some((request) => JSON.stringify(request).includes('message-followup')), true, 'follow-up model request missing');
    assert.equal(fixture.graphRequests.length > 0, true, 'Graph fixture was not exercised');
    return { validation, run: { run_id: latestRun.run_id, status: run.status }, generation, tickets: routes, activations: rows, evidence };
  } finally {
    for (const server of servers.reverse()) await server.close();
    await scope.close();
    scope.assertClean();
  }
}

async function readLatestRunForFailure(siteRoot: string, siteId: string, fixture: Fixture): Promise<JsonRecord> {
  const scope = createTestProcessScope({ label: 'isolated E2E failure diagnosis', closeTimeoutMs: 2_000 });
  const server = spawnContentLengthMcpServer(process.execPath, [SITE_LOOP_ENTRYPOINT, '--site-root', siteRoot], {
    cwd: siteRoot,
    env: siteEnvironment(siteRoot, siteId, fixture),
    scope,
    label: 'isolated Site Loop failure diagnosis',
    timeoutMs: 15_000,
    closeTimeoutMs: 2_000,
  });
  try {
    await runMcpProtocolSmoke(server.client, {
      expectedServerName: 'narada-site-loop-mcp',
      requiredTools: ['site_loop_runs_list', 'site_loop_run_show'],
    });
    const runs = await call(server.client, 'site_loop_runs_list', { limit: 3 }, 'site_loop_output_show');
    const latest = arrayAt(runs, 'runs')[0];
    if (!latest?.run_id) return { runs };
    const shown = await call(server.client, 'site_loop_run_show', { run_id: latest.run_id, detail: 'summary' }, 'site_loop_output_show');
    const run = record(shown.run);
    return {
      latest_run_id: latest.run_id,
      status: run.status,
      error: run.error ?? null,
      steps: arrayAt(run, 'steps'),
    };
  } finally {
    await server.close();
    await scope.close();
    scope.assertClean();
  }
}

async function runScenario(boundary: Boundary, index: number): Promise<JsonRecord> {
  const fixture = await startFixture();
  const siteRoot = mkdtempSync(join(NARADA_SONAR_ROOT, '.ai', `site-loop-isolated-e2e-${index}-`));
  const siteId = `site:isolated-loop-e2e-${index}`;
  try {
    writeScenario(siteRoot, siteId, fixture);
    await prepareScenario(siteRoot);
    await seedIntelligence(siteRoot, siteId, fixture);
    const interrupted = await runSupervisor(siteRoot, siteId, fixture, boundary);
    assert.equal(interrupted.timedOut, false, JSON.stringify(interrupted));
    assert.notEqual(interrupted.exitCode, 0, `interruption ${boundary} was not observed: ${JSON.stringify(interrupted)}`);
    const interruptionEvidence = readEvidence(siteRoot);
    assert.equal(interruptionEvidence.status, 'interrupted', JSON.stringify({
      evidence: {
        status: interruptionEvidence.status,
        interruption_requested: interruptionEvidence.interruption_requested,
        interruption_boundary: interruptionEvidence.interruption_boundary,
        error: typeof interruptionEvidence.error === 'string' ? interruptionEvidence.error.slice(-4_000) : interruptionEvidence.error ?? null,
      },
      supervisor: { exit_code: interrupted.exitCode, stdout: interrupted.stdout.slice(-4_000), stderr: interrupted.stderr.slice(-4_000) },
    }));
    assert.equal(interruptionEvidence.interruption_boundary, boundary, JSON.stringify(interruptionEvidence));
    assert.equal(interruptionEvidence.phase, boundary.startsWith('mailbox_') ? 'source' : 'tickets', JSON.stringify(interruptionEvidence));
    assertDurableBoundaryEvidence(boundary, interruptionEvidence);

    const replay = await runSupervisor(siteRoot, siteId, fixture);
    assert.equal(replay.timedOut, false, JSON.stringify(replay));
    if (replay.exitCode !== 0) {
      let persisted: JsonRecord;
      try {
        persisted = await readLatestRunForFailure(siteRoot, siteId, fixture);
      } catch (error) {
        persisted = { diagnostic_error: error instanceof Error ? error.message : String(error) };
      }
      let bridgeError: string | null = null;
      try {
        const bridgeEvidence = readEvidence(siteRoot);
        bridgeError = JSON.stringify({
          status: bridgeEvidence.status,
          phase: bridgeEvidence.phase,
          interruption_requested: bridgeEvidence.interruption_requested,
          interruption_boundary: bridgeEvidence.interruption_boundary,
          error: typeof bridgeEvidence.error === 'string' ? bridgeEvidence.error.slice(-4_000) : bridgeEvidence.error ?? null,
        });
      } catch {}
      assert.fail(JSON.stringify({
        replay: { exit_code: replay.exitCode, duration_ms: replay.durationMs, stderr: replay.stderr.slice(-4_000) },
        persisted: {
          latest_run_id: persisted.latest_run_id,
          status: persisted.status,
          error: typeof persisted.error === 'string'
            ? persisted.error.slice(-4_000)
            : persisted.error == null ? null : JSON.stringify(persisted.error).slice(-4_000),
          step_count: Array.isArray(persisted.steps) ? persisted.steps.length : null,
        },
        bridge_error: bridgeError,
      }));
    }
    const replayJson = JSON.parse(replay.stdout.trim()) as JsonRecord;
    assert.equal(replayJson.status, 'ok', JSON.stringify(replayJson));
    assert.equal(replayJson.health_status, 'healthy', JSON.stringify(replayJson));
    const readback = await readBack(siteRoot, siteId, fixture, boundary);
    return { boundary, interruption: interruptionEvidence, replay: { duration_ms: replay.durationMs }, readback };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`isolated_e2e_scenario_failed:${boundary}:${message.slice(-4_000)}:fixture=${JSON.stringify({
      graph_requests: fixture.graphRequests.slice(-20),
      model_request_count: fixture.modelRequests.length,
    })}`);
  } finally {
    try {
      await fixture.close();
    } finally {
      // Child scopes can finish their root process before a sibling descendant
      // has released its final SQLite handle. Defer deletion until the matrix
      // barrier below, after every scenario worker has settled.
      temporaryScenarioRoots.add(siteRoot);
    }
  }
}

function selectedBoundaries(): readonly Boundary[] {
  const marker = process.argv.indexOf('--boundary');
  if (marker < 0) return ISOLATED_INTERRUPTION_BOUNDARIES;
  const value = process.argv[marker + 1];
  assert.equal(ISOLATED_INTERRUPTION_BOUNDARIES.includes(value as Boundary), true, `unknown isolated E2E boundary: ${value}`);
  return [value as Boundary];
}

async function main(): Promise<void> {
  assertEntrypoints();
  mkdirSync(join(NARADA_SONAR_ROOT, '.ai'), { recursive: true });
  const startedAt = Date.now();
  const boundaries = selectedBoundaries();
  const scenarios: JsonRecord[] = new Array(boundaries.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= boundaries.length) return;
      const boundary = boundaries[index] as Boundary;
      assert.equal(Date.now() - startedAt < ISOLATED_E2E_DEADLINE_MS, true, `isolated E2E deadline exceeded before ${boundary}`);
      scenarios[index] = await runScenario(boundary, index);
    }
  };
  const workerResults = await Promise.allSettled(
    Array.from({ length: Math.min(ISOLATED_E2E_CONCURRENCY, boundaries.length) }, () => runWorker()),
  );
  const scenarioFailure = workerResults.find((result) => result.status === 'rejected')?.reason ?? null;
  const cleanupFailures = [...temporaryScenarioRoots].filter((root) => !removeTemporaryE2eRoot(root));
  assert.equal(cleanupFailures.length, 0, `isolated E2E temp root cleanup failed: ${cleanupFailures.join(', ')}`);
  if (scenarioFailure) throw scenarioFailure;
  assert.equal(scenarios.every(Boolean), true, 'isolated E2E scenario worker omitted a boundary');
  const result = {
    schema: 'narada.site_loop.isolated_e2e.result.v1',
    test_id: TEST_ID,
    status: boundaries.length === ISOLATED_INTERRUPTION_BOUNDARIES.length ? 'passed' : 'partial',
    coverage: boundaries.length === ISOLATED_INTERRUPTION_BOUNDARIES.length ? 'complete' : 'partial',
    full_matrix: boundaries.length === ISOLATED_INTERRUPTION_BOUNDARIES.length,
    duration_ms: Date.now() - startedAt,
    deadline_ms: ISOLATED_E2E_DEADLINE_MS,
    interruption_manifest: ISOLATED_INTERRUPTION_BOUNDARIES,
    selected_boundaries: boundaries,
    scenarios: scenarios.map((scenario) => ({ boundary: scenario.boundary, replay_ms: record(scenario.replay).duration_ms })),
    external_boundaries: { mailbox: 'deterministic_graph_contract_fixture', model: 'deterministic_openai_contract_fixture' },
    real_processes: ['site_loop_supervisor', 'site_loop_mcp', 'mailbox_mcp', 'task_lifecycle_mcp', 'work_lifecycle_mcp', 'scheduler_mcp', 'nars'],
    exactly_once_scope: 'stable_idempotency_keys_and_canonical_work_lifecycle_projection',
    no_silent_skips: true,
  };
  mkdirSync(join(SITE_LOOP_PACKAGE_ROOT, '.tmp', 'e2e-results'), { recursive: true });
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
  if (result.status !== 'passed') process.exitCode = 2;
}

let deadlineTimer: NodeJS.Timeout | null = null;
let deadlineExceeded = false;
const timeout = new Promise<never>((_, reject) => {
  deadlineTimer = setTimeout(() => {
    deadlineExceeded = true;
    reject(new Error(`isolated_e2e_deadline_exceeded:${ISOLATED_E2E_DEADLINE_MS}`));
  }, ISOLATED_E2E_DEADLINE_MS);
});
try {
  await Promise.race([main(), timeout]);
} catch (error) {
  const result = {
    schema: 'narada.site_loop.isolated_e2e.result.v1',
    test_id: TEST_ID,
    status: 'failed',
    error: error instanceof Error ? error.message.slice(-6_000) : String(error).slice(-6_000),
    deadline_ms: ISOLATED_E2E_DEADLINE_MS,
  };
  mkdirSync(join(SITE_LOOP_PACKAGE_ROOT, '.tmp', 'e2e-results'), { recursive: true });
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.error(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  if (deadlineTimer) clearTimeout(deadlineTimer);
  if (deadlineExceeded) process.exit(1);
}
