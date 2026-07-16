#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolveToolPayloadArgs } from '@narada2/mcp-transport';
import { buildGuidanceResult, guidanceToolDefinition } from './guidance.js';
import { createSessionClient, NarsSessionMcpError, type JsonRecord } from './session-client.js';

const SERVER_NAME = 'nars-session-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const MUTATING_TOOL = 'nars_session_input_deliver';
const PAYLOAD_TOOLS = [MUTATING_TOOL, 'nars_session_input_status'];
const client = createSessionClient(process.env, process.argv.slice(2));

export async function handleRequest(request: JsonRecord, requestClient = client): Promise<JsonRecord | null> {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), requestClient);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: { code: -32000, message: diagnostic.message, data: diagnostic },
    };
  }
}

export async function runStdioServer(): Promise<void> {
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
      const response = await handleRequest(request);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

export function listTools() {
  return [
    guidanceToolDefinition(),
    {
      name: 'nars_session_list',
      description: 'List bounded NARS sessions in the bound Site scope.',
      inputSchema: {
        type: 'object',
        properties: {
          site_id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          include_health: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations('nars_session_list'),
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'nars_session_show',
      description: 'Show one NARS session with bounded liveness and authority readback.',
      inputSchema: {
        type: 'object',
        required: ['session_id'],
        properties: {
          site_id: { type: 'string' },
          session_id: { type: 'string' },
          include_health: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations('nars_session_show'),
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: MUTATING_TOOL,
      description: 'Deliver one explicit send, enqueue, or steer request to a concrete existing NARS session.',
      inputSchema: {
        type: 'object',
        required: ['session_id', 'delivery', 'idempotency_key'],
        properties: {
          site_id: { type: 'string' },
          session_id: { type: 'string' },
          content: { type: 'string', maxLength: 20_000 },
          directive: { type: 'object', additionalProperties: true },
          delivery: { type: 'string', enum: ['send', 'enqueue', 'steer'] },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
          expected_authority_epoch: { type: 'integer', minimum: 1 },
          payload_ref: { type: 'string' },
        },
        additionalProperties: false,
      },
      annotations: {
        title: MUTATING_TOOL,
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'nars_session_input_status',
      description: 'Read authoritative NARS session evidence for a submitted input without claiming provider completion.',
      inputSchema: {
        type: 'object',
        required: ['session_id'],
        properties: {
          site_id: { type: 'string' },
          session_id: { type: 'string' },
          input_event_id: { type: 'string' },
          request_id: { type: 'string' },
          directive_id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          payload_ref: { type: 'string' },
        },
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations('nars_session_input_status'),
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

async function dispatchMethod(method: string, params: JsonRecord, requestClient: typeof client) {
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
      return callTool(params, requestClient);
    default:
      throw new NarsSessionMcpError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

async function callTool(params: JsonRecord, requestClient: typeof client) {
  const name = String(params.name ?? '');
  const rawArgs = asRecord(params.arguments);
  const args = resolvePayloadArgs(name, rawArgs, requestClient);
  let result: JsonRecord;
  switch (name) {
    case 'nars_session_guidance':
      result = buildGuidanceResult();
      break;
    case 'nars_session_list':
      result = await requestClient.list(args);
      break;
    case 'nars_session_show':
      result = await requestClient.show(args);
      break;
    case MUTATING_TOOL:
      result = await requestClient.deliver(args);
      break;
    case 'nars_session_input_status':
      result = await requestClient.status(args);
      break;
    default:
      throw new NarsSessionMcpError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

function resolvePayloadArgs(name: string, args: JsonRecord, requestClient: typeof client): JsonRecord {
  if (!args.payload_ref) return args;
  const siteRoot = requestClient.siteRoot();
  return resolveToolPayloadArgs({
    siteRoot,
    toolName: name,
    args,
    allowedTools: PAYLOAD_TOOLS,
    maxBytes: 256 * 1024,
    payloadDir: '.ai/tmp/mcp-payloads',
    payloadRefMode: 'merge_args_prefer_payload_placeholders',
  }).args as JsonRecord;
}

function readOnlyAnnotations(title: string) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function renderResult(result: JsonRecord): string {
  const schema = String(result.schema ?? 'narada.nars_session_mcp.result.v1');
  if (schema.endsWith('.sessions.v1')) return `nars_session_list: ${result.count ?? 0} session(s)`;
  if (schema.endsWith('.session.v1')) return `nars_session_show: ${asRecord(result.session).session_id ?? ''}`;
  if (schema.endsWith('.input_delivery.v1')) return `nars_session_input_deliver: ${result.status ?? 'unknown'} ${result.admission ?? ''}`.trim();
  if (schema.endsWith('.input_status.v1')) return `nars_session_input_status: ${result.status ?? 'unknown'}`;
  if (schema.endsWith('.guidance.v1')) return 'nars_session_guidance: governed session input and authoritative readback';
  return JSON.stringify(result);
}

function errorDiagnostic(error: unknown) {
  if (error instanceof NarsSessionMcpError) return { schema: 'narada.nars_session_mcp.error.v1', code: error.code, message: error.message, details: error.details };
  return { schema: 'narada.nars_session_mcp.error.v1', code: 'nars_session_mcp_error', message: error instanceof Error ? error.message : String(error), details: {} };
}

function drainJsonLines(buffer: string) {
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  return { framed: false, remaining, requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))) };
}

function drainJsonRpcFrames(buffer: string) {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const crlfHeaderEnd = remaining.indexOf('\r\n\r\n');
    const lfHeaderEnd = remaining.indexOf('\n\n');
    const headerEnd = crlfHeaderEnd >= 0 ? crlfHeaderEnd : lfHeaderEnd;
    if (headerEnd < 0) break;
    const separatorLength = crlfHeaderEnd >= 0 ? 4 : 2;
    const header = remaining.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + separatorLength;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    requests.push(asRecord(JSON.parse(remaining.slice(bodyStart, bodyEnd))));
    remaining = remaining.slice(bodyEnd);
  }
  return { framed: true, remaining, requests };
}

function writeJsonRpcResponse(response: JsonRecord, { framed }: { framed: boolean }) {
  const body = JSON.stringify(response);
  if (framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  else process.stdout.write(`${body}\n`);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

if (isMainModule()) {
  runStdioServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}
