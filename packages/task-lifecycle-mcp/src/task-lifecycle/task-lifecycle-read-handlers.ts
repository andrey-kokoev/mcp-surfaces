export const TASK_LIFECYCLE_READ_TOOL_NAMES = Object.freeze([
  'task_lifecycle_list',
  'task_lifecycle_roster',
  'task_lifecycle_payload_schema',
]);

export function createTaskLifecycleReadHandlers({
  store,
  jsonToolResult,
  stringField,
  numberField,
}) {
  return {
    task_lifecycle_list: (args) => {
      const statusFilter = stringField(args, 'status');
      const agentFilter = stringField(args, 'agent_id');
      const limit = numberField(args, 'limit') ?? 50;
      const rows = store.db.prepare('SELECT * FROM task_lifecycle ORDER BY task_number DESC LIMIT ?').all(limit);
      const tasks = rows.map((row) => {
        const spec = store.getTaskSpec(row.task_id);
        const assignment = store.db.prepare('SELECT * FROM task_assignments WHERE task_id = ? AND released_at IS NULL ORDER BY claimed_at DESC LIMIT 1').get(row.task_id);
        return {
          task_number: row.task_number,
          task_id: row.task_id,
          status: row.status,
          title: spec?.title ?? null,
          assigned_to: assignment?.agent_id ?? null,
          claimed_at: assignment?.claimed_at ?? null,
          updated_at: row.updated_at,
        };
      });
      const filtered = tasks.filter((task) => {
        if (statusFilter && task.status !== statusFilter) return false;
        if (agentFilter && task.assigned_to !== agentFilter) return false;
        return true;
      });
      return jsonToolResult({ status: 'ok', count: filtered.length, tasks: filtered });
    },
    task_lifecycle_roster: () => {
      const roster = store.getRoster();
      return jsonToolResult({ status: 'ok', roster: roster ?? [] });
    },
    task_lifecycle_payload_schema: (args) => {
      const tool = stringField(args, 'tool');
      const schemas = taskLifecyclePayloadSchemas();
      return jsonToolResult({
        status: 'ok',
        schema: 'narada.task_lifecycle.payload_schema.v0',
        tool: tool ?? null,
        schemas: tool ? { [tool]: schemas[tool] ?? null } : schemas,
        remediation: 'Use mcp_payload_create with one of these payload shapes, then retry the lifecycle tool with payload_ref plus required top-level identity/routing fields.',
      });
    },
  };
}

function taskLifecyclePayloadSchemas() {
  return {
    task_lifecycle_review: {
      payload_ref_shape: { findings: [{ severity: 'note|blocking', description: '<finding text>', location: '<optional location>' }] },
      top_level_fields_remain_required: ['task_number', 'agent_id', 'verdict'],
      invalid_shapes: ['{ findings: { "0": {...} } }', '{ findings: ["text"] }'],
    },
    task_lifecycle_finish: {
      payload_ref_shape: { summary: '<finish summary>', changed_files: ['path/to/file'], no_files_changed: false, self_certification: {}, recovery_truthfulness: {} },
      top_level_fields_remain_required: ['task_number', 'agent_id'],
    },
    task_lifecycle_disposition_closeout: {
      payload_ref_shape: { summary: '<closeout summary>', changed_files: ['path/to/file'], no_files_changed: false },
      top_level_fields_remain_required: ['task_number', 'agent_id'],
    },
    task_lifecycle_admit_evidence: {
      payload_ref_shape: { evidence: {}, verification: {}, criteria: [] },
      top_level_fields_remain_required: ['task_number', 'agent_id'],
    },
  };
}
