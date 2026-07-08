export type GuidanceRecord = Record<string, unknown>;
export type GuidanceToolDefinition = GuidanceRecord & { name: string; description: string; inputSchema: GuidanceRecord; annotations: GuidanceRecord; outputSchema: GuidanceRecord };

const SURFACE_ID = "sop";
const GUIDANCE_TOOL = "sop_guidance";
const PURPOSE = "Versioned SOP templates and durable SOP run execution.";

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
    first_use: [
      'Call this guidance command when the surface is unfamiliar, when a refusal/error is unclear, or before composing a multi-step workflow.',
      'Inspect policy/doctor/status tools before mutation or open-world operations.',
      'Use bounded list/search/query tools for discovery, then show/read/detail tools before acting on a specific object.',
      'Preserve structuredContent as authoritative evidence; text content is for assistant readability.'
    ],
    tool_preference: [
      { step: 'orient', guidance: 'Use *_guidance first when uncertain, then policy/doctor/status tools.' },
      { step: 'discover', guidance: 'Use bounded list/search/query commands with explicit limits and filters.' },
      { step: 'inspect', guidance: 'Use show/read/detail commands for exact targets before mutation.' },
      { step: 'mutate', guidance: 'Only call mutation tools after policy allows it and intent, target, and expected result are explicit.' },
      { step: 'verify', guidance: 'Read back state with the owning surface after any mutation.' }
    ],
    workflows: {
      template_authoring: [
        'sop_template_create or sop_template_import_yaml to define a versioned SOP.',
        'sop_template_show/export/list/search inspect imported registry templates before execution.',
        'sop_template_candidate_list/show inspect YAML files in configured sops_dirs before import.',
        'sop_template_update or sop_template_deprecate for governed template changes.'
      ],
      durable_run_execution: [
        'sop_run_start creates a durable run from an active template.',
        'sop_run_status shows run and step state.',
        'sop_run_advance records step results/evidence and moves the run forward.',
        'sop_run_refresh synchronizes parent runs with child SOP terminal status.',
        'sop_run_events reads the durable evidence/event ledger.',
        'sop_run_list and sop_run_coverage_since support run discovery and coverage readback.',
        'sop_run_cancel terminates a non-terminal run when execution is intentionally stopped.'
      ]
    },
    tool_inventory: {
      templates: ['sop_template_create', 'sop_template_show', 'sop_template_export', 'sop_template_list', 'sop_template_search', 'sop_template_candidate_list', 'sop_template_candidate_show', 'sop_template_update', 'sop_template_deprecate', 'sop_template_import_yaml'],
      runs: ['sop_run_start', 'sop_run_status', 'sop_run_refresh', 'sop_run_advance', 'sop_run_list', 'sop_run_coverage_since', 'sop_run_cancel', 'sop_run_events']
    },
    examples: [
      { intent: 'First use', call: 'sop_guidance({})' },
      { intent: 'Execute SOP run', call: 'sop_template_show -> sop_run_start -> sop_run_status -> sop_run_advance -> sop_run_events' },
      { intent: 'Tool-specific help', call: "sop_guidance({ tool: \"<tool_name>\" })" },
      { intent: 'Workflow-specific help', call: "sop_guidance({ workflow: \"<workflow_name>\" })" }
    ],
    anti_patterns: [
      'Do not guess hidden state from a tool name; use doctor/status/list/show tools for evidence.',
      'Do not use filesystem listing as the normal way to discover importable SOP YAML; use sop_template_candidate_list/show.',
      'Do not treat assistant text as the durable record when structuredContent is present.',
      'Do not bypass the owning surface with shell scripts when a governed MCP tool exists.',
      'Do not continue after malformed payloads, empty refs, or ambiguous target identifiers; stop and repair the input.'
    ],
    recovery: [
      'For unknown_tool, call tools/list and this guidance command again after restart.',
      'For policy refusal, inspect the surface policy/doctor output and report the exact refusal reason.',
      'For oversized inputs, use the surface payload_ref or output_ref convention when it exists; otherwise reduce scope.',
      'For unclear behavior, submit surface_feedback_submit with surface_id, kind, summary, reproduction steps, expected behavior, and impact.'
    ],
    feedback: {
      surface_id: SURFACE_ID,
      tool: 'surface_feedback_submit',
      when: [
        'guidance is missing, stale, or contradicted by live behavior',
        'schema shape makes correct usage hard',
        'errors hide the actionable refusal or recovery path'
      ]
    },
    boundaries: [
      'Guidance is read-only model-facing operating advice.',
      'Guidance does not weaken policy, authorize mutation, or replace tool schemas.',
      'The owning MCP surface remains authoritative for state and enforcement.'
    ]
  };
}

export function guidanceToolDefinition(name: string = GUIDANCE_TOOL, description: string = 'Show model-facing operating guidance for ' + SURFACE_ID + ' MCP workflows.'): GuidanceToolDefinition {
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
