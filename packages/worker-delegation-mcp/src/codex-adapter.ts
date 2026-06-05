import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';

export type ResolvedWorkerConfig = {
  runtime: 'codex';
  command: string;
  argv: string[];
  cwd: string;
  sandbox: string;
  model: string | null;
  reasoning_effort: string | null;
  config: Record<string, string | number | boolean>;
  skip_git_repo_check: boolean;
  ephemeral: boolean;
  json_events: boolean;
  prompt_byte_length: number;
  max_output_bytes: number;
  max_run_ms: number;
  environment_keys: string[];
};

export type Invocation = { command: string; argv: string[]; cwd: string; environment: Record<string, string> };
export type WorkerOutput = { summary: string; deliverables: { path: string; description: string }[]; open_questions: string[]; next_actions: string[] };
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
    argv: resolvedWorkerConfig.argv,
    cwd: resolvedWorkerConfig.cwd,
    environment,
  };
}

export async function runCodexInvocation(options: {
  invocation: Invocation;
  prompt: string;
  eventsPath: string;
  diagnosticPath: string;
  lastMessagePath: string;
  maxRunMs: number;
  abortSignal?: AbortSignal;
}): Promise<{ exit_code: number | null; signal: string | null; cancelled: boolean; worker_session_id: string | null; error: string | null; event_error: string | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(options.invocation.command, options.invocation.argv, {
      cwd: options.invocation.cwd,
      env: options.invocation.environment,
      shell: false,
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
      resolvePromise({ exit_code: null, signal: null, cancelled: false, worker_session_id: workerSessionId, error: error.message, event_error: eventError });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      events.end();
      diagnostics.end();
      if (options.abortSignal) options.abortSignal.removeEventListener('abort', abortHandler);
      if (stdoutBuffer.trim()) eventError ||= 'unterminated json event';
      resolvePromise({ exit_code: code, signal, cancelled, worker_session_id: workerSessionId, error: null, event_error: eventError });
    });
    if (child.stdin) child.stdin.end(options.prompt, 'utf8');
  });
}

export function parseLastMessage(path: string): WorkerOutputParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
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
  const deliverables: { path: string; description: string }[] = [];
  for (let i = 0; i < record.deliverables.length; i += 1) {
    const deliverable = asDeliverable(record.deliverables[i]);
    if (!deliverable) return { ok: false, reason: 'invalid_shape', message: `deliverables[${i}] must have string path and description` };
    deliverables.push(deliverable);
  }
  if (!record.open_questions.every((item) => typeof item === 'string')) return { ok: false, reason: 'invalid_shape', message: 'open_questions entries must be strings' };
  if (!record.next_actions.every((item) => typeof item === 'string')) return { ok: false, reason: 'invalid_shape', message: 'next_actions entries must be strings' };
  return { ok: true, data: { summary: record.summary, deliverables, open_questions: record.open_questions, next_actions: record.next_actions } };
}

export function parseResult(runRecord: { lastMessagePath: string }): WorkerOutputParseResult {
  return parseLastMessage(runRecord.lastMessagePath);
}

export function resultStatus(codexResult: { exit_code: number | null; cancelled: boolean; error: string | null; event_error?: string | null }, parsed: WorkerOutputParseResult): { status: 'completed' | 'failed' | 'cancelled'; error: string | null } {
  if (codexResult.cancelled) return { status: 'cancelled', error: 'cancelled' };
  if (codexResult.error) return { status: 'failed', error: codexResult.error };
  if (codexResult.event_error) return { status: 'failed', error: codexResult.event_error };
  if (codexResult.exit_code !== 0) return { status: 'failed', error: `worker runtime exited with code ${codexResult.exit_code}` };
  if (parsed.ok === false) return { status: 'failed', error: `invalid last_message.json: ${parsed.reason}: ${parsed.message}` };
  return { status: 'completed', error: null };
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
