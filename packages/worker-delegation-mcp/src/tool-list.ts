export function listTools() {
  return [
    { name: 'worker_policy_inspect', description: 'Inspect the active worker delegation policy.', inputSchema: objectSchema({}) },
    { name: 'worker_run', description: 'Start one new worker run for one delegated task.', inputSchema: objectSchema({
      cwd: { type: 'string' },
      task: { type: 'string' },
      runtime: { type: 'string' },
      role: { type: 'string' },
      sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
      model: { type: 'string' },
      reasoning_effort: { type: 'string' },
      config: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
      skip_git_repo_check: { type: 'boolean' },
    }, ['cwd', 'task']) },
    { name: 'worker_resume', description: 'Continue one existing worker session.', inputSchema: objectSchema({
      cwd: { type: 'string' },
      worker_session_id: { type: 'string' },
      task: { type: 'string' },
      runtime: { type: 'string' },
      role: { type: 'string' },
      sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
      model: { type: 'string' },
      reasoning_effort: { type: 'string' },
      config: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
      skip_git_repo_check: { type: 'boolean' },
    }, ['cwd', 'worker_session_id']) },
    { name: 'worker_output_show', description: 'Read materialized worker output by output reference.', inputSchema: objectSchema({
      output_ref: { type: 'string' },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
    }, ['output_ref']) },
  ];
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}
