import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DIAGNOSTIC_STAGES = [
  'preflight',
  'mcp_initialize',
  'tools_list',
  'worker_admission',
  'runtime_session',
  'terminal_event',
  'output_contract',
  'persistence',
  'cleanup',
] as const;

export type DiagnosticStage = typeof DIAGNOSTIC_STAGES[number];

export type DiagnosticStatus = 'passed' | 'failed' | 'not_run';

export type DiagnosticAttempt = Record<string, unknown> & {
  schema: 'narada.worker.e2e.attempt.v1';
  result_schema: 'narada.mcp.e2e.result.v1';
  status: DiagnosticStatus;
  stage: DiagnosticStage;
  failure_stage: DiagnosticStage | null;
  attempt_id: string;
};

export type ChildDiagnosticSnapshot = {
  pid: number | null;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_tail: string;
  stderr_tail: string;
};

export function observeChild(child: ChildProcessWithoutNullStreams, tailLimit = 4_000): () => ChildDiagnosticSnapshot {
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTail = '';
  let stderrTail = '';
  let exitCode: number | null = child.exitCode;
  let signal: NodeJS.Signals | null = null;
  let error: string | null = null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string | Buffer) => {
    const text = String(chunk);
    stdoutBytes += Buffer.byteLength(text, 'utf8');
    stdoutTail = (stdoutTail + text).slice(-tailLimit);
  });
  child.stderr.on('data', (chunk: string | Buffer) => {
    const text = String(chunk);
    stderrBytes += Buffer.byteLength(text, 'utf8');
    stderrTail = (stderrTail + text).slice(-tailLimit);
  });
  child.once('error', (childError) => {
    error = childError instanceof Error ? childError.message : String(childError);
  });
  child.once('close', (code, childSignal) => {
    exitCode = code;
    signal = childSignal;
  });

  return () => ({
    pid: child.pid ?? null,
    exit_code: exitCode,
    signal,
    error,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    stdout_tail: stdoutTail,
    stderr_tail: stderrTail,
  });
}

export function writeDiagnosticAttempt(path: string, attempt: DiagnosticAttempt): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(attempt, null, 2), 'utf8');
}

export function diagnosticError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) return { message: error.message, stack: error.stack ?? null };
  return { message: String(error), stack: null };
}
