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
      compatibility_only: true,
      authority_model: 'Migrates legacy review calls into review-contract dependency work and task_outcomes authority. New review work should finish the dependency task with task_lifecycle_finish.',
      payload_ref_shape: { findings: [{ severity: 'note|blocking', description: '<finding text>', location: '<optional location>' }] },
      top_level_fields_remain_required: ['task_number', 'agent_id', 'verdict'],
      invalid_shapes: ['{ findings: { "0": {...} } }', '{ findings: ["text"] }'],
      preferred_tool_for_new_review_work: 'task_lifecycle_finish',
    },
    task_lifecycle_finish: {
      payload_ref_shape: { summary: '<finish summary>', outcome: '<contract outcome when applicable>', findings: [], changed_files: ['path/to/file'], no_files_changed: false, self_certification: {}, recovery_truthfulness: {} },
      inline_payload_limit: { threshold_chars: 200, remediation: 'Put long summary, findings, outcome evidence, or guard packets in mcp_payload_create, then call task_lifecycle_finish with payload_ref plus top-level task_number and agent_id.' },
      top_level_fields_remain_required: ['task_number', 'agent_id'],
    },
    task_lifecycle_disposition_closeout: {
      payload_ref_shape: { summary: '<closeout summary>', changed_files: ['path/to/file'], no_files_changed: false },
      inline_payload_limit: { threshold_chars: 200, long_fields: ['summary'], remediation: 'Put long closeout summary and optional changed_files/no_files_changed in mcp_payload_create, then call task_lifecycle_closeout with payload_ref plus top-level task_number and agent_id.' },
      top_level_fields_remain_required: ['task_number', 'agent_id'],
    },
    task_lifecycle_report_blocked: {
      payload_ref_shape: { reason: '<concise blocker summary>', blockers: [{ kind: '<blocker kind>', detail: '<details>' }], next_action: '<long concrete unblock action>', defer: true },
      inline_payload_limit: { threshold_chars: 200, long_fields: ['next_action', 'blockers'], remediation: 'Put long next_action and blocker details in mcp_payload_create, then call task_lifecycle_report_blocked with payload_ref plus top-level task_number and agent_id. Keep reason concise inline or in the payload.' },
      top_level_fields_remain_required: ['task_number', 'agent_id'],
    },
    task_lifecycle_create: {
      payload_ref_shape: {
        title: '<required task title>',
        goal: '<optional goal; defaults to title>',
        context: '<optional context>',
        required_work: '<markdown string or string[] normalized to newline markdown>',
        non_goals: '<markdown string or string[] normalized to newline markdown>',
        acceptance_criteria: ['string criteria item'],
        preferred_role: '<optional role>',
        target_role: '<optional role>',
      },
      examples: [
        { payload: { title: 'Fix thing', required_work: ['Inspect failure.', 'Patch narrowly.'], non_goals: ['No unrelated refactor.'], acceptance_criteria: ['Focused test passes.'] } },
      ],
      payload_ref_required: true,
      inline_definition_fields_refused: ['title', 'goal', 'context', 'required_work', 'non_goals', 'acceptance_criteria', 'preferred_role', 'target_role'],
      normalized_fields: { required_work: 'string[] joins with newline after trimming empty entries', non_goals: 'string[] joins with newline after trimming empty entries' },
    },
    task_lifecycle_admit_evidence: {
      payload_ref_shape: { self_certification: { actor_principal: '<agent id>', findings: [], justification: '<why this evidence may be admitted>' } },
      top_level_fields_remain_required: ['task_number', 'agent_id'],
      note: 'Evidence content is read from the task lifecycle store; payload_ref is only for long self_certification guard metadata.',
    },
  };
}
