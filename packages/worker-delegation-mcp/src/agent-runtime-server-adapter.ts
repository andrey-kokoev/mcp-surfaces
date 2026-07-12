import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
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

    const finish = (result: { exit_code: number | null; signal: string | null; cancelled: boolean; error: string | null }) => {
      if (settled) return;
      settled = true;
      if (!released) { released = true; releaseWorkerAiProcessInvocation(admission, { exitCode: result.exit_code, signal: result.signal }); }
      clearTimeout(timer);
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
      if (!runtimeEvents.turnCompleted) return;
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
    child.stderr.on('data', handleDiagnosticChunk);
    child.on('error', (error) => finish({ exit_code: null, signal: null, cancelled: false, error: fatalRuntimeError ?? error.message }));
    child.on('close', (code, signal) => {
      if (stdoutBuffer.trim()) eventError ||= 'unterminated json event';
      const assistantExtraction = runtimeEvents.evidence();
      const terminalRuntimeError = fatalRuntimeError ?? (isUnavailableMcpRuntimeError(runtimeEvents.runtimeError ?? '') ? runtimeEvents.runtimeError : null);
      const missingTurnOutput = !cancelled && code === 0 && runtimeEvents.finalAssistantMessage === null ? runtimeEvents.runtimeError ?? missingAssistantMessageError(assistantExtraction) : null;
      finish({ exit_code: code, signal, cancelled, error: terminalRuntimeError ?? missingTurnOutput });
    });

    const requestId = `worker-conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
