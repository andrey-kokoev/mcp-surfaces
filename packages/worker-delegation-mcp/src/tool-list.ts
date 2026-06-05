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
    runtime: { type: 'string' },
    sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
    model: { type: 'string' },
    reasoning_effort: { type: 'string' },
    config: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    skip_git_repo_check: { type: 'boolean' },
  }, ['cwd']);
}

function decorateTools(tools: WorkerToolDefinition[]): WorkerToolDefinition[] {
  return tools.map((tool) => ({ ...tool, annotations: toolAnnotations(tool.name), outputSchema: genericToolOutputSchema() }));
}

function toolAnnotations(name: string) {
  const startsWorker = name === 'worker_run' || name === 'worker_resume';
  return {
    title: name,
    readOnlyHint: !startsWorker,
    destructiveHint: false,
    idempotentHint: /inspect|output_show/.test(name),
    openWorldHint: true,
  };
}

function genericToolOutputSchema() {
  return { type: 'object', additionalProperties: true };
}

