export type GuidanceRecord = Record<string, unknown>;
export type GuidanceToolDefinition = GuidanceRecord & { name: string; description: string; inputSchema: GuidanceRecord; annotations: GuidanceRecord; outputSchema: GuidanceRecord };

const SURFACE_ID = 'sop';
const GUIDANCE_TOOL = 'sop_guidance';
const PURPOSE = 'Durable, restart-safe execution of one parameterized procedure occurrence.';

export function buildGuidanceResult(args: GuidanceRecord = {}): GuidanceRecord {
  const workflow = typeof args.workflow === 'string' && args.workflow.trim() ? args.workflow.trim() : null;
  const tool = typeof args.tool === 'string' && args.tool.trim() ? args.tool.trim() : null;
  return {
    schema: 'narada.mcp_surface.guidance.v0',
    status: 'ok',
    surface_id: SURFACE_ID,
    guidance_tool: GUIDANCE_TOOL,
    purpose: PURPOSE,
    requested: { workflow, tool },
    core_model: [
      'One SOP run is one durable procedure occurrence, identified by caller-owned occurrence_key.',
      'The admitted template version, executable definition fingerprint, and omitted child versions are resolved and pinned before their handoffs become eligible.',
      'Dependencies and deterministic when predicates decide which steps run or are skipped.',
      'Scheduler and event surfaces decide when to call sop_run_start; trigger_kind is provenance, not an activation mechanism.',
      'Domain MCP surfaces perform effects. SOP persists an action intent and later accepts an owning-surface operation reference; it never runs shell commands.',
      'Child and manual completion reconcile transactionally; action receipts commit first and then automatically reconcile so an acknowledged domain effect is never forgotten.',
      'Pinned run definitions, execution-step snapshots, action targets, and action completion receipts are fingerprint-checked when durable state is rehydrated.'
    ],
    first_use: [
      'Call sop_doctor and inspect execution_posture and byte bounds.',
      'Inspect the exact template with sop_template_show before admitting an occurrence.',
      'Preserve structuredContent as authoritative evidence; text content is only a bounded summary.'
    ],
    workflows: {
      template_authoring: [
        'Define a dependency DAG with engine, agent, operator, sop, and action steps.',
        'Use input_schema, result_schema, output, output_ref, and output_schema where a procedure has a typed contract.',
        'Use exact {$ref:"input.field"} or {$ref:"steps.predecessor.result.field"} mappings; step references must be dependency ancestors.',
        'Use executor=action only with an owning surface_id/tool_name and a reserved idempotency_key_argument.',
        'Import YAML candidates only through sop_template_import_yaml so the same v2 validation applies.'
      ],
      occurrence_execution: [
        'The Scheduler or durable event consumer calls sop_run_start with sop_id, occurrence_key, triggered_by, bounded input, and optional immutable input_ref.',
        'An exact admission retry returns the same run; reusing the key for a different request is refused as sop_occurrence_conflict.',
        'Use sop_run_status for the complete occurrence and sop_run_events for its evidence ledger.',
        'Complete agent/operator handoffs with sop_run_advance using principal, outcome, and a stable completion_key.',
        'Use sop_run_refresh only for explicit repair/readback; it is not required for normal child continuation.'
      ],
      governed_action_handoff: [
        'Use sop_action_list to discover pending summaries, then sop_action_show to read one exact persisted target envelope.',
        'Invoke the named domain MCP tool with the exact arguments. SOP has already injected the stable action occurrence key into the declared idempotency argument.',
        'Call sop_action_resolve with a stable completion_key and the domain surface operation_ref, plus a bounded result and/or immutable result_ref.',
        'If interrupted at any boundary, re-read the same action and retry the domain operation by its injected key; exact resolution retries are idempotent.',
        'If a run is cancelled while the domain outcome is in flight, do not dispatch the cancelled action again; submit any late operation receipt so the external outcome remains recorded.'
      ]
    },
    tool_inventory: {
      templates: ['sop_template_create', 'sop_template_show', 'sop_template_export', 'sop_template_list', 'sop_template_search', 'sop_template_candidate_list', 'sop_template_candidate_show', 'sop_template_update', 'sop_template_deprecate', 'sop_template_unimport', 'sop_template_import_yaml'],
      runs: ['sop_run_start', 'sop_run_status', 'sop_run_refresh', 'sop_run_advance', 'sop_run_list', 'sop_run_coverage_since', 'sop_run_cancel', 'sop_run_events'],
      actions: ['sop_action_list', 'sop_action_show', 'sop_action_resolve']
    },
    examples: [
      { intent: 'Admit scheduled occurrence', call: 'scheduler event -> sop_run_start({ sop_id, occurrence_key, input, triggered_by })' },
      { intent: 'Execute action handoff', call: 'sop_action_list -> sop_action_show -> owning domain MCP tool -> sop_action_resolve' },
      { intent: 'Resume after interruption', call: 'sop_run_status and sop_action_show; retry with the same occurrence/completion keys' }
    ],
    anti_patterns: [
      'Do not put schedules, polling loops, or run-right-after-finish policy inside an SOP template.',
      'Do not put executable, argv, cwd, filesystem mutation, task mutation, or other domain effects in engine steps.',
      'Do not acknowledge an action without the owning domain surface operation reference.',
      'Do not reuse an occurrence_key or completion_key for semantically different data.',
      'Do not inline large evidence or results; keep a bounded summary and immutable digest-pinned reference.',
      'Do not call sop_run_refresh as routine orchestration; normal reconciliation is automatic.'
    ],
    recovery: [
      'For sop_occurrence_conflict or completion conflict, compare the recorded and supplied fingerprints/keys; do not overwrite either occurrence.',
      'For oversized input/result, materialize it with the owning surface and provide a value-ref containing ref and sha256.',
      'If aggregate run-state pressure omits an inline action result, read the full retained result with sop_action_show and revise the procedure to rely on result_ref for large payloads.',
      'For pending action after restart, read sop_action_show and retry its owning tool with the already-injected idempotency key.',
      'For unclear behavior, submit surface_feedback_submit with the exact refusal and expected invariant.'
    ],
    boundaries: [
      'SOP owns versioned procedure definitions, occurrence state, dependency/condition evaluation, handoff intents, and reconciliation.',
      'Scheduler and durable event consumers own temporal/event activation and fan-out into one occurrence per durable event.',
      'Domain MCP surfaces own effects and their authorization; an SOP action binding does not grant authority.',
      'Worker/delegation surfaces own leases, worker execution, and liveness; SOP stores only procedure-level handoff state.'
    ]
  };
}

export function guidanceToolDefinition(name: string = GUIDANCE_TOOL, description: string = `Show model-facing operating guidance for ${SURFACE_ID} MCP workflows.`): GuidanceToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Optional workflow name or area to focus guidance on.' },
        tool: { type: 'string', description: 'Optional tool name for tool-specific guidance.' }
      },
      additionalProperties: false
    },
    annotations: { title: name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: { type: 'object', additionalProperties: true }
  };
}
