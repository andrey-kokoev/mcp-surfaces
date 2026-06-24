import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { parseLastMessage, resultStatus, type Invocation, type ResolvedWorkerConfig, type WorkerChange, type WorkerExitInterview, type WorkerOutput, type WorkerOutputParseResult, type WorkerRunTerminalStatus, type WorkerVerification } from './codex-adapter.js';

export type { Invocation, ResolvedWorkerConfig, WorkerOutputParseResult, WorkerRunTerminalStatus };

export function runtimeName(): 'narada-agent-runtime-server' {
  return 'narada-agent-runtime-server';
}

export function supportsResume(): boolean {
  return true;
}

export function buildAgentRuntimeServerArgv(options: {
  authority: ResolvedWorkerConfig['authority'];
  workerSessionId?: string;
}): string[] {
  const argv = ['--raw-jsonl', '--authority', options.authority];
  if (options.workerSessionId) argv.push('--session', options.workerSessionId);
  return argv;
}

export function buildInvocation(resolvedWorkerConfig: ResolvedWorkerConfig, environment: Record<string, string>): Invocation {
  const naradaConfig = resolvedWorkerConfig as ResolvedWorkerConfig & { site_root?: string; workspace_root?: string };
  const serverEnvironment = {
    ...environment,
    NARADA_SITE_ROOT: environment.NARADA_SITE_ROOT || naradaConfig.site_root || resolvedWorkerConfig.cwd,
    NARADA_WORKSPACE_ROOT: environment.NARADA_WORKSPACE_ROOT || naradaConfig.workspace_root || resolvedWorkerConfig.cwd,
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
        const message = eventErrorMessage(record);
        if (message) runtimeError ||= message;
      }
      if (record.event === 'turn_failed') {
        runtimeError = eventErrorMessage(record) ?? runtimeError ?? 'turn_failed';
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
      const missingTurnOutput = !cancelled && code === 0 && finalAssistantMessage === null ? runtimeError ?? 'agent runtime server exited without assistant_message' : null;
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

function eventErrorMessage(record: Record<string, unknown>): string | null {
  const candidates = [
    compactString(record.error),
    compactString(record.message),
    compactString(record.reason),
    compactString(record.code),
  ].filter((value): value is string => Boolean(value));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  if (candidates[0].includes(candidates[1])) return candidates[0];
  return candidates.join(': ');
}

function compactString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return compactString(record.message) ?? compactString(record.error) ?? compactString(record.reason) ?? compactString(record.code);
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
    verification: [{ tool: 'narada-agent-runtime-server', command: null, status: 'passed', summary: 'Recovered final assistant_message after turn_complete', command_classification: 'not_applicable' }],
    verification_budget_respected: null,
    broad_unrelated_failures: [],
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
      const parsed = normalizeWorkerOutput(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function normalizeWorkerOutput(value: unknown): WorkerOutput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === 'string'
    ? record.summary
    : typeof record.message === 'string'
      ? record.message
      : null;
  if (!summary) return null;
  return {
    summary,
    deliverables: arrayOf(record.deliverables, asDeliverable),
    open_questions: stringArray(record.open_questions),
    next_actions: stringArray(record.next_actions),
    edits_performed: typeof record.edits_performed === 'boolean' ? record.edits_performed : false,
    target_state_changed: typeof record.target_state_changed === 'boolean' ? record.target_state_changed : false,
    changes: arrayOf(record.changes, asChange),
    verification: normalizeVerification(record.verification),
    verification_budget_respected: typeof record.verification_budget_respected === 'boolean' ? record.verification_budget_respected : null,
    broad_unrelated_failures: arrayOf(record.broad_unrelated_failures, asBroadUnrelatedFailure),
    exit_interview: normalizeExitInterview(record.exit_interview),
  };
}

function arrayOf<T>(value: unknown, mapper: (value: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.map(mapper).filter((item): item is T => Boolean(item));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asDeliverable(value: unknown): { path: string; description: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== 'string') return null;
  return { path: record.path, description: typeof record.description === 'string' ? record.description : '' };
}

function asChange(value: unknown): WorkerChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== 'string') return null;
  return { path: record.path, status: typeof record.status === 'string' ? record.status : 'reported', summary: typeof record.summary === 'string' ? record.summary : '' };
}

function normalizeVerification(value: unknown): WorkerVerification[] {
  if (Array.isArray(value)) return arrayOf(value, asVerification);
  const single = asVerification(value);
  return single ? [single] : [];
}

function asVerification(value: unknown): WorkerVerification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    tool: typeof record.tool === 'string' ? record.tool : null,
    command: typeof record.command === 'string' ? record.command : null,
    status: typeof record.status === 'string' ? record.status : 'reported',
    summary: typeof record.summary === 'string'
      ? record.summary
      : typeof record.message === 'string'
        ? record.message
        : '',
    command_classification: record.command_classification === 'focused' || record.command_classification === 'broad' || record.command_classification === 'not_applicable' ? record.command_classification : 'not_applicable',
  };
}

function asBroadUnrelatedFailure(value: unknown): { command: string | null; status: string; summary: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    command: typeof record.command === 'string' ? record.command : null,
    status: typeof record.status === 'string' ? record.status : 'reported',
    summary: typeof record.summary === 'string' ? record.summary : '',
  };
}

function normalizeExitInterview(value: unknown): WorkerExitInterview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ergonomics_feedback !== 'string') return null;
  return {
    ergonomics_feedback: record.ergonomics_feedback,
    friction_points: stringArray(record.friction_points),
    missing_affordances: stringArray(record.missing_affordances),
    observed_incoherencies: stringArray(record.observed_incoherencies),
    suggested_improvements: stringArray(record.suggested_improvements),
  };
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

export { parseLastMessage, resultStatus };
