import { diagnosticError } from './errors.js';

export function renderToolResultText(value: unknown): string {
  const record = asRecord(value);
  if (record.schema === 'narada.worker.output_show.v1') return String(record.output_text ?? '');
  if (record.schema === 'narada.worker.output_ref.v1' || record.result_materialized === true) return compactLines([
    `${record.tool_name ?? 'worker_result'}: materialized`,
    `status: ${record.status ?? 'ok'}`,
    'result: materialized',
    `output_ref: ${record.output_ref ?? ''}`,
    `reader_tool: ${record.reader_tool ?? 'worker_output_show'}`,
    `full_output_byte_length: ${record.full_output_byte_length ?? ''}`,
  ]);
  if (record.schema === 'narada.worker.policy.v1') return renderPolicy(record);
  if (record.schema === 'narada.worker.run.v1') return renderRun(record);
  throw diagnosticError('worker_unrenderable_result_schema', 'worker_unrenderable_result_schema', { schema: record.schema ?? null });
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
  return compactLines([
    `worker_run: ${record.status ?? ''}`,
    `run_id: ${record.run_id ?? ''}`,
    `run_dir: ${record.run_dir ?? ''}`,
    `runtime: ${record.runtime ?? ''}`,
    `worker_session_id: ${record.worker_session_id ?? 'null'}`,
    `summary: ${record.summary ?? ''}`,
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
