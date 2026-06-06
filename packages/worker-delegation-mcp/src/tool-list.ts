type WorkerToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export function listTools(): WorkerToolDefinition[] {
  return decorateTools([
    { name: 'worker_policy_inspect', description: 'Inspect the active worker delegation policy.', inputSchema: objectSchema({}) },
    { name: 'worker_run', description: 'Start one new worker run for one delegated instruction.', inputSchema: objectSchema({
      intent: intentSchema(),
      constraints: constraintRequestSchema(),
    }, ['intent', 'constraints']) },
    { name: 'worker_edit', description: 'Start one edit-capable worker run shortcut using write authority and low cognition.', inputSchema: objectSchema({
      cwd: { type: 'string' },
      instruction: { type: 'string' },
      resumable: { type: 'boolean' },
      overrides: constraintOverrideSchema(),
    }, ['cwd', 'instruction']) },
    { name: 'worker_resume', description: 'Continue one existing worker session.', inputSchema: objectSchema({
      worker_session_id: { type: 'string' },
      intent: intentSchema(),
      constraints: constraintRequestSchema(),
    }, ['worker_session_id', 'constraints']) },
    { name: 'worker_output_show', description: 'Read materialized worker output by output reference.', inputSchema: objectSchema({
      output_ref: { type: 'string' },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
    }, ['output_ref']) },
  ]);
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function intentSchema(): Record<string, unknown> {
  return objectSchema({ instruction: { type: 'string' } }, ['instruction']);
}

function constraintRequestSchema(): Record<string, unknown> {
  return objectSchema({
    cwd: { type: 'string' },
    authority: { type: 'string', enum: ['read', 'write', 'command'] },
    cognition: { type: 'string', enum: ['low', 'medium', 'high'] },
    resumable: { type: 'boolean' },
    overrides: constraintOverrideSchema(),
  }, ['cwd']);
}

function constraintOverrideSchema(): Record<string, unknown> {
  return objectSchema({
    runtime: { type: 'string' },
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
    idempotentHint: /inspect|output_show/.test(name),
    openWorldHint: true,
  };
}

function toolOutputSchema(name: string): Record<string, unknown> {
  if (name === 'worker_policy_inspect') return workerPolicyOutputSchema();
  if (name === 'worker_run' || name === 'worker_edit' || name === 'worker_resume') return workerRunOutputSchema();
  if (name === 'worker_output_show') return workerOutputShowSchema();
  return { type: 'object', additionalProperties: true };
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
    audit_log_dir: { type: 'string' },
    allowed_roots: stringArraySchema(),
    roots_from_trust_config: nullableStringSchema(),
    allowed_runtimes: stringArraySchema(),
    allowed_sandboxes: stringArraySchema(),
    allowed_config_keys: stringArraySchema(),
    allow_raw_config_overrides: { type: 'boolean' },
    allow_danger_full_access: { type: 'boolean' },
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
    status: { type: 'string', enum: ['completed', 'failed', 'cancelled'] },
    run_id: { type: 'string' },
    run_dir: { type: 'string' },
    runtime: { type: 'string' },
    worker_session_id: nullableStringSchema(),
    resolved_worker_config: { type: 'object', additionalProperties: true },
    executor_request: { type: 'object', additionalProperties: true },
    summary: { type: 'string' },
    deliverables: { type: 'array', items: objectSchema({ path: { type: 'string' }, description: { type: 'string' } }, ['path', 'description']) },
    open_questions: stringArraySchema(),
    next_actions: stringArraySchema(),
    artifacts: { type: 'array', items: objectSchema({ name: { type: 'string' }, path: { type: 'string' } }, ['name', 'path']) },
    timing: { type: 'object', additionalProperties: true },
    error: nullableStringSchema(),
  }, ['schema', 'status', 'run_id', 'run_dir', 'resolved_worker_config', 'summary', 'deliverables', 'open_questions', 'next_actions']);
}

function workerOutputShowSchema(): Record<string, unknown> {
  return objectSchema({
    schema: { type: 'string', const: 'narada.worker.output_show.v1' },
    status: { type: 'string' },
    ref: { type: 'string' },
    offset: { type: 'integer' },
    limit: { type: 'integer' },
    next_offset: { type: ['integer', 'null'] },
    output_text: { type: 'string' },
    output_truncated: { type: 'boolean' },
  }, ['schema', 'status', 'ref', 'output_text']);
}

function stringArraySchema(): Record<string, unknown> {
  return { type: 'array', items: { type: 'string' } };
}

function nullableStringSchema(): Record<string, unknown> {
  return { type: ['string', 'null'] };
}
