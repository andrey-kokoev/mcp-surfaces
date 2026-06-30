export const TASK_LIFECYCLE_READ_TOOL_NAMES = Object.freeze([
  'task_lifecycle_list',
  'task_lifecycle_roster',
  'task_lifecycle_guidance',
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
    task_lifecycle_guidance: (args) => {
      const workflow = stringField(args, 'workflow') ?? 'all';
      const tool = stringField(args, 'tool');
      return jsonToolResult(taskLifecycleGuidance({ workflow, tool }));
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

function taskLifecycleGuidance({ workflow, tool }) {
  const sections = taskLifecycleGuidanceSections();
  const normalizedWorkflow = sections[workflow] ? workflow : 'all';
  const selectedSections = normalizedWorkflow === 'all'
    ? sections
    : { [normalizedWorkflow]: sections[normalizedWorkflow] };
  return {
    status: 'ok',
    schema: 'narada.task_lifecycle.guidance.v0',
    workflow: normalizedWorkflow,
    tool: tool ?? null,
    sections: selectedSections,
    recommended_first_call: tool ? null : 'task_lifecycle_guidance({ workflow: "ordinary_task" })',
    tool_specific_note: tool ? taskLifecycleToolGuidance(tool) : null,
  };
}

function taskLifecycleGuidanceSections() {
  return {
    ordinary_task: {
      intent: 'Do task work through explicit lifecycle records instead of conversational claims.',
      canonical_sequence: [
        'task_lifecycle_show or task_lifecycle_next',
        'task_lifecycle_claim when unclaimed',
        'do the implementation or investigation work',
        'task_lifecycle_submit_work for normal completion',
        'read the returned lifecycle status before reporting done',
      ],
      required_evidence: ['execution_notes', 'verification', 'changed_files or no_files_changed', 'acceptance criteria proof'],
      state_semantics: {
        submitted: 'A report/evidence packet was recorded.',
        in_review: 'Work is submitted but closure is gated by review or dependency policy.',
        closed: 'Closure authority has been recorded.',
      },
    },
    blocked_task: {
      intent: 'Record exact blockers without pretending the task is complete.',
      canonical_sequence: ['task_lifecycle_report_blocked', 'include blocker facts and next_action', 'do not use finish for unresolved blockers'],
      required_evidence: ['reason', 'blockers when specific facts exist', 'next_action when an external action is required'],
    },
    payloads: {
      intent: 'Use immutable payload refs for long companion fields while keeping task_number and agent_id top-level.',
      canonical_sequence: ['mcp_payload_create', 'call lifecycle tool with payload_ref plus required top-level identity/routing fields'],
      inline_limit_guidance: 'Inline companion strings over 200 characters should move to payload_ref when the target tool supports it.',
      top_level_authority_fields: ['task_number', 'agent_id', 'authority_basis when required'],
      companion_fields: ['summary', 'execution_notes', 'verification', 'changed_files', 'findings', 'recovery_truthfulness', 'self_certification'],
    },
    review_and_dependencies: {
      intent: 'Review is dependency/outcome work, not a magic final state.',
      canonical_sequence: ['submit_work with reviewer when ordinary work needs review', 'reviewer claims dependency task', 'reviewer finishes with accepted/accepted_with_notes/rejected outcome'],
      state_semantics: {
        completed_outcome: 'An outcome was admitted for the task.',
        dependency_satisfied: 'Parent gating dependency has an admitted satisfying outcome.',
        rejected_outcome: 'Blocks parent closure until disposition is recorded.',
      },
    },
    closeout_truthfulness: {
      intent: 'Report the strongest true lifecycle state, not the desired state.',
      required_checks: ['latest tool result status', 'final_lifecycle_status or task show status', 'closure evidence', 'review/dependency obligations', 'working tree and verification evidence'],
      common_mistakes: [
        'Calling submitted or in_review closed.',
        'Omitting changed_files or no_files_changed.',
        'Using finish when blocked facts remain unresolved.',
        'Treating generated reports as self-authorizing closure.',
      ],
    },
  };
}

function taskLifecycleToolGuidance(tool) {
  const guidance = {
    task_lifecycle_submit_work: {
      preferred_for: 'Ordinary task completion with execution notes, verification, evidence admission, and finish/report in one call.',
      caveat: 'A successful submit_work can still return in_review or awaiting_dependencies rather than closed.',
    },
    task_lifecycle_finish: {
      preferred_for: 'Finishing a claimed task or admitting an outcome for an outcome-contract dependency task.',
      caveat: 'Use payload_ref for long summary/findings and include changed_files or no_files_changed for implementation work.',
    },
    task_lifecycle_report_blocked: {
      preferred_for: 'Recording unresolved blockers with exact next action.',
      caveat: 'Do not use completion tools when the blocker prevents truthful finish.',
    },
    task_lifecycle_claim: {
      preferred_for: 'Taking responsibility for unassigned work.',
      caveat: 'Use authority_basis when crossing role, preferred-agent, or operator gates.',
    },
  };
  return guidance[tool] ?? {
    preferred_for: null,
    caveat: 'No tool-specific guidance is registered; use the workflow sections and tool schema together.',
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
