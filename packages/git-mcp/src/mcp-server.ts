import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOutputRefToolContent,
  listOutputResources,
  outputShow,
  readOutputResource,
} from '@narada2/mcp-transport';
import { diagnosticError, GitMcpError } from './git-errors.js';
import { createGitPolicy, GitPolicyError } from './policy.js';
import { callGitTool, type GitRequestContext } from './git-tools.js';
import { listTools } from './git-tool-list.js';
import { renderToolResultText } from './result-rendering.js';
import type { GitMcpState } from './state.js';

const PROTOCOL_VERSION = '2024-11-05';
const INLINE_RESULT_BYTE_LIMIT = 6000;
const PREVIEW_CHAR_LIMIT = 1000;
const ROOTS_LIST_REQUEST_PREFIX = 'git_roots_';

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

export function createServerState(options: Record<string, unknown> = {}): GitMcpState {
  const policy = createGitPolicy(options);
  return {
    policy,
    outputRoot: resolve(String(options.outputRoot ?? policy.allowedRoots[0])),
    auditLogDir: options.auditLogDir ? resolve(String(options.auditLogDir)) : null,
    clientRoots: { supported: false, roots: [], lastUpdatedAt: null },
  };
}

async function processStdioRequest(request: Record<string, unknown>, state: GitMcpState, activeRequests: Map<string, AbortController>, options: { framed: boolean }) {
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

export async function handleRequest(request: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}) {
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state, context);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return {
      jsonrpc: '2.0',
      id: request?.id ?? null,
      error: {
        code: -32000,
        message: diagnostic.message,
        data: diagnostic,
      },
    };
  }
}

async function dispatchMethod(method: string, params: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}): Promise<unknown> {
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {}, completions: {}, logging: {} },
      serverInfo: { name: 'git-mcp', version: '0.1.0' },
    };
  }
  if (method === 'tools/list') return { tools: listTools(state.policy.mode) };
  if (method === 'tools/call') return callTool(params, state, context);
  if (method === 'resources/list') return listOutputResources({ siteRoot: state.outputRoot });
  if (method === 'resources/read') return readOutputResource({ siteRoot: state.outputRoot, uri: params.uri });
  if (method === 'prompts/list') return { prompts: listPrompts() };
  if (method === 'prompts/get') return promptGet(params);
  if (method === 'completion/complete') return completeArgument(params, state);
  if (method === 'logging/setLevel') return {};
  throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`, { method });
}

function listPrompts() {
  return [{ name: 'git_mcp_workflow', title: 'Git MCP Workflow', description: 'Guidance for inspect-stage-commit-push workflows.', arguments: [] }];
}

function promptGet(params: Record<string, unknown>) {
  const name = String(params.name ?? '');
  if (name !== 'git_mcp_workflow') throw diagnosticError('unknown_prompt', `unknown_prompt:${name}`, { name });
  return {
    description: 'Guidance for inspect-stage-commit-push workflows.',
    messages: [{ role: 'user', content: { type: 'text', text: 'Use git_status and git_diff before git_add, git_commit, or git_push. Keep commits scoped and do not force push.' } }],
  };
}

function completeArgument(params: Record<string, unknown>, state: GitMcpState) {
  const argumentName = String(asRecord(asRecord(params).argument).name ?? '');
  const values = argumentName === 'name'
    ? listTools(state.policy.mode).map((tool) => tool.name).filter(Boolean).slice(0, 100)
    : ['path', 'working_directory', 'directory'].includes(argumentName) ? clientRootCompletionValues(state) : [];
  return { completion: { values, total: values.length, hasMore: false } };
}

async function callTool(params: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  if (name === 'mcp_output_show') return toolResult(outputShow({ siteRoot: state.outputRoot, args }), state, name);
  const result = await callGitTool(name, args, state, context);
  return toolResult(result, state, name);
}

function toolResult(value: unknown, state: GitMcpState, toolName: string) {
  const text = renderToolResultText(value);
  if (asRecord(value).schema === 'narada.mcp_output_show.v1') {
    return { content: [assistantTextContent(text)], structuredContent: value };
  }
  const structuredText = JSON.stringify(value, null, 2);
  const structuredTextLength = structuredText.length;
  if (utf8ByteLength(text) <= INLINE_RESULT_BYTE_LIMIT && utf8ByteLength(structuredText) <= INLINE_RESULT_BYTE_LIMIT) {
    return { content: [assistantTextContent(text)], structuredContent: value };
  }
  const refResult = buildOutputRefToolContent({
    siteRoot: state.outputRoot,
    toolName,
    value,
    limit: INLINE_RESULT_BYTE_LIMIT,
  });
  const locator = requireOutputLocator(refResult);
  return {
    content: [
      assistantTextContent(renderToolResultText({ ...locator, tool_name: toolName, result_materialized: true })),
      ...resourceLinksFromToolResult(refResult),
    ],
    structuredContent: {
      ...boundedStructuredContent(value),
      result_materialized: true,
      output_ref: locator.output_ref ?? locator.ref,
      reader_tool: locator.reader_tool ?? 'mcp_output_show',
      full_output_char_length: locator.full_output_char_length ?? structuredTextLength,
    },
  };
}

function resourceLinksFromToolResult(value: unknown): unknown[] {
  const contentValue = asRecord(value).content;
  const content = Array.isArray(contentValue) ? contentValue : [];
  return content.filter((item) => asRecord(item).type === 'resource_link');
}

function assistantTextContent(text: string) {
  return { type: 'text', text, annotations: { audience: ['assistant'] } };
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function boundedStructuredContent(value: unknown): Record<string, unknown> {
  const record = { ...asRecord(value) };
  for (const field of ['diff', 'patch']) {
    if (typeof record[field] === 'string') {
      const text = String(record[field]);
      record[`${field}_preview`] = text.slice(0, PREVIEW_CHAR_LIMIT);
      record[`${field}_omitted`] = true;
      delete record[field];
    }
  }
  return record;
}

function requireOutputLocator(value: unknown): Record<string, unknown> {
  const locator = parseToolResultStructuredContent(value);
  if (typeof (locator.output_ref ?? locator.ref) !== 'string') throw diagnosticError('git_output_ref_materialization_failed');
  return locator;
}

function parseToolResultStructuredContent(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const content = Array.isArray(record.content) ? record.content : [];
  const text = asRecord(content.find((item) => asRecord(item).type === 'text')).text;
  if (typeof text !== 'string') throw diagnosticError('git_output_ref_materialization_failed', 'git_output_ref_materialization_failed', { reason: 'missing_text_content' });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw diagnosticError('git_output_ref_materialization_failed', 'git_output_ref_materialization_failed', {
      reason: 'invalid_json_text_content',
      parse_error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseArgs(argv: string[]): Record<string, unknown> {
  const parsed: Record<string, unknown> & { allowedRoots: string[] } = { allowedRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (key === 'allowedRoot' || key === 'allowedRoots') {
      if (next && !next.startsWith('--')) {
        parsed.allowedRoots.push(next);
        i += 1;
      }
      continue;
    }
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function errorDiagnostic(error: unknown) {
  if (error instanceof GitMcpError) {
    return {
      schema: 'narada.git.error.v1',
      code: error.codeName,
      message: error.message,
      details: { ...errorDetails(error.codeName, error.message), ...asRecord(error.details) },
    };
  }
  if (error instanceof GitPolicyError) {
    return {
      schema: 'narada.git.error.v1',
      code: error.codeName,
      message: error.message,
      details: { ...errorDetails(error.codeName, error.message), ...error.details },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(/[:\s]/)[0] || 'git_mcp_error';
  return {
    schema: 'narada.git.error.v1',
    code,
    message,
    details: { classification: 'unhandled_error' },
  };
}

function errorDetails(code: string, message: string): Record<string, unknown> {
  if (code === 'git_write_mode_required') {
    return {
      required_mode: 'write',
      requested_tool: message.split(':')[1] ?? null,
      hint: 'Restart git-mcp with mode=write to use mutating Git tools.',
    };
  }
  if (code === 'git_working_directory_outside_allowed_roots') {
    return { hint: 'Use a repository directory under one of git_policy_inspect.allowed_roots.' };
  }
  if (code.includes('path')) return { hint: 'Use an explicit repository-relative file path for git_add, or pathspec for read-only tools.' };
  if (code.includes('commitish')) return { hint: 'Use a commit hash, branch, tag, or HEAD-style revision that does not start with a dash.' };
  return { classification: 'known_git_error' };
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
  if (options.framed) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

function clientSupportsRoots(initializeParams: Record<string, unknown>): boolean {
  return Boolean(asRecord(asRecord(initializeParams).capabilities).roots);
}

function requestClientRoots(state: GitMcpState, pendingServerRequests: Map<string, (message: Record<string, unknown>) => void>, nextId: () => string, options: { framed: boolean }): void {
  const id = nextId();
  pendingServerRequests.set(id, (message) => {
    updateClientRoots(state, asRecord(message.result));
  });
  writeJsonRpcResponse({ jsonrpc: '2.0', id, method: 'roots/list', params: {} }, options);
}

function updateClientRoots(state: GitMcpState, result: Record<string, unknown>): void {
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

function clientRootCompletionValues(state: GitMcpState): string[] {
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
