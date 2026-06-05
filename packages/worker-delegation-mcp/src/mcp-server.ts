import { createWorkerPolicy } from './policy.js';
import { WorkerMcpError, diagnosticError } from './errors.js';
import { callWorkerTool } from './worker-tools.js';
import { listTools } from './tool-list.js';
import { renderToolResultText } from './result-rendering.js';
import { materializeOutput } from './output-ref.js';
import type { WorkerMcpState } from './state.js';

const PROTOCOL_VERSION = '2024-11-05';

export async function runStdioServer(options: Record<string, unknown>) {
  const state = createServerState(options);
  let buffer = '';
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let requests = [];
    if (buffer.includes('Content-Length:')) {
      sawFramedInput = true;
      const drained = drainJsonRpcFrames(buffer);
      buffer = drained.remaining;
      requests = drained.requests;
    } else {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      requests = lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
    }
    for (const request of requests) {
      const response = await handleRequest(asRecord(request), state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

export function createServerState(options: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): WorkerMcpState {
  return { policy: createWorkerPolicy(options), env };
}

export async function handleRequest(request: Record<string, unknown>, state: WorkerMcpState) {
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

async function dispatchMethod(method: string, params: Record<string, unknown>, state: WorkerMcpState): Promise<unknown> {
  if (method === 'initialize') return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'worker-delegation-mcp', version: '0.1.0' } };
  if (method === 'tools/list') return { tools: listTools() };
  if (method === 'tools/call') return callTool(params, state);
  throw diagnosticError('worker_unknown_tool', `unsupported_mcp_method:${method}`, { method });
}

async function callTool(params: Record<string, unknown>, state: WorkerMcpState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  const result = await callWorkerTool(name, args, state);
  return toolResult(result, state, name);
}

function toolResult(value: unknown, state: WorkerMcpState, toolName: string) {
  const text = renderToolResultText(value);
  if (asRecord(value).schema === 'narada.worker.output_show.v1') return { content: [{ type: 'text', text }], structuredContent: value };
  const structuredText = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, 'utf8') <= state.policy.maxOutputBytes && Buffer.byteLength(structuredText, 'utf8') <= state.policy.maxOutputBytes) {
    return { content: [{ type: 'text', text }], structuredContent: value };
  }
  const locator = materializeOutput(state.policy, toolName, structuredText);
  return {
    content: [{ type: 'text', text: renderToolResultText(locator) }],
    structuredContent: {
      result_materialized: true,
      output_ref: locator.output_ref,
      reader_tool: 'worker_output_show',
      full_output_byte_length: locator.full_output_byte_length,
    },
  };
}

export function parseArgs(argv: string[]): Record<string, unknown> {
  const parsed: Record<string, unknown> & { allowedRoots?: string[]; allowedSandboxes?: string[]; allowedConfigKeys?: string[] } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (key === 'allowedRoot' || key === 'allowedRoots') {
      if (!next || next.startsWith('--')) throw diagnosticError('worker_invalid_cli_args', 'missing value for --allowed-root');
      parsed.allowedRoots = [...(parsed.allowedRoots ?? []), next]; i += 1;
      continue;
    }
    if (key === 'allowedSandbox' || key === 'allowedSandboxes') {
      if (!next || next.startsWith('--')) throw diagnosticError('worker_invalid_cli_args', 'missing value for --allowed-sandbox');
      parsed.allowedSandboxes = [...(parsed.allowedSandboxes ?? []), next]; i += 1;
      continue;
    }
    if (key === 'allowedConfigKey' || key === 'allowedConfigKeys') {
      if (!next || next.startsWith('--')) throw diagnosticError('worker_invalid_cli_args', 'missing value for --allowed-config-key');
      parsed.allowedConfigKeys = [...(parsed.allowedConfigKeys ?? []), next]; i += 1;
      continue;
    }
    if (next && !next.startsWith('--')) { parsed[key] = next; i += 1; } else { parsed[key] = true; }
  }
  return parsed;
}

function errorDiagnostic(error: unknown): Record<string, unknown> & { message: string } {
  if (error instanceof WorkerMcpError) return { schema: 'narada.worker.error.v1', code: error.codeName, message: error.message, details: error.details };
  const message = error instanceof Error ? error.message : String(error);
  return { schema: 'narada.worker.error.v1', code: 'worker_unhandled_error', message, details: { classification: 'unhandled_error' } };
}

function drainJsonRpcFrames(buffer: string) {
  const requests = [];
  let remaining = buffer;
  while (true) {
    const match = remaining.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
    if (!match) break;
    const headerLength = match[0].length;
    const length = Number(match[1]);
    if (remaining.length < headerLength + length) break;
    const body = remaining.slice(headerLength, headerLength + length);
    requests.push(JSON.parse(body));
    remaining = remaining.slice(headerLength + length);
  }
  return { requests, remaining };
}

function writeJsonRpcResponse(response: unknown, options: { framed: boolean }): void {
  const body = JSON.stringify(response);
  if (options.framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  else process.stdout.write(`${body}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
