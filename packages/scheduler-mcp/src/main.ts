#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_NAME = 'scheduler-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

type JsonRecord = Record<string, unknown>;

type SchedulerState = {
  allowedRoots: string[];
};

export function createServerState(options: JsonRecord = {}): SchedulerState {
  const allowedRoots = optionList(options.allowedRoot ?? options.allowedRoots);
  return { allowedRoots };
}

export async function handleRequest(request: JsonRecord, state: SchedulerState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

export async function runStdioServer(options: JsonRecord = {}): Promise<void> {
  const state = createServerState(options);
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
      const response = await handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

async function dispatchMethod(method: string, params: JsonRecord, state: SchedulerState) {
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
      return await callTool(params, state);
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

export function listTools() {
  return [
    {
      name: 'scheduler_task_list',
      description: 'List scheduled tasks, optionally filtered by folder path.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Task folder path, e.g. \\Narada. Defaults to \\' },
          limit: { type: 'number', default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'scheduler_task_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_task_show',
      description: 'Show full details of one scheduled task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_name: { type: 'string', description: 'Full task path, e.g. \\Narada\\MyTask.' },
        },
        required: ['task_name'],
        additionalProperties: false,
      },
      annotations: { title: 'scheduler_task_show', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_task_create',
      description: 'Create a new scheduled task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_name: { type: 'string', description: 'Task path, e.g. \\Narada\\MyTask.' },
          command: { type: 'string', description: 'Executable path or command.' },
          arguments: { type: 'string', description: 'Command-line arguments.' },
          working_dir: { type: 'string', description: 'Start-in directory.' },
          schedule: { type: 'string', enum: ['daily', 'hourly', 'at_startup', 'at_logon', 'once'], description: 'Trigger schedule type.' },
          start_time: { type: 'string', description: 'HH:mm start time (for daily/hourly/once).' },
          interval_minutes: { type: 'number', description: 'Repeat interval in minutes (for hourly).' },
          description: { type: 'string', description: 'Task description.' },
        },
        required: ['task_name', 'command', 'schedule'],
        additionalProperties: false,
      },
      annotations: { title: 'scheduler_task_create', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_task_delete',
      description: 'Delete a scheduled task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_name: { type: 'string', description: 'Full task path to delete.' },
        },
        required: ['task_name'],
        additionalProperties: false,
      },
      annotations: { title: 'scheduler_task_delete', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_task_enable',
      description: 'Enable a scheduled task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_name: { type: 'string' },
        },
        required: ['task_name'],
        additionalProperties: false,
      },
      annotations: { title: 'scheduler_task_enable', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_task_disable',
      description: 'Disable a scheduled task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_name: { type: 'string' },
        },
        required: ['task_name'],
        additionalProperties: false,
      },
      annotations: { title: 'scheduler_task_disable', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_task_run',
      description: 'Run a scheduled task immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          task_name: { type: 'string' },
        },
        required: ['task_name'],
        additionalProperties: false,
      },
      annotations: { title: 'scheduler_task_run', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_task_history',
      description: 'Show run history for a scheduled task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_name: { type: 'string' },
          limit: { type: 'number', default: 20 },
        },
        required: ['task_name'],
        additionalProperties: false,
      },
      annotations: { title: 'scheduler_task_history', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

async function callTool(params: JsonRecord, state: SchedulerState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'scheduler_task_list': result = await schedulerTaskList(args, state); break;
    case 'scheduler_task_show': result = await schedulerTaskShow(args, state); break;
    case 'scheduler_task_create': result = await schedulerTaskCreate(args, state); break;
    case 'scheduler_task_delete': result = await schedulerTaskDelete(args, state); break;
    case 'scheduler_task_enable': result = await schedulerTaskEnable(args, state); break;
    case 'scheduler_task_disable': result = await schedulerTaskDisable(args, state); break;
    case 'scheduler_task_run': result = await schedulerTaskRun(args, state); break;
    case 'scheduler_task_history': result = await schedulerTaskHistory(args, state); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

async function schtasks(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveExecution) => {
    const child = spawn('schtasks.exe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      resolveExecution({ stdout, stderr, exitCode: code ?? -1 });
    });
    child.on('error', (err) => {
      resolveExecution({ stdout, stderr: `${stderr}\n${err.message}`, exitCode: -1 });
    });
  });
}

function parseCSV(csv: string): JsonRecord[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const rows: JsonRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length !== headers.length) continue;
    const row: JsonRecord = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j];
    }
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}

function compactTask(row: JsonRecord): JsonRecord {
  return {
    task_name: row.TaskName,
    status: row.Status,
    schedule: row['Schedule Type'],
    next_run: row['Next Run Time'],
    last_run: row['Last Run Time'],
    last_result: row['Last Result'],
    command: row['Task To Run'],
  };
}

async function schedulerTaskList(args: JsonRecord, _state: SchedulerState): Promise<JsonRecord> {
  const folder = optionalString(args.folder) ?? '\\';
  const limit = clamp(integer(args.limit, 50, 1, 500), 1, 500);
  const { stdout, exitCode } = await schtasks(['/query', '/fo', 'CSV', '/v', '/tn', folder]);
  if (exitCode !== 0 && exitCode !== 1) throw diagnosticError('scheduler_query_failed', `scheduler_query_failed:${exitCode}`);
  const all = parseCSV(stdout);
  const items = all.slice(0, limit).map(compactTask);
  return { items, count: items.length, folder };
}

async function schedulerTaskShow(args: JsonRecord, _state: SchedulerState): Promise<JsonRecord> {
  const taskName = requiredString(args.task_name, 'scheduler_requires_task_name');
  const { stdout, exitCode } = await schtasks(['/query', '/fo', 'CSV', '/v', '/tn', taskName]);
  if (exitCode !== 0) throw diagnosticError('scheduler_task_not_found', `scheduler_task_not_found:${taskName}`, { exitCode });
  const rows = parseCSV(stdout);
  if (rows.length === 0) throw diagnosticError('scheduler_task_not_found', `scheduler_task_not_found:${taskName}`);
  return { task: rows[0] };
}

async function schedulerTaskCreate(args: JsonRecord, state: SchedulerState): Promise<JsonRecord> {
  const taskName = requiredString(args.task_name, 'scheduler_requires_task_name');
  const command = requiredString(args.command, 'scheduler_requires_command');
  const cmdArgs = optionalString(args.arguments);
  const workingDir = optionalString(args.working_dir);
  const schedule = requiredString(args.schedule, 'scheduler_requires_schedule');
  const description = optionalString(args.description);
  const taskRun = cmdArgs ? `${command} ${cmdArgs}` : command;
  const schArgs = ['/create', '/tn', taskName, '/tr', taskRun, '/f'];
  switch (schedule) {
    case 'daily': {
      const startTime = optionalString(args.start_time) ?? '09:00';
      schArgs.push('/sc', 'daily', '/st', startTime);
      break;
    }
    case 'hourly': {
      const interval = clamp(integer(args.interval_minutes, 60, 1, 1440), 1, 1440);
      schArgs.push('/sc', 'hourly', '/mo', String(interval));
      break;
    }
    case 'at_startup':
      schArgs.push('/sc', 'onstart');
      break;
    case 'at_logon':
      schArgs.push('/sc', 'onlogon');
      break;
    case 'once': {
      const startTime = optionalString(args.start_time) ?? '09:00';
      schArgs.push('/sc', 'once', '/st', startTime);
      break;
    }
    default:
      throw diagnosticError('scheduler_invalid_schedule', `scheduler_invalid_schedule:${schedule}`);
  }
  if (workingDir) schArgs.push('/tr', taskRun);
  const realTr = workingDir ? `${command} ${cmdArgs ?? ''}`.trim() : taskRun;
  schArgs[schArgs.indexOf('/tr') + 1] = realTr;
  if (workingDir) {
    const trIdx = schArgs.indexOf('/tr');
    schArgs.splice(trIdx + 2, 0, '/v1', workingDir);
  }
  const { stdout, stderr, exitCode } = await schtasks(schArgs);
  if (exitCode !== 0) throw diagnosticError('scheduler_create_failed', `scheduler_create_failed:${exitCode}`, { stdout, stderr });
  return { status: 'created', task_name: taskName, schedule, command: taskRun };
}

async function schedulerTaskDelete(args: JsonRecord, _state: SchedulerState): Promise<JsonRecord> {
  const taskName = requiredString(args.task_name, 'scheduler_requires_task_name');
  const { stdout, stderr, exitCode } = await schtasks(['/delete', '/tn', taskName, '/f']);
  if (exitCode !== 0) throw diagnosticError('scheduler_delete_failed', `scheduler_delete_failed:${exitCode}`, { stdout, stderr });
  return { status: 'deleted', task_name: taskName };
}

async function schedulerTaskEnable(args: JsonRecord, _state: SchedulerState): Promise<JsonRecord> {
  const taskName = requiredString(args.task_name, 'scheduler_requires_task_name');
  const { stdout, stderr, exitCode } = await schtasks(['/change', '/tn', taskName, '/enable']);
  if (exitCode !== 0) throw diagnosticError('scheduler_enable_failed', `scheduler_enable_failed:${exitCode}`, { stdout, stderr });
  return { status: 'enabled', task_name: taskName };
}

async function schedulerTaskDisable(args: JsonRecord, _state: SchedulerState): Promise<JsonRecord> {
  const taskName = requiredString(args.task_name, 'scheduler_requires_task_name');
  const { stdout, stderr, exitCode } = await schtasks(['/change', '/tn', taskName, '/disable']);
  if (exitCode !== 0) throw diagnosticError('scheduler_disable_failed', `scheduler_disable_failed:${exitCode}`, { stdout, stderr });
  return { status: 'disabled', task_name: taskName };
}

async function schedulerTaskRun(args: JsonRecord, _state: SchedulerState): Promise<JsonRecord> {
  const taskName = requiredString(args.task_name, 'scheduler_requires_task_name');
  const { stdout, stderr, exitCode } = await schtasks(['/run', '/tn', taskName]);
  if (exitCode !== 0) throw diagnosticError('scheduler_run_failed', `scheduler_run_failed:${exitCode}`, { stdout, stderr });
  return { status: 'started', task_name: taskName };
}

async function schedulerTaskHistory(args: JsonRecord, _state: SchedulerState): Promise<JsonRecord> {
  const taskName = requiredString(args.task_name, 'scheduler_requires_task_name');
  const limit = clamp(integer(args.limit, 20, 1, 200), 1, 200);
  const { stdout, exitCode } = await schtasks(['/query', '/fo', 'CSV', '/v', '/tn', taskName]);
  if (exitCode !== 0 && exitCode !== 1) throw diagnosticError('scheduler_query_failed', `scheduler_query_failed:${exitCode}`);
  const rows = parseCSV(stdout);
  if (rows.length === 0) throw diagnosticError('scheduler_task_not_found', `scheduler_task_not_found:${taskName}`);
  const history: JsonRecord[] = [];
  for (const row of rows.slice(0, limit)) {
    history.push({
      last_run: row['Last Run Time'],
      status: row.Status,
      last_result: row['Last Result'],
      next_run: row['Next Run Time'],
      schedule: row['Schedule Type'],
    });
  }
  return { task_name: taskName, items: history, count: history.length };
}

function renderResult(result: JsonRecord): string {
  if (result.items !== undefined) {
    const items = result.items as JsonRecord[];
    const header = `scheduler: ${result.count ?? 0} tasks`;
    const lines = items.map((item) => {
      if (item.last_run) {
        return `  ${item.last_run}: ${item.status ?? ''} (${item.last_result ?? ''})`;
      }
      return `  ${item.task_name ?? ''} [${item.status ?? ''}] ${item.schedule ?? ''} next=${item.next_run ?? 'N/A'}`;
    });
    return [header, ...lines].join('\n');
  }
  if (result.task) {
    const t = result.task as JsonRecord;
    return [
      `task: ${t.TaskName ?? ''}`,
      `status: ${t.Status ?? ''}`,
      `schedule: ${t['Schedule Type'] ?? ''}`,
      `command: ${t['Task To Run'] ?? ''}`,
      `last_run: ${t['Last Run Time'] ?? ''} (${t['Last Result'] ?? ''})`,
      t.Comment ? `description: ${t.Comment}` : '',
    ].filter(Boolean).join('\n');
  }
  return `${result.status ?? 'ok'}: ${result.task_name ?? ''}`;
}

function requiredString(value: unknown, code: string, details: JsonRecord = {}): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code, code, details);
  return text;
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function optionList(value: unknown): string[] {
  if (value === undefined || value === null || value === true) return [];
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [String(value)].filter(Boolean);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function diagnosticError(code: string, message: string = code, details: JsonRecord = {}) {
  const error = new Error(message);
  Object.assign(error, { codeName: code, details });
  return error;
}

function errorDiagnostic(error: unknown) {
  const record = asRecord(error);
  return {
    schema: 'narada.scheduler.error.v1',
    code: String(record.codeName ?? 'scheduler_error'),
    message: error instanceof Error ? error.message : String(error),
    details: asRecord(record.details),
  };
}

function drainJsonLines(buffer: string) {
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  return {
    framed: false,
    remaining,
    requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))),
  };
}

function drainJsonRpcFrames(buffer: string) {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = remaining.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    requests.push(asRecord(JSON.parse(remaining.slice(bodyStart, bodyEnd))));
    remaining = remaining.slice(bodyEnd);
  }
  return { framed: true, remaining, requests };
}

function writeJsonRpcResponse(response: JsonRecord, { framed }: { framed: boolean }) {
  const body = JSON.stringify(response);
  if (framed) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

function parseArgs(argv: string[]) {
  const options: JsonRecord = {};
  const allowedRoots: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--allowed-root') allowedRoots.push(argv[++i]);
    else throw new Error(`unknown_argument:${arg}`);
  }
  if (allowedRoots.length > 0) options.allowedRoots = allowedRoots;
  return options;
}

export { parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
