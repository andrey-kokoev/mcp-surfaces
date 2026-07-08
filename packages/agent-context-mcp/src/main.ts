#!/usr/bin/env node
// @ts-nocheck
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
/**
 * Site-local agent-context MCP server.
 *
 * This is the minimum checkpoint/hydration slice admitted from the
 * agent-context checkpointing lift package. It intentionally avoids importing
 * narada-andrey runtime state or broad User Site surfaces.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  buildBoundedToolResult,
  listOutputResources,
  outputShow,
  readOutputResource,
} from '@narada2/mcp-transport';
import {
  listAgentStartSessions,
  materializeAgentSessionStart,
  openAgentContextDb,
  validateIdentityAgainstRoster,
} from './session-start.js';

const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2026-04-18';
const activeRequests = new Map();

const args = parseArgs(process.argv.slice(2));
const siteRoot = resolve(args['site-root'] ?? process.cwd());
const siteId = normalizeSiteId(args['site-id'] ?? process.env.NARADA_SITE_ID ?? deriveSiteId(siteRoot));
const SERVER_NAME = `${siteId.replace(/[^a-z0-9_.-]/gi, '-')}-agent-context-mcp`;
const dbPath = resolve(process.env.NARADA_AGENT_CONTEXT_DB || join(siteRoot, '.ai', 'state', 'agent-context.sqlite'));
const startupTracePath = join(siteRoot, '.ai', 'tmp', 'agent-context-mcp-startup.log');
const startupTraceEnabled = process.env.NARADA_AGENT_CONTEXT_MCP_TRACE === '1';

function traceStartup(event, extra = {}) {
  if (!startupTraceEnabled) return;
  try {
    mkdirSync(join(siteRoot, '.ai', 'tmp'), { recursive: true });
    appendFileSync(startupTracePath, `${JSON.stringify({
      at: new Date().toISOString(),
      event,
      pid: process.pid,
      ppid: process.ppid,
      argv: process.argv,
      cwd: process.cwd(),
      execPath: process.execPath,
      siteRoot,
      dbPath,
      agentId: process.env.NARADA_AGENT_ID ?? null,
      carrierSessionId: process.env.NARADA_CARRIER_SESSION_ID ?? null,
      ...extra,
    })}\n`);
  } catch {
    // Startup tracing must never interfere with MCP stdio.
  }
}

process.on('uncaughtException', (error) => {
  traceStartup('uncaughtException', { error: error?.stack ?? String(error) });
  throw error;
});

process.on('unhandledRejection', (error) => {
  traceStartup('unhandledRejection', { error: error?.stack ?? String(error) });
});

traceStartup('process_start');

const TOOLS = [
  guidanceToolDefinition(),
  {
    name: 'agent_context_doctor',
    description: 'Check site-local agent-context DB readiness and schema presence.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_context_whoami',
    description: 'Resolve current site session identity from NARADA_AGENT_ID, latest checkpoint, or latest start event.',
    inputSchema: {
      type: 'object',
      properties: {
        hint: { type: 'string' },
      },
    },
  },
  {
    name: 'agent_context_start_session',
    description: 'Validate a site roster identity and materialize a site-local agent start event.',
    inputSchema: {
      type: 'object',
      properties: {
        identity: { type: 'string' },
        runtime: { type: 'string' },
        cwd: { type: 'string' },
        dry_run: { type: 'boolean' },
      },
      required: ['identity'],
    },
  },
  {
    name: 'agent_context_checkpoint',
    description: 'Write a durable site-local agent checkpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        session_id: { type: 'string' },
        active_task: { type: 'object' },
        files_touched: { type: 'array', items: { type: 'string' } },
        key_decisions: { type: 'array', items: { type: 'string' } },
        open_questions: { type: 'array', items: { type: 'string' } },
        git_head: { type: 'string' },
        last_workboard_check_at: { type: 'string' },
        next_intended_action: { type: 'object' },
        authority_basis: { type: 'object' },
        continuation_blockers: { type: 'array', items: { type: 'string' } },
        evidence_refs: { type: 'array', items: { type: 'string' } },
        worktree_state: { type: 'object' },
        tactical_resume_notes: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'agent_context_rehydrate',
    description: 'Retrieve the latest site-local checkpoint or checkpoint history for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        history: { type: 'boolean' },
        limit: { type: 'integer' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'agent_context_hydrate_current',
    description: 'Hydrate the current site-bound session from local identity, checkpoint, and session evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        checkpoint_startup: { type: 'boolean' },
        output: { type: 'string' },
      },
    },
  },
  {
    name: 'agent_context_startup_sequence',
    description: 'Canonical alias for agent_context_hydrate_current.',
    inputSchema: {
      type: 'object',
      properties: {
        checkpoint_startup: { type: 'boolean' },
        output: { type: 'string' },
      },
    },
  },
  {
    name: 'agent_context_list_sessions',
    description: 'List site-local agent start sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        identity: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'agent_context_output_show',
    description: 'Read a materialized Agent Context MCP output ref with offset/limit paging.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        output_ref: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
    },
  },
].map((tool) => ({ ...tool, annotations: toolAnnotations(tool.name), outputSchema: genericToolOutputSchema() }));

function toolAnnotations(name: string) {
  const writes = /start_session|checkpoint/.test(name);
  return {
    title: name,
    readOnlyHint: !writes,
    destructiveHint: false,
    idempotentHint: /doctor|whoami|rehydrate|hydrate|startup|list/.test(name),
    openWorldHint: false,
  };
}

function genericToolOutputSchema() {
  return { type: 'object', additionalProperties: true };
}

assertSiteRoot();
traceStartup('site_root_ok');

let inputBuffer = '';
let transportMode = 'content-length';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (inputBuffer.length === 0) {
    traceStartup('first_stdin_chunk', {
      bytes: Buffer.byteLength(chunk, 'utf8'),
      sample: JSON.stringify(chunk.slice(0, 300)),
    });
  }
  inputBuffer += chunk;
  processInputBuffer();
});

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function assertSiteRoot() {
  const envSiteRoot = process.env.NARADA_SITE_ROOT;
  if (envSiteRoot && !samePath(envSiteRoot, siteRoot)) {
    throw new Error(`agent_context_site_root_mismatch: env NARADA_SITE_ROOT=${envSiteRoot}; bound_site_root=${siteRoot}`);
  }
  if (!pathWithin(siteRoot, dbPath)) {
    throw new Error(`agent_context_db_path_outside_site_root: db_path=${dbPath}; bound_site_root=${siteRoot}`);
  }
  const agPath = join(siteRoot, 'AGENTS.md');
  if (!existsSync(agPath)) {
    throw new Error(`agent_context_missing_agents_md: ${agPath}`);
  }
}

function deriveSiteId(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/g, '');
  const parts = normalized.split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? 'unknown-site';
  if (last === '.narada' && parts.length > 1) return parts[parts.length - 2];
  return last;
}

function normalizeSiteId(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return 'unknown-site';
  return text.replace(/^narada[.-]/, 'narada.');
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function pathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith('..\\')
    && !relativePath.startsWith('../')
    && !relativePath.includes(':')
  );
}

function processInputBuffer() {
  while (true) {
    if (inputBuffer.startsWith('{')) {
      const lineEnd = inputBuffer.indexOf('\n');
      if (lineEnd === -1) return;
      const line = inputBuffer.slice(0, lineEnd).trim();
      inputBuffer = inputBuffer.slice(lineEnd + 1);
      transportMode = 'ndjson';
      if (line) handleMessage(JSON.parse(line));
      continue;
    }
    const crlfHeaderEnd = inputBuffer.indexOf('\r\n\r\n');
    const lfHeaderEnd = inputBuffer.indexOf('\n\n');
    const headerEnd = crlfHeaderEnd === -1
      ? lfHeaderEnd
      : lfHeaderEnd === -1
        ? crlfHeaderEnd
        : Math.min(crlfHeaderEnd, lfHeaderEnd);
    if (headerEnd === -1) return;
    const separatorLength = inputBuffer.startsWith('\r\n\r\n', headerEnd) ? 4 : 2;
    const header = inputBuffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) throw new Error('mcp_content_length_missing');
    const length = Number(match[1]);
    const bodyStart = headerEnd + separatorLength;
    if (inputBuffer.length < bodyStart + length) return;
    const body = inputBuffer.slice(bodyStart, bodyStart + length);
    inputBuffer = inputBuffer.slice(bodyStart + length);
    handleMessage(JSON.parse(body));
  }
}

function send(payload) {
  const body = JSON.stringify(payload);
  if (transportMode === 'ndjson') {
    process.stdout.write(`${body}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, error) {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function sendProgress(message, progress, progressMessage) {
  const progressToken = message?.params?._meta?.progressToken;
  if (progressToken === undefined) return;
  send({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken, progress, total: 1, message: progressMessage },
  });
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.error) return;
  if (!message.id && message.method === 'notifications/cancelled') {
    const requestId = String(message.params?.requestId ?? '');
    activeRequests.get(requestId)?.abort();
    return;
  }
  if (!message.id && typeof message.method === 'string' && message.method.startsWith('notifications/')) return;
  const id = message.id ?? null;
  const requestId = id == null ? null : String(id);
  const abortController = requestId == null ? null : new AbortController();
  if (requestId) activeRequests.set(requestId, abortController);
  try {
    sendProgress(message, 0, 'started');
    if (message.method === 'initialize') {
      traceStartup('initialize');
      respond(id, {
        protocolVersion: message.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {}, completions: {}, logging: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    if (message.method === 'notifications/initialized') return;
    if (message.method === 'tools/list') {
      traceStartup('tools_list');
      respond(id, { tools: TOOLS });
      return;
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const toolArgs = message.params?.arguments ?? {};
      const result = callTool(name, toolArgs);
      respond(id, buildBoundedToolResult({
        siteRoot,
        toolName: String(name ?? 'unknown_tool'),
        value: result,
        limit: 6000,
        readerTool: 'agent_context_output_show',
      }));
      return;
    }
    if (message.method === 'resources/list') {
      respond(id, listOutputResources({ siteRoot }));
      return;
    }
    if (message.method === 'resources/read') {
      respond(id, readOutputResource({ siteRoot, uri: message.params?.uri }));
      return;
    }
    if (message.method === 'prompts/list') {
      respond(id, { prompts: listPrompts() });
      return;
    }
    if (message.method === 'prompts/get') {
      respond(id, promptGet(message.params ?? {}));
      return;
    }
    if (message.method === 'completion/complete') {
      respond(id, completeArgument(message.params ?? {}));
      return;
    }
    if (message.method === 'logging/setLevel') {
      respond(id, {});
      return;
    }
    respondError(id, new Error(`unsupported_method: ${message.method}`));
  } catch (error) {
    respondError(id, error);
  } finally {
    sendProgress(message, 1, abortController?.signal.aborted ? 'cancelled' : 'completed');
    if (requestId) activeRequests.delete(requestId);
  }
}

function listPrompts() {
  return [{ name: 'agent_context_startup', title: 'Agent Context Startup', description: 'Guidance for hydrating and checkpointing agent context.', arguments: [] }];
}

function promptGet(params) {
  const name = String(params.name ?? '');
  if (name !== 'agent_context_startup') throw new Error(`unknown_prompt: ${name}`);
  return {
    description: 'Guidance for hydrating and checkpointing agent context.',
    messages: [{ role: 'user', content: { type: 'text', text: 'Use agent_context_hydrate_current at startup, checkpoint meaningful state transitions, and rehydrate before resuming long-running work.' } }],
  };
}

function completeArgument(params) {
  const argumentName = String((params.argument && typeof params.argument === 'object' ? params.argument.name : '') ?? '');
  const values = argumentName === 'name' ? TOOLS.map((tool) => tool.name).filter(Boolean).slice(0, 100) : [];
  return { completion: { values, total: values.length, hasMore: false } };
}

function assistantTextContent(text: string) {
  return { type: 'text', text, annotations: { audience: ['assistant'] } };
}

function callTool(name, toolArgs) {
  switch (name) {
    case 'agent_context_guidance':
      return buildGuidanceResult(toolArgs);
    case 'agent_context_doctor':
      return doctor();
    case 'agent_context_output_show':
      return outputShow({ siteRoot, args: toolArgs });
    case 'agent_context_whoami':
      return whoami(toolArgs);
    case 'agent_context_start_session':
      return startSession(toolArgs);
    case 'agent_context_checkpoint':
      return checkpoint(toolArgs);
    case 'agent_context_rehydrate':
      return rehydrate(toolArgs);
    case 'agent_context_hydrate_current':
    case 'agent_context_startup_sequence':
      return hydrateCurrent(toolArgs);
    case 'agent_context_list_sessions':
      return listSessions(toolArgs);
    default:
      throw new Error(`unknown_tool: ${name}`);
  }
}

function withDb(fn) {
  const db = openAgentContextDb(siteRoot, dbPath);
  try {
    ensureCheckpointTables(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function ensureCheckpointTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      checkpoint_at TEXT NOT NULL,
      active_task_json TEXT,
      files_touched_json TEXT,
      key_decisions_json TEXT,
      open_questions_json TEXT,
      git_head TEXT,
      payload_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_agent
      ON agent_checkpoints(agent_id, checkpoint_at DESC);

    CREATE TABLE IF NOT EXISTS agent_checkpoint_history (
      history_id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      checkpoint_at TEXT NOT NULL,
      active_task_json TEXT,
      files_touched_json TEXT,
      key_decisions_json TEXT,
      open_questions_json TEXT,
      git_head TEXT,
      payload_json TEXT,
      archived_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_checkpoint_history_agent
      ON agent_checkpoint_history(agent_id, archived_at DESC);
  `);
}

function doctor() {
  return withDb((db) => {
    const tables = [
      'agent_start_events',
      'agent_events',
      'agent_checkpoints',
      'agent_checkpoint_history',
    ].map((table) => ({
      table,
      exists: !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    }));
    return {
      status: tables.every((table) => table.exists) ? 'ok' : 'degraded',
      site_id: siteId,
      server_name: SERVER_NAME,
      site_root: siteRoot,
      db_path: dbPath,
      tables,
    };
  });
}

function startSession(toolArgs) {
  const identity = requiredString(toolArgs, 'identity');
  assertAgentContextIdentity(identity);
  return materializeAgentSessionStart({
    siteRoot,
    identity,
    runtime: toolArgs.runtime ?? 'codex',
    dbPath,
    cwd: toolArgs.cwd ?? siteRoot,
    dryRun: toolArgs.dry_run === true,
  });
}

function checkpoint(toolArgs) {
  const agentId = toolArgs.agent_id ?? process.env.NARADA_AGENT_ID;
  if (!agentId) throw new Error('agent_id_required');
  assertAgentContextIdentity(agentId);

  return withDb((db) => {
    const now = new Date().toISOString();
    const checkpointId = `chk_${randomUUID().replace(/-/g, '')}`;
    const existing = db.prepare('SELECT * FROM agent_checkpoints WHERE agent_id = ?').get(agentId);
    if (existing) {
      db.prepare(`
        INSERT INTO agent_checkpoint_history (
          history_id, checkpoint_id, agent_id, session_id, checkpoint_at,
          active_task_json, files_touched_json, key_decisions_json,
          open_questions_json, git_head, payload_json, archived_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `hist_${randomUUID().replace(/-/g, '')}`,
        existing.checkpoint_id,
        existing.agent_id,
        existing.session_id,
        existing.checkpoint_at,
        existing.active_task_json,
        existing.files_touched_json,
        existing.key_decisions_json,
        existing.open_questions_json,
        existing.git_head,
        existing.payload_json,
        now
      );
      db.prepare('DELETE FROM agent_checkpoints WHERE checkpoint_id = ?').run(existing.checkpoint_id);
    }

    const payload = checkpointPayload(toolArgs, agentId, now);
    db.prepare(`
      INSERT INTO agent_checkpoints (
        checkpoint_id, agent_id, session_id, checkpoint_at,
        active_task_json, files_touched_json, key_decisions_json,
        open_questions_json, git_head, payload_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpointId,
      agentId,
      toolArgs.session_id ?? process.env.NARADA_AGENT_START_EVENT_ID ?? null,
      now,
      jsonOrNull(toolArgs.active_task),
      JSON.stringify(arrayValue(toolArgs.files_touched)),
      JSON.stringify(arrayValue(toolArgs.key_decisions)),
      JSON.stringify(arrayValue(toolArgs.open_questions)),
      toolArgs.git_head ?? null,
      JSON.stringify(payload)
    );

    return {
      status: 'checkpointed',
      checkpoint_id: checkpointId,
      archived_prior: existing?.checkpoint_id ?? null,
      agent_id: agentId,
      checkpoint_at: now,
      db_path: dbPath,
      site_root: siteRoot,
    };
  });
}

function rehydrate(toolArgs) {
  const agentId = requiredString(toolArgs, 'agent_id');
  assertAgentContextIdentity(agentId);
  const limit = Math.min(Math.max(Number(toolArgs.limit ?? 1), 1), 50);

  return withDb((db) => {
    if (toolArgs.history === true || limit > 1) {
      const rows = db.prepare(`
        SELECT * FROM agent_checkpoint_history
        WHERE agent_id = ?
        ORDER BY archived_at DESC
        LIMIT ?
      `).all(agentId, limit);
      return {
        status: rows.length > 0 ? 'ok' : 'no_checkpoint_history',
        agent_id: agentId,
        count: rows.length,
        checkpoints: rows.map(rowToCheckpoint),
      };
    }

    const row = db.prepare('SELECT * FROM agent_checkpoints WHERE agent_id = ? ORDER BY checkpoint_at DESC LIMIT 1').get(agentId);
    if (!row) {
      return { status: 'no_checkpoint', agent_id: agentId, message: 'No site-local checkpoint found.' };
    }
    return { status: 'ok', ...rowToCheckpoint(row) };
  });
}

function whoami(toolArgs = {}) {
  return withDb((db) => {
    const envAgent = process.env.NARADA_AGENT_ID;
    if (envAgent) {
      const roster = assertAgentContextIdentity(envAgent);
      return {
        status: 'ok',
        identity: envAgent,
        role: roster.role,
        confidence: 'high',
        source: 'NARADA_AGENT_ID',
        hint_match: toolArgs.hint ? envAgent === toolArgs.hint : null,
      };
    }

    const checkpointRow = db.prepare('SELECT agent_id, checkpoint_at FROM agent_checkpoints ORDER BY checkpoint_at DESC LIMIT 1').get();
    if (checkpointRow?.agent_id) {
      const roster = assertAgentContextIdentity(checkpointRow.agent_id);
      return {
        status: 'ok',
        identity: checkpointRow.agent_id,
        role: roster.valid ? roster.role : null,
        confidence: 'medium',
        source: 'latest_checkpoint',
        checkpoint_at: checkpointRow.checkpoint_at,
        hint_match: toolArgs.hint ? checkpointRow.agent_id === toolArgs.hint : null,
      };
    }

    const eventRow = db.prepare('SELECT identity_id, created_at FROM agent_start_events ORDER BY created_at DESC LIMIT 1').get();
    if (eventRow?.identity_id) {
      const roster = assertAgentContextIdentity(eventRow.identity_id);
      return {
        status: 'ok',
        identity: eventRow.identity_id,
        role: roster.valid ? roster.role : null,
        confidence: 'medium',
        source: 'latest_start_event',
        start_event_at: eventRow.created_at,
        hint_match: toolArgs.hint ? eventRow.identity_id === toolArgs.hint : null,
      };
    }

    return { status: 'unknown', message: 'No site-local session identity evidence found.' };
  });
}

function hydrateCurrent(toolArgs = {}) {
  const identity = process.env.NARADA_AGENT_ID ?? whoami({}).identity;
  if (!identity) return { status: 'blocked', reason: 'agent_identity_unresolved' };
  const resolved = whoami({ hint: identity });
  const checkpointResult = rehydrate({ agent_id: identity });
  const hydratedAt = new Date().toISOString();
  let startupCheckpoint = null;
  if (toolArgs.checkpoint_startup === true) {
    startupCheckpoint = checkpoint({
      agent_id: identity,
      authority_basis: {
        kind: 'startup_hydration',
        summary: `Startup hydration checkpoint recorded at ${hydratedAt}.`,
      },
      tactical_resume_notes: [`Hydrated from site-local checkpoint state at ${hydratedAt}.`],
    });
  }
  return {
    status: 'ok',
    site_id: siteId,
    site_root: siteRoot,
    hydrated_at: hydratedAt,
    whoami: resolved,
    checkpoint: checkpointResult,
    startup_checkpoint: startupCheckpoint,
    next_required_action: checkpointResult.status === 'ok'
      ? checkpointResult.next_intended_action ?? null
      : null,
  };
}

function listSessions(toolArgs = {}) {
  return withDb((db) => listAgentStartSessions({
    db,
    identity: toolArgs.identity ?? null,
    limit: toolArgs.limit ?? 100,
  }));
}

function checkpointPayload(toolArgs, agentId, checkpointAt) {
  return {
    schema: 'narada.agent_context.checkpoint.v1',
    site_id: siteId,
    site_root: siteRoot,
    agent_id: agentId,
    checkpoint_at: checkpointAt,
    active_task: toolArgs.active_task ?? null,
    files_touched: arrayValue(toolArgs.files_touched),
    key_decisions: arrayValue(toolArgs.key_decisions),
    open_questions: arrayValue(toolArgs.open_questions),
    git_head: toolArgs.git_head ?? null,
    last_workboard_check_at: toolArgs.last_workboard_check_at ?? null,
    next_intended_action: toolArgs.next_intended_action ?? null,
    authority_basis: toolArgs.authority_basis ?? null,
    continuation_blockers: arrayValue(toolArgs.continuation_blockers),
    evidence_refs: arrayValue(toolArgs.evidence_refs),
    worktree_state: toolArgs.worktree_state ?? null,
    tactical_resume_notes: arrayValue(toolArgs.tactical_resume_notes),
  };
}

function rowToCheckpoint(row) {
  const payload = parseJson(row.payload_json, {});
  return {
    checkpoint_id: row.checkpoint_id,
    agent_id: row.agent_id,
    session_id: row.session_id ?? null,
    checkpoint_at: row.checkpoint_at,
    active_task: parseJson(row.active_task_json, null),
    files_touched: parseJson(row.files_touched_json, []),
    key_decisions: parseJson(row.key_decisions_json, []),
    open_questions: parseJson(row.open_questions_json, []),
    git_head: row.git_head ?? null,
    last_workboard_check_at: payload.last_workboard_check_at ?? null,
    next_intended_action: payload.next_intended_action ?? null,
    authority_basis: payload.authority_basis ?? null,
    continuation_blockers: payload.continuation_blockers ?? [],
    evidence_refs: payload.evidence_refs ?? [],
    worktree_state: payload.worktree_state ?? null,
    tactical_resume_notes: payload.tactical_resume_notes ?? [],
    payload,
  };
}

function assertAgentContextIdentity(agentId) {
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new Error(`agent_context_identity_invalid: ${agentId}`);
  }
  const roster = validateIdentityAgainstRoster(siteRoot, agentId);
  if (!roster.valid) throw new Error(roster.error);
  return roster;
}

function requiredString(value, key) {
  const result = value?.[key];
  if (typeof result !== 'string' || result.trim() === '') {
    throw new Error(`${key}_required`);
  }
  return result;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

