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
  if (record.schema === 'narada.worker.run_reap.v1') return renderRunReap(record);
  if (record.schema === 'narada.worker.runs_list.v1') return renderRunsList(record);
  if (record.schema === 'narada.worker.run_wait.v1') return renderRunWait(record);
  if (record.schema === 'narada.worker.run_batch.v1') return renderRunBatch(record);
  if (record.schema === 'narada.worker.run_wait_batch.v1') return renderRunWaitBatch(record);
  if (record.schema === 'narada.worker.runs_synthesis.v1') return renderRunsSynthesis(record);
  if (record.schema === 'narada.worker.dashboard.v1') return renderDashboard(record);
  throw diagnosticError('worker_unrenderable_result_schema', 'worker_unrenderable_result_schema', { schema: record.schema ?? null });
}

function renderRunReap(record: Record<string, unknown>): string {
  const evidence = asRecord(record.evidence);
  const run = asRecord(record.run);
  return compactLines([
    `worker_run_reap: ${record.status ?? ''}`,
    `run_id: ${record.run_id ?? ''}`,
    `reaped: ${record.reaped ?? false}`,
    `run_status: ${run.status ?? ''}`,
    `stale_confirmed: ${evidence.stale_confirmed ?? false}`,
    `process_liveness: ${evidence.process_liveness ?? 'unknown'}`,
    `process_verification: ${evidence.process_verification ?? 'unknown'}`,
    evidence.reason ? `reason: ${evidence.reason}` : null,
  ]);
}

function renderConfigResolve(record: Record<string, unknown>): string {
  const resolved = asRecord(record.resolved_worker_config);
  const invocation = asRecord(record.invocation);
  const runtimeAvailability = asRecord(record.runtime_availability);
  const configResolution = asRecord(record.config_resolution);
  const siteBinding = asRecord(resolved.site_binding);
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
    resolved.runtime === 'narada-agent-runtime-server' ? `site_bound: ${Boolean(resolved.site_bound)}` : null,
    resolved.runtime === 'narada-agent-runtime-server' ? `site_root: ${resolved.site_root ?? 'missing'}` : null,
    resolved.runtime === 'narada-agent-runtime-server' ? `workspace_root: ${resolved.workspace_root ?? 'missing'}` : null,
    resolved.runtime === 'narada-agent-runtime-server' ? `provider: ${resolved.provider ?? 'runtime_default'}` : null,
    resolved.runtime === 'narada-agent-runtime-server' ? `provider_source: ${resolved.provider_source ?? 'runtime_default'}` : null,
    siteBinding.source ? `site_root_source: ${siteBinding.source}` : null,
    siteBinding.matched_marker ? `site_matched_marker: ${siteBinding.matched_marker}` : null,
    siteBinding.required_markers ? `site_required_markers: ${arrayList(siteBinding.required_markers)}` : null,
    resolved.runtime === 'narada-agent-runtime-server' ? `site_environment: NARADA_SITE_ROOT=${arrayIncludes(resolved.environment_keys, 'NARADA_SITE_ROOT')} NARADA_WORKSPACE_ROOT=${arrayIncludes(resolved.environment_keys, 'NARADA_WORKSPACE_ROOT')} NARADA_AGENT_ID=${arrayIncludes(resolved.environment_keys, 'NARADA_AGENT_ID')} NARADA_CARRIER_SESSION_ID=${arrayIncludes(resolved.environment_keys, 'NARADA_CARRIER_SESSION_ID')}` : null,
    resolved.runtime === 'narada-agent-runtime-server' ? `provider_environment: NARADA_INTELLIGENCE_PROVIDER=${arrayIncludes(resolved.environment_keys, 'NARADA_INTELLIGENCE_PROVIDER')}` : null,
    `runtime_available: ${runtimeAvailability.available ?? false}`,
    runtimeAvailability.reason ? `runtime_reason: ${runtimeAvailability.reason}` : null,
    `command: ${invocation.command ?? ''}`,
    `argv: ${arrayCount(invocation.argv)}`,
    `preflight: ${arrayCount(record.preflight)}`,
    `warnings: ${arrayCount(record.warnings)}`,
  ]);
}

function renderPolicy(record: Record<string, unknown>): string {
  const narsSiteSemantics = asRecord(record.nars_site_semantics);
  return compactLines([
    'worker_policy: ok',
    `default_runtime: ${record.default_runtime ?? ''}`,
    `run_root: ${record.run_root ?? ''}`,
    `allowed_roots: ${arrayCount(record.allowed_roots)}`,
    `allowed_runtimes: ${arrayCount(record.allowed_runtimes)}`,
    `allowed_nars_providers: ${arrayList(record.allowed_narada_agent_runtime_providers)}`,
    `nars_site_bound: ${asRecord(record.runtimes)['narada-agent-runtime-server'] ? asRecord(asRecord(record.runtimes)['narada-agent-runtime-server']).site_bound ?? false : false}`,
    `nars_site_markers: ${arrayList(asRecord(asRecord(record.runtimes)['narada-agent-runtime-server']).site_root_markers)}`,
    narsSiteSemantics.remediation ? `nars_site_remediation: ${narsSiteSemantics.remediation}` : null,
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
  const liveness = asRecord(record.status_liveness);
  const progressState = asRecord(record.progress_state);
  const budgetStatus = asRecord(record.budget_status);
  const exitInterview = asRecord(record.exit_interview);
  return compactLines([
    `worker_run: ${record.status ?? ''}`,
    `run_id: ${record.run_id ?? ''}`,
    `run_dir: ${record.run_dir ?? ''}`,
    `runtime: ${record.runtime ?? ''}`,
    `requested_mode: ${record.requested_mode ?? ''}`,
    `completion_state: ${record.completion_state ?? record.confidence ?? ''}`,
    `confidence: ${record.confidence ?? ''}`,
    `edits_performed: ${record.edits_performed ?? 'null'}`,
    `verification_budget_respected: ${record.verification_budget_respected ?? 'null'}`,
    `broad_unrelated_failures: ${arrayCount(record.broad_unrelated_failures)}`,
    `warning_count: ${record.warning_count ?? 0}`,
    `worker_session_id: ${record.worker_session_id ?? 'null'}`,
    `summary: ${record.summary ?? ''}`,
    progress.latest_event_preview ? `progress: ${progress.latest_event_preview}` : null,
    progressState.state ? `progress_state: ${progressState.state} action=${progressState.current_action ?? ''} recommended=${progressState.recommended_action ?? ''}` : null,
    budgetStatus.elapsed_ms !== undefined ? `budget: elapsed_ms=${budgetStatus.elapsed_ms ?? 'null'} remaining_ms=${budgetStatus.remaining_ms ?? 'null'} events=${budgetStatus.event_count ?? 0}` : null,
    liveness.state ? `liveness: ${liveness.state} stale_for_ms=${liveness.stale_for_ms ?? 0} process=${liveness.process_liveness ?? 'unknown'}` : null,
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
      const liveness = asRecord(item.status_liveness);
      const progressState = asRecord(item.progress_state);
      const livenessText = liveness.state ? `liveness=${liveness.state}` : '';
      const progressStateText = progressState.state ? `progress_state=${progressState.state}` : '';
      return `- ${item.status ?? ''} ${item.requested_mode ?? ''} ${item.authority ?? ''} ${item.run_id ?? ''} ${item.finished_at ?? item.started_at ?? ''} ${livenessText} ${progressStateText} ${item.progress_preview ?? item.summary_preview ?? ''}`.trim();
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

function renderRunBatch(record: Record<string, unknown>): string {
  return compactLines([
    `worker_run_batch: ${record.status ?? ''}`,
    `requested_count: ${record.requested_count ?? ''}`,
    `started_count: ${record.started_count ?? ''}`,
    `failed_count: ${record.failed_count ?? 0}`,
    `run_ids: ${arrayList(record.run_ids)}`,
  ]);
}

function renderRunWaitBatch(record: Record<string, unknown>): string {
  return compactLines([
    'worker_run_wait_batch: ok',
    `requested_count: ${record.requested_count ?? ''}`,
    `finished_count: ${record.finished_count ?? ''}`,
    `timed_out_count: ${record.timed_out_count ?? 0}`,
  ]);
}

function renderRunsSynthesis(record: Record<string, unknown>): string {
  const synthesis = asRecord(record.synthesis);
  return compactLines([
    'worker_runs_synthesize: ok',
    `requested_count: ${record.requested_count ?? ''}`,
    `rows: ${arrayCount(synthesis.rows)}`,
  ]);
}

function renderDashboard(record: Record<string, unknown>): string {
  const counts = asRecord(record.counts);
  const runs = Array.isArray(record.runs) ? record.runs : [];
  const topology = asRecord(record.topology);
  return compactLines([
    'worker_dashboard_describe: ok',
    `mode: ${record.mode ?? ''}`,
    `active: ${counts.active ?? 0}`,
    `terminal: ${counts.terminal ?? 0}`,
    `runs: ${runs.length}`,
    `topology_nodes: ${arrayCount(topology.nodes)}`,
    `topology_edges: ${arrayCount(topology.edges)}`,
    ...runs.map((run) => {
      const item = asRecord(run);
      const progress = asRecord(item.progress);
      return `- ${item.status ?? ''} ${item.run_id ?? ''} session=${item.worker_session_id ?? 'null'} ${progress.latest_event_preview ?? ''}`.trim();
    }),
  ]);
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function arrayIncludes(value: unknown, item: string): boolean {
  return Array.isArray(value) && value.includes(item);
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
