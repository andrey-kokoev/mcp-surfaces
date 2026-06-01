#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildOutputRefToolContent,
  listOutputTools,
  outputShow,
} from '@narada2/mcp-transport';
import { buildAllowedRoots, resolveAllowedPath } from './policy.mjs';

const PROTOCOL_VERSION = '2024-11-05';
let activeToolName = null;

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export async function runStdioServer(options) {
  const state = createServerState(options);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let requests = [];
    if (buffer.includes('Content-Length:')) {
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
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

export function createServerState(options) {
  const mode = options.mode;
  if (!['read', 'write'].includes(mode)) throw new Error('mode_must_be_read_or_write');
  const allowedRoots = buildAllowedRoots({
    codexConfigPath: options.rootsFromCodexConfig,
    explicitRoots: options.allowedRoots,
    rootsConfigPath: options.rootsConfig,
  });
  const outputRoot = resolve(options.outputRoot ?? process.cwd());
  return {
    mode,
    allowedRoots,
    outputRoot,
    auditLogDir: options.auditLogDir ? resolve(options.auditLogDir) : null,
  };
}

export function handleRequest(request, state) {
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = dispatchMethod(request.method, request.params ?? {}, state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: request?.id ?? null,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
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
  ];
  return mode === 'read' ? readTools : writeTools;
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
    case 'fs_grep_search': return toolResult(grepSearchTool(args, state));
    case 'mcp_output_show': return toolResult(outputShow({ siteRoot: state.outputRoot, args }));
    case 'fs_write_file': return toolResult(writeFileTool(args, state));
    case 'fs_str_replace_file': return toolResult(strReplaceTool(args, state));
    case 'fs_replace_range': return toolResult(replaceRangeTool(args, state));
    case 'fs_apply_patch': return toolResult(applyPatchTool(args, state));
    case 'fs_move_path': return toolResult(movePathTool(args, state));
    default: throw new Error(`unknown_tool: ${name}`);
  }
}

function readFileTool(args, state) {
  const { path, root } = resolveAllowedPath(stringField(args, 'path'), state.allowedRoots);
  const offset = Math.max(1, integerField(args, 'offset') ?? 1);
  const limit = Math.min(1000, Math.max(1, integerField(args, 'limit') ?? 400));
  return readFileRange({ path, root, offset, limit });
}

function readFileRangeTool(args, state) {
  const startLine = integerField(args, 'start_line');
  const endLine = integerField(args, 'end_line');
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error('start_line_must_be_positive_integer');
  if (!Number.isInteger(endLine) || endLine < startLine) throw new Error('end_line_must_be_greater_than_or_equal_start_line');
  const { path, root } = resolveAllowedPath(stringField(args, 'path'), state.allowedRoots);
  return readFileRange({ path, root, offset: startLine, limit: endLine - startLine + 1 });
}

function readFileRange({ path, root, offset, limit }) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  return {
    path,
    root,
    relative_path: relative(root, path).replace(/\\/g, '/'),
    total_lines: lines.length,
    offset,
    limit,
    returned_lines: selected.length,
    content: selected.join('\n'),
  };
}

function statTool(args, state) {
  const { path, root } = resolveAllowedPath(stringField(args, 'path'), state.allowedRoots);
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
  const { path: directory } = resolveAllowedPath(stringField(args, 'directory') ?? '.', state.allowedRoots);
  const limit = Math.min(500, Math.max(1, integerField(args, 'limit') ?? 100));
  const rg = spawnSync('rg', ['--files', '--hidden', '--no-ignore', '-g', pattern, directory], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  return cappedSearchResult({ state, kind: 'glob', args, lines: splitLines(rg.stdout), limit });
}

function grepSearchTool(args, state) {
  const pattern = stringField(args, 'pattern');
  if (!pattern) throw new Error('grep_requires_pattern');
  const { path } = resolveAllowedPath(stringField(args, 'path') ?? '.', state.allowedRoots);
  const mode = stringField(args, 'output_mode') ?? 'files_with_matches';
  const limit = Math.min(500, Math.max(1, integerField(args, 'limit') ?? 80));
  const modeArgs = mode === 'content' ? ['-n'] : mode === 'count_matches' ? ['-c'] : ['-l'];
  const rg = spawnSync('rg', [pattern, path, ...modeArgs, '--max-count', String(limit)], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  return cappedSearchResult({ state, kind: 'grep', args: { ...args, output_mode: mode }, lines: splitLines(rg.stdout), limit });
}

function cappedSearchResult({ state, kind, args, lines, limit }) {
  const value = {
    schema: `local.filesystem.${kind}.v1`,
    status: 'ok',
    count: lines.length,
    returned: Math.min(lines.length, limit),
    matches: lines.slice(0, limit),
  };
  if (JSON.stringify(value).length <= 6000) return value;
  return buildOutputRefToolContent({ siteRoot: state.outputRoot, toolName: activeToolName, value, isError: false });
}

function writeFileTool(args, state) {
  const { path, root } = resolveAllowedPath(stringField(args, 'path'), state.allowedRoots);
  const content = stringField(args, 'content') ?? '';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  appendAudit(state, 'fs_write_file', path, root, { size: content.length });
  return { status: 'written', path, size: content.length };
}

function strReplaceTool(args, state) {
  const { path, root } = resolveAllowedPath(stringField(args, 'path'), state.allowedRoots);
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
  return { status: 'replaced', path, occurrences: 1 };
}

function replaceRangeTool(args, state) {
  const startLine = integerField(args, 'start_line');
  const endLine = integerField(args, 'end_line');
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error('start_line_must_be_positive_integer');
  if (!Number.isInteger(endLine) || endLine < startLine) throw new Error('end_line_must_be_greater_than_or_equal_start_line');
  const { path, root } = resolveAllowedPath(stringField(args, 'path'), state.allowedRoots);
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
  return { status: 'replaced_range', path, start_line: startLine, end_line: endLine, inserted_lines: replacementLines.length };
}

function applyPatchTool(args, state) {
  const patch = stringField(args, 'patch');
  if (!patch) throw new Error('patch_required');
  const files = parseUnifiedPatch(patch);
  if (files.length === 0) throw new Error('patch_contains_no_files');
  const changed = [];
  for (const filePatch of files) {
    const target = resolvePatchTarget(filePatch, state);
    const before = existsSync(target.path) ? readFileSync(target.path, 'utf8') : '';
    const after = applyFilePatch(before, filePatch);
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileSync(target.path, after, 'utf8');
    appendAudit(state, 'fs_apply_patch', target.path, target.root, { patch_sha256: sha256(patch), before_sha256: sha256(before), after_sha256: sha256(after), hunks: filePatch.hunks.length });
    changed.push({ path: target.path, hunks: filePatch.hunks.length, before_sha256: sha256(before), after_sha256: sha256(after) });
  }
  return { status: 'patched', changed_files: changed };
}

function movePathTool(args, state) {
  const from = resolveAllowedPath(stringField(args, 'from'), state.allowedRoots);
  const to = resolveAllowedPath(stringField(args, 'to'), state.allowedRoots);
  const overwrite = booleanField(args, 'overwrite') ?? false;
  if (!existsSync(from.path)) throw new Error(`move_source_not_found: ${from.path}`);
  if (existsSync(to.path)) {
    if (!overwrite) throw new Error(`move_destination_exists: ${to.path}`);
    rmSync(to.path, { recursive: true, force: true });
  }
  mkdirSync(dirname(to.path), { recursive: true });
  renameSync(from.path, to.path);
  appendAudit(state, 'fs_move_path', to.path, to.root, {
    from: from.path,
    from_root: from.root,
    to: to.path,
    to_root: to.root,
    overwrite,
  });
  return { status: 'moved', from: from.path, to: to.path, overwrite };
}

function parseUnifiedPatch(patch) {
  const lines = patch.split(/\r?\n/);
  const files = [];
  let current = null;
  let currentHunk = null;
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      current = { oldPath: line.slice(4).trim(), newPath: null, hunks: [] };
      files.push(current);
      currentHunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!current) throw new Error('patch_new_file_without_old_file_header');
      current.newPath = line.slice(4).trim();
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (!current?.newPath) throw new Error('patch_hunk_without_file_header');
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
  return resolveAllowedPath(patchPath, state.allowedRoots);
}

function stripPatchPrefix(path) {
  const cleaned = String(path ?? '').trim();
  if (cleaned.startsWith('a/') || cleaned.startsWith('b/')) return cleaned.slice(2);
  return cleaned;
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
        if (source[sourceIndex] !== text) throw new Error(`patch_context_mismatch: expected ${JSON.stringify(text)} got ${JSON.stringify(source[sourceIndex])}`);
        output.push(source[sourceIndex++]);
      } else if (kind === '-') {
        if (source[sourceIndex] !== text) throw new Error(`patch_remove_mismatch: expected ${JSON.stringify(text)} got ${JSON.stringify(source[sourceIndex])}`);
        sourceIndex += 1;
      } else if (kind === '+') {
        output.push(text);
      } else {
        throw new Error(`patch_line_kind_unsupported: ${kind}`);
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

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function parseArgs(argv) {
  const options = { mode: 'read', allowedRoots: [] };
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
      process.stdout.write('Usage: node main.mjs --mode read|write --roots-from-trust-config <path> [--allowed-root <path>] [--roots-config <json>] [--audit-log-dir <path>]\n');
      process.exit(0);
    }
  }
  return options;
}

function drainJsonRpcFrames(buffer) {
  const requests = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = remaining.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (remaining.length < start + length) break;
    requests.push(JSON.parse(remaining.slice(start, start + length)));
    remaining = remaining.slice(start + length);
  }
  return { requests, remaining };
}

function splitLines(value) {
  return String(value ?? '').split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringField(record, key) {
  const value = asRecord(record)[key];
  return typeof value === 'string' ? value : null;
}

function integerField(record, key) {
  const value = asRecord(record)[key];
  return Number.isInteger(value) ? value : null;
}

function booleanField(record, key) {
  const value = asRecord(record)[key];
  return typeof value === 'boolean' ? value : null;
}
