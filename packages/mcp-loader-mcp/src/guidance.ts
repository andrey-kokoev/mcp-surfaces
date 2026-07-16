export type GuidanceRecord = Record<string, unknown>;
export type GuidanceToolDefinition = GuidanceRecord & {
  name: string;
  description: string;
  inputSchema: GuidanceRecord;
  annotations: GuidanceRecord;
  outputSchema: GuidanceRecord;
};

const SURFACE_ID = 'mcp-loader';
const GUIDANCE_TOOL = 'mcp_loader_guidance';
const PURPOSE = 'Policy-gated runtime attachment and proxying for MCP surfaces admitted by a Site fabric.';

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
    runtime_lifecycle: {
      managed_by: 'mcp-loader',
      restartable_attached_children: true,
      restart_scope: 'attached_child_process',
      session_restart_required: false,
      inventory_tool: 'mcp_loader_connection_inventory',
      status_tool: 'mcp_loader_surface_status',
      restart_tool: 'mcp_loader_surface_restart',
      guidance: 'Any surface attached through this loader can be restarted by connection id. Restart replaces only the child process; it does not restart the agent session.',
    },
    first_use: [
      'Call mcp_loader_policy_inspect before relying on loader capabilities or allowed roots.',
      'Call mcp_loader_connection_inventory before attachment when recovering from capacity errors or an earlier interrupted session.',
      'Call mcp_loader_list_site_surfaces and mcp_loader_site_fabric_diagnostics for the explicit Site root.',
      'Use mcp_loader_attach_surface with an explicit surface_id and runtime_kind when the projection requires one.',
      'Use mcp_loader_list_tools or mcp_loader_tool_discovery_manifest after attachment; the child tools/list response owns exact tool schemas.',
      'Preserve structuredContent as authoritative evidence; text content is for assistant readability.',
    ],
    tool_preference: [
      { step: 'orient', guidance: 'Use mcp_loader_guidance and mcp_loader_policy_inspect before attachment or proxy calls.' },
      { step: 'recover', guidance: 'For a stale or transport-closed child, inspect mcp_loader_connection_inventory or mcp_loader_surface_status, then call mcp_loader_surface_restart with the connection_id; the agent session does not need to restart.' },
      { step: 'resolve_site', guidance: 'Use mcp_loader_list_site_surfaces and mcp_loader_site_fabric_diagnostics against the same explicit Site root.' },
      { step: 'attach', guidance: 'Attach the exact declared surface and provide runtime_kind explicitly when the projection requires it.' },
      { step: 'discover', guidance: 'Use mcp_loader_list_tools or mcp_loader_tool_discovery_manifest; use the child tools/list definitions for exact input and output shape.' },
      { step: 'observe_live', guidance: 'Use mcp_loader_site_tool_inventory_check to compare declared tools with fresh child tools/list responses and retain its immutable observation_ref.' },
      { step: 'operate', guidance: 'Call a child tool only after selecting the intended connection and honoring the child surface policy.' },
      { step: 'finish', guidance: 'Use mcp_loader_detach or mcp_loader_surface_restart deliberately and inspect the returned termination or replacement evidence.' },
    ],
    examples: [
      { intent: 'First use', call: 'mcp_loader_guidance({})' },
      { intent: 'Inspect a workflow', call: 'mcp_loader_guidance({ workflow: "discover", tool: "mcp_loader_list_tools" })' },
      { intent: 'Recover capacity', call: 'mcp_loader_connection_inventory({})' },
      { intent: 'Inspect a Site', call: 'mcp_loader_list_site_surfaces({ site_root: "<site_root>" })' },
      { intent: 'Observe live tools', call: 'mcp_loader_site_tool_inventory_check({ site_root: "<site_root>", runtime_kind: "<runtime_kind>" })' },
    ],
    anti_patterns: [
      'Do not infer a Site or runtime from the current directory, process name, server name, or entrypoint path.',
      'Do not attach an undeclared surface or use an entrypoint outside the allowed policy prefixes.',
      'Do not copy child inputSchema or outputSchema into loader guidance; read the current child tools/list response instead.',
      'Do not treat loader attachment as authorization for the child surface domain; the attached surface remains authoritative.',
      'Do not copy or hand-build observation maps; pass the immutable observation_ref returned by mcp_loader_site_tool_inventory_check.',
      'Do not bypass the owning surface with shell scripts when a governed MCP tool exists.',
    ],
    recovery: [
      'For unknown_tool, call tools/list and mcp_loader_guidance again after restart.',
      'For surface_runtime_required or surface_runtime_not_supported, inspect the declared projection and retry only with an explicit compatible runtime_kind.',
      'For fabric drift, repair the owning Site fabric or shared registry declaration before retrying attachment.',
      'For missing or stale live observations, rerun mcp_loader_site_tool_inventory_check and pass its new observation_ref to the Registrar.',
      'For child failures, inspect mcp_loader_surface_status and stderr evidence, then use mcp_loader_surface_restart({ connection_id, reason }) when the attached child should be replaced.',
      'For max_connections_reached, call mcp_loader_connection_inventory, detach stale or closed connection ids, and retry only after capacity is available.',
      'For unclear behavior, submit surface_feedback_submit with reproduction steps, expected behavior, and impact.',
    ],
    feedback: {
      surface_id: SURFACE_ID,
      tool: 'surface_feedback_submit',
      when: [
        'guidance is missing, stale, or contradicted by live loader behavior',
        'schema shape makes correct usage hard',
        'errors hide the actionable refusal or recovery path',
      ],
    },
    boundaries: [
      'MCP Loader owns child attachment, initialization, tool discovery, call proxying, and detachment.',
      'MCP Loader does not own attached-surface domain policy, action admission, or child tool semantics.',
      'The loader binds children to the requested Site root and does not let an ambient caller Site root override it.',
      'Guidance is read-only model-facing operating advice and does not replace tool schemas or policy checks.',
    ],
  };
}

export function guidanceToolDefinition(
  name: string = GUIDANCE_TOOL,
  description: string = 'Show model-facing operating guidance for ' + SURFACE_ID + ' MCP workflows.',
): GuidanceToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Optional workflow name or area to focus guidance on.' },
        tool: { type: 'string', description: 'Optional tool name for tool-specific guidance.' },
      },
      additionalProperties: false,
    },
    annotations: { title: name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: { type: 'object', additionalProperties: true },
  };
}
