import { compactRunError, previewString } from '../diagnostics.js';
import type { WorkerDelegationMode } from '../worker-types.js';

export function includeRunByStatus(status: string, options: { includeCompleted: boolean; includeRunning: boolean }): boolean {
  if (status === 'running') return options.includeRunning;
  if (isTerminalRunStatus(status)) return options.includeCompleted;
  return true;
}

export function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'completed_with_errors' || status === 'failed' || status === 'cancelled';
}

export function runSortKey(run: Record<string, unknown>): string {
  const timing = asRecord(run.timing);
  return String(timing.finished_at ?? timing.started_at ?? run.run_id ?? '');
}

export function runListItem(run: Record<string, unknown>, options: { verbose: boolean; includeSummary: boolean }): Record<string, unknown> {
  const timing = asRecord(run.timing);
  const mode = modeWithInference(run);
  const progress = asRecord(run.progress);
  const item: Record<string, unknown> = {
    run_id: run.run_id,
    status: run.status,
    completion_state: run.completion_state ?? run.confidence ?? null,
    requested_mode: mode.requestedMode,
    requested_mode_inferred: mode.inferred,
    authority: asRecord(run.resolved_worker_config).authority ?? null,
    started_at: timing.started_at ?? null,
    finished_at: timing.finished_at ?? null,
    duration_ms: timing.duration_ms ?? null,
    summary_preview: previewString(run.summary, 180),
    error_preview: previewString(compactRunError(run), 180),
    error_classification: run.error_classification ?? null,
    warning_count: run.warning_count ?? 0,
    progress_preview: progress.latest_event_preview ?? null,
    latest_event_type: progress.latest_event_type ?? null,
    progress: run.progress ?? null,
  };
  if (run.status_liveness !== undefined) item.status_liveness = run.status_liveness;
  if (options.includeSummary) item.summary = String(run.summary ?? '');
  if (options.verbose) {
    item.run_dir = run.run_dir;
    item.worker_session_id = run.worker_session_id;
    item.timing = run.timing;
    item.error = run.error;
    item.diagnostic_tail = run.diagnostic_tail ?? null;
    item.error_classification = run.error_classification ?? null;
  }
  return item;
}

export function runWaitPayload(run: Record<string, unknown>, options: { status: 'finished' | 'timed_out'; timeoutMs: number; elapsedMs: number; verbose: boolean; summaryOnly: boolean }): Record<string, unknown> {
  const compact = runListItem(run, { verbose: options.verbose, includeSummary: options.summaryOnly || options.verbose });
  const payload: Record<string, unknown> = {
    schema: 'narada.worker.run_wait.v1',
    status: 'ok',
    wait: { status: options.status, timeout_ms: options.timeoutMs, elapsed_ms: options.elapsedMs },
    run: options.summaryOnly ? summaryOnlyRun(compact) : compact,
  };
  if (options.verbose) payload.full_run = run;
  return payload;
}

export function modeWithInference(run: Record<string, unknown>): { requestedMode: WorkerDelegationMode | null; inferred: boolean } {
  const direct = run.requested_mode ?? asRecord(run.executor_request).requested_mode ?? asRecord(asRecord(run.executor_request).intent).mode;
  if (direct === 'audit_only' || direct === 'plan_only' || direct === 'implement' || direct === 'implement_and_verify') return { requestedMode: direct, inferred: false };
  const authority = asRecord(run.resolved_worker_config).authority;
  if (authority === 'write' || authority === 'command') return { requestedMode: 'implement', inferred: true };
  if (authority === 'read') return { requestedMode: 'audit_only', inferred: true };
  return { requestedMode: null, inferred: false };
}

function summaryOnlyRun(run: Record<string, unknown>): Record<string, unknown> {
  return {
    run_id: run.run_id,
    status: run.status,
    summary: run.summary ?? run.summary_preview ?? '',
    error_preview: run.error_preview ?? null,
    progress: run.progress ?? null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
