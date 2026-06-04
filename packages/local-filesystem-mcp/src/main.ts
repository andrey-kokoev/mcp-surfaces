#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  buildOutputRefToolContent,
  listOutputTools,
  outputShow,
} from '@narada2/mcp-transport';
import { buildAllowedRoots, resolveAllowedPath as resolvePolicyAllowedPath } from './policy.js';
import { applyDeletePatch as applyParsedDeletePatch, applyFilePatch as applyParsedFilePatch, parsePatch as parseToolPatch } from './patch-apply.js';
import { renderToolResultText as renderFilesystemToolResultText } from './result-rendering.js';
import { RIPGREP_FIELD_SEPARATOR, grepMatchObject as buildGrepMatchObject, runRipgrepPage } from './search.js';

const PROTOCOL_VERSION = '2024-11-05';
const INLINE_RESULT_CHAR_LIMIT = 6000;
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
      const response = handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
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
        capabilities: { tools: {} },
        serverInfo: { name: `local-filesystem-${state.mode}`, version: '0.1.0' },
      };
    case 'tools/list':
      return { tools: listTools(state.mode) };
    case 'tools/call':
      return callTool(params, state);
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method: ${method}`, { method });
  }
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
        expected_sha256: { type: 'string', description: 'Optional expected current file sha256 before overwriting.' },
      }, ['path', 'content']),
    },
    {
      name: 'fs_str_replace_file',
      description: 'Replace exactly one string occurrence in a text file under an allowed root and append an audit record.',
      inputSchema: objectSchema({ path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, ['path', 'old', 'new']),
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
      inputSchema: objectSchema({ patch: { type: 'string' } }, ['patch']),
    },
    {
      name: 'fs_move_path',
      description: 'Move or rename a file or directory under allowed roots and append an audit record. Refuses overwrite unless overwrite is true.',
      inputSchema: objectSchema({
        from: { type: 'string' },
        to: { type: 'string' },
        overwrite: { type: 'boolean', default: false },
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
      }, ['from', 'to']),
    },
    {
      name: 'fs_delete_directory',
      description: 'Delete a directory under an allowed root and append an audit record. Non-empty deletion requires recursive true.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        recursive: { type: 'boolean', default: false },
      }, ['path']),
    },
  ];
  return mode === 'read' ? readTools : [...readTools, ...writeTools];
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
    case 'mcp_output_show': return toolResult(outputShow({ siteRoot: state.outputRoot, args }));
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
  const buffer = readFileSync(path);
  if (buffer.includes(0)) throw diagnosticError('binary_file_not_supported', `binary_file_not_supported: ${path}`, pathMetadata(path, root));
  const text = buffer.toString('utf8');
  const lines = splitFileLines(text);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const nextOffset = offset + selected.length <= lines.length ? offset + selected.length : null;
  return {
    path,
    root,
    relative_path: relative(root, path).replace(/\\/g, '/'),
    total_lines: lines.length,
    offset,
    limit,
    returned_lines: selected.length,
    next_offset: nextOffset,
    content: selected.join('\n'),
  };
}

function statTool(args, state) {
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_stat' });
  const stat = statSync(path);
  return {
    schema: 'local.filesystem.stat.v1',
    path,
    root,
    relative_path: relative(root, path).replace(/\\/g, '/'),
    type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

function globSearchTool(args, state) {
  const pattern = stringField(args, 'pattern');
  if (!pattern) throw diagnosticError('glob_requires_pattern', 'glob_requires_pattern');
  const { path: directory } = resolveAllowedToolPath(stringField(args, 'directory') ?? '.', state.allowedRoots, { operation: 'fs_glob_search' });
  const offset = Math.max(0, integerField(args, 'offset') ?? 0);
  const limit = Math.min(500, Math.max(1, integerField(args, 'limit') ?? 100));
  const ignorePatterns = [...DEFAULT_GLOB_IGNORE_PATTERNS, ...stringList(args.ignore)];
  const rgArgs = ['--files', '--hidden', '--no-ignore', '-g', pattern, ...ignorePatterns.flatMap((ignore) => ['-g', negateGlob(ignore)]), directory];
  return cappedSearchResult({ state, kind: 'glob', args, page: runRipgrepPage(rgArgs, { operation: 'fs_glob_search', noMatchStatus: 0, offset, limit, diagnosticError }), offset, limit });
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
  const modeArgs = mode === 'content' ? ['-n'] : mode === 'count_matches' ? ['-c'] : ['-l'];
  return cappedSearchResult({ state, kind: 'grep', args: { ...args, output_mode: mode }, page: runRipgrepPage(['--field-match-separator', RIPGREP_FIELD_SEPARATOR, '--with-filename', pattern, path, ...modeArgs], { operation: 'fs_grep_search', noMatchStatus: 1, offset, limit, diagnosticError }), offset, limit });
}

function cappedSearchResult({ state, kind, args, page, offset, limit }) {
  const matches = page.matches;
  const nextOffset = page.has_more ? offset + matches.length : null;
  const value = {
    schema: `local.filesystem.${kind}.v1`,
    status: 'ok',
    ...(kind === 'grep' ? { output_mode: stringField(args, 'output_mode') ?? 'files_with_matches' } : {}),
    offset,
    limit,
    count: page.count,
    count_exact: page.count_exact,
    scanned: page.scanned,
    returned: matches.length,
    has_more: page.has_more,
    next_offset: nextOffset,
    matches,
    ...(kind === 'grep' ? { match_objects: matches.map((match) => buildGrepMatchObject(match, stringField(args, 'output_mode') ?? 'files_with_matches')) } : {}),
  };
  return cappedToolValue({ state, value, summary: { count: value.count, count_exact: value.count_exact, scanned: value.scanned, returned: value.returned, has_more: value.has_more, next_offset: value.next_offset } });
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
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
  };
}

function writeFileTool(args, state) {
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_write_file' });
  const content = stringField(args, 'content') ?? '';
  const overwrite = booleanField(args, 'overwrite') ?? true;
  const createOnly = booleanField(args, 'create_only') ?? false;
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (before !== null && createOnly) throw diagnosticError('write_file_destination_exists', `write_file_destination_exists: ${path}`, pathMetadata(path, root));
  if (before !== null && !overwrite) throw diagnosticError('write_file_overwrite_refused', `write_file_overwrite_refused: ${path}`, pathMetadata(path, root));
  assertExpectedSha256(args, before, { operation: 'fs_write_file', path, root });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  appendAudit(state, 'fs_write_file', path, root, { size: content.length, before_sha256: before === null ? null : sha256(before), after_sha256: sha256(content) });
  return { schema: 'local.filesystem.write_file.v1', status: 'written', ...pathMetadata(path, root), size: content.length, before_sha256: before === null ? null : sha256(before), after_sha256: sha256(content) };
}

function strReplaceTool(args, state) {
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_str_replace_file' });
  const oldText = stringField(args, 'old') ?? '';
  const newText = stringField(args, 'new') ?? '';
  if (!oldText) throw diagnosticError('str_replace_requires_old', 'str_replace_requires_old', pathMetadata(path, root));
  const before = readFileSync(path, 'utf8');
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
    const patchContext = { diagnosticError };
    const after = filePatch.deleteFile ? applyParsedDeletePatch(before, filePatch, patchContext) : applyParsedFilePatch(before, filePatch, patchContext);
    return { filePatch, source, target, before, after };
  });
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
      changed.push({ ...pathMetadata(item.target.path, item.target.root), hunks: item.filePatch.hunks.length, deleted: item.filePatch.deleteFile === true, before_sha256: sha256(item.before), after_sha256: afterSha256 });
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
  return movePath({ state, operation: 'fs_move_path', from, to, overwrite, directoryOnly: false });
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
  return movePath({ state, operation: 'fs_rename_directory', from, to, overwrite: false, directoryOnly: true });
}

function deleteDirectoryTool(args, state) {
  const target = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_delete_directory' });
  const recursive = booleanField(args, 'recursive') ?? false;
  if (!existsSync(target.path)) throw diagnosticError('delete_directory_not_found', `delete_directory_not_found: ${target.path}`, pathMetadata(target.path, target.root));
  const targetStat = statSync(target.path);
  if (!targetStat.isDirectory()) throw diagnosticError('delete_directory_target_not_directory', `delete_directory_target_not_directory: ${target.path}`, pathMetadata(target.path, target.root));
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

function movePath({ state, operation, from, to, overwrite, directoryOnly }) {
  if (samePath(from.path, to.path)) throw diagnosticError('move_source_and_destination_same', `move_source_and_destination_same: ${from.path}`, { operation, from: pathMetadata(from.path, from.root), to: pathMetadata(to.path, to.root) });
  if (!existsSync(from.path)) throw diagnosticError('move_source_not_found', `move_source_not_found: ${from.path}`, { operation, ...pathMetadata(from.path, from.root) });
  const fromStat = statSync(from.path);
  if (directoryOnly && !fromStat.isDirectory()) throw diagnosticError('rename_directory_source_not_directory', `rename_directory_source_not_directory: ${from.path}`, pathMetadata(from.path, from.root));
  if (fromStat.isDirectory() && isPathInside(to.path, from.path)) throw diagnosticError('move_destination_inside_source', `move_destination_inside_source: ${to.path}`, { operation, from: pathMetadata(from.path, from.root), to: pathMetadata(to.path, to.root) });
  if (existsSync(to.path)) {
    if (!overwrite) throw diagnosticError('move_destination_exists', `move_destination_exists: ${to.path}`, { operation, ...pathMetadata(to.path, to.root) });
    const toStat = statSync(to.path);
    if (fromStat.isDirectory() !== toStat.isDirectory()) throw diagnosticError('move_destination_type_mismatch', `move_destination_type_mismatch: ${to.path}`, { operation, ...pathMetadata(to.path, to.root) });
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
      content: [{ type: 'text', text: renderFilesystemToolResultText(structuredContent, renderContext) }],
      structuredContent,
    };
  }
  return {
    content: [{ type: 'text', text: renderFilesystemToolResultText(value, renderContext) }],
    structuredContent: value,
  };
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
  return new McpToolError(codeName, message, details);
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
