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
    common_guidance_contract_schema: 'narada.mcp_surface.guidance.v0',
    surface_id: 'task-lifecycle',
    guidance_tool: 'task_lifecycle_guidance',
    purpose: 'Task lifecycle MCP surface for claiming, executing, evidencing, reviewing, blocking, and truthfully finishing task work.',
    requested: { workflow: workflow ?? null, tool: tool ?? null },
    workflow: normalizedWorkflow,
    tool: tool ?? null,
    first_use: [
      'Call task_lifecycle_guidance when you first see a lifecycle task, when a refusal is unclear, or before recovering from incomplete task evidence.',
      'Inspect the task before mutation; claim only when authorized; submit execution notes, verification, changed-file evidence, and closeout through lifecycle tools.',
      'Use payload_ref for long companion fields and preserve structuredContent as authoritative lifecycle evidence.',
    ],
    sections: selectedSections,
    first_use_decision_tree: taskLifecycleFirstUseDecisionTree(),
    state_truth_table: taskLifecycleStateTruthTable(),
    tool_preference_table: taskLifecycleToolPreferenceTable(),
    tool_preference: taskLifecycleToolPreferenceTable(),
    happy_path_examples: taskLifecycleHappyPathExamples(),
    examples: taskLifecycleHappyPathExamples(),
    anti_patterns: taskLifecycleAntiPatterns(),
    recovery_guidance: taskLifecycleRecoveryGuidance(),
    recovery: taskLifecycleRecoveryGuidance(),
    feedback: {
      surface_id: 'task-lifecycle',
      tool: 'surface_feedback_submit',
      when: [
        'guidance is missing, stale, or contradicted by live lifecycle behavior',
        'payload_ref shape or evidence gates are unclear',
        'task state, review state, or closeout requirements are hard to recover from',
      ],
    },
    boundaries: [
      'Guidance is read-only model-facing operating advice.',
      'Guidance does not weaken task lifecycle policy, authorize mutation, or replace tool schemas.',
      'Lifecycle state and completion gates remain authoritative in task lifecycle records.',
    ],
    recommended_first_call: tool ? null : 'task_lifecycle_guidance({ workflow: "ordinary_task" })',
    tool_specific_note: tool ? taskLifecycleToolGuidance(tool) : null,
  };
}

function taskLifecycleFirstUseDecisionTree() {
  return [
    {
      condition: 'You have a task number.',
      sequence: ['task_lifecycle_show', 'task_lifecycle_claim if unclaimed and claimable', 'do the work', 'task_lifecycle_submit_work'],
    },
    {
      condition: 'You do not have a task number.',
      sequence: ['task_lifecycle_next', 'claim the recommended task when appropriate', 'do the work', 'task_lifecycle_submit_work'],
    },
    {
      condition: 'You are blocked by missing input, authority, credentials, failing infrastructure, or unclear external state.',
      sequence: ['task_lifecycle_report_blocked with exact blocker facts and next_action'],
    },
    {
      condition: 'You are completing review/dependency work.',
      sequence: ['task_lifecycle_show to read outcome contract', 'task_lifecycle_finish with outcome and findings'],
    },
    {
      condition: 'Your summary, verification, findings, or blocker details are too long for inline fields.',
      sequence: ['mcp_payload_create with companion fields under payload', 'retry lifecycle tool with payload_ref plus top-level task_number and agent_id'],
    },
  ];
}

function taskLifecycleStateTruthTable() {
  return {
    opened: 'Task exists and is available or waiting; no current agent responsibility is implied.',
    claimed: 'An agent has accepted responsibility; no completion is implied.',
    submitted: 'A report or evidence packet was recorded by a tool call; closure is not implied.',
    completed_outcome: 'A task_outcome was admitted as completed; closure may still be gated by review or dependencies.',
    in_review: 'Submitted work awaits review or dependency satisfaction; do not report this as closed.',
    awaiting_dependencies: 'Parent work is not closed because one or more dependencies must satisfy outcomes first.',
    closed: 'Closure authority has been recorded; this is the normal terminal claim for task completion.',
    confirmed: 'A stronger finalization state when supported by local policy; treat as at least closed.',
    deferred: 'Work is intentionally paused; do not treat as completed.',
    blocked: 'Known blocker prevents truthful completion until resolved or explicitly dispositioned.',
  };
}

function taskLifecycleToolPreferenceTable() {
  return [
    { tool: 'task_lifecycle_next', prefer_when: 'Finding actionable work without a task number.', avoid_when: 'You already have a specific task to inspect or finish.' },
    { tool: 'task_lifecycle_show', prefer_when: 'Reading the authoritative task state, assignment, criteria, dependencies, and latest outcome.', avoid_when: 'You need a compact multi-task overview.' },
    { tool: 'task_lifecycle_claim', prefer_when: 'Taking responsibility for unclaimed work.', avoid_when: 'The task is already claimed by you or you lack real authority to cross routing gates.' },
    { tool: 'task_lifecycle_submit_work', prefer_when: 'Ordinary implementation or investigation closeout with notes, verification, evidence, and finish.', avoid_when: 'You are blocked or completing a specialized outcome-contract task.' },
    { tool: 'task_lifecycle_finish', prefer_when: 'Lower-level finish, no-edit report, or dependency/review outcome admission.', avoid_when: 'You still need to write execution/verification notes and prove criteria for ordinary work.' },
    { tool: 'task_lifecycle_report_blocked', prefer_when: 'A known unresolved blocker prevents truthful completion.', avoid_when: 'Work is complete and only needs a normal report.' },
    { tool: 'task_lifecycle_payload_schema', prefer_when: 'You need exact payload_ref shapes for a lifecycle tool.', avoid_when: 'You only need workflow guidance.' },
    { tool: 'mcp_payload_create', prefer_when: 'Companion fields are long or structurally rich.', avoid_when: 'Short ordinary fields fit the lifecycle tool schema.' },
  ];
}

function taskLifecycleHappyPathExamples() {
  return {
    ordinary_submit_work_inline: {
      tool: 'task_lifecycle_submit_work',
      arguments: {
        task_number: 123,
        agent_id: '<agent id>',
        summary: 'Implemented the requested behavior.',
        execution_notes: 'Changed the focused implementation path and preserved existing gates.',
        verification: 'Ran the focused package test and inspected the task readback.',
        changed_files: ['packages/example/src/main.ts'],
      },
    },
    ordinary_submit_work_auto_materialized: {
      tool: 'task_lifecycle_submit_work',
      use_when: 'execution_notes, verification, summary, or changed_files are too long for inline transport and you want one governed call instead of a separate mcp_payload_create call',
      arguments: {
        task_number: 123,
        agent_id: '<agent id>',
        summary: '<long summary>',
        execution_notes: '<long execution notes>',
        verification: '<long verification notes>',
        changed_files: ['packages/example/src/main.ts'],
        auto_materialize_payload: true,
      },
      result_contract: 'payload_source.kind=auto_materialized_payload and long_field_transport=auto_materialized_payload',
    },
    no_files_changed_finish: {
      tool: 'task_lifecycle_finish',
      arguments: {
        task_number: 124,
        agent_id: '<agent id>',
        summary: 'Inspection-only task completed; no repository files changed.',
        no_files_changed: true,
      },
    },
    blocked_report: {
      tool: 'task_lifecycle_report_blocked',
      arguments: {
        task_number: 125,
        agent_id: '<agent id>',
        reason: 'Required credential is missing.',
        blockers: [{ kind: 'credential_missing', detail: 'The configured token is absent from the runtime environment.' }],
        next_action: 'Operator must add the credential and restart the carrier.',
      },
    },
  };
}

function taskLifecycleAntiPatterns() {
  return [
    { mistake: 'Saying a task is closed when the lifecycle status is submitted, in_review, awaiting_dependencies, blocked, or deferred.', correction: 'Report the exact lifecycle status and whether closure authority exists.' },
    { mistake: 'Putting task_number or agent_id only inside a payload.', correction: 'Keep authority/routing fields top-level; payload carries companion fields.' },
    { mistake: 'Calling finish or submit_work when blocker facts remain unresolved.', correction: 'Use task_lifecycle_report_blocked with blockers and next_action.' },
    { mistake: 'Omitting changed_files and no_files_changed.', correction: 'Provide changed-file evidence or explicitly declare no_files_changed.' },
    { mistake: 'Treating generated reports, review artifacts, or model narration as self-authorizing closure.', correction: 'Use lifecycle readback: outcome, evidence verdict, dependencies, and closure status.' },
    { mistake: 'Forcing authority_basis to bypass routing without real operator/task-owner authority.', correction: 'Only use authority_basis when the authority exists and can be summarized truthfully.' },
  ];
}

function taskLifecycleRecoveryGuidance() {
  return [
    { failure: 'Inline field too long or structurally awkward.', action: 'Call task_lifecycle_payload_schema for the target tool, create mcp_payload_create with companion fields under payload, then retry with payload_ref.' },
    { failure: 'Authorization or routing refusal.', action: 'Read task_lifecycle_show and roster/routing state; claim only if eligible or provide a truthful authority_basis when explicitly authorized.' },
    { failure: 'Evidence rejected or acceptance criteria unchecked.', action: 'Fix task notes, verification, changed-file/no-files evidence, and criteria proof before retrying finish.' },
    { failure: 'Review or dependency is blocking closure.', action: 'Find the dependency task or review obligation, finish it with the required outcome, then re-check parent dependency satisfaction.' },
    { failure: 'Tool result is ambiguous or live MCP seems stale after source edits.', action: 'Record the observed result exactly, verify source with focused tests, and request/rely on carrier restart before claiming live behavior changed.' },
  ];
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
      examples: [
        {
          purpose: 'Submit ordinary work with long notes.',
          create_payload: {
            payload_id: 'task-123-submit-work-notes',
            payload: {
              summary: 'Implemented the requested behavior.',
              execution_notes: '<long execution notes>',
              verification: '<long verification notes>',
              changed_files: ['packages/example/src/main.ts'],
            },
            created_by: '<agent id>',
          },
          consume_payload_ref: {
            tool: 'task_lifecycle_submit_work',
            arguments: {
              task_number: 123,
              agent_id: '<agent id>',
              payload_ref: 'mcp_payload:task-123-submit-work-notes@v1',
            },
          },
        },
        {
          purpose: 'Finish an outcome-contract task with structured findings.',
          create_payload: {
            payload_id: 'task-456-review-outcome',
            payload: {
              outcome: 'accepted_with_notes',
              summary: 'The implementation satisfies the contract.',
              findings: [{ severity: 'note', description: 'Minor follow-up remains non-blocking.' }],
            },
            created_by: '<agent id>',
          },
          consume_payload_ref: {
            tool: 'task_lifecycle_finish',
            arguments: {
              task_number: 456,
              agent_id: '<agent id>',
              payload_ref: 'mcp_payload:task-456-review-outcome@v1',
            },
          },
        },
        {
          purpose: 'Report a blocked task with detailed blocker evidence.',
          create_payload: {
            payload_id: 'task-789-blocked-report',
            payload: {
              reason: 'External credential is missing.',
              blockers: [{ kind: 'operator_input_required', detail: '<long concrete evidence>' }],
              next_action: '<long exact action needed to unblock continuation>',
            },
            created_by: '<agent id>',
          },
          consume_payload_ref: {
            tool: 'task_lifecycle_report_blocked',
            arguments: {
              task_number: 789,
              agent_id: '<agent id>',
              payload_ref: 'mcp_payload:task-789-blocked-report@v1',
            },
          },
        },
      ],
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
      caveat: 'A successful submit_work can still return in_review or awaiting_dependencies rather than closed. Long inline fields are refused by default; use payload_ref or opt in with auto_materialize_payload:true to create an immutable payload artifact in one call.',
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
    task_lifecycle_submit_work: {
      payload_ref_shape: { summary: '<finish summary>', execution_notes: '<Execution Notes replacement>', verification: '<Verification replacement>', changed_files: ['path/to/file'], no_files_changed: false, self_certification: {}, recovery_truthfulness: {} },
      inline_payload_limit: { threshold_chars: 200, long_fields: ['summary', 'execution_notes', 'verification', 'changed_files'], remediation: 'Default behavior refuses long inline fields and recommends mcp_payload_create plus payload_ref. For one governed call, pass auto_materialize_payload:true; the result must include payload_source.kind=auto_materialized_payload.' },
      one_call_fallback: { field: 'auto_materialize_payload', value: true, audit_contract: 'Creates an immutable transient payload artifact and reports it in payload_source.' },
      top_level_fields_remain_required: ['task_number', 'agent_id'],
    },
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
