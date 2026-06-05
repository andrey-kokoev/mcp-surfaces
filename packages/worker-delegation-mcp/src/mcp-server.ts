import { createWorkerPolicy } from './policy.js';
import { WorkerMcpError, diagnosticError } from './errors.js';
import { callWorkerTool, type WorkerRequestContext } from './worker-tools.js';
import { listTools } from './tool-list.js';
import { renderToolResultText } from './result-rendering.js';
import { materializeOutput } from './output-ref.js';
import type { WorkerMcpState } from './state.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2024-11-05';
const ROOTS_LIST_REQUEST_PREFIX = 'worker_roots_';

export async function runStdioServer(options: Record<string, unknown>) {
  const state = createServerState(options);
  const activeRequests = new Map<string, AbortController>();
  const pendingServerRequests = new Map<string, (message: Record<string, unknown>) => void>();
  let nextServerRequestId = 1;
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
      const record = asRecord(request);
      if (record.method === undefined && record.id !== undefined) {
        const handler = pendingServerRequests.get(String(record.id));
        if (handler) {
          pendingServerRequests.delete(String(record.id));
          handler(record);
        }
        continue;
      }
      if (!record.id && record.method === 'notifications/roots/list_changed' && state.clientRoots?.supported) {
        requestClientRoots(state, pendingServerRequests, () => `${ROOTS_LIST_REQUEST_PREFIX}${nextServerRequestId++}`, { framed: sawFramedInput });
        continue;
      }
      if (record.method === 'initialize') {
        const response = await handleRequest(record, state);
        if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
        if (clientSupportsRoots(asRecord(record.params))) {
          state.clientRoots = { supported: true, roots: [], lastUpdatedAt: null };
          requestClientRoots(state, pendingServerRequests, () => `${ROOTS_LIST_REQUEST_PREFIX}${nextServerRequestId++}`, { framed: sawFramedInput });
        }
        continue;
      }
      processStdioRequest(record, state, activeRequests, { framed: sawFramedInput });
    }
  }
}

export function createServerState(options: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): WorkerMcpState {
  return { policy: createWorkerPolicy(options), env, clientRoots: { supported: false, roots: [], lastUpdatedAt: null } };
}

async function processStdioRequest(request: Record<string, unknown>, state: WorkerMcpState, activeRequests: Map<string, AbortController>, options: { framed: boolean }) {
  if (!request?.id && request.method === 'notifications/cancelled') {
    const requestId = String(asRecord(request.params).requestId ?? '');
    activeRequests.get(requestId)?.abort();
    return;
  }
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return;
  const requestId = String(request.id ?? '');
  const abortController = new AbortController();
  activeRequests.set(requestId, abortController);
  const progressToken = asRecord(asRecord(request.params)._meta).progressToken;
  const progress = (progressValue: number, message: string) => {
    if (progressToken === undefined) return;
    writeJsonRpcResponse({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken, progress: progressValue, total: 1, message },
    }, options);
  };
  progress(0, 'started');
  handleRequest(request, state, { abortSignal: abortController.signal }).then((response) => {
    progress(1, abortController.signal.aborted ? 'cancelled' : 'completed');
    if (response) writeJsonRpcResponse(response, options);
  }).finally(() => {
    activeRequests.delete(requestId);
  });
}

export async function handleRequest(request: Record<string, unknown>, state: WorkerMcpState, context: WorkerRequestContext = {}) {
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state, context);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

async function dispatchMethod(method: string, params: Record<string, unknown>, state: WorkerMcpState, context: WorkerRequestContext = {}): Promise<unknown> {
  if (method === 'initialize') return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {}, resources: {}, prompts: {}, completions: {}, logging: {} }, serverInfo: { name: 'worker-delegation-mcp', version: '0.1.0' } };
  if (method === 'tools/list') return { tools: listTools() };
  if (method === 'tools/call') return callTool(params, state, context);
  if (method === 'resources/list') return listWorkerResources(state);
  if (method === 'resources/read') return readWorkerResource(params, state);
  if (method === 'prompts/list') return { prompts: listPrompts() };
  if (method === 'prompts/get') return promptGet(params);
  if (method === 'completion/complete') return completeArgument(params, state);
  if (method === 'logging/setLevel') return {};
  throw diagnosticError('worker_unknown_tool', `unsupported_mcp_method:${method}`, { method });
}

function listPrompts() {
  return [{ name: 'worker_delegation_task', title: 'Worker Delegation Task', description: 'Guidance for delegating bounded work to a worker runtime.', arguments: [] }];
}

function promptGet(params: Record<string, unknown>) {
  const name = String(params.name ?? '');
  if (name !== 'worker_delegation_task') throw diagnosticError('worker_unknown_tool', `unknown_prompt:${name}`, { name });
  return {
    description: 'Guidance for delegating bounded work to a worker runtime.',
    messages: [{ role: 'user', content: { type: 'text', text: 'Delegate bounded work with intent.instruction and explicit constraints. Do not ask workers to call worker_* tools.' } }],
  };
}

function completeArgument(params: Record<string, unknown>, state: WorkerMcpState) {
  const argumentName = String(asRecord(asRecord(params).argument).name ?? '');
  const values = argumentName === 'name'
    ? listTools().map((tool) => tool.name).filter(Boolean).slice(0, 100)
    : ['cwd', 'directory', 'working_directory'].includes(argumentName) ? clientRootCompletionValues(state) : [];
  return { completion: { values, total: values.length, hasMore: false } };
}

async function callTool(params: Record<string, unknown>, state: WorkerMcpState, context: WorkerRequestContext = {}) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  const result = await callWorkerTool(name, args, state, context);
  return toolResult(result, state, name);
}

function toolResult(value: unknown, state: WorkerMcpState, toolName: string) {
  const text = renderToolResultText(value);
  if (asRecord(value).schema === 'narada.worker.output_show.v1') return { content: [assistantTextContent(text)], structuredContent: value };
  const structuredText = JSON.stringify(value, null, 2);
  const artifactLinks = workerArtifactResourceLinks(value, state);
  if (Buffer.byteLength(text, 'utf8') <= state.policy.maxOutputBytes && Buffer.byteLength(structuredText, 'utf8') <= state.policy.maxOutputBytes) {
    return { content: [assistantTextContent(text), ...artifactLinks], structuredContent: value };
  }
  const locator = materializeOutput(state.policy, toolName, structuredText);
  return {
    content: [assistantTextContent(renderToolResultText(locator)), workerOutputResourceLink(String(locator.output_ref ?? '')), ...artifactLinks],
    structuredContent: {
      result_materialized: true,
      output_ref: locator.output_ref,
      reader_tool: 'worker_output_show',
      full_output_byte_length: locator.full_output_byte_length,
    },
  };
}

function assistantTextContent(text: string) {
  return { type: 'text', text, annotations: { audience: ['assistant'] } };
}

function workerOutputResourceLink(outputRef: string) {
  return {
    type: 'resource_link',
    uri: workerOutputResourceUri(outputRef),
    name: outputRef,
    description: 'Materialized worker output.',
    mimeType: 'text/plain',
    annotations: { audience: ['assistant'], priority: 0.8 },
  };
}

function workerArtifactResourceLinks(value: unknown, state: WorkerMcpState) {
  const record = asRecord(value);
  const runId = String(record.run_id ?? '');
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  if (record.schema !== 'narada.worker.run.v1' || !runId) return [];
  return artifacts.map((artifact) => asRecord(artifact)).filter((artifact) => typeof artifact.name === 'string' && typeof artifact.path === 'string').map((artifact) => {
    const name = String(artifact.name);
    return {
      type: 'resource_link',
      uri: workerArtifactResourceUri(runId, name),
      name: `${runId}/${name}`,
      description: 'Worker run artifact.',
      mimeType: workerArtifactMimeType(name),
      annotations: { audience: ['assistant'], priority: 0.7 },
    };
  });
}

function listWorkerResources(state: WorkerMcpState) {
  const dir = resolve(state.policy.runRoot, 'outputs');
  const outputResources = !existsSync(dir) ? [] : readdirSync(dir).filter((name) => name.endsWith('.txt')).sort().map((name) => {
    const outputRef = name.replace(/^worker_output_/, 'worker_output:').replace(/\.txt$/, '');
    return { uri: workerOutputResourceUri(outputRef), name: outputRef, title: outputRef, description: 'Materialized worker output.', mimeType: 'text/plain' };
  });
  const artifactResources = listWorkerArtifactResources(state);
  return { resources: [...outputResources, ...artifactResources] };
}

function listWorkerArtifactResources(state: WorkerMcpState) {
  const runRoot = resolve(state.policy.runRoot);
  if (!existsSync(runRoot)) return [];
  return readdirSync(runRoot).filter((entry) => {
    const runDir = resolve(runRoot, entry);
    return entry.startsWith('run-') && existsSync(runDir) && statSync(runDir).isDirectory();
  }).sort().flatMap((runId) => {
    const runDir = resolve(runRoot, runId);
    return readdirSync(runDir).filter((name) => statSync(resolve(runDir, name)).isFile()).sort().map((name) => ({
      uri: workerArtifactResourceUri(runId, name),
      name: `${runId}/${name}`,
      title: `${runId}/${name}`,
      description: 'Worker run artifact.',
      mimeType: workerArtifactMimeType(name),
    }));
  });
}

function readWorkerResource(params: Record<string, unknown>, state: WorkerMcpState) {
  const uri = String(params.uri ?? '');
  if (uri.startsWith('worker-artifact:')) return readWorkerArtifactResource(uri, state);
  const outputRef = workerOutputRefFromUri(uri);
  const path = resolve(state.policy.runRoot, 'outputs', `${outputRef.replace(':', '_')}.txt`);
  return { contents: [{ uri: params.uri, mimeType: 'text/plain', text: readFileSync(path, 'utf8') }] };
}

function readWorkerArtifactResource(uri: string, state: WorkerMcpState) {
  const parsed = workerArtifactFromResourceUri(uri);
  const runRoot = resolve(state.policy.runRoot);
  const artifactPath = resolve(runRoot, parsed.runId, parsed.name);
  if (!isPathInside(artifactPath, runRoot) || !existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    throw diagnosticError('worker_output_materialization_failed', 'worker_artifact_resource_not_found', { uri });
  }
  return { contents: [{ uri, mimeType: workerArtifactMimeType(parsed.name), text: readFileSync(artifactPath, 'utf8') }] };
}

function workerArtifactResourceUri(runId: string, name: string) {
  return `worker-artifact:${encodeURIComponent(runId)}/${encodeURIComponent(name)}`;
}

function workerArtifactFromResourceUri(uri: string) {
  if (!uri.startsWith('worker-artifact:')) throw diagnosticError('worker_output_materialization_failed', 'worker_resource_uri_invalid', { uri });
  const rest = uri.slice('worker-artifact:'.length);
  const [encodedRunId, encodedName] = rest.split('/');
  const runId = decodeURIComponent(encodedRunId ?? '');
  const name = decodeURIComponent(encodedName ?? '');
  if (!runId || !name || name.includes('/') || name.includes('\\')) throw diagnosticError('worker_output_materialization_failed', 'worker_artifact_resource_uri_invalid', { uri });
  return { runId, name };
}

function workerArtifactMimeType(name: string) {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.jsonl')) return 'application/x-ndjson';
  if (name.endsWith('.log') || name.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

function isPathInside(candidate: string, root: string): boolean {
  const relativePath = resolve(candidate).slice(resolve(root).length);
  return resolve(candidate) === resolve(root) || (!relativePath.startsWith('..') && !relativePath.includes('..\\'));
}

function legacyListWorkerResources(state: WorkerMcpState) {
  const dir = resolve(state.policy.runRoot, 'outputs');
  if (!existsSync(dir)) return { resources: [] };
  return {
    resources: readdirSync(dir).filter((name) => name.endsWith('.txt')).sort().map((name) => {
      const outputRef = name.replace(/^worker_output_/, 'worker_output:').replace(/\.txt$/, '');
      return { uri: workerOutputResourceUri(outputRef), name: outputRef, title: outputRef, description: 'Materialized worker output.', mimeType: 'text/plain' };
    }),
  };
}

function workerOutputResourceUri(outputRef: string) {
  return `worker-output:${encodeURIComponent(outputRef)}`;
}

function workerOutputRefFromUri(uri: string) {
  if (!uri.startsWith('worker-output:')) throw diagnosticError('worker_output_materialization_failed', 'worker_resource_uri_invalid', { uri });
  return decodeURIComponent(uri.slice('worker-output:'.length));
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

function clientSupportsRoots(initializeParams: Record<string, unknown>): boolean {
  return Boolean(asRecord(asRecord(initializeParams).capabilities).roots);
}

function requestClientRoots(state: WorkerMcpState, pendingServerRequests: Map<string, (message: Record<string, unknown>) => void>, nextId: () => string, options: { framed: boolean }): void {
  const id = nextId();
  pendingServerRequests.set(id, (message) => {
    updateClientRoots(state, asRecord(message.result));
  });
  writeJsonRpcResponse({ jsonrpc: '2.0', id, method: 'roots/list', params: {} }, options);
}

function updateClientRoots(state: WorkerMcpState, result: Record<string, unknown>): void {
  const roots = Array.isArray(result.roots) ? result.roots.map((root) => asRecord(root)).filter((root) => typeof root.uri === 'string') : [];
  state.clientRoots = {
    supported: true,
    roots: roots.map((root) => ({
      uri: String(root.uri),
      ...(typeof root.name === 'string' ? { name: root.name } : {}),
    })),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function clientRootCompletionValues(state: WorkerMcpState): string[] {
  const roots = Array.isArray(state.clientRoots?.roots) ? state.clientRoots.roots : [];
  return roots.map((root) => {
    const uri = root.uri;
    if (uri.startsWith('file:')) {
      try {
        return fileURLToPath(uri);
      } catch {
        return uri;
      }
    }
    return uri;
  }).filter(Boolean).slice(0, 100);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
