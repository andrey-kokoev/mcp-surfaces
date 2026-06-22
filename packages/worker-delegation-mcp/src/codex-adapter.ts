import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { WorkerResolvedExecutionPolicy } from './worker-types.js';

export type ResolvedWorkerConfig = WorkerResolvedExecutionPolicy;

export type Invocation = { command: string; argv: string[]; cwd: string; environment: Record<string, string> };
export type WorkerChange = { path: string; status: string; summary: string };
export type WorkerVerification = { tool: string | null; command: string | null; status: string; summary: string };
export type WorkerExitInterview = { ergonomics_feedback: string; friction_points: string[]; missing_affordances: string[]; observed_incoherencies: string[]; suggested_improvements: string[] };
export type WorkerOutput = { summary: string; deliverables: { path: string; description: string }[]; open_questions: string[]; next_actions: string[]; edits_performed: boolean; target_state_changed: boolean; changes: WorkerChange[]; verification: WorkerVerification[]; exit_interview: WorkerExitInterview | null };
export type WorkerOutputParseResult =
  | { ok: true; data: WorkerOutput }
  | { ok: false; reason: 'missing_file' | 'invalid_json' | 'invalid_shape'; message: string };

export function runtimeName(): 'codex' {
  return 'codex';
}

export function supportsResume(): boolean {
  return true;
}

export function buildCodexArgv(options: {
  cwd: string;
  sandbox: string;
  schemaPath: string;
  lastMessagePath: string;
  workerSessionId?: string;
  ephemeral: boolean;
  skipGitRepoCheck: boolean;
  config: Record<string, string | number | boolean>;
}): string[] {
  const argv = ['exec'];
  if (options.ephemeral) argv.push('--ephemeral');
  argv.push('-C', options.cwd, '--sandbox', options.sandbox, '--json', '--output-schema', options.schemaPath, '-o', options.lastMessagePath);
  if (options.workerSessionId) argv.push('resume', options.workerSessionId);
  if (options.skipGitRepoCheck) argv.push('--skip-git-repo-check');
  for (const [key, value] of Object.entries(options.config).sort(([a], [b]) => a.localeCompare(b))) argv.push('-c', `${key}=${tomlValue(value)}`);
  argv.push('-');
  return argv;
}

export function buildInvocation(resolvedWorkerConfig: ResolvedWorkerConfig, environment: Record<string, string>): Invocation {
  return {
    command: resolvedWorkerConfig.command,
    argv: [...resolvedWorkerConfig.command_args, ...resolvedWorkerConfig.argv],
    cwd: resolvedWorkerConfig.cwd,
    environment,
  };
}

export function commandRequiresWindowsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const extension = extname(command).toLowerCase();
  return extension === '.cmd' || extension === '.bat' || extension === '.ps1';
}

function spawnCommandForInvocation(invocation: Invocation): { command: string; argv: string[]; shell: boolean } {
  const extension = extname(invocation.command).toLowerCase();
  if (process.platform === 'win32' && extension === '.ps1') {
    const command = `& ${powershellSingleQuoted(invocation.command)} ${invocation.argv.map(powershellSingleQuoted).join(' ')}`;
    return { command: 'powershell.exe', argv: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], shell: false };
  }
  return { command: invocation.command, argv: invocation.argv, shell: commandRequiresWindowsShell(invocation.command) };
}

function powershellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function runCodexInvocation(options: {
  invocation: Invocation;
  prompt: string;
  eventsPath: string;
  diagnosticPath: string;
  lastMessagePath: string;
  maxRunMs: number;
  abortSignal?: AbortSignal;
}): Promise<{ exit_code: number | null; signal: string | null; cancelled: boolean; worker_session_id: string | null; error: string | null; event_error: string | null; runtime_error: string | null }> {
  return new Promise((resolvePromise) => {
    if (options.abortSignal?.aborted) {
      resolvePromise({ exit_code: null, signal: null, cancelled: true, worker_session_id: null, error: null, event_error: null, runtime_error: null });
      return;
    }
    const spawnSpec = spawnCommandForInvocation(options.invocation);
    const child = spawn(spawnSpec.command, spawnSpec.argv, {
      cwd: options.invocation.cwd,
      env: options.invocation.environment,
      shell: spawnSpec.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events = createWriteStream(options.eventsPath, { flags: 'a' });
    const diagnostics = createWriteStream(options.diagnosticPath, { flags: 'a' });
    let stdoutBuffer = '';
    let workerSessionId: string | null = null;
    let settled = false;
    let cancelled = false;
    let eventError: string | null = null;
    let runtimeError: string | null = null;

    const timer = setTimeout(() => {
      cancelled = true;
      try { child.kill(); } catch { /* ignore */ }
    }, options.maxRunMs);

    const abortHandler = () => {
      cancelled = true;
      try { child.kill(); } catch { /* ignore */ }
    };
    if (options.abortSignal) options.abortSignal.addEventListener('abort', abortHandler, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      events.write(text);
      stdoutBuffer += text;
      while (true) {
        const idx = stdoutBuffer.indexOf('\n');
        if (idx === -1) break;
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          workerSessionId ||= findSessionId(parsed);
          runtimeError ||= findRuntimeError(parsed);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          eventError ||= `invalid json event: ${message}`;
        }
      }
    });
    child.stderr.on('data', (chunk) => diagnostics.write(String(chunk)));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      events.end();
      diagnostics.end();
      if (options.abortSignal) options.abortSignal.removeEventListener('abort', abortHandler);
      resolvePromise({ exit_code: null, signal: null, cancelled: false, worker_session_id: workerSessionId, error: error.message, event_error: eventError, runtime_error: runtimeError });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      events.end();
      diagnostics.end();
      if (options.abortSignal) options.abortSignal.removeEventListener('abort', abortHandler);
      if (stdoutBuffer.trim()) eventError ||= 'unterminated json event';
      resolvePromise({ exit_code: code, signal, cancelled, worker_session_id: workerSessionId, error: null, event_error: eventError, runtime_error: runtimeError });
    });
    if (child.stdin) child.stdin.end(options.prompt, 'utf8');
  });
}

export function parseLastMessage(path: string): WorkerOutputParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message.includes('ENOENT') ? 'missing_file' : 'invalid_json', message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'invalid_shape', message: 'last_message must be an object' };
  const record = parsed as Record<string, unknown>;
  if (typeof record.summary !== 'string') return { ok: false, reason: 'invalid_shape', message: 'summary must be a string' };
  if (!Array.isArray(record.deliverables)) return { ok: false, reason: 'invalid_shape', message: 'deliverables must be an array' };
  if (!Array.isArray(record.open_questions)) return { ok: false, reason: 'invalid_shape', message: 'open_questions must be an array' };
  if (!Array.isArray(record.next_actions)) return { ok: false, reason: 'invalid_shape', message: 'next_actions must be an array' };
  if (typeof record.edits_performed !== 'boolean') return { ok: false, reason: 'invalid_shape', message: 'edits_performed must be a boolean' };
  if (typeof record.target_state_changed !== 'boolean') return { ok: false, reason: 'invalid_shape', message: 'target_state_changed must be a boolean' };
  if (!Array.isArray(record.changes)) return { ok: false, reason: 'invalid_shape', message: 'changes must be an array' };
  if (!Array.isArray(record.verification)) return { ok: false, reason: 'invalid_shape', message: 'verification must be an array' };
  const deliverables: { path: string; description: string }[] = [];
  for (let i = 0; i < record.deliverables.length; i += 1) {
    const deliverable = asDeliverable(record.deliverables[i]);
    if (!deliverable) return { ok: false, reason: 'invalid_shape', message: `deliverables[${i}] must have string path and description` };
    deliverables.push(deliverable);
  }
  if (!record.open_questions.every((item) => typeof item === 'string')) return { ok: false, reason: 'invalid_shape', message: 'open_questions entries must be strings' };
  if (!record.next_actions.every((item) => typeof item === 'string')) return { ok: false, reason: 'invalid_shape', message: 'next_actions entries must be strings' };
  const changes: WorkerChange[] = [];
  for (let i = 0; i < record.changes.length; i += 1) {
    const change = asChange(record.changes[i]);
    if (!change) return { ok: false, reason: 'invalid_shape', message: `changes[${i}] must have string path, status, and summary` };
    changes.push(change);
  }
  const verification: WorkerVerification[] = [];
  for (let i = 0; i < record.verification.length; i += 1) {
    const item = asVerification(record.verification[i]);
    if (!item) return { ok: false, reason: 'invalid_shape', message: `verification[${i}] must have nullable string tool and command, plus string status and summary` };
    verification.push(item);
  }
  const exitInterview = record.exit_interview === undefined || record.exit_interview === null ? null : asExitInterview(record.exit_interview);
  if (record.exit_interview !== undefined && record.exit_interview !== null && !exitInterview) return { ok: false, reason: 'invalid_shape', message: 'exit_interview must be null or include ergonomics_feedback, friction_points, missing_affordances, observed_incoherencies, and suggested_improvements' };
  return { ok: true, data: { summary: record.summary, deliverables, open_questions: record.open_questions, next_actions: record.next_actions, edits_performed: record.edits_performed, target_state_changed: record.target_state_changed, changes, verification, exit_interview: exitInterview } };
}

export function parseResult(runRecord: { lastMessagePath: string }): WorkerOutputParseResult {
  return parseLastMessage(runRecord.lastMessagePath);
}

export type WorkerRunTerminalStatus = 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';

export function resultStatus(codexResult: { exit_code: number | null; cancelled: boolean; error: string | null; event_error?: string | null; runtime_error?: string | null }, parsed: WorkerOutputParseResult): { status: WorkerRunTerminalStatus; error: string | null; warnings: string[] } {
  if (codexResult.cancelled) return { status: 'cancelled', error: 'cancelled', warnings: [] };
  const warnings = [codexResult.runtime_error].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const runtimeError = codexResult.error
    ?? codexResult.event_error
    ?? (codexResult.exit_code !== 0 && codexResult.exit_code !== null ? codexResult.runtime_error ?? `worker runtime exited with code ${codexResult.exit_code}` : null);
  if (runtimeError && parsed.ok) return { status: 'completed_with_errors', error: runtimeError, warnings };
  if (runtimeError) return { status: 'failed', error: runtimeError, warnings };
  if (parsed.ok === false) return { status: 'failed', error: `invalid last_message.json: ${parsed.reason}: ${parsed.message}`, warnings };
  return { status: 'completed', error: null, warnings };
}

function findRuntimeError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.type === 'error') {
    const direct = stringField(record, 'message') ?? nestedErrorMessage(record.error);
    if (direct) return direct;
  }
  const nested = nestedErrorMessage(record.error);
  if (nested) return nested;
  for (const item of Object.values(record)) {
    const found = findRuntimeError(item);
    if (found) return found;
  }
  return null;
}

function nestedErrorMessage(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return stringField(record, 'message') ?? stringField(record, 'error') ?? null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === 'string' && record[key].trim() ? record[key].trim() : null;
}

function tomlValue(value: string | number | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function findSessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['thread_id', 'threadId', 'session_id', 'sessionId', 'conversation_id', 'conversationId']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  for (const nested of Object.values(record)) {
    const found = findSessionId(nested);
    if (found) return found;
  }
  return null;
}

function asDeliverable(value: unknown): { path: string; description: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== 'string' || typeof record.description !== 'string') return null;
  return { path: record.path, description: record.description };
}

function asChange(value: unknown): WorkerChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== 'string' || typeof record.status !== 'string' || typeof record.summary !== 'string') return null;
  return { path: record.path, status: record.status, summary: record.summary };
}

function asVerification(value: unknown): WorkerVerification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, 'tool') || !Object.hasOwn(record, 'command')) return null;
  if (!nullableString(record.tool) || !nullableString(record.command)) return null;
  if (typeof record.status !== 'string' || typeof record.summary !== 'string') return null;
  return { tool: record.tool, command: record.command, status: record.status, summary: record.summary };
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function asExitInterview(value: unknown): WorkerExitInterview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ergonomics_feedback !== 'string') return null;
  if (!stringArray(record.friction_points) || !stringArray(record.missing_affordances) || !stringArray(record.observed_incoherencies) || !stringArray(record.suggested_improvements)) return null;
  return {
    ergonomics_feedback: record.ergonomics_feedback,
    friction_points: record.friction_points,
    missing_affordances: record.missing_affordances,
    observed_incoherencies: record.observed_incoherencies,
    suggested_improvements: record.suggested_improvements,
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
