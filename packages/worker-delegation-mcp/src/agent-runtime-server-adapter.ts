import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { parseLastMessage, resultStatus, type Invocation, type ResolvedWorkerConfig, type WorkerOutputParseResult, type WorkerRunTerminalStatus } from './codex-adapter.js';
import { admitWorkerAiProcessInvocation, releaseWorkerAiProcessInvocation, workerAiProcessRefusalError } from './ai-process-invocation.js';
import { workerOutputFromAgentMessage } from './output-contract.js';
import { AgentRuntimeEventTracker, emptyAssistantExtraction, extractUnavailableMcpRuntimeError, isUnavailableMcpRuntimeError, missingAssistantMessageError } from './runtime-events.js';

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
    NARADA_MAX_TOOL_ROUNDS: String(resolvedWorkerConfig.max_tool_rounds ?? 32),
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

function runtimeSessionId(invocation: Invocation): string | null {
  const sessionIndex = invocation.argv.findIndex((value) => value === '--session');
  const sessionId = sessionIndex >= 0 ? invocation.argv[sessionIndex + 1] : null;
  return sessionId && sessionId.trim() ? sessionId.trim() : null;
}

function runtimeSessionEventsPathForSession(invocation: Invocation, sessionId: string | null): string | null {
  const siteRoot = invocation.environment.NARADA_SITE_ROOT;
  if (!sessionId || !siteRoot || sessionId.includes('..') || /[\\/]/.test(sessionId)) return null;
  return join(siteRoot, '.narada', 'crew', 'nars-sessions', sessionId, 'events.jsonl');
}

function runtimeSessionEventsPath(invocation: Invocation): string | null {
  return runtimeSessionEventsPathForSession(invocation, runtimeSessionId(invocation));
}

function eventSequence(event: unknown): number | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const value = (event as Record<string, unknown>).event_sequence ?? (event as Record<string, unknown>).sequence;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function eventSessionId(event: unknown): string | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const value = (event as Record<string, unknown>).session_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function durableEventMetadata(path: string): { bytes: number; max_sequence: number | null } {
  if (!existsSync(path)) return { bytes: 0, max_sequence: null };
  try {
    const content = readFileSync(path, 'utf8');
    let maxSequence: number | null = null;
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const sequence = eventSequence(JSON.parse(line));
        if (sequence !== null && (maxSequence === null || sequence > maxSequence)) maxSequence = sequence;
      } catch {
        // Ignore incomplete or non-JSON historical lines when establishing the
        // current-turn baseline. The normal poller only consumes complete JSON.
      }
    }
    return { bytes: content.length, max_sequence: maxSequence };
  } catch {
    return { bytes: 0, max_sequence: null };
  }
}

function runtimeEventIdentity(event: unknown): string {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return `json:${JSON.stringify(event)}`;
  const sessionId = eventSessionId(event) ?? '';
  const sequence = eventSequence(event);
  if (sequence !== null) return `sequence:${sessionId}:${String(sequence)}`;
  return `json:${JSON.stringify(event)}`;
}

export async function runAgentRuntimeServerInvocation(options: {
  invocation: Invocation;
  prompt: string;
  eventsPath: string;
  diagnosticPath: string;
  lastMessagePath: string;
  maxRunMs: number;
  abortSignal?: AbortSignal;
}): Promise<{ exit_code: number | null; signal: string | null; cancelled: boolean; worker_session_id: string | null; error: string | null; event_error: string | null; runtime_error: string | null; assistant_extraction: Record<string, unknown> }> {
  return new Promise((resolvePromise) => {
    if (options.abortSignal?.aborted) {
      resolvePromise({ exit_code: null, signal: null, cancelled: true, worker_session_id: null, error: null, event_error: null, runtime_error: null, assistant_extraction: emptyAssistantExtraction() });
      return;
    }

    const admission = admitWorkerAiProcessInvocation(options.invocation, { projection: 'worker-delegation', purpose: 'agent_runtime_server_worker_runtime' });
    if (!admission.admitted) {
      resolvePromise({ exit_code: null, signal: null, cancelled: false, worker_session_id: null, error: workerAiProcessRefusalError(admission), event_error: null, runtime_error: null, assistant_extraction: emptyAssistantExtraction() });
      return;
    }

    const configuredDurableEventsPath = runtimeSessionEventsPath(options.invocation);
    const configuredSessionId = runtimeSessionId(options.invocation);
    const initialDurableMetadata = configuredDurableEventsPath
      ? durableEventMetadata(configuredDurableEventsPath)
      : { bytes: 0, max_sequence: null };
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
    const runtimeEvents = new AgentRuntimeEventTracker();
    let settled = false;
    let released = false;
    let cancelled = false;
    let eventError: string | null = null;
    let fatalRuntimeError: string | null = null;
    let stderrBuffer = '';
    let closeFrameSent = false;
    let submissionSent = false;
    let durableEventsOffset = initialDurableMetadata.bytes;
    let durableEventBaselineSequence = initialDurableMetadata.max_sequence;
    let durableEventsTimer: NodeJS.Timeout | null = null;
    let durableFallbackObserved = false;
    const seenRuntimeEvents = new Set<string>();

    const finish = (result: { exit_code: number | null; signal: string | null; cancelled: boolean; error: string | null }) => {
      if (settled) return;
      settled = true;
      if (!released) { released = true; releaseWorkerAiProcessInvocation(admission, { exitCode: result.exit_code, signal: result.signal }); }
      clearTimeout(timer);
      if (durableEventsTimer) clearInterval(durableEventsTimer);
      if (options.abortSignal) options.abortSignal.removeEventListener('abort', abortHandler);
      if (runtimeEvents.finalAssistantMessage !== null) {
        writeFileSync(options.lastMessagePath, `${JSON.stringify(workerOutputFromAgentMessage(runtimeEvents.finalAssistantMessage), null, 2)}\n`, 'utf8');
      }
      const finalResult = { ...result, worker_session_id: runtimeEvents.workerSessionId, event_error: eventError, runtime_error: runtimeEvents.runtimeError, assistant_extraction: runtimeEvents.evidence() };
      let ended = 0;
      const resolveAfterStreams = () => {
        ended += 1;
        if (ended === 2) resolvePromise(finalResult);
      };
      events.end(resolveAfterStreams);
      diagnostics.end(resolveAfterStreams);
    };

    const closeAfterTurn = () => {
      if (!submissionSent || !runtimeEvents.turnCompleted) return;
      if (closeFrameSent) return;
      closeFrameSent = true;
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return;
      try {
        stdin.write(`${JSON.stringify({ id: `worker-close-${Date.now()}`, method: 'session.close', params: {} })}\n`, (error) => {
          if (error) return;
          try { stdin.end(); } catch { /* already ended */ }
        });
      } catch {
        // Best effort; process close will carry diagnostics if this fails.
      }
    };

    const handleEvent = (event: unknown) => {
      runtimeEvents.handleEvent(event);
      if (!fatalRuntimeError && isUnavailableMcpRuntimeError(runtimeEvents.runtimeError ?? '')) {
        fatalRuntimeError = runtimeEvents.runtimeError;
        try { child.kill(); } catch { /* ignore */ }
      }
      closeAfterTurn();
    };

    const acceptRuntimeEvent = (event: unknown, rawLine: string) => {
      const sequence = eventSequence(event);
      if (configuredSessionId && eventSessionId(event) === configuredSessionId
        && sequence !== null && durableEventBaselineSequence !== null
        && sequence <= durableEventBaselineSequence) return;
      const identity = runtimeEventIdentity(event);
      if (seenRuntimeEvents.has(identity)) return;
      seenRuntimeEvents.add(identity);
      if (seenRuntimeEvents.size > 4096) seenRuntimeEvents.delete(seenRuntimeEvents.values().next().value as string);
      events.write(`${rawLine.trim()}\n`);
      handleEvent(event);
    };

    const durableEventsPath = configuredDurableEventsPath;
    const pollDurableEvents = () => {
      if (settled || !durableEventsPath || !existsSync(durableEventsPath)) return;
      try {
        const content = readFileSync(durableEventsPath, 'utf8');
        if (!durableFallbackObserved) {
          durableFallbackObserved = true;
          diagnostics.write(`durable_event_fallback_observed path=${durableEventsPath}\n`);
        }
        if (content.length < durableEventsOffset) {
          durableEventsOffset = 0;
          durableEventBaselineSequence = null;
        }
        const unread = content.slice(durableEventsOffset);
        const lastNewline = unread.lastIndexOf('\n');
        if (lastNewline < 0) return;
        const completeText = unread.slice(0, lastNewline + 1);
        const completeLines = completeText.split(/\r?\n/).slice(0, -1);
        durableEventsOffset += completeText.length;
        for (const line of completeLines) {
          if (!line.trim()) continue;
          try {
            acceptRuntimeEvent(JSON.parse(line), line);
          } catch {
            // The child stdout remains the primary protocol. Ignore durable
            // lines that are not independently parseable JSON records.
          }
        }
      } catch {
        // Durable evidence is a bounded fallback; stdout/close remains authoritative
        // when the session file is unavailable or temporarily locked.
      }
    };

    const handleDiagnosticChunk = (chunk: unknown) => {
      const text = String(chunk);
      diagnostics.write(text);
      stderrBuffer = `${stderrBuffer}${text}`.slice(-16_384);
      const detected = extractUnavailableMcpRuntimeError(stderrBuffer);
      if (!detected || fatalRuntimeError) return;
      fatalRuntimeError = detected;
      runtimeEvents.handleEvent({ event: 'error', message: detected });
      try { child.kill(); } catch { /* ignore */ }
    };

    const drainStdout = (chunk: string) => {
      stdoutBuffer += chunk;
      while (true) {
        const idx = stdoutBuffer.indexOf('\n');
        if (idx === -1) break;
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          acceptRuntimeEvent(JSON.parse(line), line);
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

    if (durableEventsPath) {
      diagnostics.write(`durable_event_fallback_configured path=${durableEventsPath} baseline_bytes=${durableEventsOffset} baseline_sequence=${durableEventBaselineSequence ?? 'none'}\n`);
      durableEventsTimer = setInterval(pollDurableEvents, 100);
      durableEventsTimer.unref?.();
      pollDurableEvents();
    } else {
      diagnostics.write('durable_event_fallback_unavailable\n');
    }

    const abortHandler = () => {
      cancelled = true;
      try { child.kill(); } catch { /* ignore */ }
    };
    if (options.abortSignal) options.abortSignal.addEventListener('abort', abortHandler, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => drainStdout(String(chunk)));
    child.stderr.on('data', handleDiagnosticChunk);
    child.on('error', (error) => { finish({ exit_code: null, signal: null, cancelled: false, error: fatalRuntimeError ?? error.message }); });
    child.on('close', (code, signal) => {
      if (stdoutBuffer.trim()) eventError ||= 'unterminated json event';
      const assistantExtraction = runtimeEvents.evidence();
      const terminalRuntimeError = fatalRuntimeError ?? (isUnavailableMcpRuntimeError(runtimeEvents.runtimeError ?? '') ? runtimeEvents.runtimeError : null);
      const missingTurnOutput = !cancelled && code === 0 && runtimeEvents.finalAssistantMessage === null ? runtimeEvents.runtimeError ?? missingAssistantMessageError(assistantExtraction) : null;
      finish({ exit_code: code, signal, cancelled, error: terminalRuntimeError ?? missingTurnOutput });
    });

    const requestId = `worker-conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    submissionSent = true;
    child.stdin?.write(`${JSON.stringify({
      id: requestId,
      method: 'session.submit',
      params: {
        content: options.prompt,
        source: 'programmatic_worker',
        source_id: 'worker-delegation-mcp',
      },
    })}\n`);
  });
}


export { parseLastMessage, resultStatus };
