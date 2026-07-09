export type GuidanceRecord = Record<string, unknown>;
export type GuidanceToolDefinition = GuidanceRecord & { name: string; description: string; inputSchema: GuidanceRecord; annotations: GuidanceRecord; outputSchema: GuidanceRecord };

const SURFACE_ID = 'mcp-registrar';
const GUIDANCE_TOOL = 'registrar_guidance';
const PURPOSE = 'MCP surface registrar for site/carrier binding and materialized Site registry conformance.';

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
      'Validate the Site fabric with registrar_site_mcp_fabric_validate before regenerating its materialized registry.',
      'Use mcp_loader_site_tool_inventory_check to obtain fresh observed_tools, observed_read_only_tools, and observed_mutating_tools from actual child tools/list responses.',
      'Pass all three observation maps unchanged to registrar_site_registry_conformance_check; missing observations are failures, not permission defaults.',
      'Preserve structuredContent as authoritative evidence; text content is for assistant readability.',
    ],
    tool_preference: [
      { step: 'validate_fabric', guidance: 'Call registrar_site_mcp_fabric_validate for the target Site.' },
      { step: 'observe_live', guidance: 'Call mcp_loader_site_tool_inventory_check against the same Site root. Every live tool must explicitly declare readOnlyHint=true or false.' },
      { step: 'materialize', guidance: 'Call registrar_site_surface_registry_sync only when the Site fabric and catalog are intentional.' },
      { step: 'prove', guidance: 'Call registrar_site_registry_conformance_check with all live observation maps. Status ok is the authority projection proof.' },
      { step: 'repair', guidance: 'Repair drift at its owning layer: surface annotations, Site fabric, registrar catalog, or materialized registry generation.' },
    ],
    examples: [
      { intent: 'First use', call: 'registrar_guidance({})' },
      { intent: 'Validate Site fabric', call: 'registrar_site_mcp_fabric_validate({ site_id: "<site_id>" })' },
      { intent: 'Materialize Site registry', call: 'registrar_site_surface_registry_sync({ site_id: "<site_id>", dry_run: false })' },
      { intent: 'Prove conformance', call: 'registrar_site_registry_conformance_check({ site_id: "<site_id>", observed_tools, observed_read_only_tools, observed_mutating_tools })' },
    ],
    anti_patterns: [
      'Do not infer mutation semantics from tool names. The live surface must declare readOnlyHint explicitly.',
      'Do not treat a tools/list name match as full conformance; classification, provenance, partition, projection, and output-reader closure must also pass.',
      'Do not hand-build observation maps when mcp_loader_site_tool_inventory_check can produce them from fresh children.',
      'Do not regenerate a registry to conceal drift in a surface annotation or Site fabric declaration.',
      'Do not bypass the owning surface with shell scripts when a governed MCP tool exists.',
    ],
    recovery: [
      'For unknown_tool, call tools/list and this guidance command again after restart.',
      'For live_tool_observation_missing or live classification observation missing, rerun mcp_loader_site_tool_inventory_check and pass every returned observation map.',
      'For live_tool_semantics_partition_incomplete, add an explicit boolean readOnlyHint at the owning surface; do not default it.',
      'For registry drift, repair the named layer and then rematerialize and rerun the full proof.',
      'For unclear behavior, submit surface_feedback_submit with reproduction steps, expected behavior, and impact.',
    ],
    feedback: {
      surface_id: SURFACE_ID,
      tool: 'surface_feedback_submit',
      when: [
        'guidance is missing, stale, or contradicted by live behavior',
        'schema shape makes correct usage hard',
        'errors hide the actionable refusal or recovery path',
      ],
    },
    boundaries: [
      'The registrar materializes and verifies authority declarations; it does not infer policy from names.',
      'MCP Loader owns fresh child attachment and live tools/list observation.',
      'Each owning MCP surface remains authoritative for execution policy and domain enforcement.',
    ],
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
        tool: { type: 'string', description: 'Optional tool name for tool-specific guidance.' },
      },
      additionalProperties: false,
    },
    annotations: { title: name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: { type: 'object', additionalProperties: true },
  };
}
