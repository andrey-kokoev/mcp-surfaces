#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildAllowedRoots,
  createExecutionPolicy,
  decideStructuredCommandExecution,
  publicExecutionPolicy,
} from './policy.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const TOOL_RESULT_CHAR_LIMIT = 200;
const TOOL_INPUT_CHAR_LIMIT = 200;
const REF_PATTERN = /^structured_command_(input|output):([A-Za-z0-9_-]{8,80})$/;

if (isMainModule()) {
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
      const response = await handleRequest(request, state);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

export function createServerState(options = {}) {
  const allowedRoots = buildAllowedRoots({
    trustConfigPaths: optionList(options.rootsFromTrustConfig),
    explicitRoots: [...optionList(options.allowedRoot), ...optionList(options.allowedRoots)],
  });
  if (allowedRoots.length === 0) throw new Error('structured_command_requires_allowed_root');
  return {
    policy: createExecutionPolicy({
      allowedRoots,
      allowedCommands: optionList(options.allowCommand ?? options.allowedCommands),
      allowedPrefixes: optionList(options.allowPrefix ?? options.allowedPrefixes),
      blockedCommands: optionList(options.blockCommand ?? options.blockedCommands),
      maxTimeoutMs: options.maxTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    }),
    auditLogDir: options.auditLogDir ? resolve(options.auditLogDir) : null,
    storageRoot: resolve(options.storageRoot ?? join(allowedRoots[0], '.structured-command-mcp')),
  };
}

export async function handleRequest(request, state) {
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(request.method, request.params ?? {}, state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: request?.id ?? null,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function dispatchMethod(method, params, state) {
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'structured-command-mcp', version: '0.1.0' },
    };
  }
  if (method === 'tools/list') return { tools: listTools() };
  if (method === 'tools/call') return callTool(params, state);
  throw new Error(`unsupported_mcp_method:${method}`);
}

export function listTools() {
  return [
    {
      name: 'structured_command_execution_policy_inspect',
      description: 'Inspect the policy governing structured command execution.',
      inputSchema: objectSchema({}),
    },
    {
      name: 'structured_command_execute',
      description: 'Execute a structured argv command under allowed-root and command policy.',
      inputSchema: objectSchema({
        input_ref: { type: 'string', description: 'Structured command input ref from structured_command_input_create.' },
        command: { type: 'string', description: 'Executable name or absolute executable path admitted by policy.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argument vector. No shell parsing is performed.' },
        working_directory: { type: 'string', description: 'Working directory under an allowed root.' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds.' },
      }),
    },
    {
      name: 'structured_command_input_create',
      description: 'Create a scoped structured command input ref.',
      inputSchema: objectSchema({
        input_id: { type: 'string', description: 'Optional caller-chosen id, max 80 chars.' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        working_directory: { type: 'string' },
        timeout_ms: { type: 'integer' },
      }, ['command']),
    },
    {
      name: 'structured_command_output_show',
      description: 'Read a scoped structured command output ref, capped to 200 chars.',
      inputSchema: objectSchema({
        output_ref: { type: 'string' },
        offset: { type: 'integer' },
      }, ['output_ref']),
    },
  ];
}

async function callTool(params, state) {
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  enforceInputCharLimit(args);
  if (name === 'structured_command_execution_policy_inspect') return toolResult(publicExecutionPolicy(state.policy), state);
  if (name === 'structured_command_execute') return toolResult(await executeStructuredCommand(args, state), state);
  if (name === 'structured_command_input_create') return toolResult(createStructuredCommandInput(args, state), state);
  if (name === 'structured_command_output_show') return toolResult(showStructuredCommandOutput(args, state), state);
  throw new Error(`structured_command_unknown_tool:${name}`);
}

export async function executeStructuredCommand(args, state) {
  enforceInputCharLimit(args);
  const effectiveArgs = args.input_ref ? readStructuredCommandInput(args.input_ref, state).input : args;
  const timeoutMs = Math.min(state.policy.maxTimeoutMs, Math.max(1, Number(effectiveArgs.timeout_ms ?? 60_000)));
  const workingDirectory = effectiveArgs.working_directory ? resolve(String(effectiveArgs.working_directory)) : state.policy.allowedRoots[0];
  const decision = decideStructuredCommandExecution({
    command: effectiveArgs.command,
    args: Array.isArray(effectiveArgs.args) ? effectiveArgs.args : [],
    workingDirectory,
  }, state.policy);
  if (decision.status !== 'allowed') {
    return {
      schema: 'narada.structured_command.execution_result.v0',
      status: 'refused',
      decision,
      executed: false,
    };
  }

  const startedAt = new Date().toISOString();
  const result = await spawnStructured(decision.command, decision.args, {
    cwd: decision.working_directory,
    timeoutMs,
    maxOutputBytes: state.policy.maxOutputBytes,
  });
  const finishedAt = new Date().toISOString();
  const payload = {
    schema: 'narada.structured_command.execution_result.v0',
    status: result.timed_out ? 'timed_out' : result.exit_code === 0 ? 'ok' : 'failed',
    executed: true,
    command: decision.command,
    args: decision.args,
    working_directory: decision.working_directory,
    started_at: startedAt,
    finished_at: finishedAt,
    timeout_ms: timeoutMs,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated,
    timed_out: result.timed_out,
    input_ref: args.input_ref ?? null,
  };
  audit(state, payload);
  return payload;
}

export function createStructuredCommandInput(args, state) {
  const inputId = normalizeRefId(args.input_id ?? `i_${randomUUID().replace(/-/g, '').slice(0, 24)}`);
  const input = {
    command: String(args.command ?? ''),
    args: Array.isArray(args.args) ? args.args.map(String) : [],
    ...(args.working_directory ? { working_directory: String(args.working_directory) } : {}),
    ...(args.timeout_ms ? { timeout_ms: Number(args.timeout_ms) } : {}),
  };
  const record = {
    schema: 'narada.structured_command.input.v0',
    ref: `structured_command_input:${inputId}`,
    created_at: new Date().toISOString(),
    sha256: sha256Json(input),
    input,
  };
  writeJsonRecord(inputPath(state, inputId), record);
  return {
    schema: 'narada.structured_command.input_create_result.v0',
    status: 'created',
    input_ref: record.ref,
    sha256: record.sha256,
  };
}

export function showStructuredCommandOutput(args, state) {
  const { id } = parseRef(args.output_ref, 'output');
  const record = readJsonRecord(outputPath(state, id));
  const offset = Math.max(0, Number(args.offset ?? 0));
  const text = String(record.text ?? '');
  const chunk = text.slice(offset, offset + TOOL_RESULT_CHAR_LIMIT);
  return {
    schema: 'narada.structured_command.output_show_result.v0',
    status: 'ok',
    output_ref: record.ref,
    offset,
    next_offset: offset + chunk.length < text.length ? offset + chunk.length : null,
    text: chunk,
    full_output_char_length: text.length,
  };
}

function spawnStructured(command, args, { cwd, timeoutMs, maxOutputBytes }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      const next = stdout + chunk.toString();
      stdoutTruncated ||= Buffer.byteLength(next, 'utf8') > maxOutputBytes;
      stdout = truncateUtf8(next, maxOutputBytes);
    });
    child.stderr.on('data', (chunk) => {
      const next = stderr + chunk.toString();
      stderrTruncated ||= Buffer.byteLength(next, 'utf8') > maxOutputBytes;
      stderr = truncateUtf8(next, maxOutputBytes);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({
        exit_code: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        timed_out: timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        exit_code: code,
        stdout,
        stderr,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        timed_out: timedOut,
      });
    });
  });
}

function toolResult(payload, state) {
  const text = JSON.stringify(payload, null, 2);
  const truncated = text.length > TOOL_RESULT_CHAR_LIMIT;
  const outputRef = truncated ? createStructuredCommandOutput(text, state) : null;
  const rendered = truncated ? text.slice(0, TOOL_RESULT_CHAR_LIMIT) : text;
  return {
    content: [{ type: 'text', text: rendered }],
    structuredContent: {
      truncated,
      ...(outputRef ? { output_ref: outputRef } : {}),
      ...(payload?.input_ref ? { input_ref: payload.input_ref } : {}),
      ...(payload?.sha256 ? { sha256: payload.sha256 } : {}),
      full_output_char_length: text.length,
    },
  };
}

function enforceInputCharLimit(value, path = 'arguments') {
  if (typeof value === 'string' && value.length > TOOL_INPUT_CHAR_LIMIT) {
    throw new Error(`structured_command_input_too_long:${path}:${value.length}>${TOOL_INPUT_CHAR_LIMIT}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => enforceInputCharLimit(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      enforceInputCharLimit(child, `${path}.${key}`);
    }
  }
}

function audit(state, payload) {
  if (!state.auditLogDir) return;
  mkdirSync(state.auditLogDir, { recursive: true });
  appendFileSync(join(state.auditLogDir, 'structured-command.jsonl'), `${JSON.stringify(payload)}\n`, 'utf8');
}

function createStructuredCommandOutput(text, state) {
  if (!state) return null;
  const outputId = `o_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const record = {
    schema: 'narada.structured_command.output.v0',
    ref: `structured_command_output:${outputId}`,
    created_at: new Date().toISOString(),
    sha256: sha256Text(text),
    text,
  };
  writeJsonRecord(outputPath(state, outputId), record);
  return record.ref;
}

function readStructuredCommandInput(ref, state) {
  const { id } = parseRef(ref, 'input');
  return readJsonRecord(inputPath(state, id));
}

function parseRef(ref, kind) {
  const match = String(ref ?? '').match(REF_PATTERN);
  if (!match || match[1] !== kind) throw new Error(`structured_command_invalid_${kind}_ref`);
  return { kind: match[1], id: match[2] };
}

function inputPath(state, id) {
  return join(state.storageRoot, 'inputs', `${id}.json`);
}

function outputPath(state, id) {
  return join(state.storageRoot, 'outputs', `${id}.json`);
}

function writeJsonRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function readJsonRecord(path) {
  if (!existsSync(path)) throw new Error('structured_command_ref_not_found');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function normalizeRefId(value) {
  const id = String(value).trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error('structured_command_invalid_ref_id');
  return id;
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function truncateUtf8(value, maxBytes) {
  let out = value;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      const current = parsed[key];
      parsed[key] = current === undefined ? next : Array.isArray(current) ? [...current, next] : [current, next];
      i++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function optionList(value) {
  if (value === undefined || value === null || value === true) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function drainJsonRpcFrames(buffer) {
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

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
