#!/usr/bin/env node
import { buildGuidanceResult, guidanceToolDefinition } from './guidance.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVER_NAME = 'artifacts-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const ARTIFACT_KINDS = ['html', 'markdown', 'json', 'text', 'image', 'binary'];
const RENDER_HINTS = ['inline', 'link'];

type JsonRecord = Record<string, unknown>;
type ArtifactKind = 'html' | 'markdown' | 'json' | 'text' | 'image' | 'binary';
type ArtifactState = {
  narsBaseUrl: string | null;
  narsBaseUrlSource: string | null;
  sessionId: string | null;
  sessionIdSource: string | null;
  siteRoot: string | null;
  siteRootSource: string | null;
  serverName: string;
};
type ArtifactMessagePart = {
  type: 'artifact_ref';
  artifact_id: string;
  kind?: string;
  title?: string;
  render_hint?: string;
};

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export async function runStdioServer(options: unknown): Promise<void> {
  const state = createServerState(asRecord(options));
  let buffer = '';
  let framed = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const drained = buffer.includes('Content-Length:') ? drainJsonRpcFrames(buffer) : drainJsonLines(buffer);
    framed ||= drained.framed;
    buffer = drained.remaining;
    for (const request of drained.requests) {
      const response = await handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, framed);
    }
  }
}

export function createServerState(options: JsonRecord = {}): ArtifactState {
  const normalized = asRecord(options);
  const env = typeof process !== 'undefined' ? process.env : {};
  const narsBaseUrl = firstConfigured([
    ['option:narsBaseUrl', normalized.narsBaseUrl],
    ['option:nars_base_url', normalized.nars_base_url],
    ['env:NARADA_NARS_BASE_URL', env.NARADA_NARS_BASE_URL],
    ['env:NARADA_AGENT_RUNTIME_SERVER_URL', env.NARADA_AGENT_RUNTIME_SERVER_URL],
    ['env:NARADA_RUNTIME_SERVER_URL', env.NARADA_RUNTIME_SERVER_URL]
  ]);
  const sessionId = firstConfigured([
    ['option:sessionId', normalized.sessionId],
    ['option:session_id', normalized.session_id],
    ['env:NARADA_SESSION_ID', env.NARADA_SESSION_ID],
    ['env:NARADA_CARRIER_SESSION_ID', env.NARADA_CARRIER_SESSION_ID]
  ]);
  const siteRoot = firstConfigured([
    ['option:siteRoot', normalized.siteRoot],
    ['option:site_root', normalized.site_root],
    ['env:NARADA_SITE_ROOT', env.NARADA_SITE_ROOT]
  ]);
  return {
    narsBaseUrl: normalizeBaseUrl(narsBaseUrl.value),
    narsBaseUrlSource: narsBaseUrl.source,
    sessionId: sessionId.value,
    sessionIdSource: sessionId.source,
    siteRoot: siteRoot.value,
    siteRootSource: siteRoot.source,
    serverName: optionalString(normalized.serverName) ?? SERVER_NAME
  };
}

export async function handleRequest(request: JsonRecord, state: ArtifactState): Promise<any> {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

export function listTools(): JsonRecord[] {
  return [
    guidanceToolDefinition(),
    tool('artifacts_doctor', 'Report NARS artifact endpoint configuration and model-facing workflow readiness.', {}, [], true),
    tool('artifact_register_file', 'Register a local file with the current NARS session and return a renderable artifact_ref message part.', {
      path: { type: 'string', description: 'Local source path to register. NARS enforces admitted roots.' },
      kind: { type: 'string', enum: ARTIFACT_KINDS, description: 'Artifact kind. Use html for iframe preview in agent-web-ui.' },
      title: { type: 'string', description: 'Operator-facing artifact title.' },
      render_hint: { type: 'string', enum: RENDER_HINTS, default: 'inline', description: 'Projection hint for clients.' },
      content_type: { type: 'string', description: 'Optional content type. NARS validates it against kind.' },
      access_scope: { type: 'string', default: 'session', description: 'Optional access scope passed through to NARS.' }
    }, ['path', 'kind']),
    tool('artifact_list', 'List artifacts registered in the current NARS session.', {}, [], true),
    tool('artifact_read', 'Read one artifact metadata record from the current NARS session.', {
      artifact_id: { type: 'string', description: 'NARS artifact id.' }
    }, ['artifact_id'], true),
    tool('artifact_present', 'Ask NARS to emit a renderable assistant_message event containing this artifact_ref.', {
      artifact_id: { type: 'string', description: 'NARS artifact id.' },
      text: { type: 'string', description: 'Optional operator-facing text before the artifact preview.' },
      title: { type: 'string', description: 'Optional title override for the artifact_ref message part.' },
      render_hint: { type: 'string', enum: RENDER_HINTS, default: 'inline', description: 'Projection hint for clients.' }
    }, ['artifact_id']),
    tool('artifact_message_part_create', 'Create a renderable artifact_ref message part from known artifact metadata without registering a new artifact.', {
      artifact_id: { type: 'string', description: 'NARS artifact id.' },
      kind: { type: 'string', enum: ARTIFACT_KINDS, description: 'Artifact kind.' },
      title: { type: 'string', description: 'Operator-facing title.' },
      render_hint: { type: 'string', enum: RENDER_HINTS, default: 'inline', description: 'Projection hint for clients.' }
    }, ['artifact_id'], true),
  ];
}

async function dispatchMethod(method: string, params: JsonRecord, state: ArtifactState): Promise<any> {
  switch (method) {
    case 'initialize': return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: state.serverName, version: SERVER_VERSION } };
    case 'tools/list': return { tools: listTools() };
    case 'tools/call': return callTool(params, state);
    default: throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

async function callTool(params: JsonRecord, state: ArtifactState): Promise<any> {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  const result = name === 'artifacts_guidance'
    ? buildGuidanceResult(args)
    : name === 'artifacts_doctor'
      ? artifactsDoctor(state)
      : name === 'artifact_register_file'
        ? await artifactRegisterFile(args, state)
        : name === 'artifact_list'
          ? await artifactList(state)
          : name === 'artifact_read'
            ? await artifactRead(args, state)
            : name === 'artifact_present'
              ? await artifactPresent(args, state)
              : name === 'artifact_message_part_create'
                ? artifactMessagePartCreate(args)
                : (() => { throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name }); })();
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

export function artifactsDoctor(state: ArtifactState): JsonRecord {
  return {
    schema: 'narada.artifacts.doctor.v1',
    status: resolveNarsBaseUrl(state) && state.sessionId ? 'ok' : 'not_configured',
    server_name: state.serverName,
    nars_base_url: resolveNarsBaseUrl(state),
    configured_nars_base_url: state.narsBaseUrl,
    session_id: state.sessionId,
    site_root: state.siteRoot,
    registration_configured: Boolean(resolveNarsBaseUrl(state) && state.sessionId),
    required_configuration: {
      nars_base_url: 'Set --nars-base-url or NARADA_NARS_BASE_URL, or expose NARADA_SITE_ROOT so the surface can read the NARS session index.',
      session_id: 'Set --session-id or NARADA_SESSION_ID to the current NARS session id. NARADA_CARRIER_SESSION_ID is accepted only as a compatibility fallback.'
    },
    workflow: ['artifact_register_file', 'artifact_present when operator should see it inline', 'artifact_read or artifact_list to verify'],
    discovery: resolveNarsEndpoint(state)
  };
}

export async function artifactRegisterFile(args: JsonRecord, state: ArtifactState): Promise<JsonRecord> {
  const sourcePath = requiredString(args.path ?? args.source_path, 'artifact_register_requires_path');
  const kind = normalizeKind(requiredString(args.kind, 'artifact_register_requires_kind'));
  const renderHint = optionalString(args.render_hint) ?? 'inline';
  const body = {
    source_path: sourcePath,
    kind,
    ...(optionalString(args.title) ? { title: optionalString(args.title) } : {}),
    ...(optionalString(args.content_type) ? { content_type: optionalString(args.content_type) } : {}),
    render_hint: renderHint,
    ...(optionalString(args.access_scope) ? { access_scope: optionalString(args.access_scope) } : {})
  };
  const response = await narsJsonRequest(state, artifactCollectionPath(state), { method: 'POST', body });
  const artifact = asRecord(response.artifact);
  const messagePart = artifactMessagePartFromRecord({ artifact, fallbackKind: kind, fallbackTitle: optionalString(args.title), fallbackRenderHint: renderHint });
  return {
    schema: 'narada.artifacts.register_file.v1',
    status: 'registered',
    artifact,
    artifact_url: artifactUrl(state, messagePart.artifact_id),
    content_url: artifactContentUrl(state, messagePart.artifact_id),
    message_part: messagePart,
    assistant_content_parts: [messagePart],
    operator_message: operatorMessageForArtifact(messagePart),
    projection_instruction: 'Emit assistant_content_parts as structured assistant content when the operator should see the artifact in agent-web-ui. Do not paste the JSON object as plain text.'
  };
}

export async function artifactList(state: ArtifactState): Promise<JsonRecord> {
  const response = await narsJsonRequest(state, artifactCollectionPath(state), { method: 'GET' });
  return { schema: 'narada.artifacts.list.v1', status: 'ok', session_id: state.sessionId, index: response };
}

export async function artifactRead(args: JsonRecord, state: ArtifactState): Promise<JsonRecord> {
  const artifactId = requiredString(args.artifact_id ?? args.artifactId, 'artifact_read_requires_artifact_id');
  const response = await narsJsonRequest(state, `${artifactCollectionPath(state)}/${encodeURIComponent(artifactId)}`, { method: 'GET' });
  const artifact = asRecord(response.artifact ?? response);
  const messagePart = artifactMessagePartFromRecord({ artifact });
  return {
    schema: 'narada.artifacts.read.v1',
    status: 'ok',
    artifact,
    message_part: messagePart,
    assistant_content_parts: [messagePart],
    operator_message: operatorMessageForArtifact(messagePart)
  };
}

export async function artifactPresent(args: JsonRecord, state: ArtifactState): Promise<JsonRecord> {
  const artifactId = requiredString(args.artifact_id ?? args.artifactId, 'artifact_present_requires_artifact_id');
  const body = {
    ...(optionalString(args.text) ? { text: optionalString(args.text) } : {}),
    ...(optionalString(args.title) ? { title: optionalString(args.title) } : {}),
    ...(optionalString(args.render_hint) ? { render_hint: normalizeRenderHint(String(args.render_hint)) } : { render_hint: 'inline' })
  };
  const response = await narsJsonRequest(state, `${artifactCollectionPath(state)}/${encodeURIComponent(artifactId)}/message`, { method: 'POST', body });
  const messagePart = artifactMessagePartFromRecord({ artifact: asRecord(response.artifact), fallbackRenderHint: optionalString(args.render_hint) ?? 'inline' });
  return {
    schema: 'narada.artifacts.present.v1',
    status: 'presented',
    artifact: response.artifact,
    event: response.event,
    message_part: asRecord(response.message_part).artifact_id ? response.message_part : messagePart,
    operator_message: 'Artifact presented in the NARS session event stream.',
    projection_instruction: 'No assistant-side JSON emission is required; NARS has already emitted a structured assistant_message event.'
  };
}

export function artifactMessagePartCreate(args: JsonRecord): JsonRecord {
  const artifactId = requiredString(args.artifact_id ?? args.artifactId, 'artifact_part_requires_artifact_id');
  const messagePart: ArtifactMessagePart = {
    type: 'artifact_ref',
    artifact_id: artifactId,
    ...(optionalString(args.kind) ? { kind: normalizeKind(String(args.kind)) } : {}),
    ...(optionalString(args.title) ? { title: optionalString(args.title) as string } : {}),
    ...(optionalString(args.render_hint) ? { render_hint: normalizeRenderHint(String(args.render_hint)) } : { render_hint: 'inline' })
  };
  return {
    schema: 'narada.artifacts.message_part.v1',
    status: 'ok',
    verification_status: 'unverified',
    message_part: messagePart,
    assistant_content_parts: [messagePart],
    operator_message: operatorMessageForArtifact(messagePart),
    recommended_verification: 'Prefer artifact_read before emitting this part when a NARS endpoint is available.'
  };
}

async function narsJsonRequest(state: ArtifactState, path: string, options: { method: 'GET' | 'POST'; body?: JsonRecord }): Promise<JsonRecord> {
  const endpoint = resolveNarsEndpoint(state);
  const narsBaseUrl = endpoint.base_url;
  if (!narsBaseUrl) throw diagnosticError('nars_endpoint_missing', 'nars_endpoint_missing: configure --nars-base-url, NARADA_NARS_BASE_URL, or NARADA_SITE_ROOT with a readable NARS session index');
  if (!state.sessionId) throw diagnosticError('nars_session_missing', 'nars_session_missing: configure --session-id or NARADA_CARRIER_SESSION_ID');
  const url = `${narsBaseUrl}${path}`;
  const response = await fetch(url, {
    method: options.method,
    headers: options.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const parsed = text.trim() ? parseJson(text, 'nars_response_not_json', { url, status: response.status }) : {};
  if (!response.ok) {
    throw diagnosticError(String(parsed.error ?? 'nars_artifact_request_failed'), String(parsed.message ?? `NARS artifact request failed with HTTP ${response.status}`), { url, status: response.status, response: parsed });
  }
  return parsed;
}

function artifactMessagePartFromRecord(input: { artifact: JsonRecord; fallbackKind?: string; fallbackTitle?: string | null; fallbackRenderHint?: string | null }): ArtifactMessagePart {
  const artifactId = requiredString(input.artifact.artifact_id ?? input.artifact.artifactId ?? input.artifact.id, 'artifact_record_missing_artifact_id');
  return {
    type: 'artifact_ref',
    artifact_id: artifactId,
    ...(optionalString(input.artifact.kind) ?? input.fallbackKind ? { kind: String(optionalString(input.artifact.kind) ?? input.fallbackKind) } : {}),
    ...(optionalString(input.artifact.title) ?? input.fallbackTitle ? { title: String(optionalString(input.artifact.title) ?? input.fallbackTitle) } : {}),
    ...(optionalString(input.artifact.render_hint) ?? input.fallbackRenderHint ? { render_hint: normalizeRenderHint(String(optionalString(input.artifact.render_hint) ?? input.fallbackRenderHint)) } : { render_hint: 'inline' })
  };
}

function artifactCollectionPath(state: ArtifactState): string {
  if (!state.sessionId) throw diagnosticError('nars_session_missing', 'nars_session_missing: configure --session-id or NARADA_CARRIER_SESSION_ID');
  return `/sessions/${encodeURIComponent(state.sessionId)}/artifacts`;
}

function artifactUrl(state: ArtifactState, artifactId: string): string | null {
  const narsBaseUrl = resolveNarsBaseUrl(state);
  if (!narsBaseUrl || !state.sessionId) return null;
  return `${narsBaseUrl}${artifactCollectionPath(state)}/${encodeURIComponent(artifactId)}`;
}

function artifactContentUrl(state: ArtifactState, artifactId: string): string | null {
  const base = artifactUrl(state, artifactId);
  return base ? `${base}/content` : null;
}

function parseArgs(argv: string[]) {
  const options: JsonRecord = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--nars-base-url') options.narsBaseUrl = argv[++index];
    else if (arg === '--session-id') options.sessionId = argv[++index];
    else if (arg === '--site-root') options.siteRoot = argv[++index];
    else if (arg === '--server-name') options.serverName = argv[++index];
    else throw new Error(`unknown_argument:${arg}`);
  }
  return options;
}

function normalizeBaseUrl(value: string | null): string | null { return value ? value.replace(/\/+$/, '') : null; }
function resolveNarsBaseUrl(state: ArtifactState): string | null { return optionalString(resolveNarsEndpoint(state).base_url); }
function resolveNarsEndpoint(state: ArtifactState): JsonRecord {
  if (state.narsBaseUrl) return { status: 'configured', base_url: state.narsBaseUrl, source: state.narsBaseUrlSource ?? 'unknown' };
  const discovered = discoverNarsBaseUrlFromSessionIndex(state);
  if (discovered) return { status: 'discovered', base_url: discovered, source: 'session_index', session_index_path: sessionIndexPath(state) };
  return {
    status: 'missing',
    base_url: null,
    source: null,
    session_id_source: state.sessionIdSource,
    site_root_source: state.siteRootSource,
    attempted_session_index_path: sessionIndexPath(state),
    missing: [
      ...(state.sessionId ? [] : ['session_id']),
      ...(state.siteRoot ? [] : ['site_root_or_explicit_base_url']),
      ...(state.siteRoot && state.sessionId ? ['readable_session_index_with_health_endpoint'] : [])
    ]
  };
}
function discoverNarsBaseUrlFromSessionIndex(state: ArtifactState): string | null {
  if (!state.siteRoot || !state.sessionId) return null;
  const recordPath = sessionIndexPath(state);
  if (!existsSync(recordPath)) return null;
  try {
    const record = asRecord(JSON.parse(readFileSync(recordPath, 'utf8')));
    const healthEndpoint = optionalString(record.health_endpoint);
    if (!healthEndpoint) return null;
    const parsed = new URL(healthEndpoint);
    return normalizeBaseUrl(parsed.origin);
  } catch {
    return null;
  }
}
function sessionIndexPath(state: ArtifactState): string | null { return state.siteRoot && state.sessionId ? resolve(state.siteRoot, '.narada', 'crew', 'nars-sessions', state.sessionId, 'session-index-record.json') : null; }
function optionalString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function firstConfigured(entries: Array<[string, unknown]>): { value: string | null; source: string | null } { for (const [source, value] of entries) { const text = optionalString(value); if (text) return { value: text, source }; } return { value: null, source: null }; }
function requiredString(value: unknown, code: string): string { const text = optionalString(value); if (!text) throw diagnosticError(code, code); return text; }
function asRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function normalizeKind(value: string): ArtifactKind { const kind = value.trim().toLowerCase(); if (!ARTIFACT_KINDS.includes(kind)) throw diagnosticError('unsupported_artifact_kind', `unsupported_artifact_kind:${value}`); return kind as ArtifactKind; }
function normalizeRenderHint(value: string): string { const hint = value.trim().toLowerCase(); if (!RENDER_HINTS.includes(hint)) throw diagnosticError('unsupported_render_hint', `unsupported_render_hint:${value}`); return hint; }
function parseJson(text: string, code: string, details: JsonRecord = {}): JsonRecord { try { return asRecord(JSON.parse(text)); } catch { throw diagnosticError(code, code, details); } }
function drainJsonLines(buffer: string) { const lines = buffer.split(/\r?\n/); const remaining = lines.pop() ?? ''; return { framed: false, remaining, requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))) }; }
function drainJsonRpcFrames(buffer: string) { const requests: JsonRecord[] = []; let remaining = buffer; while (true) { const headerEnd = remaining.indexOf('\r\n\r\n'); if (headerEnd < 0) break; const header = remaining.slice(0, headerEnd); const match = /Content-Length:\s*(\d+)/i.exec(header); if (!match) break; const length = Number(match[1]); const bodyStart = headerEnd + 4; const bodyEnd = bodyStart + length; if (remaining.length < bodyEnd) break; requests.push(asRecord(JSON.parse(remaining.slice(bodyStart, bodyEnd)))); remaining = remaining.slice(bodyEnd); } return { framed: true, remaining, requests }; }
function writeJsonRpcResponse(response: JsonRecord, framed: boolean) { const payload = JSON.stringify(response); if (framed) { process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`); return; } process.stdout.write(`${payload}\n`); }
function tool(name: string, description: string, inputSchema: JsonRecord, required: string[] = [], readOnly = false): JsonRecord { return { name, description, inputSchema: { type: 'object', properties: inputSchema, required, additionalProperties: false }, annotations: { title: name, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false }, outputSchema: { type: 'object', additionalProperties: true } }; }
function diagnosticError(code: string, message = code, details: JsonRecord = {}) { const error = new Error(message) as Error & { code?: string; details?: JsonRecord }; error.code = code; error.details = details; return error; }
function errorDiagnostic(error: unknown) { if (error && typeof error === 'object' && 'message' in error) { const err = error as Error & { code?: string; details?: JsonRecord }; return { code: err.code ?? 'artifacts_error', message: err.message ?? 'artifacts_error', details: err.details ?? {} }; } return { code: 'artifacts_error', message: String(error), details: {} }; }
function operatorMessageForArtifact(messagePart: ArtifactMessagePart): string { return `Artifact ready: ${messagePart.title ?? messagePart.artifact_id}`; }
function renderResult(record: JsonRecord): string { return [`artifacts: ${record.status ?? 'ok'}`, `schema: ${record.schema ?? ''}`, `session_id: ${record.session_id ?? ''}`, `artifact_id: ${asRecord(record.artifact).artifact_id ?? asRecord(record.message_part).artifact_id ?? ''}`, `kind: ${asRecord(record.artifact).kind ?? asRecord(record.message_part).kind ?? ''}`, `message_part: ${record.message_part ? JSON.stringify(record.message_part) : ''}`].filter(Boolean).join('\n'); }
