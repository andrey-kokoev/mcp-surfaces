export type GuidanceRecord = Record<string, unknown>;
export type GuidanceToolDefinition = GuidanceRecord & { name: string; description: string; inputSchema: GuidanceRecord; annotations: GuidanceRecord; outputSchema: GuidanceRecord };

const SURFACE_ID = "local-filesystem";
const GUIDANCE_TOOL = "fs_guidance";
const PURPOSE = "Governed filesystem inspection and mutation under allowed roots.";

export function buildGuidanceResult(args: GuidanceRecord = {}): GuidanceRecord {
  const workflow = typeof args.workflow === 'string' && args.workflow.trim() ? args.workflow.trim() : null;
  const tool = typeof args.tool === 'string' && args.tool.trim() ? args.tool.trim() : null;
  const patchRecovery = workflow === 'bounded_reads_and_patch_recovery' || tool === 'fs_apply_patch' || tool === 'fs_patch_outcome_show' ? {
    patch_recovery: {
      sequence: [
        'Choose a stable operation_id before calling fs_apply_patch.',
        'Call fs_apply_patch once with that operation_id and the intended patch.',
        'After timeout or transport loss, call fs_patch_outcome_show with the same operation_id.',
        'Retry fs_apply_patch with the same operation_id only when necessary; a matching patch hash replays the durable outcome without mutation, while a different hash is rejected.'
      ],
      statuses: {
        accepted: 'The request is durable but parsing/planning has not completed.',
        checked: 'Dry-run validation completed without mutation.',
        applying: 'Mutation has started; inspect the outcome again rather than submitting a different patch.',
        patched: 'Mutation completed and changed-file hashes are durable.',
        failed_before_mutation: 'Parsing, validation, or planning failed and no mutation started.',
        failed_rolled_back: 'Mutation started, failed, and rollback evidence is included.'
      },
      read_mode: 'fs_patch_outcome_show is available in both read and write modes.',
    }
  } : {};
  const repositoryInventory = workflow === 'repository_inventory' || tool === 'fs_repository_inventory' ? {
    repository_inventory: {
      sequence: [
        'Call fs_repository_inventory with an explicit directory, pattern, limit, and cache policy.',
        'Use candidate_source_paths for bounded source-oriented follow-up and generated_artifact_paths for runtime cleanup review.',
        'Set include_generated: true only when generated artifacts are part of the explicit investigation.',
        'Call git_changed_summary for authoritative tracked and ignored state; this filesystem view does not infer Git status.'
      ],
      classification: {
        candidate_source: 'A path returned by the bounded inventory that is not in a known generated runtime/artifact location.',
        generated_artifact: 'A path under a known .ai/.narada runtime, temporary, output, or patch-outcome location.'
      },
      default_behavior: 'Known generated runtime/artifact patterns are excluded unless include_generated is true.',
      git_tracking_boundary: 'Filesystem inventory identifies candidate and generated paths; git-mcp owns tracked and ignored classification.'
    }
  } : {};
  return {
    schema: 'narada.mcp_surface.guidance.v0',
    status: 'ok',
    surface_id: SURFACE_ID,
    guidance_tool: GUIDANCE_TOOL,
    purpose: PURPOSE,
    requested: { workflow, tool },
    ...patchRecovery,
    ...repositoryInventory,
    first_use: [
      'Call this guidance command when the surface is unfamiliar, when a refusal/error is unclear, or before composing a multi-step workflow.',
      'Inspect policy/doctor/status tools before mutation or open-world operations.',
      'Use bounded list/search/query tools for discovery, then show/read/detail tools before acting on a specific object.',
      'Preserve structuredContent as authoritative evidence; text content is for assistant readability.'
    ],
    tool_preference: [
      { step: 'orient', guidance: 'Use *_guidance first when uncertain, then policy/doctor/status tools.' },
      { step: 'discover', guidance: 'Use bounded list/search/query commands with explicit limits and filters; use fs_repository_inventory for repository-oriented source/artifact discovery.' },
      { step: 'inspect', guidance: 'Use show/read/detail commands for exact targets before mutation.' },
      { step: 'mutate', guidance: 'Only call mutation tools after policy allows it and intent, target, and expected result are explicit.' },
      { step: 'verify', guidance: 'Read back state with the owning surface after any mutation.' }
    ],
    examples: [
      { intent: 'First use', call: 'fs_guidance({})' },
      { intent: 'Tool-specific help', call: "fs_guidance({ tool: \"<tool_name>\" })" },
      { intent: 'Workflow-specific help', call: "fs_guidance({ workflow: \"<workflow_name>\" })" },
      { intent: 'Repository inventory', call: 'fs_repository_inventory({ directory: ".", pattern: "**/*", limit: 100 })' }
    ],
    anti_patterns: [
      'Do not guess hidden state from a tool name; use doctor/status/list/show tools for evidence.',
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
      'The owning MCP surface remains authoritative for state and enforcement.',
      'fs_repository_inventory is a bounded filesystem view; use git-mcp for authoritative tracked and ignored state.'
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
