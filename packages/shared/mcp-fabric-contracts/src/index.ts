import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MCP_FABRIC_SCHEMA_VERSION = '3.0' as const;
export const MCP_FABRIC_SCHEMA_MAJOR = 3;
export const SURFACE_DESCRIBE_TOOL_NAME = 'surface_describe' as const;
export const SURFACE_CONTRACT_DESCRIBE_TOOL_NAME = 'surface_contract_describe' as const;
export const UNIVERSAL_SURFACE_TOOL_NAMES = [
  SURFACE_DESCRIBE_TOOL_NAME,
  SURFACE_CONTRACT_DESCRIBE_TOOL_NAME,
] as const;

export function assertUniversalSurfaceToolNames(
  names: readonly string[],
  context = 'surface',
): void {
  const declared = new Set(names);
  const missing = UNIVERSAL_SURFACE_TOOL_NAMES.filter((name) => !declared.has(name));
  if (missing.length > 0) {
    throw new Error(`mcp_fabric_universal_tools_missing:${context}:${missing.join(',')}`);
  }
}

const IdentifierSchema = z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/);
const EnvironmentVariableSchema = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const HeaderNameSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const VersionSchema = z.string().trim().min(1);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ToolEffectSchema = z.object({
  class: z.enum(['read', 'local_write', 'external_write', 'command', 'runtime_admin']),
  idempotency: z.enum(['replayable', 'idempotent', 'non_idempotent']),
  confirmation: z.enum(['never', 'policy', 'always']),
}).strict().superRefine((effect, context) => {
  if (effect.class === 'read' && effect.idempotency !== 'replayable') {
    context.addIssue({
      code: 'custom',
      message: 'read effects must be replayable',
      path: ['idempotency'],
    });
  }
  if (effect.class === 'read' && effect.confirmation !== 'never') {
    context.addIssue({
      code: 'custom',
      message: 'read effects must not require confirmation',
      path: ['confirmation'],
    });
  }
});

export const LifecycleRequirementSchema = z.object({
  mode: z.enum(['replayable', 'session_pinned', 'restart_required']),
  restart_owner: IdentifierSchema.optional(),
  reason: z.string().trim().min(1).optional(),
}).strict().superRefine((lifecycle, context) => {
  if (lifecycle.mode === 'restart_required' && lifecycle.restart_owner === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'restart_required lifecycle must name restart_owner',
      path: ['restart_owner'],
    });
  }
  if (lifecycle.mode !== 'restart_required' && lifecycle.restart_owner !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'restart_owner is only valid for restart_required lifecycle',
      path: ['restart_owner'],
    });
  }
});

export const LifecycleReadbackMetadataSchema = z.object({
  authority: z.literal('mcp-loader'),
  availability: z.literal('loader-managed'),
  discovery: z.object({
    tool_name: z.literal('mcp_loader_connection_inventory'),
    arguments: JsonObjectSchema,
    select: z.object({
      field: IdentifierSchema,
      equals: z.string().trim().min(1),
      result_field: IdentifierSchema,
    }).strict(),
  }).strict(),
  status: z.object({
    tool_name: z.literal('mcp_loader_surface_status'),
    arguments: z.object({ connection_id: z.literal('{connection_id}') }).strict(),
    connection_id_from: z.literal('discovery.selected.connection_id'),
  }).strict(),
}).strict();

export type LifecycleReadbackMetadata = z.infer<typeof LifecycleReadbackMetadataSchema>;

export const ToolContractV3Schema = z.object({
  name: IdentifierSchema,
  description: z.string().trim().min(1),
  input_schema: JsonObjectSchema,
  output_schema: JsonObjectSchema.optional(),
  annotations: JsonObjectSchema.optional(),
  effect: ToolEffectSchema,
  timeout_ms: z.number().int().positive().max(3_600_000).optional(),
}).strict();

export const StdioTransportSchema = z.object({
  kind: z.literal('stdio'),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: z.array(EnvironmentVariableSchema).default([]),
}).strict();

export const StreamableHttpTransportSchema = z.object({
  kind: z.literal('streamable_http'),
  url: z.string().url(),
  headers: z.array(HeaderNameSchema).default([]),
}).strict();

export const SurfaceProjectionV3Schema = z.object({
  id: IdentifierSchema,
  transport: z.discriminatedUnion('kind', [
    StdioTransportSchema,
    StreamableHttpTransportSchema,
  ]),
  injection_scope: z.enum(['host', 'user_site', 'local_site']),
  default_injection: z.enum(['enabled', 'disabled']).default('disabled'),
  runtime_requirements: z.array(IdentifierSchema).default([]),
  authority_requirements: z.array(IdentifierSchema).default([]),
  lifecycle: LifecycleRequirementSchema,
}).strict();

export const SurfaceDescriptorV3Schema = z.object({
  schema_version: VersionSchema,
  source: z.literal('native'),
  surface_id: IdentifierSchema,
  surface_version: VersionSchema,
  package: z.string().trim().min(1),
  description: z.string().trim().min(1),
  guidance_tool: IdentifierSchema.nullable(),
  tools: z.array(ToolContractV3Schema).min(1),
  projections: z.array(SurfaceProjectionV3Schema).min(1),
  metadata: JsonObjectSchema.optional(),
}).strict().superRefine((descriptor, context) => {
  addDuplicateIssues(descriptor.tools.map((tool) => tool.name), 'tool', ['tools'], context);
  const toolNames = new Set(descriptor.tools.map((tool) => tool.name));
  for (const universalToolName of UNIVERSAL_SURFACE_TOOL_NAMES) {
    if (!toolNames.has(universalToolName)) {
      context.addIssue({
        code: 'custom',
        message: `every executable surface must declare ${universalToolName}`,
        path: ['tools'],
      });
    }
  }
  addDuplicateIssues(
    descriptor.projections.map((projection) => projection.id),
    'projection',
    ['projections'],
    context,
  );
  if (
    descriptor.guidance_tool !== null
    && !descriptor.tools.some((tool) => tool.name === descriptor.guidance_tool)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'guidance_tool must name a declared tool',
      path: ['guidance_tool'],
    });
  }
  const lifecycleReadback = descriptor.metadata?.lifecycle_readback;
  if (lifecycleReadback !== undefined) {
    const parsed = LifecycleReadbackMetadataSchema.safeParse(lifecycleReadback);
    if (!parsed.success) {
      context.addIssue({
        code: 'custom',
        message: `invalid lifecycle_readback metadata: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
        path: ['metadata', 'lifecycle_readback'],
      });
    }
  }
});

export const FabricBindingV3Schema = z.object({
  binding_id: IdentifierSchema,
  surface_id: IdentifierSchema,
  projection_id: IdentifierSchema,
  server_name: IdentifierSchema,
  enabled: z.boolean().default(true),
  site_id: IdentifierSchema.optional(),
  carrier_kind: IdentifierSchema.optional(),
  config: JsonObjectSchema.default({}),
}).strict();

export const FabricManifestV3Schema = z.object({
  schema_version: VersionSchema,
  manifest_id: IdentifierSchema,
  site_id: IdentifierSchema,
  generated_at: z.string().datetime(),
  descriptors: z.array(SurfaceDescriptorV3Schema),
  bindings: z.array(FabricBindingV3Schema),
  source_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((manifest, context) => {
  addDuplicateIssues(
    manifest.descriptors.map((descriptor) => descriptor.surface_id),
    'surface',
    ['descriptors'],
    context,
  );
  addDuplicateIssues(
    manifest.bindings.map((binding) => binding.binding_id),
    'binding',
    ['bindings'],
    context,
  );
  addDuplicateIssues(
    manifest.bindings.map((binding) => binding.server_name),
    'server name',
    ['bindings'],
    context,
  );
});

export const CarrierProjectionV3Schema = z.object({
  schema_version: VersionSchema,
  carrier_kind: IdentifierSchema,
  site_id: IdentifierSchema,
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
  servers: z.array(z.object({
    server_name: IdentifierSchema,
    surface_id: IdentifierSchema,
    projection_id: IdentifierSchema,
    transport: z.discriminatedUnion('kind', [
      StdioTransportSchema,
      StreamableHttpTransportSchema,
    ]),
  }).strict()),
}).strict().superRefine((projection, context) => {
  addDuplicateIssues(
    projection.servers.map((server) => server.server_name),
    'server name',
    ['servers'],
    context,
  );
});

export const RuntimeGenerationV3Schema = z.object({
  generation_id: IdentifierSchema,
  state: z.enum(['active', 'terminated', 'failed']),
  started_at: z.string().datetime(),
  heartbeat_at: z.string().datetime(),
  freshness: z.enum(['current', 'stale', 'unknown']),
  health: z.enum(['healthy', 'degraded', 'unreachable', 'unknown']),
  descriptor_digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  interface_digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  detail: z.string().optional(),
}).strict();

export const RuntimeRecoveryActionV3Schema = z.object({
  actuator: IdentifierSchema,
  tool_name: IdentifierSchema.nullable(),
  arguments: JsonObjectSchema,
  guidance: z.string().trim().min(1),
}).strict();

export const RuntimeServerObservationV3Schema = z.object({
  server_name: IdentifierSchema,
  surface_id: IdentifierSchema,
  projection_id: IdentifierSchema,
  logical_connection_id: IdentifierSchema,
  lifecycle: LifecycleRequirementSchema,
  active_generation: RuntimeGenerationV3Schema.nullable(),
  recovery_actions: z.array(RuntimeRecoveryActionV3Schema),
  detail: z.string().optional(),
}).strict();

export const RuntimeObservationV3Schema = z.object({
  schema_version: VersionSchema,
  observation_id: IdentifierSchema,
  observed_at: z.string().datetime(),
  site_id: IdentifierSchema,
  carrier_kind: IdentifierSchema,
  runtime_state_root: z.string().trim().min(1).nullable(),
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  servers: z.array(RuntimeServerObservationV3Schema),
}).strict().superRefine((observation, context) => {
  addDuplicateIssues(
    observation.servers.map((server) => server.server_name),
    'runtime server',
    ['servers'],
    context,
  );
  addDuplicateIssues(
    observation.servers.map((server) => server.logical_connection_id),
    'logical connection',
    ['servers'],
    context,
  );
});

export const ReconciliationActionV3Schema = z.object({
  action: z.enum([
    'no_op',
    'restart_process',
    'reconnect_required',
    'rematerialize_carrier_config',
    'unsupported',
  ]),
  server_name: IdentifierSchema.nullable(),
  reason: z.string().trim().min(1),
  actuator: IdentifierSchema,
  required_authority: IdentifierSchema,
  operation_id: IdentifierSchema,
  expected_state: z.object({
    manifest_digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    observation_digest: z.string().regex(/^[a-f0-9]{64}$/),
    descriptor_digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  }).strict(),
  outcome_lookup: z.object({
    tool_name: IdentifierSchema,
    arguments: JsonObjectSchema,
  }).strict(),
  recovery: z.object({
    actuator: IdentifierSchema,
    tool_name: IdentifierSchema.nullable(),
    arguments: JsonObjectSchema,
    guidance: z.string().trim().min(1),
  }).strict(),
}).strict();

export const ReconciliationPlanV3Schema = z.object({
  schema_version: VersionSchema,
  generated_at: z.string().datetime(),
  site_id: IdentifierSchema,
  carrier_kind: IdentifierSchema,
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
  observation_digest: z.string().regex(/^[a-f0-9]{64}$/),
  actions: z.array(ReconciliationActionV3Schema).length(1),
}).strict();

export type ToolEffect = z.infer<typeof ToolEffectSchema>;
export type LifecycleRequirement = z.infer<typeof LifecycleRequirementSchema>;
export type ToolContractV3 = z.infer<typeof ToolContractV3Schema>;
export type SurfaceProjectionV3 = z.infer<typeof SurfaceProjectionV3Schema>;
export type SurfaceDescriptorV3 = z.infer<typeof SurfaceDescriptorV3Schema>;
export type FabricBindingV3 = z.infer<typeof FabricBindingV3Schema>;
export type FabricManifestV3 = z.infer<typeof FabricManifestV3Schema>;
export type CarrierProjectionV3 = z.infer<typeof CarrierProjectionV3Schema>;
export type RuntimeGenerationV3 = z.infer<typeof RuntimeGenerationV3Schema>;
export type RuntimeRecoveryActionV3 = z.infer<typeof RuntimeRecoveryActionV3Schema>;
export type RuntimeServerObservationV3 = z.infer<typeof RuntimeServerObservationV3Schema>;
export type RuntimeObservationV3 = z.infer<typeof RuntimeObservationV3Schema>;
export type ReconciliationActionV3 = z.infer<typeof ReconciliationActionV3Schema>;
export type ReconciliationPlanV3 = z.infer<typeof ReconciliationPlanV3Schema>;

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type SurfaceToolRegistration = {
  definition: McpToolDefinition;
  effect: ToolEffect;
  timeout_ms?: number;
};

export type DefinedSurface = {
  descriptor: SurfaceDescriptorV3;
  tools: McpToolDefinition[];
  descriptor_digest: string;
  interface_digest: string;
};

const EMPTY_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export function standardSurfaceToolDefinitions(): McpToolDefinition[] {
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;
  return [
    {
      name: SURFACE_DESCRIBE_TOOL_NAME,
      description: 'Describe this MCP surface, its authority, lifecycle, package identity, and stable contract digests.',
      inputSchema: EMPTY_INPUT_SCHEMA,
      annotations,
    },
    {
      name: SURFACE_CONTRACT_DESCRIBE_TOOL_NAME,
      description: 'Describe the normalized shapes and effects of this MCP surface interface. Optionally select one tool by name.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: {
            type: 'string',
            description: 'Optional exact tool name whose contract should be returned.',
          },
        },
        additionalProperties: false,
      },
      annotations,
    },
  ];
}

export function completeLiveSurfaceTools(
  liveTools: McpToolDefinition[],
): McpToolDefinition[] {
  const liveNames = new Set(liveTools.map((definition) => definition.name));
  return [
    ...liveTools,
    ...standardSurfaceToolDefinitions().filter((definition) => !liveNames.has(definition.name)),
  ];
}

function clientToolContracts(
  descriptor: SurfaceDescriptorV3,
  clientToolNames?: readonly string[],
): ToolContractV3[] {
  if (clientToolNames === undefined) return descriptor.tools;
  const admitted = new Set(clientToolNames);
  if (admitted.size !== clientToolNames.length) {
    throw new Error('mcp_fabric_client_tool_duplicate');
  }
  assertUniversalSurfaceToolNames(clientToolNames, 'client_binding');
  const descriptorNames = new Set(descriptor.tools.map((tool) => tool.name));
  const unknown = clientToolNames.filter((name) => !descriptorNames.has(name));
  if (unknown.length > 0) {
    throw new Error(`mcp_fabric_client_tool_undeclared: ${unknown.join(',')}`);
  }
  return descriptor.tools.filter((tool) => admitted.has(tool.name));
}

export function surfaceClientInterfaceDigest(
  descriptorValue: unknown,
  clientToolNames: readonly string[],
): string {
  const descriptor = normalizeSurfaceDescriptorV3(descriptorValue);
  return interfaceDigestForTools(
    descriptor.surface_id,
    clientToolContracts(descriptor, clientToolNames),
  );
}

export function surfaceDescriptionPayload(
  descriptorValue: unknown,
  input: {
    runtime_observation?: Record<string, unknown>;
    client_tool_names?: readonly string[];
  } = {},
): Record<string, unknown> {
  const descriptor = normalizeSurfaceDescriptorV3(descriptorValue);
  const clientTools = clientToolContracts(descriptor, input.client_tool_names);
  const clientToolNames = clientTools.map((tool) => tool.name);
  return {
    schema: 'narada.mcp_surface.description.v1',
    surface_id: descriptor.surface_id,
    surface_version: descriptor.surface_version,
    package: descriptor.package,
    description: descriptor.description,
    source: descriptor.source,
    guidance_tool: descriptor.guidance_tool,
    authority_requirements: sortUnique(
      descriptor.projections.flatMap((projection) => projection.authority_requirements),
    ),
    runtime_requirements: sortUnique(
      descriptor.projections.flatMap((projection) => projection.runtime_requirements),
    ),
    lifecycle_modes: sortUnique(
      descriptor.projections.map((projection) => projection.lifecycle.mode),
    ),
    projections: descriptor.projections,
    descriptor_digest: `sha256:${surfaceDescriptorDigest(descriptor)}`,
    interface_digest: `sha256:${surfaceInterfaceDigest(descriptor)}`,
    client_interface_digest: `sha256:${surfaceClientInterfaceDigest(descriptor, clientToolNames)}`,
    client_tool_names: clientToolNames,
    ...(input.runtime_observation === undefined
      ? {}
      : { runtime: canonicalizeJson(input.runtime_observation) }),
  };
}

export function surfaceContractPayload(
  descriptorValue: unknown,
  input: {
    tool_name?: string;
    observed_capabilities?: Record<string, unknown>;
    client_tool_names?: readonly string[];
  } = {},
): Record<string, unknown> {
  const descriptor = normalizeSurfaceDescriptorV3(descriptorValue);
  const clientTools = clientToolContracts(descriptor, input.client_tool_names);
  const tools = input.tool_name === undefined
    ? clientTools
    : clientTools.filter((tool) => tool.name === input.tool_name);
  if (input.tool_name !== undefined && tools.length === 0) {
    throw new Error(`mcp_fabric_tool_contract_missing: ${input.tool_name}`);
  }
  return {
    schema: 'narada.mcp_surface.contract.v1',
    surface_id: descriptor.surface_id,
    surface_version: descriptor.surface_version,
    interface_digest: `sha256:${surfaceInterfaceDigest(descriptor)}`,
    client_interface_digest: `sha256:${surfaceClientInterfaceDigest(
      descriptor,
      clientTools.map((tool) => tool.name),
    )}`,
    client_tool_names: clientTools.map((tool) => tool.name),
    tools,
    observed_capabilities: canonicalizeJson(input.observed_capabilities ?? {}),
  };
}

export function standardSurfaceToolResult(input: {
  descriptor: unknown;
  tool_name: string;
  arguments?: Record<string, unknown>;
  observed_capabilities?: Record<string, unknown>;
  runtime_observation?: Record<string, unknown>;
  client_tool_names?: readonly string[];
}): Record<string, unknown> {
  const payload = input.tool_name === SURFACE_DESCRIBE_TOOL_NAME
    ? surfaceDescriptionPayload(input.descriptor, {
        runtime_observation: input.runtime_observation,
        client_tool_names: input.client_tool_names,
      })
    : input.tool_name === SURFACE_CONTRACT_DESCRIBE_TOOL_NAME
      ? surfaceContractPayload(input.descriptor, {
          ...(typeof input.arguments?.tool_name === 'string'
            ? { tool_name: input.arguments.tool_name }
            : {}),
          observed_capabilities: input.observed_capabilities,
          client_tool_names: input.client_tool_names,
        })
      : null;
  if (payload === null) {
    throw new Error(`mcp_fabric_standard_tool_unknown: ${input.tool_name}`);
  }
  const surfaceId = String(payload.surface_id);
  const text = input.tool_name === SURFACE_DESCRIBE_TOOL_NAME
    ? `${surfaceId}: ${String(payload.description)}`
    : `${surfaceId}: ${Array.isArray(payload.tools) ? payload.tools.length : 0} interface contract(s)`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload,
  };
}

export function isStandardSurfaceToolName(name: string): boolean {
  return name === SURFACE_DESCRIBE_TOOL_NAME || name === SURFACE_CONTRACT_DESCRIBE_TOOL_NAME;
}

export function lifecycleReadbackMetadata(surfaceId: string): LifecycleReadbackMetadata {
  return {
    authority: 'mcp-loader',
    availability: 'loader-managed',
    discovery: {
      tool_name: 'mcp_loader_connection_inventory',
      arguments: {},
      select: {
        field: 'surface_id',
        equals: surfaceId,
        result_field: 'connection_id',
      },
    },
    status: {
      tool_name: 'mcp_loader_surface_status',
      arguments: { connection_id: '{connection_id}' },
      connection_id_from: 'discovery.selected.connection_id',
    },
  };
}

export function defineSurface(input: {
  surface_id: string;
  surface_version: string;
  package: string;
  description?: string;
  tools: SurfaceToolRegistration[];
  projections: SurfaceProjectionV3[];
  metadata?: Record<string, unknown>;
}): DefinedSurface {
  const guidanceTools = input.tools
    .map((registration) => registration.definition.name)
    .filter((name) => name.endsWith('_guidance'));
  if (guidanceTools.length !== 1) {
    throw new Error(
      `mcp_fabric_guidance_tool_count_invalid: ${input.surface_id} declared ${guidanceTools.length}`,
    );
  }
  const declaredNames = new Set(input.tools.map((registration) => registration.definition.name));
  for (const definition of standardSurfaceToolDefinitions()) {
    if (declaredNames.has(definition.name)) {
      throw new Error(`mcp_fabric_standard_tool_redeclared: ${definition.name}`);
    }
  }
  const standardTools: SurfaceToolRegistration[] = standardSurfaceToolDefinitions().map((definition) => ({
    definition,
    effect: { class: 'read', idempotency: 'replayable', confirmation: 'never' },
  }));
  const registrations = [...input.tools, ...standardTools];
  const metadata = {
    ...(input.metadata ?? {}),
    lifecycle_readback: lifecycleReadbackMetadata(input.surface_id),
  };
  const descriptor = parseSurfaceDescriptorV3({
    schema_version: MCP_FABRIC_SCHEMA_VERSION,
    source: 'native',
    surface_id: input.surface_id,
    surface_version: input.surface_version,
    package: input.package,
    description: input.description ?? input.tools.find(
      (registration) => registration.definition.name === guidanceTools[0],
    )!.definition.description,
    guidance_tool: guidanceTools[0],
    tools: registrations.map((registration) => ({
      name: registration.definition.name,
      description: registration.definition.description,
      input_schema: registration.definition.inputSchema,
      ...(registration.definition.outputSchema === undefined
        ? {}
        : { output_schema: registration.definition.outputSchema }),
      ...(registration.definition.annotations === undefined
        ? {}
        : { annotations: registration.definition.annotations }),
      effect: registration.effect,
      ...(registration.timeout_ms === undefined ? {} : { timeout_ms: registration.timeout_ms }),
    })),
    projections: input.projections,
    metadata,
  });
  return {
    descriptor,
    tools: registrations.map((registration) => registration.definition),
    descriptor_digest: surfaceDescriptorDigest(descriptor),
    interface_digest: surfaceInterfaceDigest(descriptor),
  };
}

/**
 * Build a native descriptor from the package's actual tools/list registry.
 *
 * Packages still own the read-only inventory, default effect class, and
 * projection policy; this helper only keeps the repetitive V3 mapping in one
 * transport-neutral place. It deliberately does not infer effects from tool
 * names or annotations.
 */
export function defineNativeSurface(input: {
  surface_id: string;
  surface_version: string;
  package: string;
  description?: string;
  entrypoint: string;
  tools: McpToolDefinition[];
  read_only_tools: readonly string[];
  default_effect: ToolEffect['class'];
  projections: SurfaceProjectionV3[];
  metadata?: Record<string, unknown>;
}): DefinedSurface {
  const toolNames = new Set(input.tools.map((definition) => definition.name));
  const duplicateReadOnlyTools = input.read_only_tools.filter(
    (name, index, values) => values.indexOf(name) !== index,
  );
  if (duplicateReadOnlyTools.length > 0) {
    throw new Error(`mcp_fabric_read_only_tool_duplicate: ${duplicateReadOnlyTools.join(',')}`);
  }
  const undeclaredReadOnlyTools = input.read_only_tools.filter((name) => !toolNames.has(name));
  if (undeclaredReadOnlyTools.length > 0) {
    throw new Error(`mcp_fabric_read_only_tool_undeclared: ${undeclaredReadOnlyTools.join(',')}`);
  }
  const readOnly = new Set(input.read_only_tools);
  const defaultIdempotency = input.default_effect === 'read' ? 'replayable' : 'non_idempotent';
  const defaultConfirmation = input.default_effect === 'runtime_admin' ? 'always' : 'policy';
  return defineSurface({
    surface_id: input.surface_id,
    surface_version: input.surface_version,
    package: input.package,
    description: input.description,
    tools: input.tools.map((definition) => ({
      definition,
      effect: readOnly.has(definition.name)
        ? { class: 'read', idempotency: 'replayable', confirmation: 'never' }
        : {
          class: input.default_effect,
          idempotency: defaultIdempotency,
          confirmation: defaultConfirmation,
        },
    })),
    projections: input.projections.map((projection) => {
      if (projection.transport.kind !== 'stdio') return projection;
      return {
        ...projection,
        transport: {
          ...projection.transport,
          args: [input.entrypoint, ...projection.transport.args],
        },
      };
    }),
    metadata: input.metadata,
  });
}

function interfaceDigestForTools(
  surfaceId: string,
  tools: ToolContractV3[],
): string {
  return stableDigest({
    surface_id: surfaceId,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      output_schema: tool.output_schema,
      annotations: tool.annotations,
      effect: tool.effect,
      timeout_ms: tool.timeout_ms,
    })),
  });
}

export function surfaceInterfaceDigest(descriptorValue: unknown): string {
  const descriptor = normalizeSurfaceDescriptorV3(descriptorValue);
  return interfaceDigestForTools(descriptor.surface_id, descriptor.tools);
}

export function liveInterfaceDigest(
  descriptorValue: unknown,
  liveTools: McpToolDefinition[],
): string {
  const descriptor = normalizeSurfaceDescriptorV3(descriptorValue);
  const effects = new Map(descriptor.tools.map((tool) => [tool.name, tool]));
  const completeLiveTools = completeLiveSurfaceTools(liveTools);
  const liveDescriptor = {
    ...descriptor,
    tools: completeLiveTools.map((definition) => {
      const declared = effects.get(definition.name);
      if (declared === undefined) {
        throw new Error(`mcp_fabric_live_tool_undeclared: ${definition.name}`);
      }
      return {
        name: definition.name,
        description: definition.description,
        input_schema: definition.inputSchema,
        ...(definition.outputSchema === undefined ? {} : { output_schema: definition.outputSchema }),
        ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }),
        effect: declared.effect,
        ...(declared.timeout_ms === undefined ? {} : { timeout_ms: declared.timeout_ms }),
      };
    }),
  };
  return surfaceInterfaceDigest(liveDescriptor);
}

export function assertLiveToolsConform(
  descriptorValue: unknown,
  liveTools: McpToolDefinition[],
): void {
  const expected = surfaceInterfaceDigest(descriptorValue);
  const observed = liveInterfaceDigest(descriptorValue, liveTools);
  if (expected !== observed) {
    const descriptor = normalizeSurfaceDescriptorV3(descriptorValue);
    throw new Error(
      `mcp_fabric_live_tool_contract_mismatch: ${descriptor.surface_id} expected=${expected} observed=${observed}`,
    );
  }
}

type IssueContext = {
  addIssue(issue: {
    code: 'custom';
    message: string;
    path: Array<string | number>;
  }): void;
};

function addDuplicateIssues(
  values: string[],
  noun: string,
  basePath: string[],
  context: IssueContext,
): void {
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const previous = seen.get(value);
    if (previous !== undefined) {
      context.addIssue({
        code: 'custom',
        message: `duplicate ${noun} "${value}" (first declared at index ${previous})`,
        path: [...basePath, index],
      });
    } else {
      seen.set(value, index);
    }
  });
}

function assertSchemaMajor(schemaVersion: string): void {
  const majorText = schemaVersion.split('.')[0];
  const major = Number.parseInt(majorText ?? '', 10);
  if (major !== MCP_FABRIC_SCHEMA_MAJOR) {
    throw new Error(
      `mcp_fabric_schema_major_unsupported: expected ${MCP_FABRIC_SCHEMA_MAJOR}, received ${schemaVersion}`,
    );
  }
}

function parseVersioned<T extends { schema_version: string }>(
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.parse(value);
  assertSchemaMajor(parsed.schema_version);
  return parsed;
}

export function parseSurfaceDescriptorV3(value: unknown): SurfaceDescriptorV3 {
  return parseVersioned(SurfaceDescriptorV3Schema, value);
}

export function parseFabricManifestV3(value: unknown): FabricManifestV3 {
  return parseVersioned(FabricManifestV3Schema, value);
}

export function parseCarrierProjectionV3(value: unknown): CarrierProjectionV3 {
  return parseVersioned(CarrierProjectionV3Schema, value);
}

export function parseRuntimeObservationV3(value: unknown): RuntimeObservationV3 {
  return parseVersioned(RuntimeObservationV3Schema, value);
}

export function parseReconciliationPlanV3(value: unknown): ReconciliationPlanV3 {
  return parseVersioned(ReconciliationPlanV3Schema, value);
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function normalizeSurfaceDescriptorV3(value: unknown): SurfaceDescriptorV3 {
  const descriptor = parseSurfaceDescriptorV3(value);
  return {
    ...descriptor,
    tools: descriptor.tools
      .map((tool) => ({
        ...tool,
        input_schema: canonicalizeJson(tool.input_schema) as Record<string, unknown>,
        ...(tool.output_schema === undefined
          ? {}
          : { output_schema: canonicalizeJson(tool.output_schema) as Record<string, unknown> }),
        ...(tool.annotations === undefined
          ? {}
          : { annotations: canonicalizeJson(tool.annotations) as Record<string, unknown> }),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    projections: descriptor.projections
      .map((projection) => ({
        ...projection,
        runtime_requirements: sortUnique(projection.runtime_requirements),
        authority_requirements: sortUnique(projection.authority_requirements),
        transport: projection.transport.kind === 'stdio'
          ? {
              ...projection.transport,
              env: sortUnique(projection.transport.env),
            }
          : {
              ...projection.transport,
              headers: sortUnique(projection.transport.headers),
            },
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    ...(descriptor.metadata === undefined
      ? {}
      : { metadata: canonicalizeJson(descriptor.metadata) as Record<string, unknown> }),
  };
}

export function normalizeFabricManifestV3(value: unknown): FabricManifestV3 {
  const manifest = parseFabricManifestV3(value);
  return {
    ...manifest,
    descriptors: manifest.descriptors
      .map(normalizeSurfaceDescriptorV3)
      .sort((left, right) => left.surface_id.localeCompare(right.surface_id)),
    bindings: manifest.bindings
      .map((binding) => ({
        ...binding,
        config: canonicalizeJson(binding.config) as Record<string, unknown>,
      }))
      .sort((left, right) => left.binding_id.localeCompare(right.binding_id)),
  };
}

export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function stableDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function surfaceDescriptorDigest(value: unknown): string {
  return stableDigest(normalizeSurfaceDescriptorV3(value));
}

export function fabricManifestDigest(value: unknown): string {
  return stableDigest(normalizeFabricManifestV3(value));
}

export const McpFabricJsonSchemas = {
  surface_descriptor: z.toJSONSchema(SurfaceDescriptorV3Schema),
  fabric_manifest: z.toJSONSchema(FabricManifestV3Schema),
  carrier_projection: z.toJSONSchema(CarrierProjectionV3Schema),
  runtime_observation: z.toJSONSchema(RuntimeObservationV3Schema),
  reconciliation_plan: z.toJSONSchema(ReconciliationPlanV3Schema),
} as const;
