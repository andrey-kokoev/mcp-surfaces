export type GuidanceRecord = Record<string, unknown>;
export type GuidanceToolDefinition = GuidanceRecord & { name: string; description: string; inputSchema: GuidanceRecord; annotations: GuidanceRecord; outputSchema: GuidanceRecord };

const SURFACE_ID = "surface-feedback";
const GUIDANCE_TOOL = "surface_feedback_guidance";
const PURPOSE = "Cross-site MCP surface feedback intake and routing.";

export function buildGuidanceResult(args: GuidanceRecord = {}, context: GuidanceRecord = {}): GuidanceRecord {
  const workflow = typeof args.workflow === 'string' && args.workflow.trim() ? args.workflow.trim() : null;
  const tool = typeof args.tool === 'string' && args.tool.trim() ? args.tool.trim() : null;
  return {
    schema: 'narada.mcp_surface.guidance.v0',
    status: 'ok',
    surface_id: SURFACE_ID,
    guidance_tool: GUIDANCE_TOOL,
    purpose: PURPOSE,
    requested: { workflow, tool },
    capabilities: context.capabilities ?? {
      status: 'unknown',
      read_scopes: Object.fromEntries(['all_authorized', 'authority_visible', 'owned_surfaces', 'authority_site_submissions'].map((scope) => [scope, {
        available: null,
        reason: 'Live server capability state was not provided.',
      }])),
      task_handoff: {
        available: null,
        reason: 'Live server capability state was not provided.',
      },
    },
    first_use: [
      'Call this guidance command when the surface is unfamiliar, when a refusal/error is unclear, or before composing a multi-step workflow.',
      'Inspect policy/doctor/status tools before mutation or open-world operations.',
      'Use bounded list/search/query tools for discovery, then show/read/detail tools before acting on a specific object.',
      'Preserve structuredContent as authoritative evidence; text content is for assistant readability.'
    ],
    tool_preference: [
      { step: 'orient', guidance: 'Use *_guidance first when uncertain, then policy/doctor/status tools.' },
      { step: 'discover', guidance: 'Use bounded list/search/query commands with explicit limits and filters.' },
      { step: 'read_scope', guidance: 'Every read call must provide an explicit scope. Check capabilities.read_scopes[scope].available before calling; unavailable scopes include a reason and remediation. The schema lists all scopes for protocol stability. all_authorized is the canonical feedback view and maintainer task-handoff discovery scope when available; authority_visible is the server-bound union of declared submitter-site and owned-surface entries, owned_surfaces is the owned-surface view, and authority_site_submissions is the declared submitter-site metadata view.' },
      { step: 'actionable_queue', guidance: 'Use surface_feedback_actionable_queue for one bounded queue of submitted, acknowledged, routed, and converted feedback; it includes task links and projected task state when available.' },
      { step: 'inspect', guidance: 'Use show/read/detail commands for exact targets before mutation.' },
      { step: 'convert', guidance: 'Use surface_feedback_convert_to_task only when capabilities.task_handoff.available is true and a governed maintainer handoff is intended. Server-bound User Site authority may hand off any canonical entry; ordinary feedback status mutations remain owner-scoped. The tool creates and links through task-lifecycle and returns the next authoritative action.' },
      { step: 'mutate', guidance: 'Only call mutation tools after policy allows it and intent, target, and expected result are explicit.' },
      { step: 'verify', guidance: 'Read back state with the owning surface after any mutation.' }
    ],
    examples: [
      { intent: 'First use', call: 'surface_feedback_guidance({})' },
      { intent: 'Tool-specific help', call: "surface_feedback_guidance({ tool: \"<tool_name>\" })" },
      { intent: 'Workflow-specific help', call: "surface_feedback_guidance({ workflow: \"<workflow_name>\" })" },
      { intent: 'Feedback to task', call: 'surface_feedback_convert_to_task({ feedback_id })' }
    ],
    anti_patterns: [
      'Do not guess hidden state from a tool name; use doctor/status/list/show tools for evidence.',
      'Do not treat assistant text as the durable record when structuredContent is present.',
      'Do not pass caller_site_id or owned_surface_ids to read tools; use the required explicit scope field. A zero result is only meaningful within the returned read_scope.',
      'Do not confuse submitter_site_id_filter with authorization: it filters declared metadata only and never establishes provenance or access.',
      'Use canonical Site IDs in submitter_site_id. Do not record generated server keys, carrier names, or session aliases as submitter identities.',
      'Do not bypass the owning surface with shell scripts when a governed MCP tool exists.',
      'Do not continue after malformed payloads, empty refs, or ambiguous target identifiers; stop and repair the input.'
    ],
    recovery: [
      'For unknown_tool, call tools/list and this guidance command again after restart.',
      'For policy refusal, inspect the surface policy/doctor output and report the exact refusal reason.',
      'For oversized inputs, use the surface payload_ref or output_ref convention when it exists; otherwise reduce scope.',
      'If conversion fails after reserving a handoff, retry surface_feedback_convert_to_task with the same feedback_id. The durable handoff resumes from its recorded payload or task reference without intentionally creating another task.',
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
      'Task lifecycle state in actionable queue results is an optional feedback projection; it is not a replacement for authoritative task-lifecycle readback.',
      'surface_feedback_convert_to_task delegates task creation to task-lifecycle and never executes or closes the created task.',
      'Capability gating is live server state: only call a read scope or task handoff when its capabilities entry reports available: true. The tools/list schema retains all scope names for protocol stability, and unavailable calls return an actionable refusal.',
      'Read scope is explicit and server-bound: all_authorized requires the canonical feedback store plus server authority and enables the explicit User Site task handoff; authority_visible, owned_surfaces, and authority_site_submissions require configured server authority.',
      'Canonical task handoff authority is distinct from owner-scoped feedback status authority.',
      'The submitter site recorded in feedback is declarative metadata supplied at submission time; authority_site_submissions is a metadata filter, not authenticated provenance.',
      'Mutation authority is bound when the server starts; callers must not supply caller_site_id or owned_surface_ids to mutation tools.',
      'Mutation audit identity is derived from server authority; caller-supplied resolved_by compatibility fields are ignored.',
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
