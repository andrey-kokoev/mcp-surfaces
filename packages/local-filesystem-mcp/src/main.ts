#!/usr/bin/env node
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import {
  buildOutputRefToolContent,
  listOutputResources,
  listOutputTools,
  outputShow,
  readOutputResource,
} from '@narada2/mcp-transport';
import { buildAllowedRoots, resolveAllowedPath as resolvePolicyAllowedPath } from './policy.js';
import { applyDeletePatch as applyParsedDeletePatch, applyFilePatch as applyParsedFilePatch, parsePatch as parseToolPatch } from './patch-apply.js';
import { renderToolResultText as renderFilesystemToolResultText } from './result-rendering.js';
import { RIPGREP_FIELD_SEPARATOR, grepMatchObject as buildGrepMatchObject, runRipgrepPage, runRipgrepPageAsync } from './search.js';

const PROTOCOL_VERSION = '2024-11-05';
const INLINE_RESULT_CHAR_LIMIT = 6000;
const READ_BUFFER_BYTES = 64 * 1024;
const ROOTS_LIST_REQUEST_PREFIX = 'local_filesystem_roots_';
const DEFAULT_GLOB_IGNORE_PATTERNS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.venv/**',
  '**/__pycache__/**',
  '**/target/**',
];
let activeToolName: string | null = null;

class McpToolError extends Error {
  codeName: string;
  details: unknown;

  constructor(codeName: string, message: string, details: unknown = {}) {
    super(message);
    this.name = 'McpToolError';
    this.codeName = codeName;
    this.details = details;
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

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
      if (!record.id && record.method === 'notifications/roots/list_changed' && asRecord(state.clientRoots).supported) {
        requestClientRoots(state, pendingServerRequests, () => `${ROOTS_LIST_REQUEST_PREFIX}${nextServerRequestId++}`, { framed: sawFramedInput });
        continue;
      }
      if (record.method === 'initialize') {
        sendProgress(record, 0, 'started', { framed: sawFramedInput });
        const response = handleRequest(record, state);
        sendProgress(record, 1, 'completed', { framed: sawFramedInput });
        if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
        if (clientSupportsRoots(asRecord(record.params))) {
          asRecord(state.clientRoots).supported = true;
          requestClientRoots(state, pendingServerRequests, () => `${ROOTS_LIST_REQUEST_PREFIX}${nextServerRequestId++}`, { framed: sawFramedInput });
        }
        continue;
      }
      processStdioRequest(record, state, activeRequests, { framed: sawFramedInput });
    }
  }
}

export function createServerState(options: Record<string, unknown>): Record<string, unknown> {
  const mode = typeof options.mode === 'string' ? options.mode : null;
  if (!['read', 'write'].includes(mode ?? '')) throw diagnosticError('mode_must_be_read_or_write', 'mode_must_be_read_or_write', { mode });
  let allowedRoots;
  try {
    allowedRoots = buildAllowedRoots({
      codexConfigPath: stringOrNull(options.rootsFromCodexConfig),
      explicitRoots: stringList(options.allowedRoots),
      rootsConfigPath: stringOrNull(options.rootsConfig),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const codeName = message.split(/[:\s]/)[0] || 'allowed_roots_failed';
    throw diagnosticError(codeName, message, {
      roots_from_codex_config: stringOrNull(options.rootsFromCodexConfig),
      roots_config: stringOrNull(options.rootsConfig),
      allowed_roots: stringList(options.allowedRoots),
    });
  }
  const outputRoot = resolve(stringOrNull(options.outputRoot) ?? process.cwd());
  return {
    mode,
    allowedRoots,
    outputRoot,
    auditLogDir: options.auditLogDir ? resolve(String(options.auditLogDir)) : null,
    clientRoots: { supported: false, roots: [], lastUpdatedAt: null },
  };
}

export function handleRequest(request: Record<string, unknown>, state: Record<string, unknown>) {
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = dispatchMethod(request.method, request.params ?? {}, state);
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

function dispatchMethod(method, params, state) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {}, completions: {}, logging: {} },
        serverInfo: { name: `local-filesystem-${state.mode}`, version: '0.1.0' },
      };
    case 'tools/list':
      return { tools: listTools(state.mode) };
    case 'tools/call':
      return callTool(params, state);
    case 'resources/list':
      return listOutputResources({ siteRoot: state.outputRoot });
    case 'resources/read':
      return readOutputResource({ siteRoot: state.outputRoot, uri: params.uri });
    case 'prompts/list':
      return { prompts: listPrompts(state.mode) };
    case 'prompts/get':
      return promptGet(params, state);
    case 'completion/complete':
      return completeArgument(params, state);
    case 'logging/setLevel':
      return {};
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method: ${method}`, { method });
  }
}

async function dispatchMethodAsync(method, params, state, context) {
  switch (method) {
    case 'tools/call':
      return await callToolAsync(params, state, context);
    default:
      return dispatchMethod(method, params, state);
  }
}

async function processStdioRequest(request: Record<string, unknown>, state: Record<string, unknown>, activeRequests: Map<string, AbortController>, options: { framed: boolean }) {
  if (!request?.id && request.method === 'notifications/cancelled') {
    const requestId = String(asRecord(request.params).requestId ?? '');
    activeRequests.get(requestId)?.abort();
    return;
  }
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return;
  const requestId = String(request.id ?? '');
  const abortController = new AbortController();
  activeRequests.set(requestId, abortController);
  sendProgress(request, 0, 'started', options);
  handleRequestAsync(request, state, { abortSignal: abortController.signal }).then((response) => {
    sendProgress(request, 1, abortController.signal.aborted ? 'cancelled' : 'completed', options);
    if (response) writeJsonRpcResponse(response, options);
  }).finally(() => {
    activeRequests.delete(requestId);
  });
}

async function handleRequestAsync(request: Record<string, unknown>, state: Record<string, unknown>, context: { abortSignal?: AbortSignal } = {}) {
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethodAsync(request.method, request.params ?? {}, state, context);
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

function listPrompts(mode) {
  return [{
    name: 'local_filesystem_tool_usage',
    title: 'Local Filesystem Tool Usage',
    description: `Guidance for using local-filesystem-${mode} tools safely.`,
    arguments: [],
  }];
}

function promptGet(params, state) {
  const name = stringField(params, 'name');
  if (name !== 'local_filesystem_tool_usage') throw diagnosticError('unknown_prompt', `unknown_prompt: ${name}`, { name });
  return {
    description: `Guidance for using local-filesystem-${state.mode} tools safely.`,
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Use local-filesystem-${state.mode} tools only within allowed roots. Prefer read/search tools before mutation and preserve structuredContent as authoritative.` },
    }],
  };
}

function completeArgument(params, state) {
  const argumentName = String(asRecord(asRecord(params).argument).name ?? '');
  const values = argumentName === 'name'
    ? listTools(state.mode).map((tool) => tool.name).filter(Boolean).slice(0, 100)
    : ['path', 'directory'].includes(argumentName) ? clientRootCompletionValues(state) : [];
  return { completion: { values, total: values.length, hasMore: false } };
}

export function listTools(mode) {
  const readTools = [
    {
      name: 'fs_read_file',
      description: 'Read a text file under an allowed root with line offset and limit.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        offset: { type: 'integer', default: 1 },
        limit: { type: 'integer', default: 400 },
      }, ['path']),
    },
    {
      name: 'fs_read_file_range',
      description: 'Read a text file line range under an allowed root. Lines are 1-based and inclusive.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
      }, ['path', 'start_line', 'end_line']),
    },
    {
      name: 'fs_stat',
      description: 'Return file or directory metadata under an allowed root.',
      inputSchema: objectSchema({ path: { type: 'string' } }, ['path']),
    },
    {
      name: 'fs_glob_search',
      description: 'List files under an allowed root using ripgrep file globbing.',
      inputSchema: objectSchema({
        pattern: { type: 'string' },
        directory: { type: 'string', default: '.' },
        ignore: { type: 'array', items: { type: 'string' }, description: 'Additional glob patterns to exclude. Defaults also exclude generated dependency/build directories.' },
        offset: { type: 'integer', default: 0 },
        limit: { type: 'integer', default: 100 },
        timeout_ms: { type: 'integer', description: 'Optional search timeout in milliseconds.' },
        cache_policy: { type: 'string', enum: ['auto', 'snapshot', 'refresh', 'bypass'], default: 'auto', description: 'auto uses cached complete snapshots when available; snapshot materializes a reusable snapshot; refresh rebuilds and stores a snapshot; bypass does not use cached snapshots.' },
        snapshot_id: { type: 'string', description: 'Optional snapshot_id from a previous complete search response to page consistently.' },
      }, ['pattern']),
    },
    {
      name: 'fs_grep_search',
      description: 'Search file contents under an allowed root using ripgrep. Defaults to files_with_matches.',
      inputSchema: objectSchema({
        pattern: { type: 'string' },
        path: { type: 'string', default: '.' },
        output_mode: { type: 'string', enum: ['files_with_matches', 'count_matches', 'content'], default: 'files_with_matches' },
        offset: { type: 'integer', default: 0 },
        limit: { type: 'integer', default: 80 },
        timeout_ms: { type: 'integer', description: 'Optional search timeout in milliseconds.' },
        cache_policy: { type: 'string', enum: ['auto', 'snapshot', 'refresh', 'bypass'], default: 'auto', description: 'auto uses cached complete snapshots when available; snapshot materializes a reusable snapshot; refresh rebuilds and stores a snapshot; bypass does not use cached snapshots.' },
        snapshot_id: { type: 'string', description: 'Optional snapshot_id from a previous complete search response to page consistently.' },
      }, ['pattern']),
    },
    ...listOutputTools(),
  ];
  const writeTools = [
    {
      name: 'fs_write_file',
      description: 'Write a text file under an allowed root and append an audit record.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean', default: true },
        create_only: { type: 'boolean', default: false },
        create_parent_directories: { type: 'boolean', default: true, description: 'Create missing parent directories before writing.' },
        expected_sha256: { type: 'string', description: 'Optional expected current file sha256 before overwriting.' },
      }, ['path', 'content']),
    },
    {
      name: 'fs_str_replace_file',
      description: 'Replace exactly one string occurrence in a text file under an allowed root and append an audit record.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        old: { type: 'string' },
        new: { type: 'string' },
        expected_sha256: { type: 'string', description: 'Optional expected current file sha256 before editing.' },
      }, ['path', 'old', 'new']),
    },
    {
      name: 'fs_replace_range',
      description: 'Replace an inclusive 1-based line range in a text file under an allowed root and append an audit record.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
        replacement: { type: 'string' },
        expected_sha256: { type: 'string', description: 'Optional expected current file sha256 before editing.' },
      }, ['path', 'start_line', 'end_line', 'replacement']),
    },
    {
      name: 'fs_apply_patch',
      description: 'Apply a unified diff or Codex-style apply_patch patch to files under allowed roots and append an audit record.',
      inputSchema: objectSchema({
        patch: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
        expected_sha256: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional map from patch paths to expected current file sha256 values.' },
      }, ['patch']),
    },
    {
      name: 'fs_move_path',
      description: 'Move or rename a file or directory under allowed roots and append an audit record. Refuses overwrite unless overwrite is true.',
      inputSchema: objectSchema({
        from: { type: 'string' },
        to: { type: 'string' },
        overwrite: { type: 'boolean', default: false },
        expected_from_mtime: { type: 'string', description: 'Optional expected source mtime ISO string.' },
        expected_from_size: { type: 'integer', description: 'Optional expected source byte size.' },
        expected_from_sha256: { type: 'string', description: 'Optional expected source sha256 for file sources.' },
        expected_from_tree_sha256: { type: 'string', description: 'Optional expected source tree sha256 for directory sources.' },
        expected_from_entry_count: { type: 'integer', description: 'Optional expected source direct entry count for directory sources.' },
        expected_to_mtime: { type: 'string', description: 'Optional expected destination mtime ISO string when overwriting.' },
        expected_to_size: { type: 'integer', description: 'Optional expected destination byte size when overwriting.' },
        expected_to_tree_sha256: { type: 'string', description: 'Optional expected destination tree sha256 for directory destinations.' },
        expected_to_entry_count: { type: 'integer', description: 'Optional expected destination direct entry count for directory destinations.' },
        expected_from: { type: 'object', additionalProperties: false, properties: expectedMetadataSchemaProperties(), description: 'Structured source metadata guard.' },
        expected_to: { type: 'object', additionalProperties: false, properties: expectedMetadataSchemaProperties(), description: 'Structured destination metadata guard.' },
      }, ['from', 'to']),
    },
    {
      name: 'fs_create_directory',
      description: 'Create a directory under an allowed root and append an audit record. Parent creation requires recursive true.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        recursive: { type: 'boolean', default: false },
      }, ['path']),
    },
    {
      name: 'fs_rename_directory',
      description: 'Rename or move a directory under allowed roots and append an audit record. Refuses existing destinations.',
      inputSchema: objectSchema({
        from: { type: 'string' },
        to: { type: 'string' },
        expected_from_mtime: { type: 'string', description: 'Optional expected source mtime ISO string.' },
        expected_from_size: { type: 'integer', description: 'Optional expected source byte size.' },
        expected_from_tree_sha256: { type: 'string', description: 'Optional expected source tree sha256.' },
        expected_from_entry_count: { type: 'integer', description: 'Optional expected source direct entry count.' },
        expected_to_mtime: { type: 'string', description: 'Optional expected destination mtime ISO string if it exists.' },
        expected_to_size: { type: 'integer', description: 'Optional expected destination byte size if it exists.' },
        expected_to_tree_sha256: { type: 'string', description: 'Optional expected destination tree sha256 if it exists.' },
        expected_to_entry_count: { type: 'integer', description: 'Optional expected destination direct entry count if it exists.' },
        expected_from: { type: 'object', additionalProperties: false, properties: expectedMetadataSchemaProperties(), description: 'Structured source metadata guard.' },
        expected_to: { type: 'object', additionalProperties: false, properties: expectedMetadataSchemaProperties(), description: 'Structured destination metadata guard.' },
      }, ['from', 'to']),
    },
    {
      name: 'fs_delete_directory',
      description: 'Delete a directory under an allowed root and append an audit record. Non-empty deletion requires recursive true.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        recursive: { type: 'boolean', default: false },
        expected_mtime: { type: 'string', description: 'Optional expected directory mtime ISO string before deletion.' },
        expected_size: { type: 'integer', description: 'Optional expected directory byte size before deletion.' },
        expected_tree_sha256: { type: 'string', description: 'Optional expected directory tree sha256 before deletion.' },
        expected_entry_count: { type: 'integer', description: 'Optional expected direct entry count before deletion.' },
        expected: { type: 'object', additionalProperties: false, properties: expectedMetadataSchemaProperties(), description: 'Structured target metadata guard.' },
      }, ['path']),
    },
  ];
  return decorateTools(mode === 'read' ? readTools : [...readTools, ...writeTools]);
}

function callTool(params, state) {
  const record = asRecord(params);
  const name = stringField(record, 'name');
  const args = asRecord(record.arguments);
  activeToolName = name;
  if (!name) throw diagnosticError('tools_call_requires_name', 'tools_call_requires_name');
  if (!listTools(state.mode).some((tool) => tool.name === name)) throw diagnosticError(`tool_not_available_in_${state.mode}_mode`, `tool_not_available_in_${state.mode}_mode: ${name}`, { tool_name: name, mode: state.mode });
  switch (name) {
    case 'fs_read_file': return toolResult(readFileTool(args, state));
    case 'fs_read_file_range': return toolResult(readFileRangeTool(args, state));
    case 'fs_stat': return toolResult(statTool(args, state));
    case 'fs_glob_search': return toolResult(globSearchTool(args, state));
    case 'fs_grep_search': return toolResult(grepSearchTool(args, state), { grepOutputMode: stringField(args, 'output_mode') ?? 'files_with_matches' });
    case 'mcp_output_show': return toolResult(outputShow({ siteRoot: state.outputRoot, args: normalizeOutputShowArgs(args) }));
    case 'fs_write_file': return toolResult(writeFileTool(args, state));
    case 'fs_str_replace_file': return toolResult(strReplaceTool(args, state));
    case 'fs_replace_range': return toolResult(replaceRangeTool(args, state));
    case 'fs_apply_patch': return toolResult(applyPatchTool(args, state));
    case 'fs_move_path': return toolResult(movePathTool(args, state));
    case 'fs_create_directory': return toolResult(createDirectoryTool(args, state));
    case 'fs_rename_directory': return toolResult(renameDirectoryTool(args, state));
    case 'fs_delete_directory': return toolResult(deleteDirectoryTool(args, state));
    default: throw diagnosticError('unknown_tool', `unknown_tool: ${name}`, { tool_name: name });
  }
}

function readFileTool(args, state) {
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_read_file' });
  const offset = Math.max(1, integerField(args, 'offset') ?? 1);
  const limit = Math.min(1000, Math.max(1, integerField(args, 'limit') ?? 400));
  const value = readFileRange({ path, root, offset, limit });
  return cappedToolValue({ state, value, summary: readSummary(value) });
}

function readFileRangeTool(args, state) {
  const startLine = integerField(args, 'start_line');
  const endLine = integerField(args, 'end_line');
  if (!Number.isInteger(startLine) || startLine < 1) throw diagnosticError('start_line_must_be_positive_integer', 'start_line_must_be_positive_integer', { start_line: startLine ?? null });
  if (!Number.isInteger(endLine) || endLine < startLine) throw diagnosticError('end_line_must_be_greater_than_or_equal_start_line', 'end_line_must_be_greater_than_or_equal_start_line', { start_line: startLine ?? null, end_line: endLine ?? null });
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_read_file_range' });
  const value = readFileRange({ path, root, offset: startLine, limit: endLine - startLine + 1 });
  return cappedToolValue({ state, value, summary: readSummary(value) });
}

function readFileRange({ path, root, offset, limit }) {
  const window = readTextLineWindow({ path, root, offset, limit });
  const content = window.selected.join('\n');
  return {
    path,
    root,
    relative_path: relative(root, path).replace(/\\/g, '/'),
    total_lines: window.totalLines,
    total_lines_exact: window.totalLinesExact,
    total_lines_status: window.totalLinesExact ? 'exact' : 'unknown_after_window',
    line_window_complete: window.totalLinesExact,
    offset,
    limit,
    returned_lines: window.selected.length,
    next_offset: window.nextOffset,
    content,
    content_sha256: sha256(content),
  };
}

function statTool(args, state) {
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_stat' });
  const stat = statSync(path);
  const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  const directoryFingerprint = type === 'directory' ? directoryTreeFingerprint(path, root) : null;
  return {
    schema: 'local.filesystem.stat.v1',
    path,
    root,
    relative_path: relative(root, path).replace(/\\/g, '/'),
    type,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    ...(type === 'file' ? { sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } : {}),
    ...(directoryFingerprint ? { entry_count: directoryFingerprint.entry_count, tree_entry_count: directoryFingerprint.tree_entry_count, tree_truncated: directoryFingerprint.tree_truncated, tree_sha256: directoryFingerprint.tree_sha256 } : {}),
  };
}

function globSearchTool(args, state) {
  const pattern = stringField(args, 'pattern');
  if (!pattern) throw diagnosticError('glob_requires_pattern', 'glob_requires_pattern');
  const { path: directory } = resolveAllowedToolPath(stringField(args, 'directory') ?? '.', state.allowedRoots, { operation: 'fs_glob_search' });
  const offset = Math.max(0, integerField(args, 'offset') ?? 0);
  const limit = Math.min(500, Math.max(1, integerField(args, 'limit') ?? 100));
  const timeoutMs = searchTimeoutMs(args);
  const cachePolicy = searchCachePolicy(args);
  const snapshotId = stringField(args, 'snapshot_id');
  const ignorePatterns = [...DEFAULT_GLOB_IGNORE_PATTERNS, ...stringList(args.ignore)];
  const rgArgs = ['--files', '--hidden', '--no-ignore', '-g', pattern, ...ignorePatterns.flatMap((ignore) => ['-g', negateGlob(ignore)]), directory];
  const freshness = searchFreshness(directory);
  return cappedSearchResult({ state, kind: 'glob', args, page: runRipgrepPage(rgArgs, { operation: 'fs_glob_search', noMatchStatus: 0, offset, limit, timeoutMs, freshness, cachePolicy, snapshotId, diagnosticError }), offset, limit, freshness, cachePolicy });
}

async function globSearchToolAsync(args, state, context) {
  const pattern = stringField(args, 'pattern');
  if (!pattern) throw diagnosticError('glob_requires_pattern', 'glob_requires_pattern');
  const { path: directory } = resolveAllowedToolPath(stringField(args, 'directory') ?? '.', state.allowedRoots, { operation: 'fs_glob_search' });
  const offset = Math.max(0, integerField(args, 'offset') ?? 0);
  const limit = Math.min(500, Math.max(1, integerField(args, 'limit') ?? 100));
  const timeoutMs = searchTimeoutMs(args);
  const cachePolicy = searchCachePolicy(args);
  const snapshotId = stringField(args, 'snapshot_id');
  const ignorePatterns = [...DEFAULT_GLOB_IGNORE_PATTERNS, ...stringList(args.ignore)];
  const rgArgs = ['--files', '--hidden', '--no-ignore', '-g', pattern, ...ignorePatterns.flatMap((ignore) => ['-g', negateGlob(ignore)]), directory];
  const freshness = searchFreshness(directory);
  const page = await runRipgrepPageAsync(rgArgs, { operation: 'fs_glob_search', noMatchStatus: 0, offset, limit, timeoutMs, freshness, cachePolicy, snapshotId, diagnosticError, abortSignal: context.abortSignal });
  return cappedSearchResult({ state, kind: 'glob', args, page, offset, limit, freshness, cachePolicy });
}

function readSummary(value) {
  return {
    path: value.path,
    relative_path: value.relative_path,
    offset: value.offset,
    limit: value.limit,
    returned_lines: value.returned_lines,
    next_offset: value.next_offset,
    total_lines: value.total_lines,
    total_lines_exact: value.total_lines_exact,
    total_lines_status: value.total_lines_status,
    line_window_complete: value.line_window_complete,
    content_sha256: value.content_sha256,
  };
}

function grepSearchTool(args, state) {
  const pattern = stringField(args, 'pattern');
  if (!pattern) throw diagnosticError('grep_requires_pattern', 'grep_requires_pattern');
  const { path } = resolveAllowedToolPath(stringField(args, 'path') ?? '.', state.allowedRoots, { operation: 'fs_grep_search' });
  const mode = stringField(args, 'output_mode') ?? 'files_with_matches';
  if (!['files_with_matches', 'count_matches', 'content'].includes(mode)) throw diagnosticError('grep_output_mode_unsupported', `grep_output_mode_unsupported: ${mode}`, { output_mode: mode });
  const offset = Math.max(0, integerField(args, 'offset') ?? 0);
  const limit = Math.min(500, Math.max(1, integerField(args, 'limit') ?? 80));
  const timeoutMs = searchTimeoutMs(args);
  const cachePolicy = searchCachePolicy(args);
  const snapshotId = stringField(args, 'snapshot_id');
  const modeArgs = mode === 'content' ? ['-n'] : mode === 'count_matches' ? ['-c'] : ['-l'];
  const freshness = searchFreshness(path);
  return cappedSearchResult({ state, kind: 'grep', args: { ...args, output_mode: mode }, page: runRipgrepPage(['--field-match-separator', RIPGREP_FIELD_SEPARATOR, '--with-filename', pattern, path, ...modeArgs], { operation: 'fs_grep_search', noMatchStatus: 1, offset, limit, timeoutMs, freshness, cachePolicy, snapshotId, diagnosticError }), offset, limit, freshness, cachePolicy });
}

async function grepSearchToolAsync(args, state, context) {
  const pattern = stringField(args, 'pattern');
  if (!pattern) throw diagnosticError('grep_requires_pattern', 'grep_requires_pattern');
  const { path } = resolveAllowedToolPath(stringField(args, 'path') ?? '.', state.allowedRoots, { operation: 'fs_grep_search' });
  const mode = stringField(args, 'output_mode') ?? 'files_with_matches';
  if (!['files_with_matches', 'count_matches', 'content'].includes(mode)) throw diagnosticError('grep_output_mode_unsupported', `grep_output_mode_unsupported: ${mode}`, { output_mode: mode });
  const offset = Math.max(0, integerField(args, 'offset') ?? 0);
  const limit = Math.min(500, Math.max(1, integerField(args, 'limit') ?? 80));
  const timeoutMs = searchTimeoutMs(args);
  const cachePolicy = searchCachePolicy(args);
  const snapshotId = stringField(args, 'snapshot_id');
  const modeArgs = mode === 'content' ? ['-n'] : mode === 'count_matches' ? ['-c'] : ['-l'];
  const freshness = searchFreshness(path);
  const page = await runRipgrepPageAsync(['--field-match-separator', RIPGREP_FIELD_SEPARATOR, '--with-filename', pattern, path, ...modeArgs], { operation: 'fs_grep_search', noMatchStatus: 1, offset, limit, timeoutMs, freshness, cachePolicy, snapshotId, diagnosticError, abortSignal: context.abortSignal });
  return cappedSearchResult({ state, kind: 'grep', args: { ...args, output_mode: mode }, page, offset, limit, freshness, cachePolicy });
}

function cappedSearchResult({ state, kind, args, page, offset, limit, freshness, cachePolicy }) {
  const matches = page.matches;
  const nextOffset = page.has_more ? offset + matches.length : null;
  const grepMode = stringField(args, 'output_mode') ?? 'files_with_matches';
  const value = {
    schema: `local.filesystem.${kind}.v1`,
    status: 'ok',
    ...(kind === 'grep' ? { output_mode: stringField(args, 'output_mode') ?? 'files_with_matches' } : {}),
    offset,
    limit,
    count: page.count,
    count_exact: page.count_exact,
    scanned: page.scanned,
    scanned_unit: 'matched_entries',
    returned: matches.length,
    order: 'ripgrep_traversal',
    cache_hit: page.cache_hit === true,
    cache_policy: page.cache_policy ?? cachePolicy,
    snapshot_id: page.snapshot_id ?? null,
    requested_snapshot_id: page.requested_snapshot_id ?? stringField(args, 'snapshot_id'),
    snapshot_complete: page.snapshot_complete === true,
    cache_memory_bytes: page.cache_memory_bytes ?? null,
    timeout_ms: page.timeout_ms ?? null,
    freshness,
    has_more: page.has_more,
    next_offset: nextOffset,
    matches_format: kind === 'grep' ? 'human' : 'path',
    matches: kind === 'grep' ? matches.map((match) => renderGrepMatch(match, grepMode)) : matches,
    ...(kind === 'grep' ? { match_objects_authoritative: true, match_objects: matches.map((match) => buildGrepMatchObject(match, grepMode)) } : {}),
  };
  return cappedToolValue({ state, value, summary: { count: value.count, count_exact: value.count_exact, scanned: value.scanned, scanned_unit: value.scanned_unit, returned: value.returned, order: value.order, cache_hit: value.cache_hit, cache_policy: value.cache_policy, snapshot_id: value.snapshot_id, snapshot_complete: value.snapshot_complete, cache_memory_bytes: value.cache_memory_bytes, timeout_ms: value.timeout_ms, freshness: value.freshness, matches_format: value.matches_format, has_more: value.has_more, next_offset: value.next_offset } });
}

function cappedToolValue({ state, value, summary = {} }) {
  if (JSON.stringify(value).length <= INLINE_RESULT_CHAR_LIMIT) return value;
  const result = buildOutputRefToolContent({ siteRoot: state.outputRoot, toolName: activeToolName, value, isError: false });
  const envelope = parseToolResultStructuredContent(result);
  if (!envelope) return result;
  const { truncated, ...locator } = envelope;
  const structuredContent = { ...locator, render_truncated: truncated, ...summary };
  return {
    ...result,
    structuredContent,
    content: [assistantTextContent(JSON.stringify(structuredContent, null, 2))],
  };
}

function writeFileTool(args, state) {
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_write_file' });
  const content = stringField(args, 'content') ?? '';
  const overwrite = booleanField(args, 'overwrite') ?? true;
  const createOnly = booleanField(args, 'create_only') ?? false;
  const createParentDirectories = booleanField(args, 'create_parent_directories') ?? true;
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (before !== null && createOnly) throw diagnosticError('write_file_destination_exists', `write_file_destination_exists: ${path}`, pathMetadata(path, root));
  if (before !== null && !overwrite) throw diagnosticError('write_file_overwrite_refused', `write_file_overwrite_refused: ${path}`, pathMetadata(path, root));
  assertExpectedSha256(args, before, { operation: 'fs_write_file', path, root });
  const parent = dirname(path);
  if (!existsSync(parent) && !createParentDirectories) throw diagnosticError('write_file_parent_not_found', `write_file_parent_not_found: ${parent}`, { requested_path: path, parent: pathMetadata(parent, root) });
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(path, content, 'utf8');
  appendAudit(state, 'fs_write_file', path, root, { size: content.length, create_parent_directories: createParentDirectories, before_sha256: before === null ? null : sha256(before), after_sha256: sha256(content) });
  return { schema: 'local.filesystem.write_file.v1', status: 'written', ...pathMetadata(path, root), size: content.length, create_parent_directories: createParentDirectories, before_sha256: before === null ? null : sha256(before), after_sha256: sha256(content) };
}

function strReplaceTool(args, state) {
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_str_replace_file' });
  const oldText = stringField(args, 'old') ?? '';
  const newText = stringField(args, 'new') ?? '';
  if (!oldText) throw diagnosticError('str_replace_requires_old', 'str_replace_requires_old', pathMetadata(path, root));
  const before = readFileSync(path, 'utf8');
  assertExpectedSha256(args, before, { operation: 'fs_str_replace_file', path, root });
  const count = before.split(oldText).length - 1;
  if (count === 0) throw diagnosticError('str_replace_not_found', 'str_replace_not_found', pathMetadata(path, root));
  if (count > 1) {
    throw diagnosticError('str_replace_ambiguous', `str_replace_ambiguous: ${count}`, {
      ...pathMetadata(path, root),
      occurrences: count,
      matches: findTextOccurrences(before, oldText).slice(0, 20),
    });
  }
  const after = before.replace(oldText, newText);
  writeFileSync(path, after, 'utf8');
  appendAudit(state, 'fs_str_replace_file', path, root, { old_length: oldText.length, new_length: newText.length, before_sha256: sha256(before), after_sha256: sha256(after) });
  return {
    schema: 'local.filesystem.str_replace_file.v1',
    status: 'replaced',
    ...pathMetadata(path, root),
    occurrences: 1,
    before_sha256: sha256(before),
    after_sha256: sha256(after),
  };
}

function replaceRangeTool(args, state) {
  const startLine = integerField(args, 'start_line');
  const endLine = integerField(args, 'end_line');
  if (!Number.isInteger(startLine) || startLine < 1) throw diagnosticError('start_line_must_be_positive_integer', 'start_line_must_be_positive_integer', { start_line: startLine ?? null });
  if (!Number.isInteger(endLine) || endLine < startLine) throw diagnosticError('end_line_must_be_greater_than_or_equal_start_line', 'end_line_must_be_greater_than_or_equal_start_line', { start_line: startLine ?? null, end_line: endLine ?? null });
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_replace_range' });
  const replacement = stringField(args, 'replacement') ?? '';
  const before = readFileSync(path, 'utf8');
  assertExpectedSha256(args, before, { operation: 'fs_replace_range', path, root });
  const hasTrailingNewline = /\r?\n$/.test(before);
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.replace(/\r?\n$/, '').split(/\r?\n/);
  if (startLine > lines.length + 1) throw diagnosticError('start_line_out_of_range', `start_line_out_of_range: ${startLine}`, { ...pathMetadata(path, root), start_line: startLine, total_lines: lines.length });
  if (endLine > lines.length) throw diagnosticError('end_line_out_of_range', `end_line_out_of_range: ${endLine}`, { ...pathMetadata(path, root), end_line: endLine, total_lines: lines.length });
  const replacementLines = replacement.length === 0 ? [] : replacement.split(/\r?\n/);
  const afterLines = [...lines.slice(0, startLine - 1), ...replacementLines, ...lines.slice(endLine)];
  const after = `${afterLines.join(newline)}${hasTrailingNewline ? newline : ''}`;
  writeFileSync(path, after, 'utf8');
  appendAudit(state, 'fs_replace_range', path, root, { start_line: startLine, end_line: endLine, before_sha256: sha256(before), after_sha256: sha256(after) });
  return {
    schema: 'local.filesystem.replace_range.v1',
    status: 'replaced_range',
    ...pathMetadata(path, root),
    start_line: startLine,
    end_line: endLine,
    inserted_lines: replacementLines.length,
    before_sha256: sha256(before),
    after_sha256: sha256(after),
  };
}

function applyPatchTool(args, state) {
  const patch = stringField(args, 'patch');
  if (!patch) throw diagnosticError('patch_required', 'Patch text is required.');
  const dryRun = booleanField(args, 'dry_run') ?? false;
  const expectedSha256 = expectedSha256Map(args);
  const matchedExpectedSha256Keys = new Set();
  const files = parseToolPatch(patch, { diagnosticError: patchDiagnosticError });
  if (files.length === 0) {
    throw patchDiagnosticError('patch_contains_no_files', patch, {
      expected_format: 'unified_diff_or_codex_apply_patch',
      expected_headers: ['--- <path>', '+++ <path>', '@@ -old,+new @@', '*** Begin Patch', '*** Update File: <path>'],
    });
  }
  const planned = files.map((filePatch) => {
    const source = resolvePatchSource(filePatch, state);
    const target = resolvePatchTarget(filePatch, state);
    if (filePatch.oldPath !== '/dev/null' && !existsSync(source.path)) {
      throw diagnosticError('patch_source_not_found', `patch_source_not_found: ${source.path}`, {
        ...pathMetadata(source.path, source.root),
        expected_format_for_new_files: 'unified diff with --- /dev/null or Codex *** Add File',
      });
    }
    const before = existsSync(source.path) ? readFileSync(source.path, 'utf8') : '';
    const matchedKey = assertExpectedPatchSha256(expectedSha256, filePatch, source, target, before);
    if (matchedKey) matchedExpectedSha256Keys.add(matchedKey);
    const patchContext = { diagnosticError };
    const after = filePatch.deleteFile ? applyParsedDeletePatch(before, filePatch, patchContext) : applyParsedFilePatch(before, filePatch, patchContext);
    return { filePatch, source, target, before, after };
  });
  assertAllExpectedPatchSha256KeysMatched(expectedSha256, matchedExpectedSha256Keys);
  if (dryRun) {
    return {
      schema: 'local.filesystem.apply_patch.v1',
      status: 'checked',
      dry_run: true,
      changed_files: planned.map((item) => ({
        ...pathMetadata(item.target.path, item.target.root),
        operation: patchOperation(item.filePatch, item.source, item.target),
        hunks: item.filePatch.hunks.length,
        deleted: item.filePatch.deleteFile === true,
        before_sha256: sha256(item.before),
        after_sha256: item.filePatch.deleteFile ? null : sha256(item.after),
      })),
    };
  }
  const changed = [];
  const backupPaths = uniquePaths(planned.flatMap((item) => [item.source.path, item.target.path]));
  const backups = backupPaths.map((path) => ({
    path,
    existed: existsSync(path),
    content: existsSync(path) ? readFileSync(path, 'utf8') : null,
  }));
  try {
    for (const item of planned) {
      if (item.filePatch.deleteFile) {
        if (!existsSync(item.source.path)) throw diagnosticError('patch_delete_target_not_found', `patch_delete_target_not_found: ${item.source.path}`, pathMetadata(item.source.path, item.source.root));
        rmSync(item.source.path, { force: false });
      } else {
        mkdirSync(dirname(item.target.path), { recursive: true });
        writeFileSync(item.target.path, item.after, 'utf8');
        if (!samePath(item.source.path, item.target.path) && existsSync(item.source.path)) rmSync(item.source.path, { force: false });
      }
      const afterSha256 = item.filePatch.deleteFile ? null : sha256(item.after);
      appendAudit(state, 'fs_apply_patch', item.target.path, item.target.root, { patch_sha256: sha256(patch), before_sha256: sha256(item.before), after_sha256: afterSha256, hunks: item.filePatch.hunks.length });
      changed.push({ ...pathMetadata(item.target.path, item.target.root), operation: patchOperation(item.filePatch, item.source, item.target), hunks: item.filePatch.hunks.length, deleted: item.filePatch.deleteFile === true, before_sha256: sha256(item.before), after_sha256: afterSha256 });
    }
  } catch (error) {
    rollbackPatch(backups);
    throw error;
  }
  return { schema: 'local.filesystem.apply_patch.v1', status: 'patched', changed_files: changed };
}

function movePathTool(args, state) {
  const from = resolveAllowedToolPath(stringField(args, 'from'), state.allowedRoots, { operation: 'fs_move_path', field: 'from' });
  const to = resolveAllowedToolPath(stringField(args, 'to'), state.allowedRoots, { operation: 'fs_move_path', field: 'to' });
  const overwrite = booleanField(args, 'overwrite') ?? false;
  return movePath({ state, operation: 'fs_move_path', args, from, to, overwrite, directoryOnly: false });
}

function createDirectoryTool(args, state) {
  const target = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_create_directory' });
  const recursive = booleanField(args, 'recursive') ?? false;
  if (existsSync(target.path)) {
    if (!statSync(target.path).isDirectory()) throw diagnosticError('create_directory_destination_not_directory', `create_directory_destination_not_directory: ${target.path}`, pathMetadata(target.path, target.root));
    appendAudit(state, 'fs_create_directory', target.path, target.root, { recursive, created: false });
    return {
      schema: 'local.filesystem.create_directory.v1',
      status: 'exists',
      ...pathMetadata(target.path, target.root),
      recursive,
      created: false,
    };
  }
  const parent = dirname(target.path);
  if (!recursive && !existsSync(parent)) {
    throw diagnosticError('create_directory_parent_not_found', `create_directory_parent_not_found: ${parent}`, {
      operation: 'fs_create_directory',
      requested_path: target.path,
      parent: pathMetadata(parent, target.root),
    });
  }
  mkdirSync(target.path, { recursive });
  appendAudit(state, 'fs_create_directory', target.path, target.root, { recursive });
  return {
    schema: 'local.filesystem.create_directory.v1',
    status: 'created',
    ...pathMetadata(target.path, target.root),
    recursive,
    created: true,
  };
}

function renameDirectoryTool(args, state) {
  const from = resolveAllowedToolPath(stringField(args, 'from'), state.allowedRoots, { operation: 'fs_rename_directory', field: 'from' });
  const to = resolveAllowedToolPath(stringField(args, 'to'), state.allowedRoots, { operation: 'fs_rename_directory', field: 'to' });
  return movePath({ state, operation: 'fs_rename_directory', args, from, to, overwrite: false, directoryOnly: true });
}

function deleteDirectoryTool(args, state) {
  const target = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_delete_directory' });
  const recursive = booleanField(args, 'recursive') ?? false;
  if (!existsSync(target.path)) throw diagnosticError('delete_directory_not_found', `delete_directory_not_found: ${target.path}`, pathMetadata(target.path, target.root));
  const targetStat = statSync(target.path);
  if (!targetStat.isDirectory()) throw diagnosticError('delete_directory_target_not_directory', `delete_directory_target_not_directory: ${target.path}`, pathMetadata(target.path, target.root));
  assertExpectedMetadata(args, target, { operation: 'fs_delete_directory', objectKey: 'expected', mtimeKey: 'expected_mtime', sizeKey: 'expected_size', treeShaKey: 'expected_tree_sha256', entryCountKey: 'expected_entry_count' });
  const entryCount = readdirSync(target.path).length;
  if (entryCount > 0 && !recursive) throw diagnosticError('delete_directory_not_empty', `delete_directory_not_empty: ${target.path}`, { ...pathMetadata(target.path, target.root), entry_count: entryCount });
  rmSync(target.path, { recursive, force: false });
  appendAudit(state, 'fs_delete_directory', target.path, target.root, { recursive, entry_count: entryCount });
  return {
    schema: 'local.filesystem.delete_directory.v1',
    status: 'deleted',
    ...pathMetadata(target.path, target.root),
    recursive,
  };
}

function movePath({ state, operation, args, from, to, overwrite, directoryOnly }) {
  if (samePath(from.path, to.path)) throw diagnosticError('move_source_and_destination_same', `move_source_and_destination_same: ${from.path}`, { operation, from: pathMetadata(from.path, from.root), to: pathMetadata(to.path, to.root) });
  if (!existsSync(from.path)) throw diagnosticError('move_source_not_found', `move_source_not_found: ${from.path}`, { operation, ...pathMetadata(from.path, from.root) });
  const fromStat = statSync(from.path);
  if (directoryOnly && !fromStat.isDirectory()) throw diagnosticError('rename_directory_source_not_directory', `rename_directory_source_not_directory: ${from.path}`, pathMetadata(from.path, from.root));
  assertExpectedMetadata(args, from, { operation, objectKey: 'expected_from', mtimeKey: 'expected_from_mtime', sizeKey: 'expected_from_size', shaKey: 'expected_from_sha256', treeShaKey: 'expected_from_tree_sha256', entryCountKey: 'expected_from_entry_count' });
  if (fromStat.isDirectory() && isPathInside(to.path, from.path)) throw diagnosticError('move_destination_inside_source', `move_destination_inside_source: ${to.path}`, { operation, from: pathMetadata(from.path, from.root), to: pathMetadata(to.path, to.root) });
  if (existsSync(to.path)) {
    if (!overwrite) throw diagnosticError('move_destination_exists', `move_destination_exists: ${to.path}`, { operation, ...pathMetadata(to.path, to.root) });
    const toStat = statSync(to.path);
    if (fromStat.isDirectory() !== toStat.isDirectory()) throw diagnosticError('move_destination_type_mismatch', `move_destination_type_mismatch: ${to.path}`, { operation, ...pathMetadata(to.path, to.root) });
    assertExpectedMetadata(args, to, { operation, objectKey: 'expected_to', mtimeKey: 'expected_to_mtime', sizeKey: 'expected_to_size', treeShaKey: 'expected_to_tree_sha256', entryCountKey: 'expected_to_entry_count' });
    const backupPath = uniqueSiblingPath(to.path, 'overwrite-backup');
    renameSync(to.path, backupPath);
    try {
      mkdirSync(dirname(to.path), { recursive: true });
      renameSync(from.path, to.path);
      rmSync(backupPath, { recursive: true, force: true });
    } catch (error) {
      if (!existsSync(to.path) && existsSync(backupPath)) renameSync(backupPath, to.path);
      throw error;
    }
  } else {
    mkdirSync(dirname(to.path), { recursive: true });
    renameSync(from.path, to.path);
  }
  appendAudit(state, operation, to.path, to.root, {
    from: from.path,
    from_root: from.root,
    to: to.path,
    to_root: to.root,
    overwrite,
  });
  return {
    schema: operation === 'fs_rename_directory' ? 'local.filesystem.rename_directory.v1' : 'local.filesystem.move_path.v1',
    status: 'moved',
    from: pathMetadata(from.path, from.root),
    to: pathMetadata(to.path, to.root),
    overwrite,
  };
}

function pathMetadata(path, root) {
  return {
    path,
    root,
    relative_path: relative(root, path).replace(/\\/g, '/'),
  };
}

function readTextLineWindow({ path, root, offset, limit }) {
  const fd = openSync(path, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const selected = [];
  let pending = '';
  let lineNumber = 0;
  let reachedEof = false;
  let nextOffset = null;
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) throw diagnosticError('binary_file_not_supported', `binary_file_not_supported: ${path}`, pathMetadata(path, root));
      pending += decoder.write(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        lineNumber += 1;
        if (lineNumber >= offset && selected.length < limit) selected.push(line);
        else if (lineNumber >= offset + limit) {
          nextOffset = lineNumber;
          return {
            selected,
            nextOffset,
            totalLines: null,
            totalLinesExact: false,
          };
        }
      }
    }
    pending += decoder.end();
    if (pending.length > 0) {
      lineNumber += 1;
      if (lineNumber >= offset && selected.length < limit) selected.push(pending);
      else if (lineNumber >= offset + limit) nextOffset = lineNumber;
    }
    return {
      selected,
      nextOffset,
      totalLines: reachedEof ? lineNumber : null,
      totalLinesExact: reachedEof,
    };
  } finally {
    closeSync(fd);
  }
}

async function callToolAsync(params, state, context) {
  const record = asRecord(params);
  const name = stringField(record, 'name');
  const args = asRecord(record.arguments);
  activeToolName = name;
  if (!name) throw diagnosticError('tools_call_requires_name', 'tools_call_requires_name');
  if (!listTools(state.mode).some((tool) => tool.name === name)) throw diagnosticError(`tool_not_available_in_${state.mode}_mode`, `tool_not_available_in_${state.mode}_mode: ${name}`, { tool_name: name, mode: state.mode });
  switch (name) {
    case 'fs_glob_search': return toolResult(await globSearchToolAsync(args, state, context));
    case 'fs_grep_search': return toolResult(await grepSearchToolAsync(args, state, context), { grepOutputMode: stringField(args, 'output_mode') ?? 'files_with_matches' });
    default: return callTool(params, state);
  }
}

function searchTimeoutMs(args) {
  const value = integerField(args, 'timeout_ms');
  if (value === null) return undefined;
  return Math.min(300_000, Math.max(1, value));
}

function searchCachePolicy(args) {
  const value = stringField(args, 'cache_policy') ?? 'auto';
  if (!['auto', 'snapshot', 'refresh', 'bypass'].includes(value)) throw diagnosticError('search_cache_policy_unsupported', `search_cache_policy_unsupported: ${value}`, { cache_policy: value });
  return value;
}

function searchFreshness(path) {
  const stat = statSync(path);
  const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  const directoryFingerprint = type === 'directory' ? directoryTreeFingerprint(path, path) : null;
  return {
    path,
    type,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    mtime_ms: Math.trunc(stat.mtimeMs),
    ...(type === 'file' ? { sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } : {}),
    ...(directoryFingerprint ? { entry_count: directoryFingerprint.entry_count, tree_entry_count: directoryFingerprint.tree_entry_count, tree_truncated: directoryFingerprint.tree_truncated, tree_sha256: directoryFingerprint.tree_sha256 } : {}),
  };
}

function directoryTreeFingerprint(path, root, { maxEntries = 5000 } = {}) {
  const entries = [];
  let treeTruncated = false;
  walkDirectoryFingerprint(path);
  return {
    entry_count: safeReaddir(path).length,
    tree_entry_count: entries.length,
    tree_truncated: treeTruncated,
    tree_sha256: createHash('sha256').update(entries.join('\n')).digest('hex'),
  };

  function walkDirectoryFingerprint(currentPath) {
    if (entries.length >= maxEntries) {
      treeTruncated = true;
      return;
    }
    const children = safeReaddir(currentPath).sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= maxEntries) {
        treeTruncated = true;
        return;
      }
      const childPath = resolve(currentPath, child.name);
      const stat = statSync(childPath);
      const relativePath = relative(root, childPath).replace(/\\/g, '/');
      const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      entries.push(`${relativePath}\t${type}\t${stat.size}\t${Math.trunc(stat.mtimeMs)}`);
      if (stat.isDirectory()) walkDirectoryFingerprint(childPath);
    }
  }
}

function safeReaddir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function renderGrepMatch(match, mode) {
  const parsed = buildGrepMatchObject(match, mode);
  if (mode === 'count_matches') return `${parsed.path}: ${parsed.count ?? 'unknown'}`;
  if (mode === 'content') return `${parsed.path}:${parsed.line ?? '?'}:${parsed.text ?? ''}`;
  return String(parsed.path ?? match);
}

function normalizeOutputShowArgs(args) {
  const record = { ...asRecord(args) };
  if (record.output_ref && !record.ref) record.ref = record.output_ref;
  if (record.limit !== undefined && record.output_limit === undefined) record.output_limit = record.limit;
  return record;
}

function resolvePatchSource(filePatch, state) {
  const patchPath = stripPatchPrefix(filePatch.oldPath === '/dev/null' ? filePatch.newPath : filePatch.oldPath);
  return resolveAllowedToolPath(patchPath, state.allowedRoots, { operation: 'fs_apply_patch', field: 'patch_source_path' });
}

function resolvePatchTarget(filePatch, state) {
  const patchPath = stripPatchPrefix(filePatch.newPath === '/dev/null' ? filePatch.oldPath : filePatch.newPath);
  return resolveAllowedToolPath(patchPath, state.allowedRoots, { operation: 'fs_apply_patch', field: 'patch_path' });
}

function resolveAllowedToolPath(inputPath, allowedRoots, context: Record<string, unknown> = {}) {
  try {
    return resolvePolicyAllowedPath(inputPath, allowedRoots);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const codeName = message.split(/[:\s]/)[0] || 'path_resolution_failed';
    if (codeName === 'path_required' || codeName === 'path_outside_allowed_roots' || codeName === 'allowed_root_not_found') {
      throw diagnosticError(codeName, message, {
        ...context,
        requested_path: inputPath ?? null,
        allowed_roots: allowedRoots,
      });
    }
    throw error;
  }
}

function stripPatchPrefix(path) {
  const cleaned = normalizePatchPath(String(path ?? '').trim());
  if (cleaned.startsWith('a/') || cleaned.startsWith('b/')) return cleaned.slice(2);
  return cleaned;
}

function normalizePatchPath(path) {
  if (/^[A-Za-z]:\//.test(path)) return path;
  if (/^[A-Za-z]:\\/.test(path)) return path.replace(/\\/g, '/');
  return path.replace(/\\/g, '/');
}

function rollbackPatch(backups) {
  for (const backup of backups) {
    if (backup.existed) {
      mkdirSync(dirname(backup.path), { recursive: true });
      writeFileSync(backup.path, backup.content, 'utf8');
    } else if (existsSync(backup.path)) {
      rmSync(backup.path, { recursive: true, force: true });
    }
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  const out = [];
  for (const path of paths) {
    const key = resolve(path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function appendAudit(state, operation, path, root, detail) {
  if (!state.auditLogDir) return;
  mkdirSync(state.auditLogDir, { recursive: true });
  appendFileSync(resolve(state.auditLogDir, 'filesystem-mcp-audit.jsonl'), `${JSON.stringify({
    schema: 'local.filesystem.audit.v1',
    at: new Date().toISOString(),
    operation,
    path,
    root,
    relative_path: relative(root, path).replace(/\\/g, '/'),
    detail,
  })}\n`, 'utf8');
}

function toolResult(value, renderContext: Record<string, unknown> = {}) {
  if (isToolResult(value)) {
    const structuredContent = value.structuredContent ?? parseToolResultStructuredContent(value);
    return {
      ...value,
      content: [assistantTextContent(renderFilesystemToolResultText(structuredContent, renderContext))],
      structuredContent,
    };
  }
  return {
    content: [assistantTextContent(renderFilesystemToolResultText(value, renderContext))],
    structuredContent: value,
  };
}

function assistantTextContent(text: string) {
  return { type: 'text', text, annotations: { audience: ['assistant'] } };
}

function isToolResult(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.content));
}

function parseToolResultStructuredContent(value) {
  const text = value.content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function samePath(left, right) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function uniqueSiblingPath(path, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `${path}.mcp-${label}-${process.pid}-${Date.now()}-${attempt}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw diagnosticError('temporary_path_unavailable', `temporary_path_unavailable: ${path}`, { path, label });
}

function isPathInside(path, root) {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function decorateTools(tools) {
  return tools.map((tool) => ({ ...tool, annotations: toolAnnotations(tool.name), outputSchema: genericToolOutputSchema() }));
}

function toolAnnotations(name) {
  const write = /^fs_(write|str_replace|replace|apply|move|create|rename|delete)/.test(String(name));
  return {
    title: String(name),
    readOnlyHint: !write,
    destructiveHint: /^fs_(str_replace|replace|apply|move|rename|delete)/.test(String(name)),
    idempotentHint: /^fs_(read|stat|glob|grep)|mcp_output_show/.test(String(name)),
    openWorldHint: false,
  };
}

function genericToolOutputSchema() {
  return { type: 'object', additionalProperties: true };
}

function expectedMetadataSchemaProperties() {
  return {
    mtime: { type: 'string' },
    size: { type: 'integer' },
    sha256: { type: 'string' },
    tree_sha256: { type: 'string' },
    entry_count: { type: 'integer' },
  };
}

function parseArgs(argv: string[]): Record<string, unknown> {
  const options: Record<string, unknown> & { allowedRoots: string[] } = { mode: 'read', allowedRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--mode') { options.mode = next; i += 1; }
    else if (arg === '--roots-from-trust-config' || arg === '--roots-from-codex-config') { options.rootsFromCodexConfig = next; i += 1; }
    else if (arg === '--allowed-root') { options.allowedRoots.push(next); i += 1; }
    else if (arg === '--roots-config') { options.rootsConfig = next; i += 1; }
    else if (arg === '--audit-log-dir') { options.auditLogDir = next; i += 1; }
    else if (arg === '--output-root') { options.outputRoot = next; i += 1; }
    else if (arg === '--help') {
      process.stdout.write('Usage: node dist/src/main.js --mode read|write --roots-from-trust-config <path> [--allowed-root <path>] [--roots-config <json>] [--audit-log-dir <path>]\n');
      process.exit(0);
    }
  }
  return options;
}

function drainJsonRpcFrames(buffer) {
  const requests = [];
  let remaining = buffer;
  while (true) {
    const crlfHeaderEnd = remaining.indexOf('\r\n\r\n');
    const lfHeaderEnd = remaining.indexOf('\n\n');
    const headerEnd = crlfHeaderEnd >= 0 ? crlfHeaderEnd : lfHeaderEnd;
    if (headerEnd < 0) break;
    const separatorLength = crlfHeaderEnd >= 0 ? 4 : 2;
    const header = remaining.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const length = Number(match[1]);
    const start = headerEnd + separatorLength;
    if (remaining.length < start + length) break;
    requests.push(JSON.parse(remaining.slice(start, start + length)));
    remaining = remaining.slice(start + length);
  }
  return { requests, remaining };
}

function writeJsonRpcResponse(response, { framed = false } = {}) {
  const body = JSON.stringify(response);
  if (!framed) {
    process.stdout.write(`${body}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function sendProgress(request, progress, message, options) {
  const progressToken = asRecord(asRecord(request.params)._meta).progressToken;
  if (progressToken === undefined) return;
  writeJsonRpcResponse({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken, progress, total: 1, message },
  }, options);
}

function clientSupportsRoots(initializeParams) {
  return Boolean(asRecord(asRecord(initializeParams).capabilities).roots);
}

function requestClientRoots(state, pendingServerRequests, nextId, options) {
  const id = nextId();
  pendingServerRequests.set(id, (message) => {
    updateClientRoots(state, asRecord(message.result));
  });
  writeJsonRpcResponse({ jsonrpc: '2.0', id, method: 'roots/list', params: {} }, options);
}

function updateClientRoots(state, result) {
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

function clientRootCompletionValues(state) {
  const rootsValue = asRecord(state.clientRoots).roots;
  const roots = Array.isArray(rootsValue) ? rootsValue : [];
  return roots.map((root) => {
    const uri = String(asRecord(root).uri ?? '');
    if (!uri) return '';
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

function splitLines(value) {
  return String(value ?? '').split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function splitFileLines(value) {
  const text = String(value ?? '');
  if (text.length === 0) return [];
  return text.replace(/\r?\n$/, '').split(/\r?\n/);
}

function assertExpectedSha256(args, before, { operation, path, root }) {
  const expected = stringField(args, 'expected_sha256');
  if (!expected) return;
  const actual = before === null ? null : sha256(before);
  if (actual !== expected) {
    throw diagnosticError(`${operation}_expected_sha256_mismatch`, `${operation}_expected_sha256_mismatch: ${path}`, {
      ...pathMetadata(path, root),
      expected_sha256: expected,
      actual_sha256: actual,
    });
  }
}

function expectedSha256Map(args) {
  const value = asRecord(args).expected_sha256;
  if (value === undefined || value === null) return new Map();
  const record = asRecord(value);
  if (record !== value) throw diagnosticError('expected_sha256_must_be_object', 'expected_sha256_must_be_object');
  const entries = Object.entries(record);
  for (const [key, entryValue] of entries) {
    if (typeof entryValue !== 'string' || entryValue.trim().length === 0) {
      throw diagnosticError('expected_sha256_value_must_be_string', `expected_sha256_value_must_be_string: ${key}`, { key });
    }
  }
  return new Map(entries);
}

function assertExpectedPatchSha256(expectedSha256, filePatch, source, target, before) {
  if (expectedSha256.size === 0) return;
  const keys = [
    relative(source.root, source.path).replace(/\\/g, '/'),
    relative(target.root, target.path).replace(/\\/g, '/'),
    stripPatchPrefix(filePatch.oldPath),
    stripPatchPrefix(filePatch.newPath),
    normalizePathKey(source.path),
    normalizePathKey(target.path),
  ].filter((key) => key && key !== '/dev/null');
  const matchedKey = keys.find((key) => expectedSha256.has(key));
  if (!matchedKey) return;
  const expected = expectedSha256.get(matchedKey);
  const actual = source.path && existsSync(source.path) ? sha256(before) : null;
  if (actual !== expected) {
    throw diagnosticError('fs_apply_patch_expected_sha256_mismatch', `fs_apply_patch_expected_sha256_mismatch: ${source.path}`, {
      ...pathMetadata(source.path, source.root),
      expected_sha256: expected,
      actual_sha256: actual,
      expected_sha256_key: matchedKey,
    });
  }
  return matchedKey;
}

function assertAllExpectedPatchSha256KeysMatched(expectedSha256, matchedKeys) {
  const unmatched = [...expectedSha256.keys()].filter((key) => !matchedKeys.has(key));
  if (unmatched.length === 0) return;
  throw diagnosticError('fs_apply_patch_expected_sha256_unmatched', 'fs_apply_patch_expected_sha256_unmatched', {
    unmatched_expected_sha256_keys: unmatched,
    matched_expected_sha256_keys: [...matchedKeys],
  });
}

function assertExpectedMetadata(args, target, { operation, objectKey = null, mtimeKey, sizeKey, shaKey = null, treeShaKey = null, entryCountKey = null }) {
  const expectedObject = objectKey ? asRecord(asRecord(args)[objectKey]) : {};
  const expectedMtime = stringField(expectedObject, 'mtime') ?? stringField(args, mtimeKey);
  const expectedSize = integerField(expectedObject, 'size') ?? integerField(args, sizeKey);
  const expectedSha = stringField(expectedObject, 'sha256') ?? (shaKey ? stringField(args, shaKey) : null);
  const expectedTreeSha = stringField(expectedObject, 'tree_sha256') ?? (treeShaKey ? stringField(args, treeShaKey) : null);
  const expectedEntryCount = integerField(expectedObject, 'entry_count') ?? (entryCountKey ? integerField(args, entryCountKey) : null);
  if (!expectedMtime && expectedSize === null && !expectedSha && !expectedTreeSha && expectedEntryCount === null) return;
  const stat = statSync(target.path);
  const actualMtime = stat.mtime.toISOString();
  const actualSize = stat.size;
  const directoryFingerprint = stat.isDirectory() ? directoryTreeFingerprint(target.path, target.path) : null;
  const details = {
    ...pathMetadata(target.path, target.root),
    operation,
    expected_mtime: expectedMtime,
    actual_mtime: actualMtime,
    expected_size: expectedSize,
    actual_size: actualSize,
    expected_tree_sha256: expectedTreeSha,
    actual_tree_sha256: directoryFingerprint?.tree_sha256 ?? null,
    expected_entry_count: expectedEntryCount,
    actual_entry_count: directoryFingerprint?.entry_count ?? null,
  };
  if (expectedMtime && actualMtime !== expectedMtime) {
    throw diagnosticError(`${operation}_expected_metadata_mismatch`, `${operation}_expected_metadata_mismatch: ${target.path}`, details);
  }
  if (expectedSize !== null && actualSize !== expectedSize) {
    throw diagnosticError(`${operation}_expected_metadata_mismatch`, `${operation}_expected_metadata_mismatch: ${target.path}`, details);
  }
  if (expectedSha) {
    if (!stat.isFile()) {
      throw diagnosticError(`${operation}_expected_sha256_not_supported`, `${operation}_expected_sha256_not_supported: ${target.path}`, { ...details, type: stat.isDirectory() ? 'directory' : 'other' });
    }
    const actualSha = createHash('sha256').update(readFileSync(target.path)).digest('hex');
    if (actualSha !== expectedSha) {
      throw diagnosticError(`${operation}_expected_metadata_mismatch`, `${operation}_expected_metadata_mismatch: ${target.path}`, { ...details, expected_sha256: expectedSha, actual_sha256: actualSha });
    }
  }
  if (expectedTreeSha && directoryFingerprint?.tree_sha256 !== expectedTreeSha) {
    throw diagnosticError(`${operation}_expected_metadata_mismatch`, `${operation}_expected_metadata_mismatch: ${target.path}`, details);
  }
  if (expectedEntryCount !== null && directoryFingerprint?.entry_count !== expectedEntryCount) {
    throw diagnosticError(`${operation}_expected_metadata_mismatch`, `${operation}_expected_metadata_mismatch: ${target.path}`, details);
  }
}

function normalizePathKey(path) {
  return String(path ?? '').replace(/\\/g, '/');
}

function patchOperation(filePatch, source, target) {
  if (filePatch.deleteFile) return 'delete';
  if (filePatch.oldPath === '/dev/null' || filePatch.kind === 'codex_add') return 'add';
  if (!samePath(source.path, target.path)) return 'move';
  return 'update';
}

function findTextOccurrences(text, needle) {
  const matches = [];
  let index = 0;
  while (matches.length < 100) {
    const found = text.indexOf(needle, index);
    if (found < 0) break;
    const before = text.slice(0, found);
    const line = before.split(/\r?\n/).length;
    const lineStart = Math.max(0, text.lastIndexOf('\n', found - 1) + 1);
    const lineEndRaw = text.indexOf('\n', found);
    const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
    matches.push({ line, column: found - lineStart + 1, line_text: text.slice(lineStart, lineEnd) });
    index = found + Math.max(needle.length, 1);
  }
  return matches;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function diagnosticError(codeName, message, details: unknown = {}) {
  return new McpToolError(codeName, message, normalizeDiagnosticDetails(details));
}

function normalizeDiagnosticDetails(details) {
  const record = asRecord(details);
  const normalized = { ...record };
  if (activeToolName && String(activeToolName).startsWith('fs_') && !normalized.operation) normalized.operation = activeToolName;
  return normalized;
}

function patchDiagnosticError(codeName, patch, details: unknown = {}) {
  const firstNonEmptyLine = splitLines(patch)[0] ?? '';
  const detectedFormat = firstNonEmptyLine === '*** Begin Patch'
    ? 'codex_apply_patch'
    : firstNonEmptyLine.startsWith('diff --git ')
      ? 'git_unified_diff'
      : firstNonEmptyLine.startsWith('--- ')
        ? 'unified_diff_incomplete'
        : 'unknown';
  return diagnosticError(codeName, `${codeName}: expected unified diff headers or Codex-style apply_patch markers`, {
    ...asRecord(details),
    detected_format: detectedFormat,
    first_non_empty_line: firstNonEmptyLine,
  });
}
function errorDiagnostic(error) {
  if (error instanceof McpToolError) {
    return {
      schema: 'local.filesystem.error.v1',
      code: error.codeName,
      message: error.message,
      details: error.details,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(/[:\s]/)[0] || 'tool_error';
  return {
    schema: 'local.filesystem.error.v1',
    code,
    message,
    details: {},
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function negateGlob(pattern: string): string {
  return pattern.startsWith('!') ? pattern : `!${pattern}`;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function stringField(record: unknown, key: string): string | null {
  const value = asRecord(record)[key];
  return typeof value === 'string' ? value : null;
}

function integerField(record: unknown, key: string): number | null {
  const value = asRecord(record)[key];
  return Number.isInteger(value) ? Number(value) : null;
}

function booleanField(record: unknown, key: string): boolean | null {
  const value = asRecord(record)[key];
  return typeof value === 'boolean' ? value : null;
}
