#!/usr/bin/env node
// @ts-nocheck
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
/**
 * Site-local agent-context MCP server.
 *
 * This is the minimum checkpoint/hydration slice admitted from the
 * agent-context checkpointing lift package. It intentionally avoids importing
 * andrey-user runtime state or broad User Site surfaces.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
const MAX_CONTINUATION_BYTES = 256 * 1024;
const MAX_CONTINUATION_STATE_BYTES = 64 * 1024;
const MAX_CONTINUATION_TEXT_LENGTH = 16 * 1024;
const MAX_CONTINUATION_ARRAY_ITEMS = 200;
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
    description: 'Write a durable site-local agent checkpoint, optionally carrying canonical continuation state and linking an exact portable continuation artifact.',
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
        continuation_ref: {
          type: 'object',
          additionalProperties: false,
          properties: {
            schema: { type: 'string', const: 'narada.continuation.handoff.v1' },
            path: { type: 'string' },
            sha256: { type: 'string' },
            created_at: { type: 'string' },
          },
          required: ['schema', 'path', 'sha256', 'created_at'],
        },
        continuation: {
          type: 'object',
          additionalProperties: false,
          properties: {
            schema: { type: 'string', const: 'narada.continuation.v1' },
            continuation_id: { type: 'string' },
            objective: { type: 'string' },
            current_state: { type: 'string' },
            completed_work: { type: 'array', items: { type: 'string' } },
            decisions: { type: 'array', items: { type: 'string' } },
            evidence_refs: { type: 'array', items: { type: 'string' } },
            open_blockers: { type: 'array', items: { type: 'string' } },
            next_action: { type: 'string' },
            canonical_sources: { type: 'array', items: { type: 'string' } },
            constraints: { type: 'array', items: { type: 'string' } },
            resume_mode: { type: 'string', enum: ['fresh_session', 'same_session'] },
            created_at: { type: 'string' },
          },
          required: ['schema', 'objective', 'current_state'],
        },
      },
    },
  },
  {
    name: 'agent_context_rehydrate',
    description: 'Retrieve the latest site-local checkpoint, an exact current or archived checkpoint, or bounded checkpoint history for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        checkpoint_id: { type: 'string', description: 'Optional exact checkpoint ID. Searches current and archived checkpoints scoped to this agent.' },
        history: { type: 'boolean' },
        limit: { type: 'integer' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'agent_context_continuation_export',
    description: 'Render the latest canonical continuation as a bounded Site-local Markdown projection and attach its verified reference.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        path: { type: 'string', description: 'Optional Site-relative path under .ai/continuations ending in .md.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing projection at the explicit path.' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'agent_context_continuation_read',
    description: 'Read the latest or explicitly selected continuation and verify its portable Markdown projection against the checkpoint reference and canonical content hash.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        checkpoint_id: { type: 'string', description: 'Optional exact checkpoint ID. Searches current and archived checkpoints scoped to this agent.' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'agent_context_hydrate_current',
    description: 'Hydrate the current site-bound session from local identity, the latest or explicitly selected checkpoint, and session evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        checkpoint_id: { type: 'string', description: 'Optional exact checkpoint ID. Searches current and archived checkpoints scoped to this agent.' },
        checkpoint_startup: { type: 'boolean' },
        output: { type: 'string' },
      },
    },
  },
  {
    name: 'agent_context_startup_sequence',
    description: 'Canonical alias for agent_context_hydrate_current, including optional exact checkpoint selection.',
    inputSchema: {
      type: 'object',
      properties: {
        checkpoint_id: { type: 'string', description: 'Optional exact checkpoint ID. Searches current and archived checkpoints scoped to this agent.' },
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
    name: 'mcp_output_show',
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

function checkpointRowForAgent(db, agentId, checkpointId) {
  if (checkpointId !== null) {
    const current = db.prepare(`
      SELECT * FROM agent_checkpoints
      WHERE agent_id = ? AND checkpoint_id = ?
      LIMIT 1
    `).get(agentId, checkpointId);
    if (current) return current;
    return db.prepare(`
      SELECT * FROM agent_checkpoint_history
      WHERE agent_id = ? AND checkpoint_id = ?
      ORDER BY archived_at DESC
      LIMIT 1
    `).get(agentId, checkpointId);
  }

  return db.prepare('SELECT * FROM agent_checkpoints WHERE agent_id = ? ORDER BY checkpoint_at DESC LIMIT 1').get(agentId);
}

function normalizeContinuation(value, checkpointId, checkpointAt) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('continuation_invalid: expected an object');
  }

  const allowedKeys = new Set([
    'schema',
    'continuation_id',
    'objective',
    'current_state',
    'completed_work',
    'decisions',
    'evidence_refs',
    'open_blockers',
    'next_action',
    'canonical_sources',
    'constraints',
    'resume_mode',
    'created_at',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`continuation_field_unknown: ${key}`);
  }

  if (value.schema !== 'narada.continuation.v1') {
    throw new Error('continuation_schema_invalid');
  }

  const continuationId = value.continuation_id == null
    ? `cont_${randomUUID().replace(/-/g, '')}`
    : continuationText(value.continuation_id, 'continuation_id');
  const objective = continuationText(value.objective, 'objective', true);
  const currentState = continuationText(value.current_state, 'current_state', true);
  const resumeMode = value.resume_mode ?? 'fresh_session';
  if (resumeMode !== 'fresh_session' && resumeMode !== 'same_session') {
    throw new Error('continuation_resume_mode_invalid');
  }

  const createdAt = value.created_at == null
    ? checkpointAt
    : normalizeContinuationTimestamp(value.created_at);
  const canonical = {
    schema: 'narada.continuation.v1',
    continuation_id: continuationId,
    objective,
    current_state: currentState,
    completed_work: continuationStringArray(value.completed_work, 'completed_work'),
    decisions: continuationStringArray(value.decisions, 'decisions'),
    evidence_refs: continuationStringArray(value.evidence_refs, 'evidence_refs'),
    open_blockers: continuationStringArray(value.open_blockers, 'open_blockers'),
    next_action: continuationText(value.next_action, 'next_action'),
    canonical_sources: continuationStringArray(value.canonical_sources, 'canonical_sources'),
    constraints: continuationStringArray(value.constraints, 'constraints'),
    resume_mode: resumeMode,
    source_checkpoint_ref: `agent_context_checkpoint:${checkpointId}`,
    created_at: createdAt,
  };
  const content = { ...canonical };
  delete content.source_checkpoint_ref;
  const serialized = JSON.stringify(content);
  if (Buffer.byteLength(JSON.stringify(canonical), 'utf8') > MAX_CONTINUATION_STATE_BYTES) {
    throw new Error('continuation_too_large');
  }

  return {
    ...canonical,
    content_hash: createHash('sha256').update(serialized, 'utf8').digest('hex'),
  };
}

function continuationText(value, key, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`continuation_${key}_invalid`);
  }
  if (value.length > MAX_CONTINUATION_TEXT_LENGTH) {
    throw new Error(`continuation_${key}_too_long`);
  }
  return value;
}

function continuationStringArray(value, key) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`continuation_${key}_invalid`);
  if (value.length > MAX_CONTINUATION_ARRAY_ITEMS) {
    throw new Error(`continuation_${key}_too_many_items`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`continuation_${key}_${index}_invalid`);
    }
    if (item.length > MAX_CONTINUATION_TEXT_LENGTH) {
      throw new Error(`continuation_${key}_${index}_too_long`);
    }
    return item;
  });
}

function normalizeContinuationTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error('continuation_created_at_invalid');
  }
  return new Date(value).toISOString();
}

function normalizeContinuationExportPath(value, agentId, checkpointId) {
  const defaultPath = `.ai/continuations/${safePathSegment(agentId)}-${checkpointId}.md`;
  const path = value == null ? defaultPath : value;
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\0') || isAbsolute(path) || path.includes(':')) {
    throw new Error('continuation_export_path_must_be_site_relative');
  }
  const normalizedPath = path.replace(/\\/g, '/');
  if (!normalizedPath.toLowerCase().endsWith('.md')) {
    throw new Error('continuation_export_path_must_be_markdown');
  }
  const exportRoot = resolve(siteRoot, '.ai', 'continuations');
  const artifactPath = resolve(siteRoot, normalizedPath);
  if (!pathWithin(exportRoot, artifactPath)) {
    throw new Error('continuation_export_path_outside_export_root');
  }
  return relative(siteRoot, artifactPath).replace(/\\/g, '/');
}

function safePathSegment(value) {
  const segment = String(value ?? '')
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return segment || 'agent';
}

function renderContinuationMarkdown({ agentId, checkpoint, continuation }) {
  const lines = [
    '<!-- narada.continuation.handoff.v1 -->',
    `<!-- narada.continuation.content-hash: ${continuation.content_hash} -->`,
    `<!-- narada.continuation.source-checkpoint-ref: ${continuation.source_checkpoint_ref} -->`,
    '',
    `# Continuation: ${markdownInline(continuation.objective)}`,
    '',
    '- **Schema:** `narada.continuation.v1`',
    `- **Continuation ID:** \`${markdownInline(continuation.continuation_id)}\``,
    `- **Agent:** \`${markdownInline(agentId)}\``,
    `- **Checkpoint:** \`${markdownInline(checkpoint.checkpoint_id)}\``,
    `- **Checkpointed:** ${markdownInline(checkpoint.checkpoint_at)}`,
    `- **Created:** ${markdownInline(continuation.created_at)}`,
    `- **Resume mode:** \`${markdownInline(continuation.resume_mode)}\``,
    '',
    '## Current state',
    '',
    markdownBlock(continuation.current_state),
    '',
    '## Next action',
    '',
    markdownBlock(continuation.next_action ?? 'No next action recorded.'),
    '',
  ];
  appendMarkdownList(lines, 'Completed work', continuation.completed_work);
  appendMarkdownList(lines, 'Decisions', continuation.decisions);
  appendMarkdownList(lines, 'Evidence references', continuation.evidence_refs);
  appendMarkdownList(lines, 'Open blockers', continuation.open_blockers);
  appendMarkdownList(lines, 'Canonical sources', continuation.canonical_sources);
  appendMarkdownList(lines, 'Constraints', continuation.constraints);
  lines.push('> This file is a bounded projection of agent-context checkpoint state. Verify live Git, task, and agent-context state before acting.', '');
  return lines.join('\n');
}

function appendMarkdownList(lines, title, values) {
  lines.push(`## ${title}`, '');
  if (!Array.isArray(values) || values.length === 0) {
    lines.push('_None._', '');
    return;
  }
  for (const value of values) lines.push(`- ${markdownInline(value)}`);
  lines.push('');
}

function markdownInline(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function markdownBlock(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function writeContinuationArtifact(artifactPath, markdown, overwrite) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  const bytes = Buffer.from(markdown, 'utf8');
  if (existsSync(artifactPath)) {
    const existing = readFileSync(artifactPath);
    if (existing.equals(bytes)) return { bytes: bytes.length, wrote: false };
    if (overwrite !== true) throw new Error('continuation_export_target_exists');
    writeFileSync(artifactPath, bytes);
    return { bytes: bytes.length, wrote: true };
  }
  writeFileSync(artifactPath, bytes, { flag: 'wx' });
  return { bytes: bytes.length, wrote: true };
}

function continuationInput(value) {
  if (!value) return null;
  return {
    schema: value.schema,
    continuation_id: value.continuation_id,
    objective: value.objective,
    current_state: value.current_state,
    completed_work: value.completed_work,
    decisions: value.decisions,
    evidence_refs: value.evidence_refs,
    open_blockers: value.open_blockers,
    next_action: value.next_action,
    canonical_sources: value.canonical_sources,
    constraints: value.constraints,
    resume_mode: value.resume_mode,
    created_at: value.created_at,
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

function normalizeContinuationRef(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('continuation_ref_invalid: expected an object');
  }

  const schema = value.schema;
  const path = value.path;
  const sha256 = value.sha256;
  const createdAt = value.created_at;
  if (schema !== 'narada.continuation.handoff.v1') {
    throw new Error('continuation_ref_schema_invalid');
  }
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\0') || isAbsolute(path)) {
    throw new Error('continuation_ref_path_must_be_site_relative');
  }
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('continuation_ref_sha256_invalid');
  }
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    throw new Error('continuation_ref_created_at_invalid');
  }

  const normalizedPath = path.replace(/\\/g, '/');
  if (!pathWithin(siteRoot, resolve(siteRoot, normalizedPath))) {
    throw new Error('continuation_ref_path_outside_site_root');
  }

  const artifactPath = resolve(siteRoot, normalizedPath);
  let artifactBytes;
  try {
    const artifactStats = statSync(artifactPath);
    if (!artifactStats.isFile()) throw new Error('not_a_file');
    if (artifactStats.size > MAX_CONTINUATION_BYTES) throw new Error('too_large');
    artifactBytes = readFileSync(artifactPath);
  } catch (error) {
    throw new Error(`continuation_ref_unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const actualSha256 = createHash('sha256').update(artifactBytes).digest('hex');
  if (actualSha256 !== sha256.toLowerCase()) {
    throw new Error('continuation_ref_sha256_mismatch');
  }

  return {
    schema,
    path: normalizedPath,
    sha256: sha256.toLowerCase(),
    created_at: createdAt,
  };
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
        readerTool: 'mcp_output_show',
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
    messages: [{ role: 'user', content: { type: 'text', text: 'Use agent_context_hydrate_current at startup, checkpoint meaningful state transitions, and rehydrate before resuming long-running work. For a fresh-session handoff, keep one bounded narada.continuation.v1 object in the checkpoint and, when a portable Markdown projection exists, include its site-relative path, SHA-256, creation time, and schema as continuation_ref.' } }],
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
    case 'mcp_output_show':
      return outputShow({ siteRoot, args: toolArgs });
    case 'agent_context_whoami':
      return whoami(toolArgs);
    case 'agent_context_start_session':
      return startSession(toolArgs);
    case 'agent_context_checkpoint':
      return checkpoint(toolArgs);
    case 'agent_context_rehydrate':
      return rehydrate(toolArgs);
    case 'agent_context_continuation_export':
      return continuationExport(toolArgs);
    case 'agent_context_continuation_read':
      return continuationRead(toolArgs);
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
    const payload = checkpointPayload(toolArgs, agentId, now, checkpointId);
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
      continuation: payload.continuation ?? null,
      continuation_ref: payload.continuation_ref ?? null,
    };
  });
}

function rehydrate(toolArgs) {
  const agentId = requiredString(toolArgs, 'agent_id');
  assertAgentContextIdentity(agentId);
  const checkpointId = optionalCheckpointId(toolArgs);
  const limit = Math.min(Math.max(Number(toolArgs.limit ?? 1), 1), 50);

  return withDb((db) => {
    if (checkpointId !== null) {
      const row = checkpointRowForAgent(db, agentId, checkpointId);
      if (!row) {
        return {
          status: 'checkpoint_not_found',
          agent_id: agentId,
          checkpoint_id: checkpointId,
          message: 'No site-local current or archived checkpoint found for the requested checkpoint_id.',
        };
      }
      return { status: 'ok', ...rowToCheckpoint(row) };
    }

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

    const row = checkpointRowForAgent(db, agentId, null);
    if (!row) {
      return { status: 'no_checkpoint', agent_id: agentId, message: 'No site-local checkpoint found.' };
    }
    return { status: 'ok', ...rowToCheckpoint(row) };
  });
}

function continuationExport(toolArgs) {
  const agentId = toolArgs.agent_id ?? process.env.NARADA_AGENT_ID;
  if (!agentId) throw new Error('agent_id_required');
  assertAgentContextIdentity(agentId);

  return withDb((db) => {
    const row = db.prepare('SELECT * FROM agent_checkpoints WHERE agent_id = ? ORDER BY checkpoint_at DESC LIMIT 1').get(agentId);
    if (!row) return { status: 'no_checkpoint', agent_id: agentId, message: 'No site-local checkpoint found.' };

    const checkpoint = rowToCheckpoint(row);
    if (!checkpoint.continuation) {
      return {
        status: 'no_continuation',
        agent_id: agentId,
        checkpoint_id: checkpoint.checkpoint_id,
        message: 'The latest checkpoint has no canonical continuation state.',
      };
    }

    const relativePath = normalizeContinuationExportPath(toolArgs.path, agentId, checkpoint.checkpoint_id);
    const artifactPath = resolve(siteRoot, relativePath);
    const markdown = renderContinuationMarkdown({ agentId, checkpoint, continuation: checkpoint.continuation });
    const writeResult = writeContinuationArtifact(artifactPath, markdown, toolArgs.overwrite === true);
    const artifactBytes = readFileSync(artifactPath);
    const reference = normalizeContinuationRef({
      schema: 'narada.continuation.handoff.v1',
      path: relativePath,
      sha256: createHash('sha256').update(artifactBytes).digest('hex'),
      created_at: new Date().toISOString(),
    });
    const nextPayload = { ...checkpoint.payload, continuation_ref: reference };
    db.prepare('UPDATE agent_checkpoints SET payload_json = ? WHERE checkpoint_id = ?')
      .run(JSON.stringify(nextPayload), checkpoint.checkpoint_id);

    return {
      status: 'exported',
      site_id: siteId,
      site_root: siteRoot,
      agent_id: agentId,
      checkpoint_id: checkpoint.checkpoint_id,
      checkpoint_at: checkpoint.checkpoint_at,
      continuation: checkpoint.continuation,
      continuation_ref: reference,
      artifact: {
        path: relativePath,
        bytes: artifactBytes.length,
        wrote: writeResult.wrote,
      },
    };
  });
}

function continuationRead(toolArgs) {
  const agentId = toolArgs.agent_id ?? process.env.NARADA_AGENT_ID;
  if (!agentId) throw new Error('agent_id_required');
  assertAgentContextIdentity(agentId);
  const checkpointId = optionalCheckpointId(toolArgs);

  return withDb((db) => {
    const row = checkpointRowForAgent(db, agentId, checkpointId);
    if (!row) {
      return checkpointId === null
        ? { status: 'no_checkpoint', agent_id: agentId, message: 'No site-local checkpoint found.' }
        : {
            status: 'checkpoint_not_found',
            agent_id: agentId,
            checkpoint_id: checkpointId,
            message: 'No site-local current or archived checkpoint found for the requested checkpoint_id.',
          };
    }

    const checkpoint = rowToCheckpoint(row);
    const checkpointLabel = checkpointId === null ? 'latest checkpoint' : `checkpoint ${checkpointId}`;
    const base = {
      site_id: siteId,
      site_root: siteRoot,
      agent_id: agentId,
      checkpoint_id: checkpoint.checkpoint_id,
      checkpoint_at: checkpoint.checkpoint_at,
      continuation: checkpoint.continuation,
      continuation_ref: checkpoint.continuation_ref,
    };
    if (!checkpoint.continuation_ref) {
      return {
        ...base,
        status: checkpoint.continuation ? 'unlinked' : 'no_continuation',
        message: checkpoint.continuation
          ? `Canonical continuation exists in the ${checkpointLabel} but has no portable Markdown reference.`
          : `The ${checkpointLabel} has no canonical continuation state.`,
      };
    }

    try {
      const reference = normalizeContinuationRef(checkpoint.continuation_ref);
      const markdown = readFileSync(resolve(siteRoot, reference.path), 'utf8');
      if (checkpoint.continuation) {
        const handoffMarker = '<!-- narada.continuation.handoff.v1 -->';
        const contentHashMarker = `<!-- narada.continuation.content-hash: ${checkpoint.continuation.content_hash} -->`;
        if (!markdown.includes(handoffMarker) || !markdown.includes(contentHashMarker)) {
          return {
            ...base,
            continuation_ref: reference,
            status: 'stale',
            reason: 'continuation_artifact_content_hash_mismatch',
            artifact: { path: reference.path, verified: false },
          };
        }
      }
      return {
        ...base,
        continuation_ref: reference,
        status: 'ok',
        artifact: {
          path: reference.path,
          sha256: reference.sha256,
          created_at: reference.created_at,
          bytes: Buffer.byteLength(markdown, 'utf8'),
          verified: true,
          markdown,
        },
      };
    } catch (error) {
      return {
        ...base,
        status: 'stale',
        reason: error instanceof Error ? error.message : String(error),
        artifact: { path: checkpoint.continuation_ref.path, verified: false },
      };
    }
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
  const checkpointId = optionalCheckpointId(toolArgs);
  const checkpointSelection = checkpointId === null ? {} : { checkpoint_id: checkpointId };
  const resolved = whoami({ hint: identity });
  const checkpointResult = rehydrate({ agent_id: identity, ...checkpointSelection });
  const portableContinuationBefore = continuationRead({ agent_id: identity, ...checkpointSelection });
  const hydratedAt = new Date().toISOString();
  let startupCheckpoint = null;
  if (toolArgs.checkpoint_startup === true && checkpointResult.status !== 'checkpoint_not_found') {
    const selectedCheckpointId = checkpointResult.status === 'ok'
      ? checkpointResult.checkpoint_id
      : checkpointId;
    const selectedCheckpointLabel = selectedCheckpointId ? `checkpoint ${selectedCheckpointId}` : 'the latest checkpoint';
    const startupArgs = {
      agent_id: identity,
      authority_basis: {
        kind: 'startup_hydration',
        summary: `Startup hydration checkpoint recorded at ${hydratedAt} from ${selectedCheckpointLabel}.`,
      },
      tactical_resume_notes: [`Hydrated from ${selectedCheckpointLabel} at ${hydratedAt}.`],
    };
    if (checkpointResult.status === 'ok' && checkpointResult.continuation) {
      startupArgs.continuation = continuationInput(checkpointResult.continuation);
    }
    if (checkpointResult.status === 'ok' && checkpointResult.continuation_ref && portableContinuationBefore.status === 'ok') {
      startupArgs.continuation_ref = checkpointResult.continuation_ref;
    }
    startupCheckpoint = checkpoint(startupArgs);
  }
  const portableContinuation = continuationRead({ agent_id: identity, ...checkpointSelection });
  return {
    status: checkpointResult.status === 'checkpoint_not_found' ? 'checkpoint_not_found' : 'ok',
    site_id: siteId,
    site_root: siteRoot,
    hydrated_at: hydratedAt,
    whoami: resolved,
    checkpoint: checkpointResult,
    startup_checkpoint: startupCheckpoint,
    portable_continuation: portableContinuation,
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

function checkpointPayload(toolArgs, agentId, checkpointAt, checkpointId) {
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
    continuation: normalizeContinuation(toolArgs.continuation, checkpointId, checkpointAt),
    continuation_ref: normalizeContinuationRef(toolArgs.continuation_ref),
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
    continuation: payload.continuation ?? null,
    continuation_ref: payload.continuation_ref ?? null,
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

function optionalCheckpointId(value) {
  const checkpointId = value?.checkpoint_id;
  if (checkpointId == null) return null;
  if (typeof checkpointId !== 'string' || checkpointId.trim() === '') {
    throw new Error('checkpoint_id_invalid');
  }
  return checkpointId.trim();
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

