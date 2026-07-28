import { pathToFileURL } from 'node:url';
import {
  CATALOG_OBSERVATION_PORT_SCHEMA,
  type CatalogObservationAccessMode,
  type CatalogObservationPort,
  type CatalogObservationPortRequest,
  type CatalogObservationPortResponse,
} from './port.js';

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type CatalogObservationServerState = {
  observationPort?: CatalogObservationPort;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const TOOLS: ToolDefinition[] = [
  {
    name: 'catalog_observation_guidance',
    description: 'Explain the read-only catalog observation boundary and its credential-separation rules.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'catalog_observation_observe',
    description: 'Observe a provider model catalog through the Narada-owned observation port.',
    inputSchema: {
      type: 'object',
      properties: {
        provider_id: { type: 'string', description: 'Canonical inference-provider resource id.' },
        observed_at: { type: 'string', description: 'Explicit observation instant in ISO format.' },
        access_mode: {
          type: 'string',
          enum: ['public', 'credentialed', 'operator_attested'],
          default: 'public',
        },
      },
      required: ['provider_id', 'observed_at'],
      additionalProperties: false,
    },
  },
];

export function listTools(): ToolDefinition[] {
  return TOOLS.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
}

const GUIDANCE = {
  schema: 'narada.catalog-observation.guidance.v1',
  authority: 'Narada management owns catalog observation and credential resolution.',
  boundary: 'This MCP surface is read-only and forwards typed observation requests only.',
  credentials: 'Credential values never cross this MCP boundary and never appear in observations.',
  unavailable: 'Without an injected Narada observation port, the surface returns an unavailable observation.',
};

export function createServerState(options: CatalogObservationServerState = {}): CatalogObservationServerState {
  return { observationPort: options.observationPort };
}

function response(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function errorResponse(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

function textResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

function parseObserveRequest(params: Record<string, unknown> | undefined): CatalogObservationPortRequest | string {
  const providerId = params?.provider_id;
  const observedAt = params?.observed_at;
  const accessMode = params?.access_mode ?? 'public';
  if (typeof providerId !== 'string' || providerId.length === 0) return 'provider_id is required.';
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) return 'observed_at must be an explicit ISO instant.';
  if (accessMode !== 'public' && accessMode !== 'credentialed' && accessMode !== 'operator_attested') {
    return 'access_mode must be public, credentialed, or operator_attested.';
  }
  return {
    schema: CATALOG_OBSERVATION_PORT_SCHEMA,
    provider_id: providerId,
    observed_at: observedAt,
    access_mode: accessMode as CatalogObservationAccessMode,
  };
}

function unavailableObservation(request: CatalogObservationPortRequest): CatalogObservationPortResponse {
  return {
    schema: 'narada.invokable-intelligence.catalog-observation.v1',
    id: `catalog-observation:unavailable-${request.provider_id}`,
    observed_at: request.observed_at,
    inference_provider: { kind: 'inference-provider', id: request.provider_id },
    access_mode: 'unavailable',
    authority: { kind: 'unavailable', authority_ref: 'narada-observation-port:not-injected' },
    source: { kind: 'unavailable', reference: 'narada-observation-port:not-injected' },
    status: 'unavailable',
    models: [],
    diagnostics: [{
      code: 'provider-authority-unavailable',
      message: 'No Narada catalog observation port was injected into this surface process.',
      retryable: false,
    }],
    digest: `sha256:${'0'.repeat(64)}`,
  };
}

export async function observeCatalog(
  state: CatalogObservationServerState,
  request: CatalogObservationPortRequest,
): Promise<CatalogObservationPortResponse> {
  return state.observationPort
    ? state.observationPort.observe(request)
    : unavailableObservation(request);
}

export async function handleRequest(
  request: JsonRpcRequest,
  state: CatalogObservationServerState,
): Promise<JsonRpcResponse | null> {
  if (request.method === 'notifications/initialized' || request.method.startsWith('notifications/')) return null;
  if (request.method === 'initialize') {
    return response(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'catalog-observation-mcp', version: '0.1.0' },
    });
  }
  if (request.method === 'tools/list') return response(request.id, { tools: TOOLS });
  if (request.method !== 'tools/call') return errorResponse(request.id, -32601, `Method not found: ${request.method}`);

  const toolName = request.params?.name;
  const toolArguments = request.params?.arguments;
  if (typeof toolName !== 'string') return errorResponse(request.id, -32602, 'tools/call requires a tool name.');
  if (toolName === 'catalog_observation_guidance') return response(request.id, textResult(GUIDANCE));
  if (toolName !== 'catalog_observation_observe') return errorResponse(request.id, -32602, `Unknown tool: ${toolName}`);

  const parsed = parseObserveRequest(
    typeof toolArguments === 'object' && toolArguments !== null
      ? toolArguments as Record<string, unknown>
      : undefined,
  );
  if (typeof parsed === 'string') return response(request.id, textResult({ code: 'invalid_request', message: parsed }, true));
  const observation = await observeCatalog(state, parsed);
  return response(request.id, textResult(observation, observation.status === 'unavailable'));
}

type FramedInput = { body: string; consumed: number };

function readFrame(buffer: string): FramedInput | null {
  const separator = buffer.indexOf('\r\n\r\n');
  if (separator < 0) return null;
  const header = buffer.slice(0, separator);
  const lengthHeader = header.split('\r\n').find((line) => line.toLowerCase().startsWith('content-length:'));
  const length = Number(lengthHeader?.slice(lengthHeader.indexOf(':') + 1).trim());
  if (!Number.isInteger(length) || length < 0) throw new Error('Invalid Content-Length frame.');
  const bodyStart = separator + 4;
  if (Buffer.byteLength(buffer.slice(bodyStart), 'utf8') < length) return null;
  const bodyBuffer = Buffer.from(buffer.slice(bodyStart), 'utf8');
  return { body: bodyBuffer.subarray(0, length).toString('utf8'), consumed: bodyStart + bodyBuffer.subarray(0, length).toString('utf8').length };
}

export async function runStdioServer(state: CatalogObservationServerState): Promise<void> {
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += chunk.toString();
    let frame: FramedInput | null;
    while ((frame = readFrame(buffer))) {
      buffer = buffer.slice(frame.consumed);
      const request = JSON.parse(frame.body) as JsonRpcRequest;
      const result = await handleRequest(request, state);
      if (result === null) continue;
      const body = JSON.stringify(result);
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    }
  }
}

export async function main(): Promise<void> {
  await runStdioServer(createServerState());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
