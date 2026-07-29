import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MCP_FABRIC_SCHEMA_VERSION = '2.0' as const;
export const MCP_FABRIC_SCHEMA_MAJOR = 2;

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

export const ToolContractV2Schema = z.object({
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

export const SurfaceProjectionV2Schema = z.object({
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

export const SurfaceDescriptorV2Schema = z.object({
  schema_version: VersionSchema,
  source: z.enum(['native', 'legacy_adapter']),
  surface_id: IdentifierSchema,
  surface_version: VersionSchema,
  package: z.string().trim().min(1),
  guidance_tool: IdentifierSchema.nullable(),
  tools: z.array(ToolContractV2Schema).min(1),
  projections: z.array(SurfaceProjectionV2Schema).min(1),
  metadata: JsonObjectSchema.optional(),
}).strict().superRefine((descriptor, context) => {
  addDuplicateIssues(descriptor.tools.map((tool) => tool.name), 'tool', ['tools'], context);
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

export const FabricBindingV2Schema = z.object({
  binding_id: IdentifierSchema,
  surface_id: IdentifierSchema,
  projection_id: IdentifierSchema,
  server_name: IdentifierSchema,
  enabled: z.boolean().default(true),
  site_id: IdentifierSchema.optional(),
  carrier_kind: IdentifierSchema.optional(),
  config: JsonObjectSchema.default({}),
}).strict();

export const FabricManifestV2Schema = z.object({
  schema_version: VersionSchema,
  manifest_id: IdentifierSchema,
  site_id: IdentifierSchema,
  generated_at: z.string().datetime(),
  descriptors: z.array(SurfaceDescriptorV2Schema),
  bindings: z.array(FabricBindingV2Schema),
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

export const CarrierProjectionV2Schema = z.object({
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

export const RuntimeGenerationV2Schema = z.object({
  generation_id: IdentifierSchema,
  state: z.enum(['starting', 'warming', 'active', 'draining', 'terminated', 'failed']),
  started_at: z.string().datetime(),
  activated_at: z.string().datetime().nullable(),
  heartbeat_at: z.string().datetime(),
  lease_expires_at: z.string().datetime(),
  freshness: z.enum(['current', 'stale', 'unknown']),
  health: z.enum(['healthy', 'degraded', 'unreachable', 'unknown']),
  descriptor_digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  tool_contract_digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  inflight: z.number().int().nonnegative(),
  detail: z.string().optional(),
}).strict();

export const RuntimeRecoveryActionV2Schema = z.object({
  actuator: IdentifierSchema,
  tool_name: IdentifierSchema.nullable(),
  arguments: JsonObjectSchema,
  guidance: z.string().trim().min(1),
}).strict();

export const RuntimeServerObservationV2Schema = z.object({
  server_name: IdentifierSchema,
  surface_id: IdentifierSchema,
  projection_id: IdentifierSchema,
  logical_connection_id: IdentifierSchema,
  lifecycle: LifecycleRequirementSchema,
  active_generation: RuntimeGenerationV2Schema.nullable(),
  draining_generations: z.array(RuntimeGenerationV2Schema),
  recovery_actions: z.array(RuntimeRecoveryActionV2Schema),
  detail: z.string().optional(),
}).strict();

export const RuntimeObservationV2Schema = z.object({
  schema_version: VersionSchema,
  observation_id: IdentifierSchema,
  observed_at: z.string().datetime(),
  site_id: IdentifierSchema,
  carrier_kind: IdentifierSchema,
  runtime_state_root: z.string().trim().min(1).nullable(),
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  servers: z.array(RuntimeServerObservationV2Schema),
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

export const ReconciliationActionV2Schema = z.object({
  action: z.enum([
    'no_op',
    'replace_generation',
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

export const ReconciliationPlanV2Schema = z.object({
  schema_version: VersionSchema,
  generated_at: z.string().datetime(),
  site_id: IdentifierSchema,
  carrier_kind: IdentifierSchema,
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
  observation_digest: z.string().regex(/^[a-f0-9]{64}$/),
  actions: z.array(ReconciliationActionV2Schema).length(1),
}).strict();

export type ToolEffect = z.infer<typeof ToolEffectSchema>;
export type LifecycleRequirement = z.infer<typeof LifecycleRequirementSchema>;
export type ToolContractV2 = z.infer<typeof ToolContractV2Schema>;
export type SurfaceProjectionV2 = z.infer<typeof SurfaceProjectionV2Schema>;
export type SurfaceDescriptorV2 = z.infer<typeof SurfaceDescriptorV2Schema>;
export type FabricBindingV2 = z.infer<typeof FabricBindingV2Schema>;
export type FabricManifestV2 = z.infer<typeof FabricManifestV2Schema>;
export type CarrierProjectionV2 = z.infer<typeof CarrierProjectionV2Schema>;
export type RuntimeGenerationV2 = z.infer<typeof RuntimeGenerationV2Schema>;
export type RuntimeRecoveryActionV2 = z.infer<typeof RuntimeRecoveryActionV2Schema>;
export type RuntimeServerObservationV2 = z.infer<typeof RuntimeServerObservationV2Schema>;
export type RuntimeObservationV2 = z.infer<typeof RuntimeObservationV2Schema>;
export type ReconciliationActionV2 = z.infer<typeof ReconciliationActionV2Schema>;
export type ReconciliationPlanV2 = z.infer<typeof ReconciliationPlanV2Schema>;

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
  descriptor: SurfaceDescriptorV2;
  tools: McpToolDefinition[];
  descriptor_digest: string;
  tool_contract_digest: string;
};

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
  tools: SurfaceToolRegistration[];
  projections: SurfaceProjectionV2[];
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
  const metadata = {
    ...(input.metadata ?? {}),
    lifecycle_readback: lifecycleReadbackMetadata(input.surface_id),
  };
  const descriptor = parseSurfaceDescriptorV2({
    schema_version: MCP_FABRIC_SCHEMA_VERSION,
    source: 'native',
    surface_id: input.surface_id,
    surface_version: input.surface_version,
    package: input.package,
    guidance_tool: guidanceTools[0],
    tools: input.tools.map((registration) => ({
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
    tools: input.tools.map((registration) => registration.definition),
    descriptor_digest: surfaceDescriptorDigest(descriptor),
    tool_contract_digest: surfaceToolContractDigest(descriptor),
  };
}

/**
 * Build a native descriptor from the package's actual tools/list registry.
 *
 * Packages still own the read-only inventory, default effect class, and
 * projection policy; this helper only keeps the repetitive V2 mapping in one
 * transport-neutral place. It deliberately does not infer effects from tool
 * names or annotations.
 */
export function defineNativeSurface(input: {
  surface_id: string;
  surface_version: string;
  package: string;
  entrypoint: string;
  tools: McpToolDefinition[];
  read_only_tools: readonly string[];
  default_effect: ToolEffect['class'];
  projections: SurfaceProjectionV2[];
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

export function surfaceToolContractDigest(descriptorValue: unknown): string {
  const descriptor = normalizeSurfaceDescriptorV2(descriptorValue);
  return stableDigest({
    surface_id: descriptor.surface_id,
    tools: descriptor.tools.map((tool) => ({
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

export function liveToolsContractDigest(
  descriptorValue: unknown,
  liveTools: McpToolDefinition[],
): string {
  const descriptor = normalizeSurfaceDescriptorV2(descriptorValue);
  const effects = new Map(descriptor.tools.map((tool) => [tool.name, tool]));
  const liveDescriptor = {
    ...descriptor,
    tools: liveTools.map((definition) => {
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
  return surfaceToolContractDigest(liveDescriptor);
}

export function assertLiveToolsConform(
  descriptorValue: unknown,
  liveTools: McpToolDefinition[],
): void {
  const expected = surfaceToolContractDigest(descriptorValue);
  const observed = liveToolsContractDigest(descriptorValue, liveTools);
  if (expected !== observed) {
    const descriptor = normalizeSurfaceDescriptorV2(descriptorValue);
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

export function parseSurfaceDescriptorV2(value: unknown): SurfaceDescriptorV2 {
  return parseVersioned(SurfaceDescriptorV2Schema, value);
}

export function parseFabricManifestV2(value: unknown): FabricManifestV2 {
  return parseVersioned(FabricManifestV2Schema, value);
}

export function parseCarrierProjectionV2(value: unknown): CarrierProjectionV2 {
  return parseVersioned(CarrierProjectionV2Schema, value);
}

export function parseRuntimeObservationV2(value: unknown): RuntimeObservationV2 {
  return parseVersioned(RuntimeObservationV2Schema, value);
}

export function parseReconciliationPlanV2(value: unknown): ReconciliationPlanV2 {
  return parseVersioned(ReconciliationPlanV2Schema, value);
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function normalizeSurfaceDescriptorV2(value: unknown): SurfaceDescriptorV2 {
  const descriptor = parseSurfaceDescriptorV2(value);
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

export function normalizeFabricManifestV2(value: unknown): FabricManifestV2 {
  const manifest = parseFabricManifestV2(value);
  return {
    ...manifest,
    descriptors: manifest.descriptors
      .map(normalizeSurfaceDescriptorV2)
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
  return stableDigest(normalizeSurfaceDescriptorV2(value));
}

export function fabricManifestDigest(value: unknown): string {
  return stableDigest(normalizeFabricManifestV2(value));
}

export const McpFabricJsonSchemas = {
  surface_descriptor: z.toJSONSchema(SurfaceDescriptorV2Schema),
  fabric_manifest: z.toJSONSchema(FabricManifestV2Schema),
  carrier_projection: z.toJSONSchema(CarrierProjectionV2Schema),
  runtime_observation: z.toJSONSchema(RuntimeObservationV2Schema),
  reconciliation_plan: z.toJSONSchema(ReconciliationPlanV2Schema),
} as const;
