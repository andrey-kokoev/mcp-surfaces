import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readDiagnosticTail } from './diagnostics.js';
import { parseLastMessage, workerOutputFromAgentMessage, type WorkerOutput } from './output-contract.js';
import { runArtifacts } from './run-store.js';
import { writeJson } from './run-record.js';
import { assistantMessageText, eventTimestamp, eventType } from './runtime-events.js';
import type { WorkerMcpState } from './state.js';

const RUN_STATUS_GRACE_MS = 60_000;

export function recoverOrphanedRunningRun(run: Record<string, unknown>, state: WorkerMcpState): Record<string, unknown> {
  if (run.status !== 'running') return run;
  const runDir = typeof run.run_dir === 'string' ? run.run_dir : null;
  if (!runDir) return run;
  const timing = asRecord(run.timing);
  const startedAtMs = Date.parse(String(timing.started_at ?? ''));
  if (!Number.isFinite(startedAtMs)) return run;
  const resolvedConfig = asRecord(run.resolved_worker_config);
  const maxRunMsValue = typeof resolvedConfig.max_run_ms === 'number' ? resolvedConfig.max_run_ms : state.policy.maxRunMs;
  if (Date.now() - startedAtMs <= maxRunMsValue + RUN_STATUS_GRACE_MS) return run;
  const parsed = parseLastMessage(resolve(runDir, 'last_message.json'));
  if (!parsed.ok) return run;
  const output = parsed.data;
  const finishedAt = new Date(startedAtMs + maxRunMsValue);
  const existingWarnings = Array.isArray(run.runtime_warnings) ? run.runtime_warnings.map(String) : [];
  const warning = 'worker_run_orphaned_final_output: valid last_message.json exists, but result.json was not finalized before max_run_ms elapsed';
  const runtimeWarnings = existingWarnings.includes(warning) ? existingWarnings : [...existingWarnings, warning];
  return {
    ...run,
    status: 'completed_with_errors',
    edits_performed: output.edits_performed,
    target_state_changed: output.target_state_changed,
    confidence: 'partial',
    runtime_warnings: runtimeWarnings,
    warning_count: runtimeWarnings.length,
    summary: output.summary,
    deliverables: output.deliverables,
    open_questions: output.open_questions,
    next_actions: output.next_actions,
    changes: output.changes,
    verification_results: output.verification,
    exit_interview: output.exit_interview ?? null,
    timing: {
      ...timing,
      finished_at: finishedAt.toISOString(),
      duration_ms: maxRunMsValue,
    },
    error: warning,
  };
}

export function recoverExpiredRunningRun(run: Record<string, unknown>, state: WorkerMcpState, resultPath?: string): Record<string, unknown> {
  if (run.status !== 'running') return run;
  const runDir = typeof run.run_dir === 'string' ? run.run_dir : null;
  if (!runDir) return run;
  const timing = asRecord(run.timing);
  const startedAtMs = Date.parse(String(timing.started_at ?? ''));
  if (!Number.isFinite(startedAtMs)) return run;
  const resolvedConfig = asRecord(run.resolved_worker_config);
  const maxRunMsValue = typeof resolvedConfig.max_run_ms === 'number' ? resolvedConfig.max_run_ms : state.policy.maxRunMs;
  const expiredAtMs = startedAtMs + maxRunMsValue + RUN_STATUS_GRACE_MS;
  if (Date.now() <= expiredAtMs) return run;
  const parsed = parseLastMessage(resolve(runDir, 'last_message.json'));
  if (parsed.ok) return run;
  const existingWarnings = Array.isArray(run.runtime_warnings) ? run.runtime_warnings.map(String) : [];
  const warning = 'worker_run_expired_without_terminal_output: run stayed running past max_run_ms plus grace without a usable last_message.json';
  const runtimeWarnings = existingWarnings.includes(warning) ? existingWarnings : [...existingWarnings, warning];
  const diagnosticTail = readDiagnosticTail(resolve(runDir, 'diagnostic.log'));
  const recoveredRun = {
    ...run,
    status: 'failed',
    confidence: 'partial',
    completion_state: 'partial',
    runtime_warnings: runtimeWarnings,
    warning_count: runtimeWarnings.length,
    timing: {
      ...timing,
      finished_at: new Date(expiredAtMs).toISOString(),
      duration_ms: maxRunMsValue + RUN_STATUS_GRACE_MS,
    },
    error: warning,
    error_classification: 'worker_run_expired_without_terminal_output',
    ...(diagnosticTail ? { diagnostic_tail: diagnosticTail } : {}),
  };
  if (resultPath) writeJson(resultPath, recoveredRun);
  return recoveredRun;
}

export function recoverCompletedRunFromEvents(run: Record<string, unknown>, resultPath: string): Record<string, unknown> {
  if (run.status !== 'running') return run;
  const runDir = typeof run.run_dir === 'string' ? run.run_dir : null;
  if (!runDir) return run;
  const lastMessagePath = resolve(runDir, 'last_message.json');
  if (existsSync(lastMessagePath)) return run;
  const recovered = recoverWorkerOutputFromEvents(resolve(runDir, 'events.jsonl'));
  if (!recovered) return run;

  writeJson(lastMessagePath, recovered.output);
  const timing = asRecord(run.timing);
  const startedAtMs = Date.parse(String(timing.started_at ?? ''));
  const finishedAtMs = recovered.finishedAt.getTime();
  const existingWarnings = Array.isArray(run.runtime_warnings) ? run.runtime_warnings.map(String) : [];
  const warning = 'worker_run_recovered_from_events: turn.completed observed with final agent_message, but last_message.json was missing';
  const runtimeWarnings = existingWarnings.includes(warning) ? existingWarnings : [...existingWarnings, warning];
  const output = recovered.output;
  const recoveredRun = {
    ...run,
    status: 'completed_with_errors',
    edits_performed: output.edits_performed,
    target_state_changed: output.target_state_changed,
    confidence: 'partial',
    runtime_warnings: runtimeWarnings,
    warning_count: runtimeWarnings.length,
    summary: output.summary,
    deliverables: output.deliverables,
    open_questions: output.open_questions,
    next_actions: output.next_actions,
    changes: output.changes,
    verification_results: output.verification,
    exit_interview: output.exit_interview ?? null,
    artifacts: Array.isArray(run.artifacts) ? run.artifacts : runArtifacts({
      runId: String(run.run_id ?? ''),
      runDir,
      requestPath: resolve(runDir, 'request.json'),
      executorRequestPath: resolve(runDir, 'executor_request.json'),
      resolvedConfigPath: resolve(runDir, 'resolved_worker_config.json'),
      promptPath: resolve(runDir, 'worker_prompt.txt'),
      invocationPath: resolve(runDir, 'worker_invocation.json'),
      eventsPath: resolve(runDir, 'events.jsonl'),
      diagnosticPath: resolve(runDir, 'diagnostic.log'),
      lastMessagePath,
      resultPath,
      schemaPath: resolve(runDir, 'worker_output.schema.json'),
    }),
    timing: {
      ...timing,
      finished_at: recovered.finishedAt.toISOString(),
      duration_ms: Number.isFinite(startedAtMs) ? Math.max(0, finishedAtMs - startedAtMs) : null,
    },
    error: warning,
  };
  writeJson(resultPath, recoveredRun);
  return recoveredRun;
}

export function reapEvidence(run: Record<string, unknown>, reason: string, force: boolean): Record<string, unknown> {
  const liveness = asRecord(run.status_liveness);
  return {
    reason,
    force,
    previous_status: run.status ?? null,
    status_liveness: liveness,
    process_liveness: liveness.process_liveness ?? 'unknown',
    process_verification: 'not_available:no_run_pid_recorded',
    stale_confirmed: liveness.state === 'stale',
    reaped_at: new Date().toISOString(),
  };
}

function recoverWorkerOutputFromEvents(eventsPath: string): { output: WorkerOutput; finishedAt: Date } | null {
  if (!existsSync(eventsPath)) return null;
  let terminalSeen = false;
  let finalAgentMessage: string | null = null;
  let finishedAt: Date | null = null;
  try {
    const lines = readFileSync(eventsPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const type = eventType(event);
      if (type === 'agent_message') {
        finalAgentMessage = assistantMessageText(asRecord(event)) ?? finalAgentMessage;
      }
      if (type === 'turn.completed') {
        terminalSeen = true;
        finishedAt = eventTimestamp(event) ?? finishedAt;
      }
    }
  } catch {
    return null;
  }
  if (!terminalSeen || !finalAgentMessage) return null;
  return { output: workerOutputFromAgentMessage(finalAgentMessage), finishedAt: finishedAt ?? new Date() };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
