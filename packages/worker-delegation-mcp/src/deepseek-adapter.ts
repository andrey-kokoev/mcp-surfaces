import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseLastMessage, resultStatus, type Invocation, type ResolvedWorkerConfig, type WorkerOutputParseResult, type WorkerRunTerminalStatus } from './codex-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type { Invocation, ResolvedWorkerConfig, WorkerOutputParseResult, WorkerRunTerminalStatus };

export function runtimeName(): 'deepseek-api' {
  return 'deepseek-api';
}

export function supportsResume(): boolean {
  return true;
}

export function buildDeepseekArgv(options: {
  schemaPath: string;
  lastMessagePath: string;
  model: string | null;
  reasoningEffort: string | null;
  mcpConfigPath: string | null;
  workerSessionId?: string;
}): string[] {
  const argv: string[] = [
    '--schema-path', options.schemaPath,
    '--last-message-path', options.lastMessagePath,
    '--model', options.model || 'deepseek-v4-flash',
    '--reasoning-effort', options.reasoningEffort || 'high',
  ];
  if (options.mcpConfigPath) argv.push('--mcp-config-file', options.mcpConfigPath);
  if (options.workerSessionId) argv.push('--worker-session-id', options.workerSessionId);
  return argv;
}

function workerScriptPath(): string {
  const inDist = __dirname.includes('dist') || __dirname.includes('dist\\');
  if (inDist) {
    return resolve(__dirname, 'deepseek-worker.js');
  }
  return resolve(__dirname, 'deepseek-worker.ts');
}

export function buildInvocation(resolvedWorkerConfig: ResolvedWorkerConfig, environment: Record<string, string>): Invocation {
  const scriptPath = workerScriptPath();
  const hasScript = resolvedWorkerConfig.command_args.some((arg) => arg.includes('deepseek-worker'));
  return {
    command: resolvedWorkerConfig.command,
    argv: hasScript
      ? [...resolvedWorkerConfig.command_args, ...resolvedWorkerConfig.argv]
      : [scriptPath, ...resolvedWorkerConfig.command_args, ...resolvedWorkerConfig.argv],
    cwd: resolvedWorkerConfig.cwd,
    environment,
  };
}

export async function runDeepseekInvocation(options: {
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
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const diagnostics = createWriteStream(options.diagnosticPath, { flags: 'a' });
    let workerSessionId: string | null = null;
    let settled = false;
    let cancelled = false;

    const timer = setTimeout(() => {
      cancelled = true;
      try { child.kill(); } catch { /* ignore */ }
    }, options.maxRunMs);

    const abortHandler = () => {
      cancelled = true;
      try { child.kill(); } catch { /* ignore */ }
    };
    if (options.abortSignal) options.abortSignal.addEventListener('abort', abortHandler, { once: true });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => diagnostics.write(String(chunk)));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      diagnostics.end();
      if (options.abortSignal) options.abortSignal.removeEventListener('abort', abortHandler);
      resolvePromise({ exit_code: null, signal: null, cancelled: false, worker_session_id: workerSessionId, error: error.message, event_error: null, runtime_error: null });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      diagnostics.end();
      if (options.abortSignal) options.abortSignal.removeEventListener('abort', abortHandler);
      if (!workerSessionId) {
        const sidPath = resolve(dirname(options.lastMessagePath), 'worker_session_id.txt');
        if (existsSync(resolve(dirname(options.lastMessagePath), 'worker_session_id.txt'))) {
          try {
            workerSessionId = readFileSync(sidPath, 'utf8').trim() || null;
          } catch {
            // ignore
          }
        }
      }
      resolvePromise({ exit_code: code, signal: signal, cancelled, worker_session_id: workerSessionId, error: null, event_error: null, runtime_error: null });
    });

    if (child.stdin) child.stdin.end(options.prompt, 'utf8');
  });
}

export { parseLastMessage, resultStatus };
