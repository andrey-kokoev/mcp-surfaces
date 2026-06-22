type WorkerToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export function listTools(): WorkerToolDefinition[] {
  return decorateTools([
    { name: 'worker_policy_inspect', description: 'Inspect the active worker delegation policy, including narada-agent-runtime-server Site binding markers and environment projection.', inputSchema: objectSchema({}) },
    { name: 'worker_config_resolve', description: 'Resolve worker run inputs without launching a worker, including narada-agent-runtime-server Site binding status.', inputSchema: objectSchema({
      worker_session_id: { type: 'string', description: 'Optional existing worker session whose constraints should be inherited like worker_resume.' },
      intent: intentSchema(),
      constraints: constraintRequestSchema(),
    }, ['intent', 'constraints']) },
    { name: 'worker_run', description: 'Start one new worker run for one delegated instruction.', inputSchema: objectSchema({
      intent: intentSchema(),
      constraints: constraintRequestSchema(),
    }, ['intent', 'constraints']) },
    { name: 'worker_edit', description: 'Start one edit-capable worker run shortcut using write authority and low cognition.', inputSchema: objectSchema({
      cwd: { type: 'string' },
      site_root: { type: 'string', description: 'Explicit Narada Site root for narada-agent-runtime-server workers. Defaults to nearest Site marker above cwd.' },
      instruction: { type: 'string' },
      resumable: { type: 'boolean' },
      wait_for_completion: { type: 'boolean', description: 'When true, block until completion. Defaults to false so delegation returns promptly with run_id.' },
      exit_interview: { type: 'boolean', description: 'Ask the worker to include ergonomics feedback in its final output.' },
      overrides: constraintOverrideSchema(),
    }, ['cwd', 'instruction']) },
    { name: 'worker_resume', description: 'Continue one existing worker session.', inputSchema: objectSchema({
      worker_session_id: { type: 'string' },
      intent: intentSchema(),
      constraints: constraintRequestSchema(),
    }, ['worker_session_id', 'constraints']) },
    { name: 'worker_run_status', description: 'Inspect a worker run by run id without waiting for completion.', inputSchema: objectSchema({
      run_id: { type: 'string' },
    }, ['run_id']) },
    { name: 'worker_runs_list', description: 'List recent worker runs so callers can rediscover outstanding run ids.', inputSchema: objectSchema({
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      include_running: { type: 'boolean' },
      include_completed: { type: 'boolean' },
      include_summary: { type: 'boolean', description: 'Include full summaries in each compact list item.' },
      verbose: { type: 'boolean', description: 'Include full run path, timing object, session id, and full error fields.' },
    }) },
    { name: 'worker_run_wait', description: 'Wait briefly for one worker run to finish, returning the latest run status on timeout.', inputSchema: objectSchema({
      run_id: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 0, maximum: 300000 },
      poll_ms: { type: 'integer', minimum: 25, maximum: 10000 },
      summary_only: { type: 'boolean', description: 'Return only run id, status, summary, and error preview.' },
      verbose: { type: 'boolean', description: 'Include the full worker run payload as full_run.' },
    }, ['run_id']) },
  ]);
}

function workerRunsListOutputSchema(): Record<string, unknown> {
  return objectSchema({
    schema: { type: 'string', const: 'narada.worker.runs_list.v1' },
    status: { type: 'string', const: 'ok' },
    count: { type: 'integer' },
    limit: { type: 'integer' },
    verbose: { type: 'boolean' },
    include_summary: { type: 'boolean' },
    runs: { type: 'array', items: objectSchema({
      run_id: { type: 'string' },
      status: { type: 'string' },
      completion_state: { type: ['string', 'null'], enum: ['complete', 'partial', null] },
      requested_mode: nullableStringSchema(),
      requested_mode_inferred: { type: 'boolean' },
      authority: nullableStringSchema(),
      started_at: nullableStringSchema(),
      finished_at: nullableStringSchema(),
      duration_ms: { type: ['integer', 'null'] },
      worker_session_id: nullableStringSchema(),
      summary_preview: nullableStringSchema(),
      error_preview: nullableStringSchema(),
      error_classification: nullableStringSchema(),
      warning_count: { type: 'integer' },
      progress_preview: nullableStringSchema(),
      latest_event_type: nullableStringSchema(),
      progress: progressPreviewSchema(),
      summary: { type: 'string' },
      run_dir: { type: 'string' },
      timing: { type: 'object', additionalProperties: true },
      error: nullableStringSchema(),
      diagnostic_tail: nullableStringSchema(),
      status_liveness: { type: 'object', additionalProperties: true },
    }, ['run_id', 'status']) },
  }, ['schema', 'status', 'runs']);
}

function workerRunWaitOutputSchema(): Record<string, unknown> {
  return objectSchema({
    schema: { type: 'string', const: 'narada.worker.run_wait.v1' },
    status: { type: 'string', const: 'ok' },
    wait: { type: 'object', additionalProperties: true },
    run: { type: 'object', additionalProperties: true },
    full_run: { type: 'object', additionalProperties: true },
  }, ['schema', 'status', 'wait', 'run']);
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function intentSchema(): Record<string, unknown> {
  return objectSchema({
    instruction: { type: 'string' },
    mode: { type: 'string', enum: ['audit_only', 'plan_only', 'implement', 'implement_and_verify'], description: 'Non-mechanical task mode. Defaults to audit_only for read authority and implement for write/command authority.' },
  }, ['instruction']);
}

function constraintRequestSchema(): Record<string, unknown> {
  return objectSchema({
    cwd: { type: 'string' },
    site_root: { type: 'string', description: 'Explicit Narada Site root for narada-agent-runtime-server workers. Defaults to nearest Site marker above cwd.' },
    authority: { type: 'string', enum: ['read', 'write', 'command'] },
    cognition: { type: 'string', enum: ['low', 'medium', 'high'] },
    resumable: { type: 'boolean' },
    wait_for_completion: { type: 'boolean', description: 'When true, block until completion. Defaults to false so delegation returns promptly with run_id.' },
    exit_interview: { type: 'boolean', description: 'Ask the worker to include ergonomics feedback in its final output.' },
    preflight_paths: { type: 'array', items: objectSchema({
      path: { type: 'string' },
      access: { type: 'string', enum: ['read', 'write', 'create'] },
      label: { type: 'string' },
    }, ['path', 'access']), description: 'Optional path capability checks recorded before the worker starts.' },
    required_mcp_tools: { type: 'array', items: { type: 'string' }, description: 'Tool names the worker must verify before work. Recorded as advisory preflight because worker-delegation cannot inspect the worker runtime tool inventory.' },
    overrides: constraintOverrideSchema(),
  }, ['cwd']);
}

function constraintOverrideSchema(): Record<string, unknown> {
  return objectSchema({
    runtime: { type: 'string', enum: ['codex', 'deepseek-api', 'narada-agent-runtime-server'] },
    sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
    model: { type: 'string' },
    reasoning_effort: { type: 'string' },
    config: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    skip_git_repo_check: { type: 'boolean' },
  });
}

function decorateTools(tools: WorkerToolDefinition[]): WorkerToolDefinition[] {
  return tools.map((tool) => ({ ...tool, annotations: toolAnnotations(tool.name), outputSchema: toolOutputSchema(tool.name) }));
}

function toolAnnotations(name: string) {
  const startsWorker = name === 'worker_run' || name === 'worker_edit' || name === 'worker_resume';
  return {
    title: name,
    readOnlyHint: !startsWorker,
    destructiveHint: false,
    idempotentHint: /inspect|config_resolve|run_status|runs_list|run_wait/.test(name),
    openWorldHint: true,
  };
}

function toolOutputSchema(name: string): Record<string, unknown> {
  if (name === 'worker_policy_inspect') return workerPolicyOutputSchema();
  if (name === 'worker_config_resolve') return workerConfigResolveOutputSchema();
  if (name === 'worker_run' || name === 'worker_edit' || name === 'worker_resume' || name === 'worker_run_status') return workerRunOutputSchema();
  if (name === 'worker_run_wait') return workerRunWaitOutputSchema();
  if (name === 'worker_runs_list') return workerRunsListOutputSchema();
  return { type: 'object', additionalProperties: true };
}

function workerConfigResolveOutputSchema(): Record<string, unknown> {
  return objectSchema({
    schema: { type: 'string', const: 'narada.worker.config_resolve.v1' },
    status: { type: 'string', const: 'ok' },
    dry_run: { type: 'boolean', const: true },
    requested_mode: { type: 'string', enum: ['audit_only', 'plan_only', 'implement', 'implement_and_verify'] },
    resume_worker_session_id: nullableStringSchema(),
    resolved_worker_config: { type: 'object', additionalProperties: true },
    invocation: { type: 'object', additionalProperties: true },
    preflight: { type: 'array', items: objectSchema({ name: { type: 'string' }, status: { type: 'string', enum: ['ok', 'warning', 'blocked'] }, message: { type: 'string' } }, ['name', 'status', 'message']) },
    runtime_availability: { type: 'object', additionalProperties: true },
    config_resolution: { type: 'object', additionalProperties: true },
    warnings: stringArraySchema(),
  }, ['schema', 'status', 'dry_run', 'requested_mode', 'resolved_worker_config', 'invocation', 'preflight', 'runtime_availability', 'config_resolution', 'warnings']);
}

function workerPolicyOutputSchema(): Record<string, unknown> {
  return objectSchema({
    schema: { type: 'string', const: 'narada.worker.policy.v1' },
    status: { type: 'string' },
    default_runtime: { type: 'string' },
    default_authority: { type: 'string' },
    default_cognition: { type: 'string' },
    allowed_authorities: stringArraySchema(),
    allowed_cognition: stringArraySchema(),
    run_root: { type: 'string' },
    audit_log_dir: nullableStringSchema(),
    allowed_roots: stringArraySchema(),
    roots_from_trust_config: nullableStringSchema(),
    allowed_runtimes: stringArraySchema(),
    allowed_sandboxes: stringArraySchema(),
    allowed_config_keys: stringArraySchema(),
    allow_raw_config_overrides: { type: 'boolean' },
    allow_danger_full_access: { type: 'boolean' },
    nars_site_semantics: { type: 'object', additionalProperties: true },
    max_parallel_runs: { type: 'integer' },
    max_prompt_bytes: { type: 'integer' },
    max_output_bytes: { type: 'integer' },
    max_run_ms: { type: 'integer' },
    cognition_defaults: { type: 'object', additionalProperties: true },
    runtimes: { type: 'object', additionalProperties: true },
  }, ['schema', 'status']);
}

function workerRunOutputSchema(): Record<string, unknown> {
  return objectSchema({
    schema: { type: 'string', const: 'narada.worker.run.v1' },
    status: { type: 'string', enum: ['running', 'completed', 'completed_with_errors', 'failed', 'cancelled'] },
    run_id: { type: 'string' },
    run_dir: { type: 'string' },
    runtime: { type: 'string', enum: ['codex', 'deepseek-api', 'narada-agent-runtime-server'] },
    worker_session_id: nullableStringSchema(),
    resolved_worker_config: { type: 'object', additionalProperties: true },
    executor_request: { type: 'object', additionalProperties: true },
    requested_mode: { type: 'string', enum: ['audit_only', 'plan_only', 'implement', 'implement_and_verify'] },
    edits_performed: { type: ['boolean', 'null'] },
    target_state_changed: { type: ['boolean', 'null'] },
    confidence: { type: 'string', enum: ['complete', 'partial'] },
    completion_state: { type: 'string', enum: ['complete', 'partial'] },
    blocked_paths: stringArraySchema(),
    verification: stringArraySchema(),
    runtime_warnings: stringArraySchema(),
    warning_count: { type: 'integer' },
    preflight: { type: 'array', items: objectSchema({ name: { type: 'string' }, status: { type: 'string', enum: ['ok', 'warning', 'blocked'] }, message: { type: 'string' } }, ['name', 'status', 'message']) },
    final_checklist: stringArraySchema(),
    summary: { type: 'string' },
    deliverables: { type: 'array', items: objectSchema({ path: { type: 'string' }, description: { type: 'string' } }, ['path', 'description']) },
    open_questions: stringArraySchema(),
    next_actions: stringArraySchema(),
    changes: { type: 'array', items: objectSchema({ path: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' } }, ['path', 'status', 'summary']) },
    verification_results: { type: 'array', items: objectSchema({ tool: { type: ['string', 'null'] }, command: { type: ['string', 'null'] }, status: { type: 'string' }, summary: { type: 'string' } }, ['tool', 'command', 'status', 'summary']) },
    exit_interview: { type: ['object', 'null'], properties: {
      ergonomics_feedback: { type: 'string' },
      friction_points: stringArraySchema(),
      missing_affordances: stringArraySchema(),
      observed_incoherencies: stringArraySchema(),
      suggested_improvements: stringArraySchema(),
    }, additionalProperties: false },
    progress: progressPreviewSchema(),
    artifacts: { type: 'array', items: objectSchema({ name: { type: 'string' }, path: { type: 'string' } }, ['name', 'path']) },
    artifact_readback: { type: 'object', additionalProperties: true },
    timing: { type: 'object', additionalProperties: true },
    error: nullableStringSchema(),
    worker_output_error: { type: 'object', additionalProperties: true },
    diagnostic_tail: nullableStringSchema(),
    error_classification: nullableStringSchema(),
    status_liveness: { type: 'object', additionalProperties: true },
  }, ['schema', 'status', 'run_id', 'run_dir', 'resolved_worker_config', 'summary', 'deliverables', 'open_questions', 'next_actions']);
}

function stringArraySchema(): Record<string, unknown> {
  return { type: 'array', items: { type: 'string' } };
}

function nullableStringSchema(): Record<string, unknown> {
  return { type: ['string', 'null'] };
}

function progressPreviewSchema(): Record<string, unknown> {
  return objectSchema({
    event_count: { type: 'integer' },
    latest_event_type: nullableStringSchema(),
    latest_event_preview: nullableStringSchema(),
    latest_event_at: nullableStringSchema(),
    readable: { type: 'boolean' },
    tail_truncated: { type: 'boolean' },
    error_preview: { type: 'string' },
  }, ['event_count', 'latest_event_type', 'latest_event_preview', 'readable', 'tail_truncated']);
}
