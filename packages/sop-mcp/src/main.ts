#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SERVER_NAME = 'sop-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

const TEMPLATE_STATUSES = ['draft', 'active', 'deprecated'] as const;
const RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'awaiting_manual'] as const;
const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STEP_KINDS = ['manual', 'note', 'command'] as const;
const STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
const STEP_TERMINAL = new Set(['completed', 'failed', 'skipped']);

type JsonRecord = Record<string, unknown>;

type SopState = {
  sopRoot: string;
  db: DatabaseSync;
};

type SopTemplate = {
  sop_id: string;
  version: number;
  title: string;
  status: string;
  description: string;
  steps: SopStep[];
  trigger_kind: string;
  acceptance_criteria: string[];
  evidence_requirements: string[];
  created_at: string;
  updated_at: string;
};

type SopStep = {
  id: string;
  kind: string;
  title: string;
  depends_on: string[];
  instructions: string;
  command: string | null;
  args: string[] | null;
  timeout_ms: number | null;
  cwd: string | null;
};

type SopRun = {
  run_id: string;
  sop_id: string;
  sop_version: number;
  sop_title: string;
  status: string;
  step_states: SopStepState[];
  trigger_source_kind: string;
  trigger_source_ref: string;
  triggered_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type SopStepState = {
  step_id: string;
  kind: string;
  title: string;
  status: string;
  depends_on: string[];
  started_at: string | null;
  completed_at: string | null;
  result: JsonRecord;
  error_message: string | null;
};

type SopEvent = {
  event_id: string;
  run_id: string;
  step_id: string;
  event_kind: string;
  details: JsonRecord;
  recorded_at: string;
};

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS sop_templates (
    sop_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    description TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL DEFAULT '[]',
    trigger_kind TEXT NOT NULL DEFAULT 'manual',
    acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
    evidence_requirements_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (sop_id, version)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS sop_runs (
    run_id TEXT PRIMARY KEY,
    sop_id TEXT NOT NULL,
    sop_version INTEGER NOT NULL,
    sop_title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    step_states_json TEXT NOT NULL DEFAULT '[]',
    trigger_source_kind TEXT NOT NULL DEFAULT 'manual',
    trigger_source_ref TEXT NOT NULL DEFAULT '',
    triggered_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS sop_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    recorded_at TEXT NOT NULL
  ) STRICT`,
];

export function createServerState(options: JsonRecord = {}): SopState {
  const sopRoot = resolve(String(options.sopRoot ?? options.outputRoot ?? process.cwd()));
  const dbPath = resolve(sopRoot, '.sop', 'sop.db');
  const dbDir = resolve(dbPath, '..');
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  for (const sql of CREATE_TABLES) db.exec(sql);
  return { sopRoot, db };
}

export function closeServerState(state: SopState): void {
  state.db.close();
}

export function handleRequest(request: JsonRecord, state: SopState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

export async function runStdioServer(options: JsonRecord = {}): Promise<void> {
  const state = createServerState(options);
  let buffer = '';
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const drained = buffer.includes('Content-Length:')
      ? drainJsonRpcFrames(buffer)
      : drainJsonLines(buffer);
    sawFramedInput ||= drained.framed;
    buffer = drained.remaining;
    for (const request of drained.requests) {
      const response = handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

function dispatchMethod(method: string, params: JsonRecord, state: SopState) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return callTool(params, state);
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

export function listTools() {
  return [
    {
      name: 'sop_template_create',
      description: 'Create a new versioned SOP template with ordered steps.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string', description: 'Stable SOP identifier, e.g. site-onboarding.' },
          title: { type: 'string', description: 'Human-readable title.' },
          description: { type: 'string', description: 'Purpose and scope of this SOP.' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Step identifier, e.g. verify_identity.' },
                kind: { type: 'string', enum: STEP_KINDS, description: 'Step kind.' },
                title: { type: 'string' },
                depends_on: { type: 'array', items: { type: 'string' }, description: 'Step IDs this step depends on.' },
                instructions: { type: 'string', description: 'What the operator/agent must do.' },
                command: { type: 'string', description: 'For command steps: the executable.' },
                args: { type: 'array', items: { type: 'string' }, description: 'For command steps: argv.' },
                timeout_ms: { type: 'number', description: 'For command steps: timeout.' },
                cwd: { type: 'string', description: 'For command steps: working directory.' },
              },
              required: ['id', 'kind', 'title', 'instructions'],
              additionalProperties: false,
            },
          },
          trigger_kind: { type: 'string', enum: ['manual', 'inbox_event', 'schedule'], default: 'manual' },
          acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria for validating SOP completion.' },
          evidence_requirements: { type: 'array', items: { type: 'string' }, description: 'Evidence expected from each run.' },
        },
        required: ['sop_id', 'title', 'steps'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_create', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_show',
      description: 'Show the latest version of an SOP template.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          version: { type: 'number', description: 'Specific version; defaults to latest.' },
        },
        required: ['sop_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_show', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_list',
      description: 'List SOP templates with optional status filter.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: TEMPLATE_STATUSES },
          limit: { type: 'number', default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_search',
      description: 'Search SOP templates by title or description text.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text matched against title and description.' },
          status: { type: 'string', enum: TEMPLATE_STATUSES },
          limit: { type: 'number', default: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_update',
      description: 'Update an SOP template, creating a new version.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                kind: { type: 'string', enum: STEP_KINDS },
                title: { type: 'string' },
                depends_on: { type: 'array', items: { type: 'string' } },
                instructions: { type: 'string' },
                command: { type: 'string' },
                args: { type: 'array', items: { type: 'string' } },
                timeout_ms: { type: 'number' },
                cwd: { type: 'string' },
              },
              required: ['id', 'kind', 'title', 'instructions'],
              additionalProperties: false,
            },
          },
          trigger_kind: { type: 'string', enum: ['manual', 'inbox_event', 'schedule'] },
          acceptance_criteria: { type: 'array', items: { type: 'string' } },
          evidence_requirements: { type: 'array', items: { type: 'string' } },
        },
        required: ['sop_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_update', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_deprecate',
      description: 'Deprecate an SOP template.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['sop_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_deprecate', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_start',
      description: 'Start a run of an SOP template by its latest active version.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          sop_version: { type: 'number', description: 'Specific version; defaults to latest active.' },
          trigger_source_kind: { type: 'string', default: 'manual' },
          trigger_source_ref: { type: 'string' },
          triggered_by: { type: 'string' },
        },
        required: ['sop_id', 'triggered_by'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_start', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_status',
      description: 'Get the status of an SOP run including step states.',
      inputSchema: {
        type: 'object',
        properties: { run_id: { type: 'string' } },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_advance',
      description: 'Advance an SOP run by completing a step or resolving an awaiting_manual gate.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          step_id: { type: 'string', description: 'The manual step to confirm as completed.' },
          result: { type: 'object', additionalProperties: true, description: 'Result payload for the step.' },
        },
        required: ['run_id', 'step_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_advance', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_list',
      description: 'List SOP runs with optional filters.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          status: { type: 'string', enum: RUN_STATUSES },
          include_terminal: { type: 'boolean' },
          limit: { type: 'number', default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_cancel',
      description: 'Cancel a pending or running SOP run.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_cancel', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_events',
      description: 'List events for an SOP run.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_events', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

function callTool(params: JsonRecord, state: SopState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'sop_template_create': result = sopTemplateCreate(args, state); break;
    case 'sop_template_show': result = sopTemplateShow(args, state); break;
    case 'sop_template_list': result = sopTemplateList(args, state); break;
    case 'sop_template_search': result = sopTemplateSearch(args, state); break;
    case 'sop_template_update': result = sopTemplateUpdate(args, state); break;
    case 'sop_template_deprecate': result = sopTemplateDeprecate(args, state); break;
    case 'sop_run_start': result = sopRunStart(args, state); break;
    case 'sop_run_status': result = sopRunStatus(args, state); break;
    case 'sop_run_advance': result = sopRunAdvance(args, state); break;
    case 'sop_run_list': result = sopRunList(args, state); break;
    case 'sop_run_cancel': result = sopRunCancel(args, state); break;
    case 'sop_run_events': result = sopRunEvents(args, state); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

function sopTemplateCreate(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const title = requiredString(args.title, 'sop_requires_title');
  const steps = validateSteps(arrayOfRecords(args.steps, true), state);
  const existing = state.db.prepare('SELECT MAX(version) as v FROM sop_templates WHERE sop_id = ?').get(sopId) as JsonRecord | undefined;
  const version = existing && existing.v ? (Number(existing.v) + 1) : 1;
  const now = nowIso();
  const triggerKind = optionalString(args.trigger_kind) ?? 'manual';
  if (!TEMPLATE_STATUSES.includes(triggerKind as typeof TEMPLATE_STATUSES[number]) && !['manual', 'inbox_event', 'schedule'].includes(triggerKind)) {
    throw diagnosticError('sop_invalid_trigger_kind', `sop_invalid_trigger_kind:${triggerKind}`);
  }
  const criteria = stringList(args.acceptance_criteria);
  const evidenceReq = stringList(args.evidence_requirements);
  state.db.prepare(
    'INSERT INTO sop_templates (sop_id, version, title, status, description, steps_json, trigger_kind, acceptance_criteria_json, evidence_requirements_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sopId, version, title, 'draft', optionalString(args.description) ?? '', JSON.stringify(steps), triggerKind, JSON.stringify(criteria), JSON.stringify(evidenceReq), now, now);
  appendSopEvent(state, 'template_created', { sop_id: sopId, version });
  return { status: 'created', sop_id: sopId, version, title, step_count: steps.length };
}

function sopTemplateShow(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const version = args.version !== undefined && args.version !== null ? Number(args.version) : undefined;
  const row = version !== undefined
    ? state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? AND version = ?').get(sopId, version) as JsonRecord | undefined
    : state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_not_found', `sop_not_found:${sopId}${version ? `@v${version}` : ''}`);
  return hydrateTemplate(row);
}

function sopTemplateList(args: JsonRecord, state: SopState) {
  const limit = clamp(integer(args.limit, 50, 1, 200), 1, 200);
  const status = optionalString(args.status);
  let rows: JsonRecord[];
  if (status && TEMPLATE_STATUSES.includes(status as typeof TEMPLATE_STATUSES[number])) {
    rows = state.db.prepare(
      `SELECT t.* FROM sop_templates t JOIN (SELECT sop_id, MAX(version) as mv FROM sop_templates GROUP BY sop_id) latest ON t.sop_id = latest.sop_id AND t.version = latest.mv WHERE t.status = ? ORDER BY t.updated_at DESC LIMIT ?`
    ).all(status, limit) as JsonRecord[];
  } else {
    rows = state.db.prepare(
      `SELECT t.* FROM sop_templates t JOIN (SELECT sop_id, MAX(version) as mv FROM sop_templates GROUP BY sop_id) latest ON t.sop_id = latest.sop_id AND t.version = latest.mv ORDER BY t.updated_at DESC LIMIT ?`
    ).all(limit) as JsonRecord[];
  }
  return { items: rows.map(hydrateTemplate), count: rows.length };
}

function sopTemplateSearch(args: JsonRecord, state: SopState) {
  const query = requiredString(args.query, 'sop_requires_query');
  const limit = clamp(integer(args.limit, 20, 1, 100), 1, 100);
  const status = optionalString(args.status);
  const like = `%${query}%`;
  let sql = `SELECT t.* FROM sop_templates t JOIN (SELECT sop_id, MAX(version) as mv FROM sop_templates GROUP BY sop_id) latest ON t.sop_id = latest.sop_id AND t.version = latest.mv WHERE (t.title LIKE ? OR t.description LIKE ?)`;
  const params: (string | number)[] = [like, like];
  if (status && TEMPLATE_STATUSES.includes(status as typeof TEMPLATE_STATUSES[number])) {
    sql += ' AND t.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY t.updated_at DESC LIMIT ?';
  params.push(limit);
  const rows = state.db.prepare(sql).all(...params) as JsonRecord[];
  return { items: rows.map(hydrateTemplate), count: rows.length, query };
}

function sopTemplateUpdate(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const current = state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;
  if (!current) throw diagnosticError('sop_not_found', `sop_not_found:${sopId}`);
  const nextVersion = Number(current.version) + 1;
  const now = nowIso();
  const title = optionalString(args.title) ?? String(current.title);
  const description = optionalString(args.description) ?? String(current.description);
  const steps = args.steps !== undefined ? validateSteps(arrayOfRecords(args.steps, true), state) : JSON.parse(String(current.steps_json));
  const triggerKind = optionalString(args.trigger_kind) ?? String(current.trigger_kind);
  const criteria = args.acceptance_criteria !== undefined ? stringList(args.acceptance_criteria) : JSON.parse(String(current.acceptance_criteria_json));
  const evidenceReq = args.evidence_requirements !== undefined ? stringList(args.evidence_requirements) : JSON.parse(String(current.evidence_requirements_json));
  state.db.prepare(
    'INSERT INTO sop_templates (sop_id, version, title, status, description, steps_json, trigger_kind, acceptance_criteria_json, evidence_requirements_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sopId, nextVersion, title, 'draft', description, JSON.stringify(steps), triggerKind, JSON.stringify(criteria), JSON.stringify(evidenceReq), now, now);
  appendSopEvent(state, 'template_updated', { sop_id: sopId, version: nextVersion, previous_version: current.version });
  return { status: 'updated', sop_id: sopId, version: nextVersion, previous_version: current.version, title, step_count: steps.length };
}

function sopTemplateDeprecate(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const current = state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;
  if (!current) throw diagnosticError('sop_not_found', `sop_not_found:${sopId}`);
  state.db.prepare('UPDATE sop_templates SET status = ? WHERE sop_id = ? AND version = ?').run('deprecated', sopId, Number(current.version));
  appendSopEvent(state, 'template_deprecated', { sop_id: sopId, version: current.version, reason: optionalString(args.reason) });
  return { status: 'deprecated', sop_id: sopId, version: current.version };
}

function sopRunStart(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const version: number = args.sop_version !== undefined && args.sop_version !== null
    ? Number(args.sop_version)
    : Number((state.db.prepare('SELECT MAX(version) as v FROM sop_templates WHERE sop_id = ? AND status != ?').get(sopId, 'deprecated') as JsonRecord | undefined)?.v ?? 0);
  if (!version) throw diagnosticError('sop_no_active_version', `sop_no_active_version:${sopId}`);
  const row = state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? AND version = ?').get(sopId, version) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_not_found', `sop_not_found:${sopId}@v${version}`);
  const template = hydrateTemplate(row);
  const runId = `sop_run_${stamp()}_${randomUUID().slice(0, 8)}`;
  const now = nowIso();
  const stepStates: SopStepState[] = template.steps.map((step) => ({
    step_id: step.id,
    kind: step.kind,
    title: step.title,
    status: 'pending' as const,
    depends_on: step.depends_on,
    started_at: null,
    completed_at: null,
    result: {},
    error_message: null,
  }));
  const triggerSourceKind = optionalString(args.trigger_source_kind) ?? 'manual';
  state.db.prepare(
    'INSERT INTO sop_runs (run_id, sop_id, sop_version, sop_title, status, step_states_json, trigger_source_kind, trigger_source_ref, triggered_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(runId, sopId, version, template.title, 'pending', JSON.stringify(stepStates), triggerSourceKind, optionalString(args.trigger_source_ref) ?? '', requiredString(args.triggered_by, 'sop_requires_triggered_by'), now, now);
  appendRunEvent(state, runId, null, 'run_started', { sop_id: sopId, sop_version: version, triggered_by: args.triggered_by });
  const advanced = advanceAutoSteps(runId, stepStates, state);
  return { status: advanced.status, run_id: runId, sop_id: sopId, sop_version: version, sop_title: template.title, step_states: advanced.stepStates, next_awaits_manual: advanced.awaitingManual };
}

function sopRunStatus(args: JsonRecord, state: SopState) {
  const runId = requiredString(args.run_id, 'sop_requires_run_id');
  const row = state.db.prepare('SELECT * FROM sop_runs WHERE run_id = ?').get(runId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_run_not_found', `sop_run_not_found:${runId}`);
  return hydrateRun(row);
}

function sopRunAdvance(args: JsonRecord, state: SopState) {
  const runId = requiredString(args.run_id, 'sop_requires_run_id');
  const stepId = requiredString(args.step_id, 'sop_requires_step_id');
  const result = asRecord(args.result);
  const row = state.db.prepare('SELECT * FROM sop_runs WHERE run_id = ?').get(runId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_run_not_found', `sop_run_not_found:${runId}`);
  const run = hydrateRun(row);
  if (RUN_TERMINAL.has(run.status)) throw diagnosticError('sop_run_terminal', `sop_run_terminal:${runId}`, { status: run.status });
  const stepStates = run.step_states;
  const target = stepStates.find((s) => s.step_id === stepId);
  if (!target) throw diagnosticError('sop_step_not_found', `sop_step_not_found:${stepId}`);
  if (target.kind !== 'manual') throw diagnosticError('sop_step_not_manual', `sop_step_not_manual:${stepId}`, { kind: target.kind });
  if (target.status !== 'running') throw diagnosticError('sop_step_not_running', `sop_step_not_running:${stepId}`, { status: target.status });
  target.status = 'completed';
  target.completed_at = nowIso();
  target.result = result;
  appendRunEvent(state, runId, stepId, 'step_completed', { result });
  const advanced = advanceAutoSteps(runId, stepStates, state);
  return { status: advanced.status, run_id: runId, step_states: advanced.stepStates, next_awaits_manual: advanced.awaitingManual };
}

function sopRunList(args: JsonRecord, state: SopState) {
  const limit = clamp(integer(args.limit, 50, 1, 200), 1, 200);
  const sopId = optionalString(args.sop_id);
  const status = optionalString(args.status);
  const includeTerminal = args.include_terminal === undefined ? false : Boolean(args.include_terminal);
  let sql = 'SELECT * FROM sop_runs';
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];
  if (sopId) { conditions.push('sop_id = ?'); params.push(sopId); }
  if (status && RUN_STATUSES.includes(status as typeof RUN_STATUSES[number])) { conditions.push('status = ?'); params.push(status); }
  if (!includeTerminal) { conditions.push("status NOT IN ('completed','failed','cancelled')"); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  const rows = state.db.prepare(sql).all(...params) as JsonRecord[];
  return { items: rows.map(hydrateRun), count: rows.length };
}

function sopRunCancel(args: JsonRecord, state: SopState) {
  const runId = requiredString(args.run_id, 'sop_requires_run_id');
  const row = state.db.prepare('SELECT * FROM sop_runs WHERE run_id = ?').get(runId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_run_not_found', `sop_run_not_found:${runId}`);
  const run = hydrateRun(row);
  if (RUN_TERMINAL.has(run.status)) throw diagnosticError('sop_run_already_terminal', `sop_run_already_terminal:${runId}`, { status: run.status });
  const now = nowIso();
  state.db.prepare('UPDATE sop_runs SET status = ?, updated_at = ?, completed_at = ? WHERE run_id = ?').run('cancelled', now, now, runId);
  appendRunEvent(state, runId, null, 'run_cancelled', { reason: optionalString(args.reason) });
  return { status: 'cancelled', run_id: runId, completed_at: now };
}

function sopRunEvents(args: JsonRecord, state: SopState) {
  const runId = requiredString(args.run_id, 'sop_requires_run_id');
  const limit = clamp(integer(args.limit, 50, 1, 500), 1, 500);
  const offset = clamp(integer(args.offset, 0, 0, 100000), 0, 100000);
  const rows = state.db.prepare(
    'SELECT * FROM sop_events WHERE run_id = ? ORDER BY rowid DESC LIMIT ? OFFSET ?'
  ).all(runId, limit, offset) as JsonRecord[];
  return { items: rows.map(hydrateEvent), count: rows.length, run_id: runId };
}

function advanceAutoSteps(runId: string, stepStates: SopStepState[], state: SopState): { status: string; stepStates: SopStepState[]; awaitingManual: boolean } {
  let progressMade = true;
  let awaitingManual = false;
  while (progressMade) {
    progressMade = false;
    for (const stepState of stepStates) {
      if (stepState.status !== 'pending') continue;
      const allDepsReady = stepState.depends_on.every((depId) => {
        const dep = stepStates.find((s) => s.step_id === depId);
        return dep && dep.status === 'completed';
      });
      if (!allDepsReady) continue;
      if (stepState.kind === 'note') {
        stepState.status = 'completed';
        stepState.started_at = nowIso();
        stepState.completed_at = nowIso();
        stepState.result = { noted: true };
        appendRunEvent(state, runId, stepState.step_id, 'step_completed', { kind: 'note' });
        progressMade = true;
      } else if (stepState.kind === 'manual') {
        stepState.status = 'running';
        stepState.started_at = nowIso();
        appendRunEvent(state, runId, stepState.step_id, 'step_started', { kind: 'manual' });
        awaitingManual = true;
        progressMade = true;
      }
    }
  }
  const allTerminal = stepStates.every((s) => STEP_TERMINAL.has(s.status));
  if (allTerminal) {
    const anyFailed = stepStates.some((s) => s.status === 'failed');
    const finalStatus = anyFailed ? 'failed' : 'completed';
    const now = nowIso();
    state.db.prepare('UPDATE sop_runs SET status = ?, step_states_json = ?, updated_at = ?, completed_at = ? WHERE run_id = ?').run(finalStatus, JSON.stringify(stepStates), now, now, runId);
    appendRunEvent(state, runId, null, finalStatus === 'completed' ? 'run_completed' : 'run_failed', { step_states: stepStates.map((s) => ({ step_id: s.step_id, status: s.status })) });
    return { status: finalStatus, stepStates, awaitingManual: false };
  }
  const activeStatus = awaitingManual ? 'awaiting_manual' : 'running';
  state.db.prepare('UPDATE sop_runs SET status = ?, step_states_json = ?, updated_at = ? WHERE run_id = ?').run(activeStatus, JSON.stringify(stepStates), nowIso(), runId);
  appendRunEvent(state, runId, null, 'run_advanced', { status: activeStatus });
  return { status: activeStatus, stepStates, awaitingManual };
}

function validateSteps(steps: JsonRecord[], state: SopState): SopStep[] {
  const validated: SopStep[] = [];
  const ids = new Set<string>();
  for (const step of steps) {
    const id = requiredString(step.id, 'sop_step_requires_id');
    if (ids.has(id)) throw diagnosticError('sop_duplicate_step_id', `sop_duplicate_step_id:${id}`);
    ids.add(id);
    const kind = requiredString(step.kind, 'sop_step_requires_kind', { step_id: id });
    if (!STEP_KINDS.includes(kind as typeof STEP_KINDS[number])) throw diagnosticError('sop_invalid_step_kind', `sop_invalid_step_kind:${kind}`, { step_id: id, allowed: STEP_KINDS });
    validated.push({
      id,
      kind,
      title: requiredString(step.title, 'sop_step_requires_title', { step_id: id }),
      depends_on: stringList(step.depends_on),
      instructions: requiredString(step.instructions, 'sop_step_requires_instructions', { step_id: id }),
      command: optionalString(step.command),
      args: stringList(step.args),
      timeout_ms: step.timeout_ms !== undefined ? clamp(integer(step.timeout_ms, 30000, 1000, 600000), 1000, 600000) : null,
      cwd: optionalString(step.cwd),
    });
  }
  for (const step of validated) {
    for (const depId of step.depends_on) {
      if (!ids.has(depId)) throw diagnosticError('sop_unknown_dependency', `sop_unknown_dependency:${depId}`, { step_id: step.id });
    }
  }
  return validated;
}

function appendSopEvent(state: SopState, eventKind: string, details: JsonRecord) {
  const eventId = `soe_${randomUUID().slice(0, 12)}`;
  state.db.prepare('INSERT INTO sop_events (event_id, run_id, step_id, event_kind, details_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(eventId, '', '', eventKind, JSON.stringify(details), nowIso());
}

function appendRunEvent(state: SopState, runId: string, stepId: string | null, eventKind: string, details: JsonRecord) {
  const eventId = `soe_${randomUUID().slice(0, 12)}`;
  state.db.prepare('INSERT INTO sop_events (event_id, run_id, step_id, event_kind, details_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(eventId, runId, stepId ?? '', eventKind, JSON.stringify(details), nowIso());
}

function hydrateTemplate(row: JsonRecord): SopTemplate {
  return {
    sop_id: String(row.sop_id),
    version: Number(row.version),
    title: String(row.title),
    status: String(row.status),
    description: String(row.description),
    steps: JSON.parse(String(row.steps_json)),
    trigger_kind: String(row.trigger_kind),
    acceptance_criteria: JSON.parse(String(row.acceptance_criteria_json)),
    evidence_requirements: JSON.parse(String(row.evidence_requirements_json)),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function hydrateRun(row: JsonRecord): SopRun {
  return {
    run_id: String(row.run_id),
    sop_id: String(row.sop_id),
    sop_version: Number(row.sop_version),
    sop_title: String(row.sop_title),
    status: String(row.status),
    step_states: JSON.parse(String(row.step_states_json)),
    trigger_source_kind: String(row.trigger_source_kind),
    trigger_source_ref: String(row.trigger_source_ref),
    triggered_by: String(row.triggered_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: optionalString(row.completed_at) || null,
  };
}

function hydrateEvent(row: JsonRecord): SopEvent {
  return {
    event_id: String(row.event_id),
    run_id: String(row.run_id),
    step_id: String(row.step_id),
    event_kind: String(row.event_kind),
    details: JSON.parse(String(row.details_json)),
    recorded_at: String(row.recorded_at),
  };
}

function renderResult(result: JsonRecord): string {
  if (result.status === 'created' || result.status === 'updated' || result.status === 'deprecated') {
    return [
      `sop_template: ${result.status}`,
      `sop_id: ${result.sop_id ?? ''}`,
      `version: ${result.version ?? ''}`,
      `title: ${result.title ?? ''}`,
      result.previous_version ? `previous_version: ${result.previous_version}` : '',
      `step_count: ${result.step_count ?? ''}`,
    ].filter(Boolean).join('\n');
  }
  if (result.items !== undefined) {
    return [
      `sop_list: ${result.count ?? 0} items`,
      ...(result.items as JsonRecord[]).map((item: JsonRecord) => `  ${item.sop_id ?? item.run_id}: ${item.title ?? item.sop_title ?? ''} [${item.status ?? ''}]`),
    ].join('\n');
  }
  if (result.run_id) {
    return [
      `sop_run: ${result.status ?? 'ok'}`,
      `run_id: ${result.run_id}`,
      `sop_id: ${result.sop_id ?? ''}`,
      result.sop_title ? `title: ${result.sop_title}` : '',
      result.completed_at ? `completed_at: ${result.completed_at}` : '',
      result.next_awaits_manual !== undefined ? `next_awaits_manual: ${result.next_awaits_manual}` : '',
    ].filter(Boolean).join('\n');
  }
  return result.status ? `sop: ${result.status}` : 'sop: ok';
}

function requiredString(value: unknown, code: string, details: JsonRecord = {}): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code, code, details);
  return text;
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function arrayOfRecords(value: unknown, required: boolean = false): JsonRecord[] {
  if (!Array.isArray(value)) {
    if (required) throw diagnosticError('sop_requires_array');
    return [];
  }
  return value.map(asRecord);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function nowIso(): string {
  return new Date().toISOString();
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
}

function diagnosticError(code: string, message: string = code, details: JsonRecord = {}) {
  const error = new Error(message);
  Object.assign(error, { codeName: code, details });
  return error;
}

function errorDiagnostic(error: unknown) {
  const record = asRecord(error);
  return {
    schema: 'narada.sop.error.v1',
    code: String(record.codeName ?? 'sop_error'),
    message: error instanceof Error ? error.message : String(error),
    details: asRecord(record.details),
  };
}

function drainJsonLines(buffer: string) {
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  return {
    framed: false,
    remaining,
    requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))),
  };
}

function drainJsonRpcFrames(buffer: string) {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = remaining.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    requests.push(asRecord(JSON.parse(remaining.slice(bodyStart, bodyEnd))));
    remaining = remaining.slice(bodyEnd);
  }
  return { framed: true, remaining, requests };
}

function writeJsonRpcResponse(response: JsonRecord, { framed }: { framed: boolean }) {
  const body = JSON.stringify(response);
  if (framed) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

function parseArgs(argv: string[]) {
  const options: JsonRecord = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sop-root') options.sopRoot = argv[++i];
    else if (arg === '--output-root') options.outputRoot = argv[++i];
    else throw new Error(`unknown_argument:${arg}`);
  }
  return options;
}

export { parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
