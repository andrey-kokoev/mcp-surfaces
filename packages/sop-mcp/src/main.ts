#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml';
import { Ajv } from 'ajv';

const DEFAULT_SERVER_NAME = 'sop-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

const TEMPLATE_STATUSES = ['draft', 'active', 'deprecated'] as const;
const RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'awaiting_confirmation'] as const;
const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STEP_EXECUTORS = ['engine', 'agent', 'operator', 'sop'] as const;
const STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
const STEP_TERMINAL = new Set(['completed', 'failed', 'skipped']);

type JsonRecord = Record<string, unknown>;

type SopState = {
  sopRoot: string;
  db: DatabaseSync;
  serverName: string;
  sopsDirs: string[];
};

type SopTemplate = {
  schema: string;
  render_mode: string;
  full_step_definitions_path: string;
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
  executor: string;
  blocking: boolean;
  title: string;
  depends_on: string[];
  instructions: string;
  command: string | null;
  args: string[] | null;
  timeout_ms: number | null;
  cwd: string | null;
  sop_id: string | null;
  sop_version: number | null;
  wait_policy: string | null;
};

type SopRun = {
  run_id: string;
  sop_id: string;
  sop_version: number;
  sop_title: string;
  status: string;
  step_states: SopStepState[];
  step_states_parse_error?: string | null;
  trigger_source_kind: string;
  trigger_source_ref: string;
  triggered_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type SopStepState = {
  step_id: string;
  executor: string;
  blocking: boolean;
  title: string;
  status: string;
  depends_on: string[];
  instructions: string;
  command: string | null;
  args: string[] | null;
  timeout_ms: number | null;
  cwd: string | null;
  sop_id: string | null;
  sop_version: number | null;
  wait_policy: string | null;
  child_run_id: string | null;
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_SOPS_DIR = resolve(__dirname, '..', '..', 'sops');

const ajv = new Ajv({ allErrors: true });
const SCHEMA_PATH = resolve(DEFAULT_SOPS_DIR, 'sop-template.schema.json');
let validateYamlSchema: ReturnType<typeof ajv.compile>;
try {
  validateYamlSchema = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
} catch {
  validateYamlSchema = ajv.compile({ type: 'object' });
  process.stderr.write(`sop-mcp: WARNING schema load failed for ${SCHEMA_PATH}, YAML import validation disabled\n`);
}

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
  const sopsDirs: string[] = [];
  if (Array.isArray(options.sopsDirs)) {
    for (const d of options.sopsDirs as string[]) sopsDirs.push(resolve(String(d)));
  } else if (options.sopsDir) {
    sopsDirs.push(resolve(String(options.sopsDir)));
  }
  if (sopsDirs.length === 0) sopsDirs.push(DEFAULT_SOPS_DIR);
  return { sopRoot, db, serverName: String(options.serverName || DEFAULT_SERVER_NAME), sopsDirs };
}

export function closeServerState(state: SopState): void {
  state.db.close();
}

export async function handleRequest(request: JsonRecord, state: SopState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state);
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
      const response = await handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

async function dispatchMethod(method: string, params: JsonRecord, state: SopState) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: state.serverName, version: SERVER_VERSION },
      };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return await callTool(params, state);
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

export function listTools() {
  return [
    {
      name: 'sop_doctor',
      description: 'Inspect SOP MCP server posture, build/schema metadata, database path, and available recovery tools.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'sop_doctor', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
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
                executor: { type: 'string', enum: STEP_EXECUTORS, description: 'Who performs: engine (auto), agent (programmatic), operator (human), sop (child SOP run).' },
                blocking: { type: 'boolean', description: 'If true, the run pauses and waits for sop_run_advance to complete this step. If false, auto-advances when dependencies are met.' },
                title: { type: 'string' },
                depends_on: { type: 'array', items: { type: 'string' }, description: 'Step IDs this step depends on.' },
                instructions: { type: 'string', description: 'What the executor must do.' },
                command: { type: 'string', description: 'For engine command steps: the executable.' },
                args: { type: 'array', items: { type: 'string' }, description: 'For engine command steps: argv.' },
                timeout_ms: { type: 'number', description: 'For engine command steps: timeout.' },
                cwd: { type: 'string', description: 'For command steps: working directory.' },
                sop_id: { type: 'string', description: 'For sop steps: child SOP identifier to start.' },
                sop_version: { type: 'number', description: 'For sop steps: optional child SOP version; defaults to latest active.' },
                wait_policy: { type: 'string', enum: ['wait'], description: 'For sop steps: wait for the child run to reach a terminal status.' },
              },
              required: ['id', 'executor', 'title', 'instructions'],
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
      name: 'sop_template_export',
      description: 'Export one SOP template version with raw persisted JSON and full parsed step definitions for recovery workflows.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          version: { type: 'number', description: 'Specific version; defaults to latest.' },
        },
        required: ['sop_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_export', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
                executor: { type: 'string', enum: STEP_EXECUTORS },
                blocking: { type: 'boolean' },
                title: { type: 'string' },
                depends_on: { type: 'array', items: { type: 'string' } },
                instructions: { type: 'string' },
                command: { type: 'string' },
                args: { type: 'array', items: { type: 'string' } },
                timeout_ms: { type: 'number' },
                cwd: { type: 'string' },
                sop_id: { type: 'string' },
                sop_version: { type: 'number' },
                wait_policy: { type: 'string', enum: ['wait'] },
              },
              required: ['id', 'executor', 'title', 'instructions'],
              additionalProperties: false,
            },
          },
          trigger_kind: { type: 'string', enum: ['manual', 'inbox_event', 'schedule'] },
          status: { type: 'string', enum: ['draft', 'active', 'deprecated'], description: 'Template status. Defaults to draft.' },
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
      name: 'sop_template_import_yaml',
      description: 'Import an SOP template from a YAML file in the sops/ directory. Validates against the SOP JSON Schema before inserting.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string', description: 'SOP identifier matching a .sop.yaml file in the sops/ directory, e.g. site-onboarding.' },
        },
        required: ['sop_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_import_yaml', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
      description: 'Get the status of an SOP run including step states. Read-only; use sop_run_refresh to synchronize parent runs with child SOP terminal status.',
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
      name: 'sop_run_refresh',
      description: 'Refresh a non-terminal SOP run by synchronizing running child SOP steps from their current terminal status and continuing automatic advancement.',
      inputSchema: {
        type: 'object',
        properties: { run_id: { type: 'string' } },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_refresh', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_advance',
      description: 'Advance an SOP run by completing a blocking step (awaits agent or operator confirmation).',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          step_id: { type: 'string', description: 'The blocking step to confirm as completed.' },
          result: { type: 'object', additionalProperties: true, description: 'Result payload for the step.' },
          principal: { type: 'string', description: 'Identity of the principal completing the step.' },
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

async function callTool(params: JsonRecord, state: SopState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'sop_doctor': result = sopDoctor(state); break;
    case 'sop_template_create': result = sopTemplateCreate(args, state); break;
    case 'sop_template_show': result = sopTemplateShow(args, state); break;
    case 'sop_template_export': result = sopTemplateExport(args, state); break;
    case 'sop_template_list': result = sopTemplateList(args, state); break;
    case 'sop_template_search': result = sopTemplateSearch(args, state); break;
    case 'sop_template_import_yaml': result = sopTemplateImportYaml(args, state); break;
    case 'sop_template_update': result = sopTemplateUpdate(args, state); break;
    case 'sop_template_deprecate': result = sopTemplateDeprecate(args, state); break;
    case 'sop_run_start': result = await sopRunStart(args, state); break;
    case 'sop_run_status': result = await sopRunStatus(args, state); break;
    case 'sop_run_refresh': result = await sopRunRefresh(args, state); break;
    case 'sop_run_advance': result = await sopRunAdvance(args, state); break;
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

function sopTemplateExport(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const version = args.version !== undefined && args.version !== null ? Number(args.version) : undefined;
  const row = version !== undefined
    ? state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? AND version = ?').get(sopId, version) as JsonRecord | undefined
    : state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_not_found', `sop_not_found:${sopId}${version ? `@v${version}` : ''}`);
  return {
    ...hydrateTemplate(row),
    export_schema: 'narada.sop.template_export.v1',
    raw: {
      steps_json: String(row.steps_json),
      acceptance_criteria_json: String(row.acceptance_criteria_json),
      evidence_requirements_json: String(row.evidence_requirements_json),
    },
  };
}

function sopDoctor(state: SopState): JsonRecord {
  return {
    schema: 'narada.sop.doctor.v1',
    status: 'ok',
    server_name: state.serverName,
    server_version: SERVER_VERSION,
    protocol_version: PROTOCOL_VERSION,
    template_response_schema: 'narada.sop.template.v1',
    template_show_render_mode: 'summary_text_with_full_structured_content',
    full_step_definitions_path: 'structuredContent.steps',
    recovery_tools: ['sop_template_show', 'sop_template_export'],
    sop_root: state.sopRoot,
    db_path: resolve(state.sopRoot, '.sop', 'sop.db'),
    sops_dirs: state.sopsDirs,
  };
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

function sopTemplateImportYaml(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const fileName = `${sopId}.sop.yaml`;

  let yamlPath: string | null = null;
  for (const dir of state.sopsDirs) {
    const candidate = resolve(dir, fileName);
    if (existsSync(candidate)) { yamlPath = candidate; break; }
  }
  if (!yamlPath) {
    throw diagnosticError('sop_yaml_not_found', `sop_yaml_not_found:${sopId}`, { searched: state.sopsDirs, file: fileName });
  }

  let raw: string;
  try {
    raw = readFileSync(yamlPath, 'utf8');
  } catch (err) {
    throw diagnosticError('sop_yaml_read_error', `sop_yaml_read_error:${sopId}`, { yaml_path: yamlPath, message: err instanceof Error ? err.message : String(err) });
  }

  let doc: unknown;
  try {
    doc = loadYaml(raw, { schema: JSON_SCHEMA, filename: yamlPath });
  } catch (err) {
    throw diagnosticError('sop_yaml_parse_error', `sop_yaml_parse_error:${sopId}`, { message: err instanceof Error ? err.message : String(err) });
  }

  if (!validateYamlSchema(doc)) {
    const errors = (validateYamlSchema.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
    throw diagnosticError('sop_yaml_schema_error', `sop_yaml_schema_error:${sopId}`, { errors });
  }

  const data = doc as JsonRecord;
  const yamlSopId = requiredString(data.sop_id, 'sop_yaml_requires_sop_id');
  if (yamlSopId !== sopId) {
    throw diagnosticError('sop_yaml_id_mismatch', `sop_yaml_id_mismatch:arg=${sopId} yaml=${yamlSopId}`);
  }

  const steps = validateSteps(arrayOfRecords(data.steps, true), state);
  const title = requiredString(data.title, 'sop_yaml_requires_title');
  const description = optionalString(data.description) ?? '';
  const triggerKind = optionalString(data.trigger_kind) ?? 'manual';
  const status = optionalString(data.status) ?? 'draft';
  const criteria = stringList(data.acceptance_criteria);
  const evidenceReq = stringList(data.evidence_requirements);

  const current = state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;

  if (current) {
    const prev = hydrateTemplate(current);
    if (
      prev.title === title &&
      prev.description === description &&
      prev.trigger_kind === triggerKind &&
      JSON.stringify(prev.steps) === JSON.stringify(steps) &&
      JSON.stringify(prev.acceptance_criteria) === JSON.stringify(criteria) &&
      JSON.stringify(prev.evidence_requirements) === JSON.stringify(evidenceReq)
    ) {
      return { status: 'unchanged', sop_id: sopId, version: prev.version, title, step_count: steps.length };
    }
  }

  const version = current ? (Number(current.version) + 1) : 1;
  const now = nowIso();

  state.db.prepare(
    'INSERT INTO sop_templates (sop_id, version, title, status, description, steps_json, trigger_kind, acceptance_criteria_json, evidence_requirements_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sopId, version, title, status, description, JSON.stringify(steps), triggerKind, JSON.stringify(criteria), JSON.stringify(evidenceReq), now, now);

  const eventKind = current ? 'template_updated' : 'template_created';
  appendSopEvent(state, eventKind, { sop_id: sopId, version, previous_version: current ? current.version : undefined, source: 'yaml_import', yaml_path: yamlPath });
  return { status: current ? 'updated' : 'created', sop_id: sopId, version, previous_version: current ? current.version : undefined, title, step_count: steps.length };
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
  ).run(sopId, nextVersion, title, optionalString(args.status) ?? 'draft', description, JSON.stringify(steps), triggerKind, JSON.stringify(criteria), JSON.stringify(evidenceReq), now, now);
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

function nextStep(stepStates: SopStepState[]): JsonRecord | null {
  const next = stepStates.find((s) => s.status === 'running');
  if (!next) return null;
  const autoBefore = stepStates.filter((s) => s.step_id !== next.step_id && s.status !== 'pending' && !s.blocking).slice(-3).map((s) => ({
    step_id: s.step_id,
    status: s.status,
    summary: s.result.exit_code !== undefined ? `exit ${s.result.exit_code}` : s.result.stdout ? String(s.result.stdout).slice(0, 80) : '',
  }));
  return {
    step_id: next.step_id,
    executor: next.executor,
    title: next.title,
    instructions: ((next.result as JsonRecord).instructions as string) || next.instructions,
    command: next.command,
    child_run_id: next.child_run_id ?? asRecord(next.result).child_run_id,
    child_sop_id: next.sop_id ?? asRecord(next.result).child_sop_id,
    child_status: asRecord(next.result).child_status,
    result: next.result,
    prior_auto_steps: autoBefore.length ? autoBefore : undefined,
  };
}

async function sopRunStart(args: JsonRecord, state: SopState) {
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
    executor: step.executor,
    blocking: step.blocking,
    title: step.title,
    status: 'pending' as const,
    depends_on: step.depends_on,
    instructions: step.instructions,
    command: step.command,
    args: step.args,
    timeout_ms: step.timeout_ms,
    cwd: step.cwd,
    sop_id: step.sop_id,
    sop_version: step.sop_version,
    wait_policy: step.wait_policy,
    child_run_id: null,
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
  const advanced = await advanceAutoSteps(runId, stepStates, state);
  return { status: advanced.status, run_id: runId, sop_id: sopId, sop_version: version, sop_title: template.title, step_states: advanced.stepStates, next_awaits_confirmation: advanced.awaitingConfirmation, next_step: nextStep(advanced.stepStates) };
}

async function sopRunStatus(args: JsonRecord, state: SopState) {
  const runId = requiredString(args.run_id, 'sop_requires_run_id');
  const row = state.db.prepare('SELECT * FROM sop_runs WHERE run_id = ?').get(runId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_run_not_found', `sop_run_not_found:${runId}`);
  const run = hydrateRun(row);
  const childRefreshAvailable = !RUN_TERMINAL.has(run.status) && !run.step_states_parse_error && run.step_states.some((s) => s.executor === 'sop' && s.status === 'running' && s.child_run_id);
  return {
    ...run,
    next_step: nextStep(run.step_states),
    relationship_refresh: childRefreshAvailable ? { available: true, tool: 'sop_run_refresh', reason: 'running_child_sop_step' } : { available: false },
  };
}

async function sopRunRefresh(args: JsonRecord, state: SopState) {
  const runId = requiredString(args.run_id, 'sop_requires_run_id');
  const row = state.db.prepare('SELECT * FROM sop_runs WHERE run_id = ?').get(runId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_run_not_found', `sop_run_not_found:${runId}`);
  const run = hydrateRun(row);
  if (RUN_TERMINAL.has(run.status) || run.step_states_parse_error) {
    return { ...run, next_step: nextStep(run.step_states), relationship_refresh: { refreshed: false, reason: RUN_TERMINAL.has(run.status) ? 'terminal_run' : 'step_state_parse_error' } };
  }
  const hadRunningChild = run.step_states.some((s) => s.executor === 'sop' && s.status === 'running' && s.child_run_id);
  const advanced = await advanceAutoSteps(runId, run.step_states, state);
  const refreshed = getRunById(runId, state);
  return {
    ...refreshed,
    step_states: advanced.stepStates,
    next_step: nextStep(advanced.stepStates),
    relationship_refresh: { refreshed: hadRunningChild, kind: hadRunningChild ? 'child_sop_status' : 'none' },
  };
}

async function sopRunAdvance(args: JsonRecord, state: SopState) {
  const runId = requiredString(args.run_id, 'sop_requires_run_id');
  const stepId = requiredString(args.step_id, 'sop_requires_step_id');
  const result = asRecord(args.result);
  const row = state.db.prepare('SELECT * FROM sop_runs WHERE run_id = ?').get(runId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_run_not_found', `sop_run_not_found:${runId}`);
  const run = hydrateRun(row);
  if (RUN_TERMINAL.has(run.status)) throw diagnosticError('sop_run_terminal', `sop_run_terminal:${runId}`, { status: run.status });
  const stepStates = run.step_states;
  if (run.step_states_parse_error) throw diagnosticError('sop_run_corrupt', `sop_run_corrupt:${runId}`, { reason: run.step_states_parse_error });
  if (!Array.isArray(stepStates) || (stepStates.length === 0 && !RUN_TERMINAL.has(run.status))) throw diagnosticError('sop_run_corrupt', `sop_run_corrupt:${runId}`, { reason: 'step_states missing or empty for non-terminal run' });
  const target = stepStates.find((s) => s.step_id === stepId);
  if (!target) throw diagnosticError('sop_step_not_found', `sop_step_not_found:${stepId}`);
  if (!target.blocking) throw diagnosticError('sop_step_not_blocking', `sop_step_not_blocking:${stepId}`, { blocking: target.blocking });
  if (target.status !== 'running') throw diagnosticError('sop_step_not_running', `sop_step_not_running:${stepId}`, { status: target.status });
  target.status = 'completed';
  target.completed_at = nowIso();
  const principal = optionalString(args.principal);
  const mergedResult = { ...target.result, ...result };
  if (principal) mergedResult.confirmed_by = principal;
  target.result = mergedResult;
  appendRunEvent(state, runId, stepId, 'step_completed', { result: target.result, principal: principal || undefined });
  const advanced = await advanceAutoSteps(runId, stepStates, state);
  const sop = state.db.prepare('SELECT sop_id, sop_title FROM sop_runs WHERE run_id = ?').get(runId) as JsonRecord;
  return { status: advanced.status, run_id: runId, sop_id: String(sop?.sop_id ?? ''), sop_title: String(sop?.sop_title ?? ''), step_states: advanced.stepStates, next_awaits_confirmation: advanced.awaitingConfirmation, next_step: nextStep(advanced.stepStates) };
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

function interpolateContext(text: string | null, stepStates: SopStepState[]): string | null {
  if (!text) return text;
  return text.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_match, stepId: string, field: string) => {
    const source = stepStates.find((s) => s.step_id === stepId);
    if (!source || source.status !== 'completed') return `{{${stepId}.${field}}}`;
    const value = asRecord(source.result)[field];
    return value !== undefined ? String(value).trim() : `{{${stepId}.${field}}}`;
  });
}

async function executeStepCommand(command: string, args: string[], cwd: string | null, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveExecution) => {
    const child = spawn(command, args, { cwd: cwd ?? undefined, windowsHide: true, timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      resolveExecution({ exitCode: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut: false });
    });
    child.on('close', (code, signal) => {
      timedOut = signal === 'SIGTERM' || signal === 'SIGKILL';
      resolveExecution({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

async function advanceAutoSteps(runId: string, stepStates: SopStepState[], state: SopState): Promise<{ status: string; stepStates: SopStepState[]; awaitingConfirmation: boolean }> {
  let awaitingConfirmation = false;
  for (const stepState of stepStates) {
    if (stepState.status !== 'running' || stepState.executor !== 'sop' || !stepState.child_run_id) continue;
    const child = getRunById(stepState.child_run_id, state);
    stepState.result = { ...stepState.result, child_run_id: stepState.child_run_id, child_status: child.status };
    if (child.status === 'completed') {
      stepState.status = 'completed';
      stepState.completed_at = nowIso();
      appendRunEvent(state, runId, stepState.step_id, 'child_sop_completed', { child_run_id: child.run_id, child_status: child.status });
    } else if (child.status === 'failed' || child.status === 'cancelled') {
      stepState.status = 'failed';
      stepState.completed_at = nowIso();
      stepState.error_message = `child_sop_${child.status}:${child.run_id}`;
      appendRunEvent(state, runId, stepState.step_id, 'child_sop_failed', { child_run_id: child.run_id, child_status: child.status });
    }
  }
  for (const stepState of stepStates) {
    if (stepState.status !== 'pending') continue;
    const failedDeps = stepState.depends_on.filter((depId) => {
      const dep = stepStates.find((s) => s.step_id === depId);
      return dep && (dep.status === 'failed' || dep.status === 'skipped');
    });
    if (failedDeps.length) {
      stepState.status = 'failed';
      stepState.completed_at = nowIso();
      stepState.error_message = `failed_dependency:${failedDeps.join(',')}`;
      appendRunEvent(state, runId, stepState.step_id, 'step_failed', { failed_dependencies: failedDeps });
      continue;
    }
    const allDepsReady = stepState.depends_on.every((depId) => {
      const dep = stepStates.find((s) => s.step_id === depId);
      return dep && dep.status === 'completed';
    });
    if (!allDepsReady && stepState.blocking) continue;
    if (!allDepsReady && !stepState.blocking) {
      stepState.status = 'blocked';
      stepState.error_message = `blocked_by:${stepState.depends_on.filter((d) => !stepStates.find((s) => s.step_id === d) || stepStates.find((s) => s.step_id === d)!.status !== 'completed').join(',')}`;
      appendRunEvent(state, runId, stepState.step_id, 'step_blocked', { blocked_by: stepState.error_message });
      continue;
    }
    const resolvedCmd = interpolateContext(stepState.command ?? null, stepStates);
    const resolvedArgs = stepState.args?.map((a) => interpolateContext(a, stepStates) ?? a);
    const resolvedInstructions = interpolateContext(stepState.instructions ?? null, stepStates);
    stepState.started_at = nowIso();
    let execResult: { exitCode: number; stdout: string; stderr: string; timedOut: boolean } | null = null;
    if (stepState.executor === 'sop') {
      const child = await startChildSopRun(runId, stepState, state);
      stepState.status = child.status === 'completed' ? 'completed' : child.status === 'failed' || child.status === 'cancelled' ? 'failed' : 'running';
      stepState.child_run_id = child.run_id;
      stepState.result = {
        child_run_id: child.run_id,
        child_sop_id: child.sop_id,
        child_sop_version: child.sop_version,
        child_status: child.status,
        wait_policy: stepState.wait_policy ?? 'wait',
      };
      if (stepState.status === 'completed' || stepState.status === 'failed') stepState.completed_at = nowIso();
      if (stepState.status === 'failed') stepState.error_message = `child_sop_${child.status}:${child.run_id}`;
      appendRunEvent(state, runId, stepState.step_id, 'child_sop_started', { child_run_id: child.run_id, child_sop_id: child.sop_id, child_sop_version: child.sop_version, child_status: child.status });
      if (stepState.status === 'running') break;
      continue;
    }
    if (resolvedCmd) {
      stepState.status = 'running';
      appendRunEvent(state, runId, stepState.step_id, 'step_started', { executor: stepState.executor, blocking: stepState.blocking, command: resolvedCmd });
      try {
        execResult = await executeStepCommand(resolvedCmd, resolvedArgs ?? [], stepState.cwd ?? null, stepState.timeout_ms ?? 30000);
      } catch (err) {
        execResult = { exitCode: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false };
      }
    }
    const result: JsonRecord = {};
    if (execResult) {
      result.command = resolvedCmd;
      result.exit_code = execResult.exitCode;
      result.timed_out = execResult.timedOut;
      result.stdout = execResult.stdout.replace(/\r?\n$/, '').slice(0, 10000);
      result.stderr = execResult.stderr.replace(/\r?\n$/, '').slice(0, 4000);
    }
    if (!stepState.blocking) {
      stepState.status = execResult && execResult.exitCode !== 0 ? 'failed' : 'completed';
      stepState.completed_at = nowIso();
      stepState.result = result;
      if (resolvedInstructions) result.instructions = resolvedInstructions;
      appendRunEvent(state, runId, stepState.step_id, stepState.status === 'failed' ? 'step_failed' : 'step_completed', { executor: stepState.executor, blocking: false, result });
    } else {
      stepState.status = 'running';
      stepState.result = result;
      if (resolvedInstructions) result.instructions = resolvedInstructions;
      appendRunEvent(state, runId, stepState.step_id, execResult ? 'step_completed' : 'step_started', { executor: stepState.executor, blocking: true, result });
      awaitingConfirmation = true;
      break;
    }
  }
  const allTerminal = stepStates.every((s) => STEP_TERMINAL.has(s.status));
  if (allTerminal) {
    const anyFailed = stepStates.some((s) => s.status === 'failed');
    const finalStatus = anyFailed ? 'failed' : 'completed';
    const now = nowIso();
    state.db.prepare('UPDATE sop_runs SET status = ?, step_states_json = ?, updated_at = ?, completed_at = ? WHERE run_id = ?').run(finalStatus, JSON.stringify(stepStates), now, now, runId);
    appendRunEvent(state, runId, null, finalStatus === 'completed' ? 'run_completed' : 'run_failed', { step_states: stepStates.map((s) => ({ step_id: s.step_id, status: s.status })) });
    return { status: finalStatus, stepStates, awaitingConfirmation: false };
  }
  const activeStatus = awaitingConfirmation ? 'awaiting_confirmation' : 'running';
  state.db.prepare('UPDATE sop_runs SET status = ?, step_states_json = ?, updated_at = ? WHERE run_id = ?').run(activeStatus, JSON.stringify(stepStates), nowIso(), runId);
  appendRunEvent(state, runId, null, 'run_advanced', { status: activeStatus });
  return { status: activeStatus, stepStates, awaitingConfirmation };
}

function getRunById(runId: string, state: SopState): SopRun {
  const row = state.db.prepare('SELECT * FROM sop_runs WHERE run_id = ?').get(runId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_run_not_found', `sop_run_not_found:${runId}`);
  return hydrateRun(row);
}

async function startChildSopRun(parentRunId: string, stepState: SopStepState, state: SopState): Promise<SopRun> {
  const childSopId = stepState.sop_id;
  if (!childSopId) throw diagnosticError('sop_step_requires_child_sop_id', `sop_step_requires_child_sop_id:${stepState.step_id}`, { step_id: stepState.step_id });
  const start = await sopRunStart({
    sop_id: childSopId,
    sop_version: stepState.sop_version ?? undefined,
    trigger_source_kind: 'parent_sop_step',
    trigger_source_ref: `${parentRunId}:${stepState.step_id}`,
    triggered_by: `sop:${parentRunId}`,
  }, state);
  const childRunId = String(start.run_id);
  appendRunEvent(state, childRunId, null, 'child_run_linked_to_parent', { parent_run_id: parentRunId, parent_step_id: stepState.step_id });
  return getRunById(childRunId, state);
}

function validateSteps(steps: JsonRecord[], state: SopState): SopStep[] {
  const validated: SopStep[] = [];
  const ids = new Set<string>();
  for (const step of steps) {
    const id = requiredString(step.id, 'sop_step_requires_id');
    if (ids.has(id)) throw diagnosticError('sop_duplicate_step_id', `sop_duplicate_step_id:${id}`);
    ids.add(id);
    const executor = requiredString(step.executor, 'sop_step_requires_executor', { step_id: id });
    if (!STEP_EXECUTORS.includes(executor as typeof STEP_EXECUTORS[number])) throw diagnosticError('sop_invalid_executor', `sop_invalid_executor:${executor}`, { step_id: id, allowed: STEP_EXECUTORS });
    const blocking = executor === 'sop' ? false : step.blocking !== undefined ? Boolean(step.blocking) : true;
    const sopId = optionalString(step.sop_id);
    const sopVersion = step.sop_version !== undefined && step.sop_version !== null ? Number(step.sop_version) : null;
    const waitPolicy = optionalString(step.wait_policy) ?? (executor === 'sop' ? 'wait' : null);
    if (executor === 'sop') {
      if (!sopId) throw diagnosticError('sop_step_requires_child_sop_id', `sop_step_requires_child_sop_id:${id}`, { step_id: id });
      if (waitPolicy !== 'wait') throw diagnosticError('sop_invalid_wait_policy', `sop_invalid_wait_policy:${waitPolicy}`, { step_id: id, allowed: ['wait'] });
      if (sopVersion !== null && (!Number.isInteger(sopVersion) || sopVersion < 1)) throw diagnosticError('sop_invalid_child_sop_version', `sop_invalid_child_sop_version:${sopVersion}`, { step_id: id });
    }
    validated.push({
      id,
      executor,
      blocking,
      title: requiredString(step.title, 'sop_step_requires_title', { step_id: id }),
      depends_on: stringList(step.depends_on),
      instructions: requiredString(step.instructions, 'sop_step_requires_instructions', { step_id: id }),
      command: optionalString(step.command),
      args: stringList(step.args),
      timeout_ms: step.timeout_ms !== undefined ? clamp(integer(step.timeout_ms, 30000, 1000, 600000), 1000, 600000) : null,
      cwd: optionalString(step.cwd),
      sop_id: sopId,
      sop_version: sopVersion,
      wait_policy: waitPolicy,
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
  const steps: JsonRecord[] = JSON.parse(String(row.steps_json));
  const migrated = steps.map(migrateStep);
  return {
    schema: 'narada.sop.template.v1',
    render_mode: 'summary_text_with_full_structured_content',
    full_step_definitions_path: 'structuredContent.steps',
    sop_id: String(row.sop_id),
    version: Number(row.version),
    title: String(row.title),
    status: String(row.status),
    description: String(row.description),
    steps: migrated,
    trigger_kind: String(row.trigger_kind),
    acceptance_criteria: JSON.parse(String(row.acceptance_criteria_json)),
    evidence_requirements: JSON.parse(String(row.evidence_requirements_json)),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function migrateStep(step: JsonRecord): SopStep {
  const executor = String(step.executor ?? (step.kind === 'manual' ? 'operator' : step.kind === 'note' ? 'engine' : step.kind));
  const blocking = step.blocking !== undefined ? Boolean(step.blocking) : (step.kind !== 'note');
  return {
    id: String(step.id),
    executor: STEP_EXECUTORS.includes(executor as typeof STEP_EXECUTORS[number]) ? executor : 'operator',
    blocking: executor === 'sop' ? false : blocking,
    title: String(step.title),
    depends_on: Array.isArray(step.depends_on) ? step.depends_on.map(String) : [],
    instructions: String(step.instructions),
    command: step.command != null ? String(step.command) : null,
    args: Array.isArray(step.args) ? step.args.map(String) : [],
    timeout_ms: step.timeout_ms != null ? clamp(Number(step.timeout_ms), 1000, 600000) : null,
    cwd: step.cwd != null ? String(step.cwd) : null,
    sop_id: step.sop_id != null ? String(step.sop_id) : null,
    sop_version: step.sop_version != null ? Number(step.sop_version) : null,
    wait_policy: step.wait_policy != null ? String(step.wait_policy) : (executor === 'sop' ? 'wait' : null),
  };
}

function migrateStepState(step: JsonRecord): SopStepState {
  const migrated = migrateStep(step);
  return {
    step_id: String(step.step_id ?? migrated.id),
    executor: migrated.executor,
    blocking: migrated.blocking,
    title: migrated.title,
    status: String(step.status ?? 'pending'),
    depends_on: migrated.depends_on,
    instructions: migrated.instructions,
    command: migrated.command,
    args: migrated.args,
    timeout_ms: migrated.timeout_ms,
    cwd: migrated.cwd,
    sop_id: migrated.sop_id,
    sop_version: migrated.sop_version,
    wait_policy: migrated.wait_policy,
    child_run_id: step.child_run_id != null ? String(step.child_run_id) : (asRecord(step.result).child_run_id != null ? String(asRecord(step.result).child_run_id) : null),
    started_at: step.started_at != null ? String(step.started_at) : null,
    completed_at: step.completed_at != null ? String(step.completed_at) : null,
    result: asRecord(step.result),
    error_message: step.error_message != null ? String(step.error_message) : null,
  };
}

function hydrateRun(row: JsonRecord): SopRun {
  let stepStates: SopStepState[];
  let parseError: string | null = null;
  try {
    const parsed = JSON.parse(String(row.step_states_json));
    if (!Array.isArray(parsed)) {
      parseError = 'step_states_json is not an array';
      stepStates = [];
    } else {
      stepStates = parsed.map((s) => migrateStepState(asRecord(s)));
    }
  } catch (e) {
    parseError = String(e instanceof Error ? e.message : e);
    stepStates = [];
  }
  return {
    run_id: String(row.run_id),
    sop_id: String(row.sop_id),
    sop_version: Number(row.sop_version),
    sop_title: String(row.sop_title),
    status: String(row.status),
    step_states: stepStates,
    step_states_parse_error: parseError,
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
  if (result.status === 'created' || result.status === 'updated' || result.status === 'deprecated' || result.status === 'unchanged') {
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
    const items = result.items as JsonRecord[];
    const header = items.length > 0 && items[0].event_kind
      ? [`events: ${result.count ?? 0}`]
      : [`sop_list: ${result.count ?? 0}`];
    const lines = items.map((item) => {
      if (item.event_kind) {
        return `  ${item.event_kind}: step=${item.step_id || '-'} at ${(String(item.recorded_at ?? '')).slice(0, 19)}`;
      }
      return `  ${item.sop_id ?? item.run_id ?? ''}: ${item.title ?? item.sop_title ?? ''} [${item.status ?? ''}]`;
    });
    return [...header, ...lines].join('\n');
  }
  if (result.run_id) {
    const steps = (result.step_states as JsonRecord[] | undefined) ?? [];
    const stepSummary = steps.map((s) => {
      const marker = s.status === 'running' ? '>' : s.status === 'completed' ? '+' : s.status === 'failed' ? '!' : ' ';
      return `  ${marker} ${s.step_id} [${s.executor ?? '?'}${s.blocking ? ':block' : ''}] ${s.status}`;
    });
    return [
      `sop_run: ${result.status ?? 'ok'}`,
      `run_id: ${result.run_id}`,
      `sop_id: ${result.sop_id ?? ''}`,
      result.sop_title ? `title: ${result.sop_title}` : '',
      result.completed_at ? `completed_at: ${result.completed_at}` : '',
      result.next_awaits_confirmation ? 'next_awaits_confirmation: true' : '',
      result.next_step ? `next_step: ${(result.next_step as JsonRecord).step_id} (${(result.next_step as JsonRecord).executor}) — ${String((result.next_step as JsonRecord).instructions ?? '').slice(0, 120)}` : '',
      ...stepSummary,
    ].filter(Boolean).join('\n');
  }
  if (Array.isArray(result.steps)) {
    return [
      `sop_template: ${result.sop_id} v${result.version} [${result.status}]`,
      `title: ${result.title ?? ''}`,
      `description: ${String(result.description ?? '').slice(0, 120)}`,
      `trigger: ${result.trigger_kind ?? ''}`,
      `render_mode: ${result.render_mode ?? 'summary_text'}`,
      `full_step_definitions: ${result.full_step_definitions_path ?? 'structuredContent.steps'}`,
      `steps_summary: ${(result.steps as JsonRecord[]).map((s: JsonRecord) => `${s.id} (${s.executor}${s.blocking ? ':block' : ''})`).join(', ')}`,
      result.acceptance_criteria ? `criteria: ${JSON.stringify(result.acceptance_criteria)}` : '',
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
    else if (arg === '--sops-dir') {
      if (!Array.isArray(options.sopsDirs)) options.sopsDirs = [];
      (options.sopsDirs as string[]).push(argv[++i]);
    }
    else if (arg === '--output-root') options.outputRoot = argv[++i];
    else if (arg === '--server-name') options.serverName = argv[++i];
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
