import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { parseLastMessage, resultStatus, type Invocation, type ResolvedWorkerConfig, type WorkerOutput, type WorkerOutputParseResult, type WorkerRunTerminalStatus } from './codex-adapter.js';

export type { Invocation, ResolvedWorkerConfig, WorkerOutputParseResult, WorkerRunTerminalStatus };

export function runtimeName(): 'narada-agent-runtime-server' {
  return 'narada-agent-runtime-server';
}

export function supportsResume(): boolean {
  return true;
}

export function buildAgentRuntimeServerArgv(options: {
  workerSessionId?: string;
} = {}): string[] {
  const argv = ['--raw-jsonl'];
  if (options.workerSessionId) argv.push('--session', options.workerSessionId);
  return argv;
}

export function buildInvocation(resolvedWorkerConfig: ResolvedWorkerConfig, environment: Record<string, string>): Invocation {
  const serverEnvironment = {
    ...environment,
    NARADA_SITE_ROOT: environment.NARADA_SITE_ROOT || resolvedWorkerConfig.cwd,
    NARADA_WORKSPACE_ROOT: environment.NARADA_WORKSPACE_ROOT || resolvedWorkerConfig.cwd,
  };
  const commandArgs = [...resolvedWorkerConfig.command_args];
  let command = resolvedWorkerConfig.command;
  // Keep raw JSONL attached to the real Node process instead of a Windows npm/pnpm shim.
  const nodeShim = resolveWindowsNodeShim(command, serverEnvironment);
  if (nodeShim) {
    command = nodeShim.command;
    commandArgs.unshift(nodeShim.entrypoint);
    Object.assign(serverEnvironment, nodeShim.environment);
  }
  return {
    command,
    argv: [...commandArgs, ...resolvedWorkerConfig.argv],
    cwd: resolvedWorkerConfig.cwd,
    environment: serverEnvironment,
  };
}

function resolveWindowsNodeShim(command: string, environment: Record<string, string>): { command: string; entrypoint: string; environment: Record<string, string> } | null {
  if (process.platform !== 'win32') return null;
  const extension = extname(command).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') return null;
  if (!existsSync(command)) return null;
  let content = '';
  try {
    content = readFileSync(command, 'utf8');
  } catch {
    return null;
  }
  const nodeLine = content.match(/(?:^|\r?\n)\s*(?:@)?(?:"%~dp0\\node\.exe"|node)\s+"([^"]+)"\s+%\*/i);
  if (!nodeLine) return null;
  const shimDir = dirname(command);
  const entrypoint = realpathIfPresent(resolve(nodeLine[1].replace(/%~dp0/gi, shimDir)));
  const nodePathLine = content.match(/@SET\s+"NODE_PATH=([^"]+)"/i);
  const extraEnvironment: Record<string, string> = {};
  if (nodePathLine && !environment.NODE_PATH) extraEnvironment.NODE_PATH = nodePathLine[1].replace(/%NODE_PATH%/gi, environment.NODE_PATH ?? '');
  return { command: process.execPath, entrypoint, environment: extraEnvironment };
}

function realpathIfPresent(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function commandRequiresWindowsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const extension = extname(command).toLowerCase();
  return extension === '.cmd' || extension === '.bat' || extension === '.ps1';
}

export async function runAgentRuntimeServerInvocation(options: {
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

    const child = spawn(options.invocation.command, options.invocation.argv, {
      cwd: options.invocation.cwd,
      env: options.invocation.environment,
      shell: commandRequiresWindowsShell(options.invocation.command),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const events = createWriteStream(options.eventsPath, { flags: 'a' });
    const diagnostics = createWriteStream(options.diagnosticPath, { flags: 'a' });
    let stdoutBuffer = '';
    let workerSessionId: string | null = null;
    let finalAssistantMessage: string | null = null;
    let turnCompleted = false;
    let settled = false;
    let cancelled = false;
    let eventError: string | null = null;
    let runtimeError: string | null = null;

    const finish = (result: { exit_code: number | null; signal: string | null; cancelled: boolean; error: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      events.end();
      diagnostics.end();
      if (options.abortSignal) options.abortSignal.removeEventListener('abort', abortHandler);
      if (finalAssistantMessage !== null) {
        writeFileSync(options.lastMessagePath, `${JSON.stringify(workerOutputFromAgentMessage(finalAssistantMessage), null, 2)}\n`, 'utf8');
      }
      resolvePromise({ ...result, worker_session_id: workerSessionId, event_error: eventError, runtime_error: runtimeError });
    };

    const closeAfterTurn = () => {
      if (!turnCompleted) return;
      try {
        child.stdin?.write(`${JSON.stringify({ id: `worker-close-${Date.now()}`, method: 'session.close', params: {} })}\n`);
        child.stdin?.end();
      } catch {
        // Best effort; process close will carry diagnostics if this fails.
      }
    };

    const handleEvent = (event: unknown) => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) return;
      const record = event as Record<string, unknown>;
      if (typeof record.session_id === 'string' && record.session_id) workerSessionId ||= record.session_id;
      if (record.event === 'assistant_message' && typeof record.content === 'string') finalAssistantMessage = record.content;
      if (record.event === 'error') {
        const message = [record.code, record.message].filter(Boolean).join(': ');
        if (message) runtimeError ||= message;
      }
      if (record.event === 'turn_failed') {
        runtimeError ||= String(record.error ?? record.message ?? record.reason ?? 'turn_failed');
        turnCompleted = true;
        closeAfterTurn();
      }
      if (record.event === 'turn_complete') {
        turnCompleted = true;
        closeAfterTurn();
      }
    };

    const drainStdout = (chunk: string) => {
      events.write(chunk);
      stdoutBuffer += chunk;
      while (true) {
        const idx = stdoutBuffer.indexOf('\n');
        if (idx === -1) break;
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          eventError ||= `invalid json event: ${message}`;
        }
      }
    };

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
    child.stdout.on('data', (chunk) => drainStdout(String(chunk)));
    child.stderr.on('data', (chunk) => diagnostics.write(String(chunk)));
    child.on('error', (error) => finish({ exit_code: null, signal: null, cancelled: false, error: error.message }));
    child.on('close', (code, signal) => {
      if (stdoutBuffer.trim()) eventError ||= 'unterminated json event';
      const missingTurnOutput = !cancelled && code === 0 && finalAssistantMessage === null ? 'agent runtime server exited without assistant_message' : null;
      finish({ exit_code: code, signal, cancelled, error: missingTurnOutput });
    });

    const requestId = `worker-conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    child.stdin?.write(`${JSON.stringify({
      id: requestId,
      method: 'conversation.send',
      params: {
        request_id: requestId,
        message: options.prompt,
        source: 'programmatic_operator',
        source_id: 'worker-delegation-mcp',
      },
    })}\n`);
  });
}

function workerOutputFromAgentMessage(message: string): WorkerOutput {
  const parsed = parseWorkerOutputJson(message);
  if (parsed) return parsed;
  return {
    summary: message,
    deliverables: [],
    open_questions: [],
    next_actions: [],
    edits_performed: false,
    target_state_changed: false,
    changes: [],
    verification: [{ tool: 'narada-agent-runtime-server', command: null, status: 'passed', summary: 'Recovered final assistant_message after turn_complete' }],
    exit_interview: null,
  };
}

function parseWorkerOutputJson(message: string): WorkerOutput | null {
  const candidates = [
    message.trim(),
    message.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim(),
    extractJsonObject(message),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as WorkerOutput;
      if (typeof parsed.summary !== 'string') continue;
      if (!Array.isArray(parsed.deliverables) || !Array.isArray(parsed.open_questions) || !Array.isArray(parsed.next_actions) || !Array.isArray(parsed.changes) || !Array.isArray(parsed.verification)) continue;
      if (typeof parsed.edits_performed !== 'boolean' || typeof parsed.target_state_changed !== 'boolean') continue;
      return { ...parsed, exit_interview: parsed.exit_interview ?? null };
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

export { parseLastMessage, resultStatus };
