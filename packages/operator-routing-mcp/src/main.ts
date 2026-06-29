#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SERVER_NAME = 'operator-routing-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_FALLBACK_CHANNEL = 'site-inbox';
const DEFAULT_TTS_MODEL = 'tts-1';
const DEFAULT_TTS_VOICE = 'nova';

type JsonRecord = Record<string, unknown>;
type RoutingState = { siteRoot: string; logRoot: string; serverName: string };

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
      const response = handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, framed);
    }
  }
}

export function createServerState(options: JsonRecord = {}): RoutingState {
  const normalized = asRecord(options);
  const siteRoot = resolve(String(normalized.siteRoot ?? normalized.site_root ?? process.cwd()));
  return { siteRoot, logRoot: resolve(String(normalized.logRoot ?? normalized.log_root ?? resolve(siteRoot, '.narada', 'runtime', 'operator-routing'))), serverName: String(normalized.serverName ?? SERVER_NAME) };
}

export function handleRequest(request: JsonRecord, state: RoutingState): any {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

export function listTools(): JsonRecord[] {
  return [
    tool('operator_route_doctor', 'Report operator routing posture, fallback policy, and the suggested spoken acknowledgement shape.', {}),
    tool('operator_route_request', 'Compile a transcript into a routing decision and a site-inbox-compatible fallback envelope.', {
      transcript: { type: 'string', description: 'Transcript text to route.' },
      target_runtime: { type: 'string', description: 'Target runtime or runtime family to receive the command.' },
      target_identity: { type: 'string', default: null, description: 'Optional target agent identity.' },
      intent_kind: { type: 'string', default: null, description: 'Optional intent classification.' },
      speaker_agent_id: { type: 'string', default: null, description: 'Optional speaker identity to preserve in the route record.' },
      allow_inbox_fallback: { type: 'boolean', default: true, description: 'Allow a site-inbox fallback envelope when direct delivery is unavailable.' },
      request_id: { type: 'string', default: null, description: 'Optional stable request identifier.' },
    }, ['transcript', 'target_runtime']),
  ];
}

function dispatchMethod(method: string, params: JsonRecord, state: RoutingState): any {
  switch (method) {
    case 'initialize': return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: state.serverName, version: SERVER_VERSION } };
    case 'tools/list': return { tools: listTools() };
    case 'tools/call': return callTool(params, state);
    default: throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

function callTool(params: JsonRecord, state: RoutingState): any {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  const result = name === 'operator_route_doctor' ? operatorRouteDoctor(state) : name === 'operator_route_request' ? operatorRouteRequest(args, state) : (() => { throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name }); })();
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

export function operatorRouteDoctor(state: RoutingState): JsonRecord {
  return { schema: 'narada.operator_routing.doctor.v1', status: 'ok', server_name: state.serverName, site_root: state.siteRoot, direct_delivery_supported: false, fallback_channel: DEFAULT_FALLBACK_CHANNEL, suggested_speech: { provider: 'openai_api', model: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE, text: 'Request recorded. Direct delivery to that runtime is not available from this surface. I can route it through the admitted inbox path.' } };
}

export function operatorRouteRequest(args: JsonRecord, state: RoutingState): JsonRecord {
  const transcript = requiredString(args.transcript, 'operator_route_requires_transcript');
  const targetRuntime = requiredString(args.target_runtime, 'operator_route_requires_target_runtime');
  const targetIdentity = optionalString(args.target_identity);
  const intentKind = optionalString(args.intent_kind);
  const speakerAgentId = optionalString(args.speaker_agent_id);
  const allowInboxFallback = booleanOption(args.allow_inbox_fallback, true);
  const requestId = optionalString(args.request_id) ?? `route_${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${randomUUID().slice(0, 8)}`;
  const recordedAt = new Date().toISOString();
  const spokenText = allowInboxFallback
    ? 'Request recorded. Direct delivery to that runtime is not available from this surface. I can route it through the admitted inbox path.'
    : 'Request recorded. Direct delivery to that runtime is not available from this surface, and no fallback path was enabled.';
  const routeRecord = { schema: 'narada.operator_routing.route_request.v1', status: allowInboxFallback ? 'drafted_for_site_inbox' : 'unroutable', request_id: requestId, recorded_at: recordedAt, direct_delivery_supported: false, direct_delivery_attempted: false, direct_delivery_reason: 'no_runtime_ingress_available', target_runtime: targetRuntime, target_identity: targetIdentity, intent_kind: intentKind, speaker_agent_id: speakerAgentId, transcript, routing: { target_runtime: targetRuntime, target_identity: targetIdentity, route_kind: allowInboxFallback ? 'inbox_fallback_draft' : 'unroutable', fallback_channel: allowInboxFallback ? DEFAULT_FALLBACK_CHANNEL : null, next_step: allowInboxFallback ? 'submit_to_site_inbox' : 'none' }, spoken_acknowledgement: { provider: 'openai_api', model: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE, text: spokenText }, inbox_envelope: allowInboxFallback ? buildInboxEnvelope({ requestId, recordedAt, transcript, targetRuntime, targetIdentity, intentKind, speakerAgentId, spokenText }) : null };
  appendRouteRecord(routeRecord, state);
  return { ...routeRecord, log_path: routeLogPath(state) };
}

function buildInboxEnvelope(input: { requestId: string; recordedAt: string; transcript: string; targetRuntime: string; targetIdentity: string | null; intentKind: string | null; speakerAgentId: string | null; spokenText: string }) {
  return { kind: 'command_request', title: input.targetIdentity ? `Route request for ${input.targetIdentity}` : `Route request for ${input.targetRuntime}`, summary: input.transcript.slice(0, 240), principal: input.speakerAgentId, target_role: null, severity: 35, authority_level: 'operator_confirmed', payload: { request_id: input.requestId, recorded_at: input.recordedAt, transcript: input.transcript, target_runtime: input.targetRuntime, target_identity: input.targetIdentity, intent_kind: input.intentKind, speaker_agent_id: input.speakerAgentId, spoken_acknowledgement: input.spokenText, suggested_delivery_channel: DEFAULT_FALLBACK_CHANNEL } };
}

function appendRouteRecord(routeRecord: JsonRecord, state: RoutingState) { const path = routeLogPath(state); mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(routeRecord)}\n`, 'utf8'); }
function routeLogPath(state: RoutingState) { return resolve(state.logRoot, 'operator-routing-log.jsonl'); }
function renderResult(record: JsonRecord): string { return [`operator_route: ${record.status ?? 'ok'}`, `request_id: ${record.request_id ?? ''}`, `target_runtime: ${record.target_runtime ?? ''}`, `target_identity: ${record.target_identity ?? ''}`, `direct_delivery_supported: ${record.direct_delivery_supported ?? false}`, `fallback_channel: ${asRecord(record.routing).fallback_channel ?? ''}`, `spoken_acknowledgement: ${asRecord(record.spoken_acknowledgement).text ?? ''}`, `log_path: ${record.log_path ?? ''}`].join('\n'); }

function parseArgs(argv: string[]) { const options: JsonRecord = {}; for (let index = 0; index < argv.length; index += 1) { const arg = argv[index]; if (arg === '--site-root') options.siteRoot = argv[++index]; else if (arg === '--log-root') options.logRoot = argv[++index]; else if (arg === '--server-name') options.serverName = argv[++index]; else throw new Error(`unknown_argument:${arg}`); } return options; }
function drainJsonLines(buffer: string) { const lines = buffer.split(/\r?\n/); const remaining = lines.pop() ?? ''; return { framed: false, remaining, requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))) }; }
function drainJsonRpcFrames(buffer: string) { const requests: JsonRecord[] = []; let remaining = buffer; while (true) { const headerEnd = remaining.indexOf('\r\n\r\n'); if (headerEnd < 0) break; const header = remaining.slice(0, headerEnd); const match = /Content-Length:\s*(\d+)/i.exec(header); if (!match) break; const length = Number(match[1]); const bodyStart = headerEnd + 4; const bodyEnd = bodyStart + length; if (remaining.length < bodyEnd) break; requests.push(asRecord(JSON.parse(remaining.slice(bodyStart, bodyEnd)))); remaining = remaining.slice(bodyEnd); } return { framed: true, remaining, requests }; }
function writeJsonRpcResponse(response: JsonRecord, framed: boolean) { const payload = JSON.stringify(response); if (framed) { process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`); return; } process.stdout.write(`${payload}\n`); }
function tool(name: string, description: string, inputSchema: JsonRecord, required: string[] = []): JsonRecord { return { name, description, inputSchema: { type: 'object', properties: inputSchema, required, additionalProperties: false }, annotations: { title: name, readOnlyHint: name === 'operator_route_doctor', destructiveHint: false, idempotentHint: name === 'operator_route_doctor', openWorldHint: false }, outputSchema: { type: 'object', additionalProperties: true } }; }
function asRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function optionalString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function requiredString(value: unknown, code: string): string { const text = optionalString(value); if (!text) throw diagnosticError(code, code); return text; }
function booleanOption(value: unknown, defaultValue: boolean): boolean { return typeof value === 'boolean' ? value : defaultValue; }
function diagnosticError(code: string, message = code, details: JsonRecord = {}) { const error = new Error(message) as Error & { code?: string; details?: JsonRecord }; error.code = code; error.details = details; return error; }
function errorDiagnostic(error: unknown) { if (error && typeof error === 'object' && 'message' in error) { const err = error as Error & { code?: string; details?: JsonRecord }; return { code: err.code ?? 'operator_routing_error', message: err.message ?? 'operator_routing_error', details: err.details ?? {} }; } return { code: 'operator_routing_error', message: String(error), details: {} }; }
