import { diagnosticError } from './errors.js';

export function renderToolResultText(value: unknown): string {
  const record = asRecord(value);
  if (record.result_materialized === true) return compactLines([
    `${record.tool_name ?? 'worker_result'}: materialized`,
    `status: ${record.status ?? 'ok'}`,
    'result: materialized',
    `reader_tool: ${record.reader_tool ?? 'none'}`,
    `full_output_byte_length: ${record.full_output_byte_length ?? ''}`,
  ]);
  if (record.schema === 'narada.worker.policy.v1') return renderPolicy(record);
  if (record.schema === 'narada.worker.config_resolve.v1') return renderConfigResolve(record);
  if (record.schema === 'narada.worker.run.v1') return renderRun(record);
  if (record.schema === 'narada.worker.runs_list.v1') return renderRunsList(record);
  if (record.schema === 'narada.worker.run_wait.v1') return renderRunWait(record);
  throw diagnosticError('worker_unrenderable_result_schema', 'worker_unrenderable_result_schema', { schema: record.schema ?? null });
}

function renderConfigResolve(record: Record<string, unknown>): string {
  const resolved = asRecord(record.resolved_worker_config);
  const invocation = asRecord(record.invocation);
  const runtimeAvailability = asRecord(record.runtime_availability);
  const configResolution = asRecord(record.config_resolution);
  return compactLines([
    'worker_config_resolve: ok',
    `runtime: ${resolved.runtime ?? ''}`,
    `cwd: ${resolved.cwd ?? ''}`,
    `sandbox: ${resolved.sandbox ?? ''}`,
    `requested_mode: ${record.requested_mode ?? ''}`,
    `model: ${resolved.model ?? 'null'}`,
    `model_source: ${configResolution.model_source ?? ''}`,
    `reasoning_effort: ${resolved.reasoning_effort ?? 'null'}`,
    `reasoning_effort_source: ${configResolution.reasoning_effort_source ?? ''}`,
    `runtime_available: ${runtimeAvailability.available ?? false}`,
    runtimeAvailability.reason ? `runtime_reason: ${runtimeAvailability.reason}` : null,
    `command: ${invocation.command ?? ''}`,
    `argv: ${arrayCount(invocation.argv)}`,
    `preflight: ${arrayCount(record.preflight)}`,
    `warnings: ${arrayCount(record.warnings)}`,
  ]);
}

function renderPolicy(record: Record<string, unknown>): string {
  return compactLines([
    'worker_policy: ok',
    `default_runtime: ${record.default_runtime ?? ''}`,
    `run_root: ${record.run_root ?? ''}`,
    `allowed_roots: ${arrayCount(record.allowed_roots)}`,
    `allowed_runtimes: ${arrayCount(record.allowed_runtimes)}`,
    `allowed_sandboxes: ${arrayList(record.allowed_sandboxes)}`,
    `allowed_config_keys: ${arrayList(record.allowed_config_keys)}`,
    `allow_raw_config_overrides: ${record.allow_raw_config_overrides ?? false}`,
    `allow_danger_full_access: ${record.allow_danger_full_access ?? false}`,
    `max_output_bytes: ${record.max_output_bytes ?? ''}`,
  ]);
}

function renderRun(record: Record<string, unknown>): string {
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  const progress = asRecord(record.progress);
  const exitInterview = asRecord(record.exit_interview);
  return compactLines([
    `worker_run: ${record.status ?? ''}`,
    `run_id: ${record.run_id ?? ''}`,
    `run_dir: ${record.run_dir ?? ''}`,
    `runtime: ${record.runtime ?? ''}`,
    `requested_mode: ${record.requested_mode ?? ''}`,
    `confidence: ${record.confidence ?? ''}`,
    `edits_performed: ${record.edits_performed ?? 'null'}`,
    `warning_count: ${record.warning_count ?? 0}`,
    `worker_session_id: ${record.worker_session_id ?? 'null'}`,
    `summary: ${record.summary ?? ''}`,
    progress.latest_event_preview ? `progress: ${progress.latest_event_preview}` : null,
    exitInterview.ergonomics_feedback ? `ergonomics: ${exitInterview.ergonomics_feedback}` : null,
    `deliverables: ${arrayCount(record.deliverables)}`,
    `open_questions: ${arrayCount(record.open_questions)}`,
    `next_actions: ${arrayCount(record.next_actions)}`,
    `artifacts: ${artifacts.length}`,
    ...artifacts.map((artifact) => {
      const item = asRecord(artifact);
      return `- ${item.name ?? ''}: ${item.path ?? ''}`;
    }),
    record.error ? `error: ${record.error}` : null,
  ]);
}

function renderRunsList(record: Record<string, unknown>): string {
  const runs = Array.isArray(record.runs) ? record.runs : [];
  return compactLines([
    'worker_runs_list: ok',
    `count: ${record.count ?? runs.length}`,
    `limit: ${record.limit ?? ''}`,
    ...runs.map((run) => {
      const item = asRecord(run);
      return `- ${item.status ?? ''} ${item.requested_mode ?? ''} ${item.authority ?? ''} ${item.run_id ?? ''} ${item.finished_at ?? item.started_at ?? ''} ${item.progress_preview ?? item.summary_preview ?? ''}`.trim();
    }),
  ]);
}

function renderRunWait(record: Record<string, unknown>): string {
  const wait = asRecord(record.wait);
  const run = asRecord(record.run);
  return compactLines([
    `worker_run_wait: ${wait.status ?? ''}`,
    `run_id: ${run.run_id ?? ''}`,
    `status: ${run.status ?? ''}`,
    `summary: ${run.summary ?? run.summary_preview ?? ''}`,
    run.progress_preview ? `progress: ${run.progress_preview}` : null,
    run.error_preview ? `error: ${run.error_preview}` : null,
  ]);
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function arrayList(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(',') : '';
}

function compactLines(lines: Array<string | null>): string {
  return lines.filter((line) => typeof line === 'string' && line.length > 0).join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
