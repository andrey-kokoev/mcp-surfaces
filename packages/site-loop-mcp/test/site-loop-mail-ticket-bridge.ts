import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createTestProcessScope,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  structured,
  type JsonlMcpClient,
  type JsonRecord,
} from '@narada-core/mcp-e2e-harness';

type AnyRecord = Record<string, any>;

const CHILD_MCP_REQUEST_TIMEOUT_MS = 40_000;

function narsSessionId(messageId: string): string {
  const siteId = String(process.env.NARADA_SITE_ID ?? 'site-loop-e2e').replace(/[^a-z0-9_-]+/gi, '_');
  return `${siteId}-${messageId}`;
}

function residentAgentId(): string {
  const siteId = String(process.env.NARADA_SITE_ID ?? 'site-loop-e2e').trim();
  return `${siteId}.resident`;
}

const BUILD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_LOOP_PACKAGE_ROOT = resolve(BUILD_ROOT, '..');
const PACKAGES_ROOT = resolve(SITE_LOOP_PACKAGE_ROOT, '..');
const NARADA_ROOT = resolve(process.env.NARADA_E2E_NARADA_ROOT ?? 'D:/code/narada');
const MAILBOX_ENTRYPOINT = join(PACKAGES_ROOT, 'mailbox-mcp', 'dist', 'src', 'main.js');
const WORK_ENTRYPOINT = join(PACKAGES_ROOT, 'work-lifecycle-mcp', 'dist', 'src', 'main.js');
const SCHEDULER_ENTRYPOINT = join(PACKAGES_ROOT, 'scheduler-mcp', 'dist', 'src', 'main.js');
const TASK_ENTRYPOINT = join(PACKAGES_ROOT, 'task-lifecycle-mcp', 'dist', 'src', 'task-lifecycle', 'task-mcp-server.js');
const NARS_ENTRYPOINT = process.env.NARADA_E2E_RUNTIME_SERVER_ENTRYPOINT
  ?? join(NARADA_ROOT, 'packages', 'agent-runtime-server', 'dist', 'bin', 'narada-agent-runtime-server.js');

const TEST_SCHEMA = 'narada.site_loop.isolated_bridge.v1';
const MAILBOX_SCOPE = 'support';
const MAILBOX_CONFIG = 'config/config.json';
const MESSAGE_IDS = ['message-response', 'message-followup'] as const;
const INTERRUPTION_BOUNDARIES = [
  'mailbox_generation_cursor_committed',
  'mailbox_observation_receipt',
  'ticket_source_projection',
  'scheduler_activation_admitted',
  'agent_decision_receipt',
  'terminal_proposal_projection',
] as const;
type InterruptionBoundary = typeof INTERRUPTION_BOUNDARIES[number];

let requestId = 0;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as JsonRecord[] : [];
}

function requiredString(value: unknown, label: string): string {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label}_required`);
  return result;
}

function stringAt(value: unknown, key: string): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = (value as JsonRecord)[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    for (const child of Object.values(value as JsonRecord)) {
      const nested = stringAt(child, key);
      if (nested) return nested;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const nested = stringAt(child, key);
      if (nested) return nested;
    }
  }
  return null;
}

function arrayAt(value: unknown, ...keys: string[]): JsonRecord[] {
  for (const key of keys) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const candidate = (value as JsonRecord)[key];
      if (Array.isArray(candidate)) return records(candidate);
    }
  }
  return [];
}

function childEnvironment(siteRoot: string): NodeJS.ProcessEnv {
  return siteFabricChildEnv(siteRoot, {
    ...process.env,
    NARADA_SITE_ROOT: siteRoot,
    NARADA_WORKSPACE_ROOT: siteRoot,
    GRAPH_ACCESS_TOKEN: process.env.GRAPH_ACCESS_TOKEN ?? 'site-loop-isolated-graph-token',
    NARADA_SITE_LOOP_E2E_BRIDGE: '1',
  });
}

async function call(client: JsonlMcpClient, name: string, args: JsonRecord = {}): Promise<JsonRecord> {
  const response = await client.request(++requestId, 'tools/call', { name, arguments: args });
  const result = structured(response);
  if (typeof result.output_ref === 'string') {
    throw new Error(`isolated_bridge_unbounded_output:${name}`);
  }
  return result;
}

async function openMcp(
  entrypoint: string,
  siteRoot: string,
  label: string,
  serverName: string,
  requiredTools: readonly string[],
  scope: ReturnType<typeof createTestProcessScope>,
): Promise<ReturnType<typeof spawnJsonlMcpServer>> {
  if (!existsSync(entrypoint)) throw new Error(`isolated_bridge_entrypoint_missing:${entrypoint}`);
  const serverArgs = entrypoint === SCHEDULER_ENTRYPOINT
    ? [entrypoint, '--allowed-root', siteRoot]
    : [entrypoint, '--site-root', siteRoot];
  const server = spawnJsonlMcpServer(process.execPath, serverArgs, {
    cwd: siteRoot,
    env: childEnvironment(siteRoot),
    label,
    scope,
    timeoutMs: CHILD_MCP_REQUEST_TIMEOUT_MS,
    closeTimeoutMs: 2_000,
  });
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: serverName,
    requiredTools,
    initializeId: `${label}:initialize`,
    toolsListId: `${label}:tools`,
  });
  return server;
}

function evidencePath(siteRoot: string): string {
  const root = join(siteRoot, '.ai', 'runtime', 'site-loop-e2e');
  mkdirSync(root, { recursive: true });
  return join(root, 'bridge-evidence.json');
}

function recordEvidence(siteRoot: string, value: JsonRecord): void {
  const evidenceFile = evidencePath(siteRoot);
  const payload = {
    ...value,
    schema: TEST_SCHEMA,
    recorded_at: new Date().toISOString(),
  };
  const serialized = JSON.stringify(payload, null, 2);
  writeFileSync(evidenceFile, serialized, 'utf8');
  if (typeof value.phase === 'string' && value.phase.trim()) {
    const phase = value.phase.replace(/[^a-z0-9_-]+/gi, '_');
    writeFileSync(join(dirname(evidenceFile), `bridge-${phase}.json`), serialized, 'utf8');
  }
}

function readRecordedEvidence(siteRoot: string): JsonRecord {
  try {
    return JSON.parse(readFileSync(evidencePath(siteRoot), 'utf8')) as JsonRecord;
  } catch {
    return {};
  }
}

function requestedInterruption(): InterruptionBoundary | null {
  const value = process.env.NARADA_SITE_LOOP_E2E_INTERRUPT_AFTER;
  return INTERRUPTION_BOUNDARIES.includes(value as InterruptionBoundary)
    ? value as InterruptionBoundary
    : null;
}

class InjectedInterruption extends Error {
  readonly boundary: InterruptionBoundary;

  constructor(boundary: InterruptionBoundary) {
    super(`isolated_bridge_injected_interruption:${boundary}`);
    this.name = 'InjectedInterruption';
    this.boundary = boundary;
  }
}

function checkpoint(siteRoot: string, boundary: InterruptionBoundary, details: JsonRecord = {}): void {
  if (requestedInterruption() !== boundary) return;
  recordEvidence(siteRoot, {
    status: 'interrupted',
    interruption_boundary: boundary,
    durable_boundary_evidence: details,
  });
  throw new InjectedInterruption(boundary);
}

function mailboxEvents(result: JsonRecord): JsonRecord[] {
  return arrayAt(result, 'items', 'events', 'outbox');
}

function workEvents(result: JsonRecord): JsonRecord[] {
  return arrayAt(result, 'events', 'items', 'outbox');
}

function eventPayload(event: JsonRecord): JsonRecord {
  return record(event.payload);
}

function eventMessageId(event: JsonRecord): string {
  return requiredString(eventPayload(event).message_id, 'mailbox_event_message_id');
}

function admissionArguments(result: JsonRecord): JsonRecord {
  const nested = record(result.result);
  const args = record(nested.ticket_admit_source_arguments);
  if (nested.decision !== 'admitted' || !args.immutable_source_id) {
    throw new Error(`isolated_bridge_message_not_admitted:${JSON.stringify({ decision: nested.decision, reason: nested.reason })}`);
  }
  return args;
}

async function runSource(siteRoot: string): Promise<JsonRecord> {
  const scope = createTestProcessScope({ label: 'isolated Site Loop source bridge', closeTimeoutMs: 2_000 });
  const servers: Array<ReturnType<typeof spawnJsonlMcpServer>> = [];
  const executed: string[] = [];
  let mailboxOutboxAckCount = 0;
  try {
    const mailbox = await openMcp(MAILBOX_ENTRYPOINT, siteRoot, 'isolated mailbox source', 'narada-mailbox-mcp', [
      'mailbox_doctor', 'mailbox_sync_generation', 'mailbox_reconcile_first_observations',
      'mailbox_message_admit', 'mailbox_outbox_consumer_register', 'mailbox_outbox_list', 'mailbox_outbox_ack',
    ], scope);
    servers.push(mailbox);
    const task = await openMcp(TASK_ENTRYPOINT, siteRoot, 'isolated legacy Task Lifecycle source', 'narada-task-lifecycle-mcp', [
      'task_lifecycle_doctor',
    ], scope);
    servers.push(task);

    const doctor = await call(mailbox.client, 'mailbox_doctor');
    const taskDoctor = await call(task.client, 'task_lifecycle_doctor');
    const sync = await call(mailbox.client, 'mailbox_sync_generation', {
      idempotency_key: 'site-loop-e2e:mailbox-sync',
      scope_id: MAILBOX_SCOPE,
      config_path: MAILBOX_CONFIG,
    });
    executed.push('mailbox_sync_generation');
    const generationId = requiredString(record(sync.result).generation_id ?? stringAt(sync, 'generation_id'), 'mailbox_generation_id');
    const generation = await call(mailbox.client, 'mailbox_generation_show', { generation_id: generationId });
    const generationRecord = record(generation.generation);
    const generationRows = arrayAt(generation, 'records');
    const generationMessageIds = generationRows.map((row) => String(row.message_id ?? '')).filter(Boolean);
    const parentCursorSha256 = typeof generationRecord.parent_cursor_sha256 === 'string' ? generationRecord.parent_cursor_sha256 : null;
    const nextCursorSha256 = typeof generationRecord.next_cursor_sha256 === 'string' ? generationRecord.next_cursor_sha256 : null;
    if (generationRecord.status !== 'completed') throw new Error(`isolated_bridge_generation_not_completed:${generationId}`);
    if (generationMessageIds.length !== MESSAGE_IDS.length || new Set(generationMessageIds).size !== MESSAGE_IDS.length
      || MESSAGE_IDS.some((messageId) => !generationMessageIds.includes(messageId))) {
      throw new Error(`isolated_bridge_generation_message_set:${JSON.stringify(generationRows)}`);
    }
    if (!nextCursorSha256 || nextCursorSha256 === parentCursorSha256) {
      throw new Error(`isolated_bridge_cursor_not_advanced:${JSON.stringify(generationRecord)}`);
    }
    checkpoint(siteRoot, 'mailbox_generation_cursor_committed', {
      generation_id: generationId,
      generation,
      cursor: { parent_cursor_sha256: parentCursorSha256, next_cursor_sha256: nextCursorSha256, advanced: true },
    });

    const observation = await call(mailbox.client, 'mailbox_reconcile_first_observations', {
      idempotency_key: 'site-loop-e2e:mailbox-observations',
      generation_id: generationId,
      scope_id: MAILBOX_SCOPE,
      config_path: MAILBOX_CONFIG,
      limit: 10,
    });
    executed.push('mailbox_reconcile_first_observations');
    const observationResult = record(observation.result);
    if (typeof observationResult.idempotency_replayed !== 'boolean') {
      throw new Error(`isolated_bridge_observation_replay_marker_missing:${JSON.stringify(observation)}`);
    }
    checkpoint(siteRoot, 'mailbox_observation_receipt', {
      generation_id: generationId,
      observation,
      observation_result: observationResult,
    });

    await call(mailbox.client, 'mailbox_outbox_consumer_register', {
      consumer_id: 'site-loop-e2e:mail-admission-audit',
      start_at: '1970-01-01T00:00:00.000Z',
    });
    await call(mailbox.client, 'mailbox_outbox_consumer_register', {
      consumer_id: 'site-loop-e2e:mail-admission',
      start_at: '1970-01-01T00:00:00.000Z',
    });
    const listed = await call(mailbox.client, 'mailbox_outbox_list', {
      consumer_id: 'site-loop-e2e:mail-admission-audit',
      limit: 20,
    });
    const events = mailboxEvents(listed).filter((event) => MESSAGE_IDS.includes(eventMessageId(event) as typeof MESSAGE_IDS[number]));
    const listedMessageIds = events.map(eventMessageId);
    if (events.length !== MESSAGE_IDS.length || new Set(listedMessageIds).size !== MESSAGE_IDS.length) {
      throw new Error(`isolated_bridge_mailbox_event_set:${JSON.stringify(listedMessageIds)}`);
    }
    const admissions: JsonRecord[] = [];
    for (const event of events) {
      const messageId = eventMessageId(event);
      const factId = requiredString(eventPayload(event).fact_id, 'mailbox_event_fact_id');
      const fact = await call(mailbox.client, 'mailbox_fact_show', { fact_id: factId, scope_id: MAILBOX_SCOPE });
      const admitted = await call(mailbox.client, 'mailbox_message_admit', {
        idempotency_key: `site-loop-e2e:mail-admission:${messageId}`,
        fact_id: factId,
        scope_id: MAILBOX_SCOPE,
        config_path: MAILBOX_CONFIG,
      });
      const sourceArgs = admissionArguments(admitted);
      const admissionAck = await call(mailbox.client, 'mailbox_outbox_ack', {
        consumer_id: 'site-loop-e2e:mail-admission',
        event_id: requiredString(event.event_id, 'mailbox_event_id'),
        receipt: {
          schema: 'narada.site_loop.mail_admission_receipt.v1',
          admission_id: stringAt(admitted, 'admission_id') ?? `mail-admission:${messageId}`,
          fact_id: factId,
          message_id: messageId,
        },
      });
      mailboxOutboxAckCount += 1;
      admissions.push({
        message_id: messageId,
        fact_id: factId,
        event_id: event.event_id,
        source_args: sourceArgs,
        fact_ref: fact.fact,
        admission_result: record(admitted.result),
        acknowledgment_result: admissionAck,
      });
    }
    executed.push('mailbox_message_admit');
    executed.push('mailbox_outbox_ack');
    const output = {
      schema: 'narada.site_loop.source_sync.v1',
      status: 'ok',
      interruption_requested: requestedInterruption(),
      generation_id: generationId,
      cursor: { parent_cursor_sha256: parentCursorSha256, next_cursor_sha256: nextCursorSha256, advanced: nextCursorSha256 !== parentCursorSha256 },
      cursor_advanced: nextCursorSha256 !== parentCursorSha256,
      generation_record_count: generationRows.length,
      generation_message_ids: generationMessageIds,
      sync_result: record(sync.result),
      observation_receipt: observation,
      observation_result: observationResult,
      mailbox_event_count: events.length,
      mailbox_outbox_ack_count: mailboxOutboxAckCount,
      admissions,
      task_lifecycle_doctor: taskDoctor,
      mailbox_doctor: doctor,
      executed_bridges: ['mailbox', 'task_lifecycle'],
      executed_operations: executed,
      interruption_manifest: INTERRUPTION_BOUNDARIES,
    };
    recordEvidence(siteRoot, { ...output, phase: 'source_sync', status: 'ok' });
    process.stdout.write(JSON.stringify(output) + '\n');
    return output;
  } finally {
    for (const server of servers.reverse()) await server.close();
    await scope.close();
    scope.assertClean();
  }
}

type NarsDecision = {
  schema: 'narada.site_loop.agent_decision.v1';
  route: 'response_draft' | 'followup_task';
  message_id: string;
  summary: string;
};

function findDecision(value: unknown, messageId: string): NarsDecision | null {
  if (typeof value === 'string') {
    try {
      return findDecision(JSON.parse(value), messageId);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findDecision(child, messageId);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const current = value as JsonRecord;
  if (current.schema === 'narada.site_loop.agent_decision.v1'
    && current.message_id === messageId
    && (current.route === 'response_draft' || current.route === 'followup_task')) {
    return {
      schema: 'narada.site_loop.agent_decision.v1',
      route: current.route,
      message_id: messageId,
      summary: String(current.summary ?? `decision for ${messageId}`),
    };
  }
  for (const child of Object.values(current)) {
    const found = findDecision(child, messageId);
    if (found) return found;
  }
  return null;
}

function persistedSessionEvents(siteRoot: string, sessionId: string): JsonRecord[] {
  const eventPath = join(siteRoot, '.narada', 'crew', 'nars-sessions', sessionId, 'events.jsonl');
  if (!existsSync(eventPath)) return [];
  return readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' ? [value as JsonRecord] : [];
    } catch {
      return [];
    }
  });
}

async function runNarsDecision(siteRoot: string, messageId: string, expectedRoute: NarsDecision['route']): Promise<{ decision: NarsDecision; session_id: string; events: number; spawned: boolean }> {
  const sessionId = narsSessionId(messageId);
  const agentId = residentAgentId();
  const existing = persistedSessionEvents(siteRoot, sessionId);
  const reused = existing.map((event) => findDecision(event, messageId)).find(Boolean) as NarsDecision | undefined;
  if (reused) {
    if (reused.route !== expectedRoute) throw new Error(`isolated_bridge_replayed_route_mismatch:${messageId}`);
    return { decision: reused, session_id: sessionId, events: existing.length, spawned: false };
  }
  if (!existsSync(NARS_ENTRYPOINT)) throw new Error(`isolated_bridge_nars_entrypoint_missing:${NARS_ENTRYPOINT}`);
  const scope = createTestProcessScope({ label: `isolated NARS ${messageId}`, closeTimeoutMs: 3_000 });
  const child = scope.spawn(process.execPath, [
    NARS_ENTRYPOINT,
    '--raw-jsonl',
    '--authority', 'read',
    '--identity', agentId,
    '--session', sessionId,
  ], {
    cwd: siteRoot,
    env: siteFabricChildEnv(siteRoot, {
      ...childEnvironment(siteRoot),
      NARADA_AGENT_ID: agentId,
      NARADA_CARRIER_SESSION_ID: sessionId,
      // The mechanical MCP surfaces are exercised by the supervisor and
      // bridge below. This NARS turn only returns the decision; disabling its
      // ambient MCP gateway keeps the agent decision boundary deterministic
      // and prevents unrelated MCP bootstrap from delaying carrier completion.
      NARADA_MCP_SCOPE: 'none',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events: JsonRecord[] = [];
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && typeof event === 'object') events.push(event as JsonRecord);
      } catch {
        // The protocol assertion below reports the bounded event tail.
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4_000); });
  const waitFor = async (predicate: (event: JsonRecord) => boolean, timeoutMs = 25_000): Promise<JsonRecord> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    throw new Error(`isolated_bridge_nars_timeout:${messageId}:${JSON.stringify({ events: events.slice(-12), stderr })}`);
  };
  const closeSession = async (): Promise<void> => {
    if (child.exitCode !== null || child.killed) return;
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(JSON.stringify({
        id: `site-loop-e2e-cancel-${messageId}`,
        method: 'session.cancel',
        params: { reason: 'test_scope_close' },
      }) + '\n');
      child.stdin.write(JSON.stringify({
        id: `site-loop-e2e-close-${messageId}`,
        method: 'session.close',
      }) + '\n');
      child.stdin.end();
    }
    await new Promise<void>((resolvePromise) => {
      if (child.exitCode !== null || child.killed) return resolvePromise();
      const timer = setTimeout(resolvePromise, 5_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  };
  try {
    await waitFor((event) => event.event === 'session_started');
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(JSON.stringify({
        id: `site-loop-e2e-decision-${messageId}`,
        method: 'session.submit',
        params: {
          content: `Decide the terminal route for mailbox message ${messageId}. Return the site_loop_agent_decision_v1 structured output. The required route is ${expectedRoute}.`,
        },
      }) + '\n');
    }
    await waitFor((event) => event.event === 'carrier_turn_completed');
    const decision = events.map((event) => findDecision(event, messageId)).find(Boolean) as NarsDecision | undefined;
    if (!decision) throw new Error(`isolated_bridge_nars_decision_missing:${messageId}:${JSON.stringify(events.slice(-12))}`);
    if (decision.route !== expectedRoute) throw new Error(`isolated_bridge_nars_route_mismatch:${messageId}`);
    return { decision, session_id: sessionId, events: events.length, spawned: true };
  } finally {
    await closeSession();
    await scope.close();
    scope.assertClean();
  }
}

function activationRows(result: JsonRecord): JsonRecord[] {
  return arrayAt(result, 'activations', 'items');
}

function ticketRefs(result: JsonRecord): { sources: JsonRecord[]; drafts: JsonRecord[]; tasks: JsonRecord[] } {
  const source = record(result.sources ?? record(result.result).sources);
  const direct = record(result.ticket);
  return {
    sources: arrayAt(result, 'sources').length ? arrayAt(result, 'sources') : arrayAt(source, 'items', 'sources'),
    drafts: arrayAt(result, 'draft_refs').length ? arrayAt(result, 'draft_refs') : arrayAt(direct, 'draft_refs'),
    tasks: arrayAt(result, 'task_links').length ? arrayAt(result, 'task_links') : arrayAt(direct, 'task_links'),
  };
}

async function runTickets(siteRoot: string): Promise<JsonRecord> {
  const scope = createTestProcessScope({ label: 'isolated Site Loop ticket bridge', closeTimeoutMs: 2_000 });
  const servers: Array<ReturnType<typeof spawnJsonlMcpServer>> = [];
  const executed: string[] = [];
  let mailboxOutboxAckCount = 0;
  try {
    const mailbox = await openMcp(MAILBOX_ENTRYPOINT, siteRoot, 'isolated mailbox ticket', 'narada-mailbox-mcp', [
      'mailbox_message_admit', 'mailbox_outbox_consumer_register', 'mailbox_outbox_list', 'mailbox_outbox_ack',
    ], scope);
    servers.push(mailbox);
    const work = await openMcp(WORK_ENTRYPOINT, siteRoot, 'isolated Work Lifecycle', 'work-lifecycle-mcp', [
      'work_lifecycle_doctor', 'ticket_list', 'ticket_show', 'ticket_sources_list', 'ticket_processing_context_load',
      'ticket_admit_source', 'ticket_admit_proposal', 'ticket_draft_receipt_record',
      'work_outbox_consumer_register', 'work_outbox_list', 'work_outbox_ack',
    ], scope);
    servers.push(work);
    const scheduler = await openMcp(SCHEDULER_ENTRYPOINT, siteRoot, 'isolated Scheduler', 'scheduler-mcp', [
      'scheduler_runtime_status', 'scheduler_activation_prepare', 'scheduler_binding_upsert', 'scheduler_binding_show',
      'scheduler_event_admit', 'scheduler_activation_list', 'scheduler_activation_claim',
      'scheduler_activation_admit_sop', 'scheduler_activation_resolve',
    ], scope);
    servers.push(scheduler);
    const task = await openMcp(TASK_ENTRYPOINT, siteRoot, 'isolated legacy Task Lifecycle ticket', 'narada-task-lifecycle-mcp', [
      'task_lifecycle_doctor',
    ], scope);
    servers.push(task);

    const mailboxDoctor = await call(mailbox.client, 'mailbox_doctor');
    const workDoctor = await call(work.client, 'work_lifecycle_doctor');
    const taskDoctor = await call(task.client, 'task_lifecycle_doctor');
    const runtime = await call(scheduler.client, 'scheduler_runtime_status');
    const implementationId = requiredString(runtime.implementation_id ?? stringAt(runtime, 'implementation_id'), 'scheduler_implementation_id');
    await call(scheduler.client, 'scheduler_activation_prepare', { implementation_id: implementationId });
    executed.push('scheduler_activation_prepare');

    await call(mailbox.client, 'mailbox_outbox_consumer_register', {
      consumer_id: 'site-loop-e2e:ticket-mail-audit',
      start_at: '1970-01-01T00:00:00.000Z',
    });
    await call(mailbox.client, 'mailbox_outbox_consumer_register', {
      consumer_id: 'site-loop-e2e:ticket-mail',
      start_at: '1970-01-01T00:00:00.000Z',
    });
    const mailboxOutbox = await call(mailbox.client, 'mailbox_outbox_list', {
      consumer_id: 'site-loop-e2e:ticket-mail-audit',
      limit: 20,
    });
    const mailboxEventsForTickets = mailboxEvents(mailboxOutbox).filter((event) => MESSAGE_IDS.includes(eventMessageId(event) as typeof MESSAGE_IDS[number]));
    if (mailboxEventsForTickets.length !== MESSAGE_IDS.length) throw new Error(`isolated_bridge_ticket_mailbox_event_count:${mailboxEventsForTickets.length}`);

    await call(work.client, 'work_outbox_consumer_register', {
      topic: 'work.ticket-work-due.v1',
      consumer_id: 'site-loop-e2e:work-audit',
    });
    await call(work.client, 'work_outbox_consumer_register', {
      topic: 'work.ticket-work-due.v1',
      consumer_id: 'site-loop-e2e:work-processing',
    });

    for (const event of mailboxEventsForTickets) {
      const messageId = eventMessageId(event);
      const mailboxAdmission = await call(mailbox.client, 'mailbox_message_admit', {
        idempotency_key: `site-loop-e2e:mail-admission:${messageId}`,
        fact_id: requiredString(eventPayload(event).fact_id, 'mailbox_event_fact_id'),
        scope_id: MAILBOX_SCOPE,
        config_path: MAILBOX_CONFIG,
      });
      const sourceArgs = admissionArguments(mailboxAdmission);
      await call(work.client, 'ticket_admit_source', {
        ...sourceArgs,
        idempotency_key: `site-loop-e2e:ticket-source:${messageId}`,
      });
      await call(mailbox.client, 'mailbox_outbox_ack', {
        consumer_id: 'site-loop-e2e:ticket-mail',
        event_id: requiredString(event.event_id, 'mailbox_event_id'),
        receipt: {
          schema: 'narada.site_loop.ticket_mail_receipt.v1',
          message_id: messageId,
          source_projection_key: `site-loop-e2e:ticket-source:${messageId}`,
        },
      });
      mailboxOutboxAckCount += 1;
    }
    executed.push('mailbox_message_admit');
    executed.push('ticket_admit_source');
    executed.push('mailbox_outbox_ack');

    const ticketsResult = await call(work.client, 'ticket_list', { limit: 20 });
    const tickets = arrayAt(ticketsResult, 'tickets', 'items');
    if (tickets.length !== MESSAGE_IDS.length) throw new Error(`isolated_bridge_ticket_count:${tickets.length}`);
    const ticketByMessage = new Map<string, { ticket: JsonRecord; source: JsonRecord }>();
    for (const listedTicket of tickets) {
      const ticketId = requiredString(listedTicket.ticket_id ?? listedTicket.id, 'ticket_id');
      const shown = await call(work.client, 'ticket_show', { ticket_id: ticketId });
      const refs = ticketRefs(shown);
      if (refs.sources.length !== 1) throw new Error(`isolated_bridge_ticket_source_count:${ticketId}:${refs.sources.length}`);
      const messageId = requiredString(refs.sources[0].immutable_source_id ?? refs.sources[0].message_id, 'ticket_source_message_id');
      ticketByMessage.set(messageId, { ticket: shown, source: refs.sources[0] });
    }
    for (const messageId of MESSAGE_IDS) if (!ticketByMessage.has(messageId)) throw new Error(`isolated_bridge_ticket_missing:${messageId}`);
    const ticketIds = [...ticketByMessage.values()].map((entry) => requiredString(stringAt(entry.ticket, 'ticket_id'), 'ticket_id'));
    const sourceIds = [...ticketByMessage.values()].map((entry) => requiredString(entry.source.source_id, 'ticket_source_id'));
    if (new Set(ticketIds).size !== MESSAGE_IDS.length || new Set(sourceIds).size !== MESSAGE_IDS.length) {
      throw new Error(`isolated_bridge_ticket_identity_duplicates:${JSON.stringify({ ticketIds, sourceIds })}`);
    }
    checkpoint(siteRoot, 'ticket_source_projection', {
      ticket_count: tickets.length,
      ticket_ids: ticketIds,
      source_ids: sourceIds,
    });

    const workOutbox = await call(work.client, 'work_outbox_list', {
      consumer_id: 'site-loop-e2e:work-audit',
      topics: ['work.ticket-work-due.v1'],
      limit: 20,
    });
    const dueEvents = workEvents(workOutbox);
    if (dueEvents.length !== MESSAGE_IDS.length) throw new Error(`isolated_bridge_work_due_count:${dueEvents.length}`);
    const topic = requiredString(dueEvents[0].topic ?? 'work.ticket-work-due.v1', 'work_due_topic');
    await call(scheduler.client, 'scheduler_binding_upsert', {
      binding_id: 'site-loop-e2e:ticket-processing',
      trigger_kind: 'domain_event',
      source_topic: topic,
      target_sop_id: 'site-loop-e2e.process-ticket',
      target_template_version: '1',
      concurrency: 'partitioned',
      default_delay_ms: 0,
      retry_base_ms: 100,
      retry_max_ms: 1_000,
      max_attempts: 3,
      terminal_outcomes: ['response_draft', 'followup_task'],
      implementation_id: implementationId,
    });
    executed.push('scheduler_binding_upsert');

    const processing: Array<{ messageId: string; sourceId: string; ticketId: string; eventId: string; sopRunId: string; activationId: string; expectedRevision: number; route: NarsDecision['route']; decision: NarsDecision; proposal: JsonRecord; schedulerEventStatus: string }> = [];
    for (const dueEvent of dueEvents) {
      const payload = eventPayload(dueEvent);
      const ticketId = requiredString(payload.ticket_id ?? stringAt(dueEvent, 'ticket_id'), 'work_due_ticket_id');
      const entry = [...ticketByMessage.entries()].find(([, value]) => stringAt(value.ticket, 'ticket_id') === ticketId);
      if (!entry) throw new Error(`isolated_bridge_work_due_ticket_unknown:${ticketId}`);
      const [messageId, ticketEntry] = entry;
      const workEventId = requiredString(dueEvent.event_id, 'work_due_event_id');
      const processingContextOperation = await call(work.client, 'ticket_processing_context_load', {
        ticket_id: ticketId,
        triggering_event_id: workEventId,
        idempotency_key: `site-loop-e2e:processing-context:${messageId}`,
      });
      const processingContext = record(processingContextOperation.result);
      const triggeringEvent = record(processingContext.triggering_event);
      const expectedRevision = Number(processingContext.ticket && record(processingContext.ticket).revision);
      const triggeringAggregateRevision = Number(triggeringEvent.aggregate_revision);
      if (!Number.isInteger(expectedRevision) || !Number.isInteger(triggeringAggregateRevision)) {
        throw new Error(`isolated_bridge_processing_context_revision_missing:${messageId}:${JSON.stringify(processingContextOperation)}`);
      }
      const schedulerEventId = `site-loop-e2e:scheduler-event:${messageId}`;
      const eventAdmission = await call(scheduler.client, 'scheduler_event_admit', {
        event_id: schedulerEventId,
        topic,
        partition_key: ticketId,
        aggregate_id: ticketId,
        aggregate_revision: triggeringAggregateRevision,
        schema_version: 1,
        causation_id: workEventId,
        idempotency_key: `site-loop-e2e:scheduler-event:${messageId}`,
        payload: {
          ticket_id: ticketId,
          message_id: messageId,
          work_event_id: workEventId,
          outcome: messageId === 'message-response' ? 'response_draft' : 'followup_task',
        },
        occurred_at: String(dueEvent.occurred_at ?? '2026-08-03T12:00:00.000Z'),
        implementation_id: implementationId,
      });
      if (Number(eventAdmission.activation_count ?? 0) !== 1) {
        throw new Error(`isolated_bridge_scheduler_event_activation_count:${messageId}:${JSON.stringify(eventAdmission)}`);
      }
      const existingActivationResult = await call(scheduler.client, 'scheduler_activation_list', {
        source_event_id: schedulerEventId,
        limit: 10,
      });
      let activation = activationRows(existingActivationResult)[0];
      if (!activation || ['pending', 'leased'].includes(String(activation.status))) {
        const claimed = await call(scheduler.client, 'scheduler_activation_claim', {
          consumer_id: 'site-loop-e2e:activation-dispatcher',
          lease_ms: 30_000,
          implementation_id: implementationId,
        });
        activation = record(claimed.activation);
        if (!activation.activation_id) {
          const activationRowsAfterClaim = await call(scheduler.client, 'scheduler_activation_list', { limit: 20 });
          throw new Error(`isolated_bridge_activation_not_claimed:${messageId}:${JSON.stringify({ claimed, activations: activationRowsAfterClaim })}`);
        }
        await call(scheduler.client, 'scheduler_activation_admit_sop', {
          activation_id: requiredString(activation.activation_id, 'activation_id'),
          consumer_id: 'site-loop-e2e:activation-dispatcher',
          lease_token: requiredString(activation.lease_token, 'lease_token'),
          sop_run_id: `site-loop-e2e:sop-run:${messageId}`,
          receipt_id: `site-loop-e2e:sop-admission:${messageId}`,
          receipt: { schema: 'narada.site_loop.sop_admission_receipt.v1', ticket_id: ticketId, message_id: messageId },
          implementation_id: implementationId,
        });
        activation = { ...activation, status: 'admitted', sop_run_id: `site-loop-e2e:sop-run:${messageId}` };
      }
      const sopRunId = requiredString(activation.sop_run_id ?? `site-loop-e2e:sop-run:${messageId}`, 'sop_run_id');
      processing.push({
        messageId,
        sourceId: requiredString(ticketEntry.source.source_id, 'ticket_source_id'),
        ticketId,
        eventId: workEventId,
        sopRunId,
        activationId: requiredString(activation.activation_id, 'activation_id'),
        expectedRevision,
        route: messageId === 'message-response' ? 'response_draft' : 'followup_task',
        decision: {} as NarsDecision,
        proposal: {},
        schedulerEventStatus: String(eventAdmission.status ?? ''),
      });
    }
    executed.push('ticket_processing_context_load');
    executed.push('scheduler_event_admit');
    executed.push('scheduler_activation_claim');
    executed.push('scheduler_activation_admit_sop');
    checkpoint(siteRoot, 'scheduler_activation_admitted', {
      activations: processing.map((item) => ({ ticket_id: item.ticketId, activation_id: item.activationId, sop_run_id: item.sopRunId })),
      scheduler_event_statuses: processing.map((item) => ({ message_id: item.messageId, status: item.schedulerEventStatus })),
    });

    let workOutboxAckCount = 0;
    const projectionChecks: JsonRecord[] = [];
    for (const item of processing) {
      const nars = await runNarsDecision(siteRoot, item.messageId, item.route);
      item.decision = nars.decision;
      (item as AnyRecord).nars = { session_id: nars.session_id, events: nars.events, spawned: nars.spawned };
    }
    executed.push('nars_agent_decision');
    checkpoint(siteRoot, 'agent_decision_receipt', { decisions: processing.map((item) => item.decision) });

    for (const item of processing) {
      const proposalArgs: JsonRecord = item.route === 'response_draft'
        ? {
            ticket_id: item.ticketId,
            expected_revision: item.expectedRevision,
            route: 'response_draft',
            idempotency_key: `site-loop-e2e:terminal-proposal:${item.messageId}`,
            causation_id: item.sopRunId,
            actor_id: residentAgentId(),
            summary: 'Deterministic response draft proposed by the real NARS process.',
            draft: { source_id: item.sourceId, reply_mode: 'reply', body_text: `Deterministic response for ${item.messageId}.` },
          }
        : {
            ticket_id: item.ticketId,
            expected_revision: item.expectedRevision,
            route: 'followup_task',
            idempotency_key: `site-loop-e2e:terminal-proposal:${item.messageId}`,
            causation_id: item.sopRunId,
            actor_id: residentAgentId(),
            summary: 'Deterministic follow-up task proposed by the real NARS process.',
            task: {
              title: `Follow up ${item.messageId}`,
              goal: `Continue processing ${item.messageId}.`,
              required_work: `Perform the bounded follow-up for ${item.messageId}.`,
              acceptance_criteria: [`The ${item.messageId} follow-up is completed.`],
              tags: ['site-loop-e2e'],
            },
          };
      item.proposal = await call(work.client, 'ticket_admit_proposal', proposalArgs);
      if (item.proposal.outcome !== 'completed') throw new Error(`isolated_bridge_terminal_proposal_not_completed:${item.messageId}`);
    }
    executed.push('ticket_admit_proposal');
    checkpoint(siteRoot, 'terminal_proposal_projection', { proposals: processing.map((item) => ({ ticket_id: item.ticketId, route: item.route, result: item.proposal.result })) });

    let draftReceiptCount = 0;
    for (const item of processing.filter((candidate) => candidate.route === 'response_draft')) {
      const proposal = record(item.proposal.result);
      const mailboxId = requiredString(proposal.mailbox_id, 'draft_receipt_mailbox_id');
      const sourceMessageId = requiredString(proposal.source_message_id, 'draft_receipt_source_message_id');
      const draftId = `site-loop-e2e:draft:${item.messageId}`;
      const draftReceipt = await call(work.client, 'ticket_draft_receipt_record', {
        ticket_id: item.ticketId,
        effect_claim_id: requiredString(proposal.effect_claim_id, 'draft_receipt_effect_claim_id'),
        draft_operation_key: requiredString(proposal.draft_operation_key, 'draft_receipt_operation_key'),
        draft_request_digest: requiredString(proposal.draft_request_digest, 'draft_receipt_request_digest'),
        receipt_id: `site-loop-e2e:graph-draft-receipt:${item.messageId}`,
        draft_id: draftId,
        draft_ref: {
          schema: 'narada.graph_mail.draft_receipt_ref.v1',
          draft_id: draftId,
          mailbox_id: mailboxId,
          source_message_id: sourceMessageId,
          operation_key: proposal.draft_operation_key,
          request_digest: proposal.draft_request_digest,
          deterministic_fixture: true,
        },
        idempotency_key: `site-loop-e2e:draft-receipt:${item.messageId}`,
        causation_id: item.sopRunId,
      });
      if (draftReceipt.outcome !== 'completed') throw new Error(`isolated_bridge_draft_receipt_not_completed:${item.messageId}`);
      (item as AnyRecord).draftReceipt = draftReceipt;
      draftReceiptCount += 1;
    }
    executed.push('ticket_draft_receipt_record');

    for (const item of processing) {
      await call(scheduler.client, 'scheduler_activation_resolve', {
        activation_id: item.activationId,
        sop_run_id: item.sopRunId,
        outcome: item.route,
        receipt_id: `site-loop-e2e:terminal-receipt:${item.messageId}`,
        receipt: {
          schema: 'narada.site_loop.terminal_receipt.v1',
          ticket_id: item.ticketId,
          proposal_id: stringAt(item.proposal, 'proposal_id') ?? `terminal-proposal:${item.messageId}`,
          route: item.route,
        },
        implementation_id: implementationId,
      });
      await call(work.client, 'work_outbox_ack', {
        consumer_id: 'site-loop-e2e:work-processing',
        event_id: item.eventId,
        receipt: {
          schema: 'narada.site_loop.work_due_receipt.v1',
          ticket_id: item.ticketId,
          sop_run_id: item.sopRunId,
          outcome: item.route,
        },
      });
      workOutboxAckCount += 1;
      const shown = await call(work.client, 'ticket_show', { ticket_id: item.ticketId });
      const refs = ticketRefs(shown);
      if (item.route === 'response_draft' && refs.drafts.length !== 1) throw new Error(`isolated_bridge_draft_projection_count:${item.ticketId}`);
      if (item.route === 'followup_task' && refs.tasks.length !== 1) throw new Error(`isolated_bridge_task_projection_count:${item.ticketId}`);
      projectionChecks.push({ ticket_id: item.ticketId, route: item.route, draft_count: refs.drafts.length, task_count: refs.tasks.length });
    }
    executed.push('scheduler_activation_resolve');
    executed.push('work_outbox_ack');
    const finalActivations = await call(scheduler.client, 'scheduler_activation_list', { limit: 20 });
    const terminal = activationRows(finalActivations).filter((activation) => processing.some((item) => item.sopRunId === activation.sop_run_id));
    const terminalSopRunIds = new Set(terminal.map((activation) => String(activation.sop_run_id ?? '')));
    if (terminal.length !== MESSAGE_IDS.length || terminalSopRunIds.size !== MESSAGE_IDS.length || terminal.some((activation) => activation.status !== 'terminal')) {
      throw new Error(`isolated_bridge_terminal_activation_count:${JSON.stringify(terminal)}`);
    }
    const noDuplicateProjection = projectionChecks.length === MESSAGE_IDS.length
      && new Set(projectionChecks.map((check) => String(check.ticket_id))).size === MESSAGE_IDS.length
      && projectionChecks.every((check) => check.route === 'response_draft'
        ? check.draft_count === 1 && check.task_count === 0
        : check.route === 'followup_task' && check.draft_count === 0 && check.task_count === 1);
    if (!noDuplicateProjection || mailboxOutboxAckCount !== MESSAGE_IDS.length || workOutboxAckCount !== MESSAGE_IDS.length || draftReceiptCount !== 1) {
      throw new Error(`isolated_bridge_projection_receipts_incomplete:${JSON.stringify({ projectionChecks, mailboxOutboxAckCount, workOutboxAckCount, draftReceiptCount })}`);
    }
    const output = {
      schema: 'narada.site_loop.ticket_task_reconciliation.v1',
      status: 'success',
      interruption_requested: requestedInterruption(),
      exactly_once_scope: 'stable_idempotency_keys_and_canonical_work_lifecycle_projection',
      ticket_count: tickets.length,
      routes: processing.map((item) => ({ message_id: item.messageId, ticket_id: item.ticketId, route: item.route, sop_run_id: item.sopRunId, nars: (item as AnyRecord).nars })),
      receipts: {
        scheduler_terminal_count: terminal.length,
        scheduler_terminal_receipt_count: terminal.length,
        work_outbox_ack_count: workOutboxAckCount,
        work_outbox_acknowledged: workOutboxAckCount === MESSAGE_IDS.length,
        mailbox_outbox_ack_count: mailboxOutboxAckCount,
        mailbox_outbox_acknowledged: mailboxOutboxAckCount === MESSAGE_IDS.length,
        draft_receipt_count: draftReceiptCount,
      },
      projection_checks: projectionChecks,
      no_duplicate_projection: noDuplicateProjection,
      work_lifecycle_doctor: workDoctor,
      task_lifecycle_doctor: taskDoctor,
      mailbox_doctor: mailboxDoctor,
      scheduler_runtime: runtime,
      executed_bridges: ['mailbox', 'work_lifecycle', 'scheduler', 'task_lifecycle', 'resident_nars'],
      executed_operations: executed,
      interruption_manifest: INTERRUPTION_BOUNDARIES,
    };
    recordEvidence(siteRoot, { ...output, phase: 'ticket_task_reconciliation', status: 'success' });
    process.stdout.write(JSON.stringify(output) + '\n');
    return output;
  } finally {
    for (const server of servers.reverse()) await server.close();
    await scope.close();
    scope.assertClean();
  }
}

function parseArgs(argv: string[]): { mode: 'source' | 'tickets'; siteRoot: string } {
  let mode: 'source' | 'tickets' = 'source';
  let siteRoot = process.env.NARADA_SITE_ROOT ?? process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--mode') mode = argv[index + 1] === 'tickets' ? 'tickets' : 'source';
    if (argv[index] === '--site-root' && argv[index + 1]) siteRoot = resolve(argv[index + 1]);
  }
  return { mode, siteRoot: resolve(siteRoot) };
}

const { mode, siteRoot } = parseArgs(process.argv.slice(2));
try {
  if (mode === 'source') await runSource(siteRoot);
  else await runTickets(siteRoot);
} catch (error) {
  const interrupted = error instanceof InjectedInterruption;
  const previous = readRecordedEvidence(siteRoot);
  const result = {
    ...previous,
    schema: TEST_SCHEMA,
    status: interrupted ? 'interrupted' : 'failed',
    phase: mode,
    interruption_requested: requestedInterruption(),
    interruption_boundary: interrupted ? error.boundary : null,
    error: error instanceof Error ? error.message : String(error),
  };
  recordEvidence(siteRoot, result);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = interrupted ? 137 : 1;
}
