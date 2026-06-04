#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildOutputRefToolContent,
  listOutputTools,
  outputShow,
} from '@narada2/mcp-transport';
import { buildAllowedRoots, resolveAllowedPath as resolvePolicyAllowedPath } from './policy.js';

const PROTOCOL_VERSION = '2024-11-05';
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
  if (!['read', 'write'].includes(mode ?? '')) throw new Error('mode_must_be_read_or_write');
  const allowedRoots = buildAllowedRoots({
    codexConfigPath: stringOrNull(options.rootsFromCodexConfig),
    explicitRoots: stringList(options.allowedRoots),
    rootsConfigPath: stringOrNull(options.rootsConfig),
  });
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
      throw new Error(`unsupported_mcp_method: ${method}`);
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
      inputSchema: objectSchema({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
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
      }, ['path', 'start_line', 'end_line', 'replacement']),
    },
    {
      name: 'fs_apply_patch',
      description: 'Apply a unified diff patch to files under allowed roots and append an audit record.',
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
  if (!name) throw new Error('tools_call_requires_name');
  if (!listTools(state.mode).some((tool) => tool.name === name)) throw new Error(`tool_not_available_in_${state.mode}_mode: ${name}`);
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
    default: throw new Error(`unknown_tool: ${name}`);
  }
}

function readFileTool(args, state) {
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_read_file' });
  const offset = Math.max(1, integerField(args, 'offset') ?? 1);
  const limit = Math.min(1000, Math.max(1, integerField(args, 'limit') ?? 400));
  return readFileRange({ path, root, offset, limit });
}

function readFileRangeTool(args, state) {
  const startLine = integerField(args, 'start_line');
  const endLine = integerField(args, 'end_line');
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error('start_line_must_be_positive_integer');
  if (!Number.isInteger(endLine) || endLine < startLine) throw new Error('end_line_must_be_greater_than_or_equal_start_line');
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_read_file_range' });
  return readFileRange({ path, root, offset: startLine, limit: endLine - startLine + 1 });
}

function readFileRange({ path, root, offset, limit }) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
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
  if (!pattern) throw new Error('glob_requires_pattern');
  const { path: directory } = resolveAllowedToolPath(stringField(args, 'directory') ?? '.', state.allowedRoots, { operation: 'fs_glob_search' });
  const offset = Math.max(0, integerField(args, 'offset') ?? 0);
  const limit = Math.min(500, Math.max(1, integerField(args, 'limit') ?? 100));
  const ignorePatterns = [...DEFAULT_GLOB_IGNORE_PATTERNS, ...stringList(args.ignore)];
  const rgArgs = ['--files', '--hidden', '--no-ignore', '-g', pattern, ...ignorePatterns.flatMap((ignore) => ['-g', negateGlob(ignore)]), directory];
  const rg = spawnSync('rg', rgArgs, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  return cappedSearchResult({ state, kind: 'glob', args, lines: splitLines(rg.stdout), offset, limit });
}

function grepSearchTool(args, state) {
  const pattern = stringField(args, 'pattern');
  if (!pattern) throw new Error('grep_requires_pattern');
  const { path } = resolveAllowedToolPath(stringField(args, 'path') ?? '.', state.allowedRoots, { operation: 'fs_grep_search' });
  const mode = stringField(args, 'output_mode') ?? 'files_with_matches';
  if (!['files_with_matches', 'count_matches', 'content'].includes(mode)) throw new Error(`grep_output_mode_unsupported: ${mode}`);
  const offset = Math.max(0, integerField(args, 'offset') ?? 0);
  const limit = Math.min(500, Math.max(1, integerField(args, 'limit') ?? 80));
  const modeArgs = mode === 'content' ? ['-n'] : mode === 'count_matches' ? ['-c'] : ['-l'];
  const rg = spawnSync('rg', [pattern, path, ...modeArgs, '--max-count', String(limit + offset)], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  return cappedSearchResult({ state, kind: 'grep', args: { ...args, output_mode: mode }, lines: splitLines(rg.stdout), offset, limit });
}

function cappedSearchResult({ state, kind, args, lines, offset, limit }) {
  const matches = lines.slice(offset, offset + limit);
  const nextOffset = offset + matches.length < lines.length ? offset + matches.length : null;
  const value = {
    schema: `local.filesystem.${kind}.v1`,
    status: 'ok',
    offset,
    limit,
    count: lines.length,
    returned: matches.length,
    truncated: nextOffset !== null,
    next_offset: nextOffset,
    matches,
  };
  if (JSON.stringify(value).length <= 6000) return value;
  return buildOutputRefToolContent({ siteRoot: state.outputRoot, toolName: activeToolName, value, isError: false });
}

function writeFileTool(args, state) {
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_write_file' });
  const content = stringField(args, 'content') ?? '';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  appendAudit(state, 'fs_write_file', path, root, { size: content.length });
  return { schema: 'local.filesystem.write_file.v1', status: 'written', ...pathMetadata(path, root), size: content.length };
}

function strReplaceTool(args, state) {
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_str_replace_file' });
  const oldText = stringField(args, 'old') ?? '';
  const newText = stringField(args, 'new') ?? '';
  if (!oldText) throw new Error('str_replace_requires_old');
  const before = readFileSync(path, 'utf8');
  const count = before.split(oldText).length - 1;
  if (count === 0) throw new Error('str_replace_not_found');
  if (count > 1) throw new Error(`str_replace_ambiguous: ${count}`);
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
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error('start_line_must_be_positive_integer');
  if (!Number.isInteger(endLine) || endLine < startLine) throw new Error('end_line_must_be_greater_than_or_equal_start_line');
  const { path, root } = resolveAllowedToolPath(stringField(args, 'path'), state.allowedRoots, { operation: 'fs_replace_range' });
  const replacement = stringField(args, 'replacement') ?? '';
  const before = readFileSync(path, 'utf8');
  const hasTrailingNewline = /\r?\n$/.test(before);
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.replace(/\r?\n$/, '').split(/\r?\n/);
  if (startLine > lines.length + 1) throw new Error(`start_line_out_of_range: ${startLine}`);
  if (endLine > lines.length) throw new Error(`end_line_out_of_range: ${endLine}`);
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
  const files = parseUnifiedPatch(patch);
  if (files.length === 0) {
    throw patchDiagnosticError('patch_contains_no_files', patch, {
      expected_format: 'unified_diff',
      expected_headers: ['--- <path>', '+++ <path>', '@@ -old,+new @@'],
    });
  }
  const planned = files.map((filePatch) => {
    const target = resolvePatchTarget(filePatch, state);
    const before = existsSync(target.path) ? readFileSync(target.path, 'utf8') : '';
    const after = applyFilePatch(before, filePatch);
    return { filePatch, target, before, after };
  });
  const changed = [];
  for (const item of planned) {
    mkdirSync(dirname(item.target.path), { recursive: true });
    writeFileSync(item.target.path, item.after, 'utf8');
    appendAudit(state, 'fs_apply_patch', item.target.path, item.target.root, { patch_sha256: sha256(patch), before_sha256: sha256(item.before), after_sha256: sha256(item.after), hunks: item.filePatch.hunks.length });
    changed.push({ ...pathMetadata(item.target.path, item.target.root), hunks: item.filePatch.hunks.length, before_sha256: sha256(item.before), after_sha256: sha256(item.after) });
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
    if (!statSync(target.path).isDirectory()) throw new Error(`create_directory_destination_not_directory: ${target.path}`);
    throw new Error(`create_directory_destination_exists: ${target.path}`);
  }
  mkdirSync(target.path, { recursive });
  appendAudit(state, 'fs_create_directory', target.path, target.root, { recursive });
  return {
    schema: 'local.filesystem.create_directory.v1',
    status: 'created',
    ...pathMetadata(target.path, target.root),
    recursive,
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
  if (!existsSync(target.path)) throw new Error(`delete_directory_not_found: ${target.path}`);
  const targetStat = statSync(target.path);
  if (!targetStat.isDirectory()) throw new Error(`delete_directory_target_not_directory: ${target.path}`);
  const entryCount = readdirSync(target.path).length;
  if (entryCount > 0 && !recursive) throw new Error(`delete_directory_not_empty: ${target.path}`);
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
  if (samePath(from.path, to.path)) throw new Error(`move_source_and_destination_same: ${from.path}`);
  if (!existsSync(from.path)) throw new Error(`move_source_not_found: ${from.path}`);
  const fromStat = statSync(from.path);
  if (directoryOnly && !fromStat.isDirectory()) throw new Error(`rename_directory_source_not_directory: ${from.path}`);
  if (fromStat.isDirectory() && isPathInside(to.path, from.path)) throw new Error(`move_destination_inside_source: ${to.path}`);
  if (existsSync(to.path)) {
    if (!overwrite) throw new Error(`move_destination_exists: ${to.path}`);
    const toStat = statSync(to.path);
    if (fromStat.isDirectory() !== toStat.isDirectory()) throw new Error(`move_destination_type_mismatch: ${to.path}`);
    rmSync(to.path, { recursive: true, force: true });
  }
  mkdirSync(dirname(to.path), { recursive: true });
  renameSync(from.path, to.path);
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

function parseUnifiedPatch(patch) {
  const lines = patch.split(/\r?\n/);
  const files = [];
  let current = null;
  let currentHunk = null;
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      current = { oldPath: parsePatchHeaderPath(line.slice(4)), newPath: null, hunks: [] };
      files.push(current);
      currentHunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!current) throw diagnosticError('patch_new_file_without_old_file_header', 'Patch has a new-file header before an old-file header.');
      current.newPath = parsePatchHeaderPath(line.slice(4));
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (!current?.newPath) throw diagnosticError('patch_hunk_without_file_header', 'Patch hunk appears before complete file headers.');
      currentHunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] ?? '1'),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] ?? '1'),
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk && (/^[ +\-]/.test(line) || line === '\\ No newline at end of file')) {
      if (line !== '\\ No newline at end of file') currentHunk.lines.push(line);
    }
  }
  return files.filter((file) => file.newPath && file.hunks.length > 0);
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

function parsePatchHeaderPath(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed === '/dev/null') return trimmed;
  const quoted = trimmed.match(/^"((?:\\.|[^"])*)"/);
  if (quoted) return quoted[1].replace(/\\"/g, '"');
  const tabIndex = trimmed.indexOf('\t');
  if (tabIndex >= 0) return trimmed.slice(0, tabIndex);
  return trimmed.split(/\s+/)[0] ?? '';
}

function normalizePatchPath(path) {
  if (/^[A-Za-z]:\//.test(path)) return path;
  if (/^[A-Za-z]:\\/.test(path)) return path.replace(/\\/g, '/');
  return path.replace(/\\/g, '/');
}

function applyFilePatch(before, filePatch) {
  const hadTrailingNewline = /\r?\n$/.test(before);
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const source = before.length === 0 ? [] : before.replace(/\r?\n$/, '').split(/\r?\n/);
  const output = [];
  let sourceIndex = 0;
  for (const hunk of filePatch.hunks) {
    const hunkStart = hunk.oldStart - 1;
    while (sourceIndex < hunkStart) output.push(source[sourceIndex++]);
    for (const line of hunk.lines) {
      const kind = line[0];
      const text = line.slice(1);
      if (kind === ' ') {
        if (source[sourceIndex] !== text) throw diagnosticError('patch_context_mismatch', `patch_context_mismatch: expected ${JSON.stringify(text)} got ${JSON.stringify(source[sourceIndex])}`, { expected: text, actual: source[sourceIndex] ?? null });
        output.push(source[sourceIndex++]);
      } else if (kind === '-') {
        if (source[sourceIndex] !== text) throw diagnosticError('patch_remove_mismatch', `patch_remove_mismatch: expected ${JSON.stringify(text)} got ${JSON.stringify(source[sourceIndex])}`, { expected: text, actual: source[sourceIndex] ?? null });
        sourceIndex += 1;
      } else if (kind === '+') {
        output.push(text);
      } else {
        throw diagnosticError('patch_line_kind_unsupported', `patch_line_kind_unsupported: ${kind}`, { kind });
      }
    }
  }
  while (sourceIndex < source.length) output.push(source[sourceIndex++]);
  return `${output.join(newline)}${hadTrailingNewline ? newline : ''}`;
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
      content: [{ type: 'text', text: renderToolResultText(structuredContent, renderContext) }],
      structuredContent,
    };
  }
  return {
    content: [{ type: 'text', text: renderToolResultText(value, renderContext) }],
    structuredContent: value,
  };
}

function renderToolResultText(value, renderContext: Record<string, unknown> = {}) {
  const record = asRecord(value);
  if (record.schema === 'narada.mcp_output_show.v1') return String(record.output_text ?? '');
  if (record.schema === 'narada.mcp_output_locator.v1' || typeof record.output_ref === 'string') {
    return compactLines([
      `status: ${record.status ?? 'ok'}`,
      'result: materialized',
      `output_ref: ${record.output_ref ?? record.ref ?? ''}`,
      `reader_tool: ${record.reader_tool ?? 'mcp_output_show'}`,
      `truncated: ${record.truncated ?? record.original_truncated ?? true}`,
      record.full_output_char_length !== undefined ? `full_output_char_length: ${record.full_output_char_length}` : null,
    ]);
  }
  if (isReadFileResult(record)) return renderReadFileResult(record);
  if (record.schema === 'local.filesystem.glob.v1') return renderSearchResult('fs_glob_search', record);
  if (record.schema === 'local.filesystem.grep.v1') return renderSearchResult('fs_grep_search', record, renderContext);
  if (record.schema === 'local.filesystem.apply_patch.v1') {
    const changedFiles = Array.isArray(record.changed_files) ? record.changed_files : [];
    return compactLines([
      `fs_apply_patch: ${record.status ?? 'ok'}`,
      `changed_files: ${changedFiles.length}`,
      ...changedFiles.map((file) => `- ${asRecord(file).relative_path ?? asRecord(file).path ?? ''}`),
    ]);
  }
  if (record.schema || record.status || record.path || record.relative_path || record.type) return renderCompactRecord(record);
  return JSON.stringify(value, null, 2);
}

function isReadFileResult(record) {
  return typeof record.path === 'string'
    && typeof record.content === 'string'
    && typeof record.offset === 'number'
    && typeof record.returned_lines === 'number'
    && typeof record.total_lines === 'number';
}

function renderReadFileResult(record) {
  const startLine = Number(record.offset);
  const returnedLines = Number(record.returned_lines);
  const endLine = returnedLines > 0 ? startLine + returnedLines - 1 : startLine - 1;
  return [
    `path: ${record.path}`,
    `lines: ${startLine}-${endLine} of ${record.total_lines}`,
    `returned_lines: ${record.returned_lines}`,
    `next_offset: ${record.next_offset ?? 'null'}`,
    'content:',
    String(record.content ?? ''),
  ].join('\n');
}

function renderSearchResult(toolName, record, renderContext: Record<string, unknown> = {}) {
  const matches = Array.isArray(record.matches) ? record.matches.map(String) : [];
  const mode = toolName === 'fs_grep_search' ? [`mode: ${renderContext.grepOutputMode ?? 'files_with_matches'}`] : [];
  return [
    `${toolName}: ${record.status ?? 'ok'}`,
    ...mode,
    `count: ${record.count ?? matches.length}`,
    `returned: ${record.returned ?? matches.length}`,
    `truncated: ${record.truncated ?? false}`,
    `next_offset: ${record.next_offset ?? 'null'}`,
    'matches:',
    ...matches,
  ].join('\n');
}

function renderCompactRecord(record) {
  if (record.schema === 'local.filesystem.stat.v1' || record.type) {
    return compactLines([
      'fs_stat: ok',
      `path: ${record.path ?? ''}`,
      record.relative_path !== undefined ? `relative_path: ${record.relative_path}` : null,
      record.type !== undefined ? `type: ${record.type}` : null,
      record.size !== undefined ? `size: ${record.size}` : null,
      record.mtime !== undefined ? `mtime: ${record.mtime}` : null,
    ]);
  }
  const lines = [
    `${filesystemToolLabel(record)}: ${record.status ?? 'ok'}`,
    record.path !== undefined ? `path: ${record.path}` : null,
    record.relative_path !== undefined ? `relative_path: ${record.relative_path}` : null,
    record.size !== undefined ? `size: ${record.size}` : null,
    record.occurrences !== undefined ? `occurrences: ${record.occurrences}` : null,
    record.start_line !== undefined ? `start_line: ${record.start_line}` : null,
    record.end_line !== undefined ? `end_line: ${record.end_line}` : null,
    record.inserted_lines !== undefined ? `inserted_lines: ${record.inserted_lines}` : null,
    record.recursive !== undefined ? `recursive: ${record.recursive}` : null,
    record.overwrite !== undefined ? `overwrite: ${record.overwrite}` : null,
  ];
  const from = asRecord(record.from);
  const to = asRecord(record.to);
  if (from.path || from.relative_path) lines.push(`from: ${from.relative_path ?? from.path}`);
  if (to.path || to.relative_path) lines.push(`to: ${to.relative_path ?? to.path}`);
  return compactLines(lines);
}

function filesystemToolLabel(record) {
  const schema = typeof record.schema === 'string' ? record.schema : '';
  const match = schema.match(/^local\.filesystem\.(.+)\.v1$/);
  return match ? `fs_${match[1]}` : 'fs_result';
}

function compactLines(lines) {
  return lines.filter((line) => typeof line === 'string' && line.length > 0).join('\n');
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
  return diagnosticError(codeName, `${codeName}: expected unified diff with ---/+++ file headers and @@ hunks`, {
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
