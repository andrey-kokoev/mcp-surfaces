export type GuidanceRecord = Record<string, unknown>;
export type GuidanceToolDefinition = GuidanceRecord & { name: string; description: string; inputSchema: GuidanceRecord; annotations: GuidanceRecord; outputSchema: GuidanceRecord };

const SURFACE_ID = "structured-command";
const GUIDANCE_TOOL = "structured_command_guidance";
const PURPOSE = "Policy-gated argv command execution.";

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
    examples: [
      { intent: 'First use', call: 'structured_command_guidance({})' },
      { intent: 'Tool-specific help', call: "structured_command_guidance({ tool: \"<tool_name>\" })" },
      { intent: 'Workflow-specific help', call: "structured_command_guidance({ workflow: \"<workflow_name>\" })" }
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
      'For a "Transport closed" error through mcp-loader, inspect mcp_loader_connection_inventory and mcp_loader_surface_status, then call mcp_loader_surface_restart({ connection_id, reason }) to replace only the child surface process; the agent session does not need to restart.',
      'After mcp_loader_surface_restart or detach plus reattach, treat input_ref and execution_ref from the old child as expired. Create a fresh structured_command_input_create result or send a new inline argv request before retrying. If the child stayed live after a timeout, page the existing execution_ref first.',
      'Use mcp_loader_list_tools({ connection_id: replacement_connection_id }) followed by mcp_loader_call_tool({ connection_id: replacement_connection_id, tool_name: "structured_command_execution_policy_inspect", arguments: {} }) as a small health check on the replacement connection. When calling through mcp-loader, pass timeout_ms in the nested structured-command arguments and stay within the loader and child policy caps.',
      'For a governed command that may outlast the MCP request ceiling, declare test_scope: "known_slow" and set wait_for_completion: false. The call returns a running execution_ref immediately; poll structured_command_execute with that execution_ref until status is ok, failed, timed_out, or cancelled. The command remains bounded by policy and the ref is scoped to this surface process/storage.',
      'For unclear behavior, submit surface_feedback_submit with surface_id, kind, summary, reproduction steps, expected behavior, and impact.'
    ],
    recovery_commands: [
      {
        failure: 'Transport closed',
        sequence: [
          'mcp_loader_connection_inventory({})',
          'mcp_loader_surface_status({ connection_id })',
          'mcp_loader_surface_restart({ connection_id, reason: "replace closed structured-command child" })',
          'mcp_loader_list_tools({ connection_id: replacement_connection_id })',
          'mcp_loader_call_tool({ connection_id: replacement_connection_id, tool_name: "structured_command_execution_policy_inspect", arguments: {} })'
        ],
        note: 'Restart replaces the attached child only. Recreate input_ref and execution_ref after replacement; do not reuse refs owned by the dead child.'
      },
      {
        failure: 'Timed-out execution with a live child',
        sequence: [
          'mcp_loader_call_tool({ connection_id, tool_name: "structured_command_execute", arguments: { execution_ref, stdout_offset, stdout_limit } })',
          'mcp_loader_call_tool({ connection_id, tool_name: "structured_command_execute", arguments: { input_ref: fresh_input_ref, timeout_ms: policy_max } })'
        ],
        note: 'Read back the existing execution_ref before rerunning. If the child was replaced, create a fresh input_ref and execution request.'
      },
      {
        failure: 'Known-slow verification exceeds the MCP request ceiling',
        sequence: [
          'mcp_loader_call_tool({ connection_id, tool_name: "structured_command_execute", arguments: { command: "pnpm", args: ["test"], working_directory, timeout_ms: 900000, test_scope: "known_slow", wait_for_completion: false } })',
          'mcp_loader_call_tool({ connection_id, tool_name: "structured_command_execute", arguments: { execution_ref } })'
        ],
        note: 'The first call is an admission/start operation. Poll the returned execution_ref; do not rerun the command while it is still running.'
      }
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
