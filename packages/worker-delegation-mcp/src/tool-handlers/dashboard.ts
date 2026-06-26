import { resolve } from 'node:path';
import { diagnosticError } from '../errors.js';
import { compactEventStream, compactRunError, previewString } from '../diagnostics.js';
import { isTerminalRunStatus, modeWithInference } from './status.js';

export function dashboardMode(value: unknown, runId: unknown): 'all_active' | 'single_run' {
  if (value === undefined || value === null || value === '') return typeof runId === 'string' && runId.trim() ? 'single_run' : 'all_active';
  const mode = String(value).trim();
  if (mode === 'all_active' || mode === 'single_run') return mode;
  throw diagnosticError('worker_invalid_dashboard_mode', 'worker_invalid_dashboard_mode', { mode });
}

export function dashboardRun(run: Record<string, unknown>): Record<string, unknown> {
  const timing = asRecord(run.timing);
  const config = asRecord(run.resolved_worker_config);
  const progress = asRecord(run.progress);
  const runDir = typeof run.run_dir === 'string' ? run.run_dir : null;
  return {
    run_id: run.run_id,
    status: run.status,
    completion_state: run.completion_state ?? run.confidence ?? null,
    requested_mode: modeWithInference(run).requestedMode,
    runtime: run.runtime ?? config.runtime ?? null,
    authority: config.authority ?? null,
    worker_session_id: run.worker_session_id ?? null,
    started_at: timing.started_at ?? null,
    finished_at: timing.finished_at ?? null,
    duration_ms: timing.duration_ms ?? null,
    retry: { attempt: 1, max_attempts: 1, source: 'not_recorded' },
    failure: {
      error_preview: previewString(compactRunError(run), 180),
      error_classification: run.error_classification ?? null,
      warning_count: run.warning_count ?? 0,
    },
    result_refs: dashboardResultRefs(run),
    progress: {
      event_count: progress.event_count ?? 0,
      latest_event_type: progress.latest_event_type ?? null,
      latest_event_preview: progress.latest_event_preview ?? null,
      latest_event_at: progress.latest_event_at ?? null,
      readable: progress.readable ?? false,
    },
    events: runDir ? compactEventStream(resolve(runDir, 'events.jsonl'), 8) : [],
    status_liveness: run.status_liveness ?? null,
    progress_state: run.progress_state ?? null,
    budget_status: run.budget_status ?? null,
    recent_activity: Array.isArray(run.recent_activity) ? run.recent_activity : [],
  };
}

export function dashboardPendingJoinGates(runs: Record<string, unknown>[]): Record<string, unknown>[] {
  return runs.filter((run) => !isTerminalRunStatus(String(run.status ?? ''))).map((run) => ({
    gate_id: `join:${run.run_id}`,
    run_id: run.run_id,
    status: 'pending',
    waiting_for: [run.run_id],
  }));
}

export function dashboardApiEndpoints(): Record<string, unknown>[] {
  return [
    { path: 'mcp://tools/worker_dashboard_describe', method: 'tools/call', description: 'Read-only compact dashboard payload for one run or all active runs.', arguments: { mode: 'all_active|single_run', run_id: 'optional run id', include_terminal: 'boolean', limit: '1..200' } },
    { path: 'mcp://tools/worker_runs_list', method: 'tools/call', description: 'Recent run index with compact status fields.', arguments: { include_running: true, include_completed: true, verbose: false } },
    { path: 'mcp://tools/worker_run_status', method: 'tools/call', description: 'Full status for one run, including artifact readback and progress.', arguments: { run_id: 'run-*' } },
    { path: 'mcp://resources/worker-artifact', method: 'resources/read', description: 'Read run artifacts such as events.jsonl and result.json for primary run-root records.' },
  ];
}

function dashboardResultRefs(run: Record<string, unknown>): Record<string, unknown>[] {
  const refs = [];
  const artifactReadback = asRecord(run.artifact_readback);
  if (typeof run.run_dir === 'string') refs.push({ name: 'run_dir', kind: 'local_path', ref: run.run_dir });
  if (typeof artifactReadback.events_tail === 'string') refs.push({ name: 'events_tail', kind: 'inline_preview', ref: 'artifact_readback.events_tail' });
  if (Array.isArray(run.artifacts)) {
    for (const artifact of run.artifacts.map(asRecord)) {
      if (typeof artifact.name === 'string' && typeof artifact.path === 'string') refs.push({ name: artifact.name, kind: 'local_path', ref: artifact.path });
    }
  }
  return refs;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
