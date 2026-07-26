import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import {
  ArtifactIntegrityError,
  artifactStorePaths,
  compatibilityKey,
  verifyArtifactPin,
  type ArtifactSelector,
  type Sha256Digest,
} from '@narada2/artifact-integrity';
import {
  canonicalJson,
  parseSurfaceDescriptorV3,
  stableDigest,
  surfaceDescriptorDigest,
  surfaceInterfaceDigest,
  UNIVERSAL_SURFACE_TOOL_NAMES,
  type SurfaceDescriptorV3,
} from '@narada2/mcp-fabric-contracts';

export const MCP_RUNTIME_CONTRACT_VERSION = 3 as const;
export const MCP_CARRIER_GENERATION_SCHEMA = 'narada.mcp_carrier_generation.v3' as const;
export const MCP_CARRIER_ACTIVATION_SCHEMA = 'narada.mcp_carrier_activation.v3' as const;
export const MCP_RUNTIME_PROXY_PACKAGE = '@narada2/mcp-runtime-proxy' as const;
export const MCP_RUNTIME_PROXY_ARTIFACT_PROFILE = 'mcp-runtime-proxy-v3' as const;

type JsonRecord = Record<string, unknown>;

export type NormalizedCarrierLaunch = {
  command: string;
  args: string[];
};

export function runtimeProxyCompatibility() {
  return {
    artifact_profile: MCP_RUNTIME_PROXY_ARTIFACT_PROFILE,
    descriptor_digest: digest({
      schema: MCP_CARRIER_GENERATION_SCHEMA,
      runtime_contract_version: MCP_RUNTIME_CONTRACT_VERSION,
      role: 'sealed_carrier_runtime_proxy',
    }),
    interface_digest: digest({
      argv: [
        '--runtime-contract-version',
        '--carrier-generation',
        '--server-key',
        '--artifact-store',
      ],
      protocol: 'mcp-stdio-transparent-v3',
      generated_tools: ['surface_describe', 'surface_contract_describe'],
    }),
  };
}

function normalizePinnedDigest(value: string, field: string): Sha256Digest {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new CarrierGenerationError(
      'carrier_generation_invalid',
      `Pinned artifact ${field} is not a SHA-256 digest.`,
      { field, value },
    );
  }
  return value as Sha256Digest;
}

export function pinnedRuntimeProxyEntrypoint(generation: CarrierGeneration): string {
  const pin = generation.runtime_proxy;
  const paths = artifactStorePaths(
    pin.artifact_selector.store_root,
    MCP_RUNTIME_PROXY_PACKAGE,
    compatibilityKey(MCP_RUNTIME_PROXY_PACKAGE, pin.artifact_selector.compatibility),
  );
  const entrypoint = join(
    paths.closureDirectory(pin.closure_digest),
    pin.artifact_entrypoint,
  );
  if (!pathInside(paths.closureDirectory(pin.closure_digest), entrypoint)) {
    throw new CarrierGenerationError(
      'carrier_runtime_proxy_unsealed',
      'The pinned runtime proxy entrypoint escapes its immutable closure.',
      { artifact_entrypoint: pin.artifact_entrypoint },
    );
  }
  return entrypoint;
}

export async function resolvePinnedRuntimeProxy(input: {
  generation: CarrierGeneration;
  runtime_entrypoint: string;
}): Promise<void> {
  const pin = input.generation.runtime_proxy;
  let selected;
  try {
    selected = await verifyArtifactPin({
      store_root: pin.artifact_selector.store_root,
      package_name: pin.artifact_selector.package_name,
      compatibility: pin.artifact_selector.compatibility,
      closure_digest: pin.closure_digest,
      receipt_digest: pin.receipt_digest,
    });
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) {
      throw new CarrierGenerationError(error.code, error.message, error.details, { cause: error });
    }
    throw error;
  }
  if (
    selected.closure.closure_digest !== pin.closure_digest
    || selected.receipt.receipt_digest !== pin.receipt_digest
  ) {
    throw new CarrierGenerationError(
      'carrier_runtime_proxy_stale',
      'Carrier configuration is pinned to an obsolete runtime proxy closure.',
      {
        pinned_closure_digest: pin.closure_digest,
        selected_closure_digest: selected.closure.closure_digest,
        pinned_receipt_digest: pin.receipt_digest,
        selected_receipt_digest: selected.receipt.receipt_digest,
      },
    );
  }
  const expectedEntrypoint = pinnedRuntimeProxyEntrypoint(input.generation);
  if (resolve(expectedEntrypoint).toLowerCase() !== resolve(input.runtime_entrypoint).toLowerCase()) {
    throw new CarrierGenerationError(
      'carrier_runtime_proxy_unsealed',
      'The executing runtime proxy is not the sealed closure pinned by this generation.',
      { expected_entrypoint: expectedEntrypoint, actual_entrypoint: resolve(input.runtime_entrypoint) },
    );
  }
}

function normalizeRuntimeProxy(input: CarrierRuntimeProxyPin): CarrierRuntimeProxyPin {
  const expected = runtimeProxyCompatibility();
  const selector = input.artifact_selector;
  if (
    selector.mode !== 'latest_compatible'
    || selector.source_policy !== 'require_fresh'
    || selector.package_name !== MCP_RUNTIME_PROXY_PACKAGE
    || selector.compatibility.artifact_profile !== expected.artifact_profile
    || selector.compatibility.descriptor_digest !== expected.descriptor_digest
    || selector.compatibility.interface_digest !== expected.interface_digest
  ) {
    throw new CarrierGenerationError(
      'binding_artifact_incompatible',
      'Runtime proxy selector is incompatible with runtime contract V3.',
      { expected_compatibility: expected, actual_selector: selector },
    );
  }
  return {
    artifact_selector: { ...selector, store_root: resolve(selector.store_root) },
    source: {
      package_root: resolve(input.source.package_root),
      workspace_root: resolve(input.source.workspace_root),
    },
    artifact_entrypoint: normalizeArtifactEntrypoint(input.artifact_entrypoint),
    closure_digest: normalizePinnedDigest(input.closure_digest, 'closure_digest'),
    receipt_digest: normalizePinnedDigest(input.receipt_digest, 'receipt_digest'),
  };
}

export type CarrierRuntimeProxyPin = {
  artifact_selector: ArtifactSelector;
  source: CarrierGenerationSource;
  artifact_entrypoint: string;
  closure_digest: Sha256Digest;
  receipt_digest: Sha256Digest;
};

export type CarrierGenerationSource = {
  package_root: string;
  workspace_root: string;
};

export type CarrierGenerationActivation = {
  cutover_id: string;
  marker_path: string;
  token_digest: Sha256Digest;
};

export type CarrierActivationMarker = {
  schema: typeof MCP_CARRIER_ACTIVATION_SCHEMA;
  cutover_id: string;
  activation_token: string;
  generation_digests: Sha256Digest[];
  activated_at: string;
  marker_digest: Sha256Digest;
};

export type CarrierGenerationBinding = {
  binding_id: string;
  server_key: string;
  surface_id: string;
  projection_id: string;
  descriptor: SurfaceDescriptorV3;
  artifact_selector: ArtifactSelector;
  closure_digest: Sha256Digest;
  receipt_digest: Sha256Digest;
  source: CarrierGenerationSource;
  artifact_entrypoint: string;
  child_args: string[];
  child_env_names: string[];
  client_tool_names: string[];
  proxy_launch: NormalizedCarrierLaunch;
  proxy_launch_digest: Sha256Digest;
};

export type CarrierGeneration = {
  schema: typeof MCP_CARRIER_GENERATION_SCHEMA;
  runtime_contract_version: typeof MCP_RUNTIME_CONTRACT_VERSION;
  generation_id: string;
  carrier_id: string;
  carrier_kind: string;
  config_path: string;
  generated_at: string;
  activation: CarrierGenerationActivation;
  runtime_proxy: CarrierRuntimeProxyPin;
  bindings: CarrierGenerationBinding[];
  generation_digest: Sha256Digest;
};

export type CarrierGenerationBindingInput = Omit<CarrierGenerationBinding, 'descriptor' | 'proxy_launch_digest'> & {
  descriptor: unknown;
};

export class CarrierGenerationError extends Error {
  readonly code: string;
  readonly details: JsonRecord;

  constructor(code: string, message: string, details: JsonRecord = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CarrierGenerationError';
    this.code = code;
    this.details = details;
  }

  toJSON(): JsonRecord {
    return {
      schema: 'narada.mcp_runtime_proxy.error.v1',
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${stableDigest(value)}`;
}

function normalizeLaunch(value: NormalizedCarrierLaunch): NormalizedCarrierLaunch {
  if (!value.command.trim()) {
    throw new CarrierGenerationError('carrier_generation_invalid', 'Carrier launch command is empty.');
  }
  return {
    command: value.command,
    args: value.args.map(String),
  };
}

export function carrierLaunchDigest(value: NormalizedCarrierLaunch): Sha256Digest {
  return digest(normalizeLaunch(value));
}

function normalizeArtifactEntrypoint(value: string): string {
  const portable = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!portable || isAbsolute(value) || portable === '..' || portable.startsWith('../')) {
    throw new CarrierGenerationError(
      'carrier_generation_invalid',
      'Artifact entrypoint must be a relative path inside the sealed closure.',
      { artifact_entrypoint: value },
    );
  }
  return portable;
}

function expectedCompatibility(descriptor: SurfaceDescriptorV3, profile: string) {
  return {
    artifact_profile: profile,
    descriptor_digest: `sha256:${surfaceDescriptorDigest(descriptor)}` as Sha256Digest,
    interface_digest: `sha256:${surfaceInterfaceDigest(descriptor)}` as Sha256Digest,
  };
}

function normalizeSelector(
  descriptor: SurfaceDescriptorV3,
  selector: ArtifactSelector,
): ArtifactSelector {
  const expected = expectedCompatibility(descriptor, selector.compatibility.artifact_profile);
  if (
    selector.mode !== 'latest_compatible'
    || selector.source_policy !== 'require_fresh'
    || selector.package_name !== descriptor.package
    || selector.compatibility.descriptor_digest !== expected.descriptor_digest
    || selector.compatibility.interface_digest !== expected.interface_digest
  ) {
    throw new CarrierGenerationError(
      'binding_artifact_incompatible',
      `Artifact selector is incompatible with surface ${descriptor.surface_id}.`,
      {
        surface_id: descriptor.surface_id,
        package_name: descriptor.package,
        expected_compatibility: expected,
        actual_selector: selector,
      },
    );
  }
  return {
    ...selector,
    store_root: resolve(selector.store_root),
  };
}

function normalizeBinding(input: CarrierGenerationBindingInput): CarrierGenerationBinding {
  const descriptor = parseSurfaceDescriptorV3(input.descriptor);
  if (descriptor.surface_id !== input.surface_id) {
    throw new CarrierGenerationError(
      'carrier_generation_invalid',
      'Binding surface id does not match its descriptor.',
      { binding_surface_id: input.surface_id, descriptor_surface_id: descriptor.surface_id },
    );
  }
  if (!descriptor.projections.some((projection) => projection.id === input.projection_id)) {
    throw new CarrierGenerationError(
      'carrier_generation_invalid',
      'Binding projection id is absent from its native descriptor.',
      {
        surface_id: descriptor.surface_id,
        projection_id: input.projection_id,
        known_projection_ids: descriptor.projections.map((projection) => projection.id),
      },
    );
  }
  const descriptorToolNames = new Set(descriptor.tools.map((tool) => tool.name));
  const clientToolNames = [...new Set(input.client_tool_names)].sort();
  const missingUniversalToolNames = UNIVERSAL_SURFACE_TOOL_NAMES.filter(
    (name) => !clientToolNames.includes(name),
  );
  if (missingUniversalToolNames.length > 0) {
    throw new CarrierGenerationError(
      'carrier_generation_invalid',
      'Every executable binding must admit both universal surface description tools.',
      {
        surface_id: descriptor.surface_id,
        missing_universal_tool_names: missingUniversalToolNames,
      },
    );
  }
  const unknownClientToolNames = clientToolNames.filter((name) => !descriptorToolNames.has(name));
  if (unknownClientToolNames.length > 0) {
    throw new CarrierGenerationError(
      'carrier_generation_invalid',
      'Binding client tools are absent from its native descriptor.',
      {
        surface_id: descriptor.surface_id,
        unknown_client_tool_names: unknownClientToolNames,
      },
    );
  }
  const proxyLaunch = normalizeLaunch(input.proxy_launch);
  return {
    binding_id: input.binding_id,
    server_key: input.server_key,
    surface_id: input.surface_id,
    projection_id: input.projection_id,
    descriptor,
    artifact_selector: normalizeSelector(descriptor, input.artifact_selector),
    closure_digest: normalizePinnedDigest(input.closure_digest, 'closure_digest'),
    receipt_digest: normalizePinnedDigest(input.receipt_digest, 'receipt_digest'),
    source: {
      package_root: resolve(input.source.package_root),
      workspace_root: resolve(input.source.workspace_root),
    },
    artifact_entrypoint: normalizeArtifactEntrypoint(input.artifact_entrypoint),
    child_args: input.child_args.map(String),
    child_env_names: [...new Set(input.child_env_names)].sort(),
    client_tool_names: clientToolNames,
    proxy_launch: proxyLaunch,
    proxy_launch_digest: carrierLaunchDigest(proxyLaunch),
  };
}

function generationUnsigned(generation: Omit<CarrierGeneration, 'generation_digest'>): Omit<CarrierGeneration, 'generation_digest'> {
  return {
    ...generation,
    bindings: [...generation.bindings].sort((left, right) => left.server_key.localeCompare(right.server_key)),
  };
}

function normalizeActivation(input: CarrierGenerationActivation): CarrierGenerationActivation {
  if (
    !input.cutover_id.trim()
    || !isAbsolute(input.marker_path)
    || !/^sha256:[0-9a-f]{64}$/u.test(input.token_digest)
  ) {
    throw new CarrierGenerationError(
      'carrier_generation_invalid',
      'Carrier generation activation requirement is incomplete.',
      { activation: input },
    );
  }
  return {
    cutover_id: input.cutover_id,
    marker_path: resolve(input.marker_path),
    token_digest: input.token_digest,
  };
}

export function buildCarrierGeneration(input: {
  generation_id?: string;
  carrier_id: string;
  carrier_kind: string;
  config_path: string;
  generated_at?: string;
  activation: CarrierGenerationActivation;
  runtime_proxy: CarrierRuntimeProxyPin;
  bindings: CarrierGenerationBindingInput[];
}): CarrierGeneration {
  if (input.bindings.length === 0) {
    throw new CarrierGenerationError('carrier_generation_invalid', 'Carrier generation has no bindings.');
  }
  const bindings = input.bindings.map(normalizeBinding);
  const serverKeys = new Set<string>();
  const bindingIds = new Set<string>();
  for (const binding of bindings) {
    if (serverKeys.has(binding.server_key)) {
      throw new CarrierGenerationError(
        'carrier_generation_invalid',
        `Duplicate carrier server key: ${binding.server_key}`,
      );
    }
    if (bindingIds.has(binding.binding_id)) {
      throw new CarrierGenerationError(
        'carrier_generation_invalid',
        `Duplicate carrier binding id: ${binding.binding_id}`,
      );
    }
    serverKeys.add(binding.server_key);
    bindingIds.add(binding.binding_id);
  }
  const unsigned = generationUnsigned({
    schema: MCP_CARRIER_GENERATION_SCHEMA,
    runtime_contract_version: MCP_RUNTIME_CONTRACT_VERSION,
    generation_id: input.generation_id ?? randomUUID(),
    carrier_id: input.carrier_id,
    carrier_kind: input.carrier_kind,
    config_path: resolve(input.config_path),
    generated_at: input.generated_at ?? new Date().toISOString(),
    activation: normalizeActivation(input.activation),
    runtime_proxy: normalizeRuntimeProxy(input.runtime_proxy),
    bindings,
  });
  return {
    ...unsigned,
    generation_digest: digest(unsigned),
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseSelector(value: unknown): ArtifactSelector {
  if (!isRecord(value) || !isRecord(value.compatibility)) {
    throw new CarrierGenerationError('carrier_generation_corrupt', 'Artifact selector is malformed.');
  }
  const compatibility = value.compatibility;
  if (
    value.mode !== 'latest_compatible'
    || typeof value.store_root !== 'string'
    || typeof value.package_name !== 'string'
    || value.source_policy !== 'require_fresh'
    || typeof compatibility.descriptor_digest !== 'string'
    || typeof compatibility.interface_digest !== 'string'
    || typeof compatibility.artifact_profile !== 'string'
  ) {
    throw new CarrierGenerationError('carrier_generation_corrupt', 'Artifact selector is structurally incomplete.');
  }
  return value as unknown as ArtifactSelector;
}

export function parseCarrierGeneration(value: unknown): CarrierGeneration {
  if (
    !isRecord(value)
    || !Array.isArray(value.bindings)
    || !isRecord(value.runtime_proxy)
    || !isRecord(value.activation)
  ) {
    throw new CarrierGenerationError('carrier_generation_corrupt', 'Carrier generation is not an object.');
  }
  if (
    value.schema !== MCP_CARRIER_GENERATION_SCHEMA
    || value.runtime_contract_version !== MCP_RUNTIME_CONTRACT_VERSION
    || typeof value.generation_id !== 'string'
    || typeof value.carrier_id !== 'string'
    || typeof value.carrier_kind !== 'string'
    || typeof value.config_path !== 'string'
    || typeof value.generated_at !== 'string'
    || typeof value.generation_digest !== 'string'
    || typeof value.activation.cutover_id !== 'string'
    || typeof value.activation.marker_path !== 'string'
    || typeof value.activation.token_digest !== 'string'
  ) {
    throw new CarrierGenerationError(
      'carrier_generation_corrupt',
      'Carrier generation has an unsupported or incomplete V3 contract.',
    );
  }
  const bindings = value.bindings.map((raw): CarrierGenerationBinding => {
    if (
      !isRecord(raw)
      || typeof raw.binding_id !== 'string'
      || typeof raw.server_key !== 'string'
      || typeof raw.surface_id !== 'string'
      || typeof raw.projection_id !== 'string'
      || !isRecord(raw.source)
      || typeof raw.source.package_root !== 'string'
      || typeof raw.source.workspace_root !== 'string'
      || typeof raw.artifact_entrypoint !== 'string'
      || typeof raw.closure_digest !== 'string'
      || typeof raw.receipt_digest !== 'string'
      || !isStringArray(raw.child_args)
      || !isStringArray(raw.child_env_names)
      || !isStringArray(raw.client_tool_names)
      || !isRecord(raw.proxy_launch)
      || typeof raw.proxy_launch.command !== 'string'
      || !isStringArray(raw.proxy_launch.args)
      || typeof raw.proxy_launch_digest !== 'string'
    ) {
      throw new CarrierGenerationError('carrier_generation_corrupt', 'Carrier binding is structurally incomplete.');
    }
    const descriptor = parseSurfaceDescriptorV3(raw.descriptor);
    const selector = parseSelector(raw.artifact_selector);
    const binding = normalizeBinding({
      binding_id: raw.binding_id,
      server_key: raw.server_key,
      surface_id: raw.surface_id,
      projection_id: raw.projection_id,
      descriptor,
      artifact_selector: selector,
      closure_digest: raw.closure_digest as string as Sha256Digest,
      receipt_digest: raw.receipt_digest as string as Sha256Digest,
      source: {
        package_root: raw.source.package_root,
        workspace_root: raw.source.workspace_root,
      },
      artifact_entrypoint: raw.artifact_entrypoint,
      child_args: raw.child_args,
      child_env_names: raw.child_env_names,
      client_tool_names: raw.client_tool_names,
      proxy_launch: { command: raw.proxy_launch.command, args: raw.proxy_launch.args },
    });
    if (binding.proxy_launch_digest !== raw.proxy_launch_digest) {
      throw new CarrierGenerationError('carrier_generation_corrupt', 'Carrier binding launch digest does not match.');
    }
    return binding;
  });
  const runtimeProxyRaw = value.runtime_proxy;
  if (
    !isRecord(runtimeProxyRaw.source)
    || typeof runtimeProxyRaw.source.package_root !== 'string'
    || typeof runtimeProxyRaw.source.workspace_root !== 'string'
    || typeof runtimeProxyRaw.artifact_entrypoint !== 'string'
    || typeof runtimeProxyRaw.closure_digest !== 'string'
    || typeof runtimeProxyRaw.receipt_digest !== 'string'
  ) {
    throw new CarrierGenerationError('carrier_generation_corrupt', 'Runtime proxy pin is incomplete.');
  }
  const runtimeProxy = normalizeRuntimeProxy({
    artifact_selector: parseSelector(runtimeProxyRaw.artifact_selector),
    source: {
      package_root: runtimeProxyRaw.source.package_root,
      workspace_root: runtimeProxyRaw.source.workspace_root,
    },
    artifact_entrypoint: runtimeProxyRaw.artifact_entrypoint,
    closure_digest: runtimeProxyRaw.closure_digest as Sha256Digest,
    receipt_digest: runtimeProxyRaw.receipt_digest as Sha256Digest,
  });
  const unsigned = generationUnsigned({
    schema: MCP_CARRIER_GENERATION_SCHEMA,
    runtime_contract_version: MCP_RUNTIME_CONTRACT_VERSION,
    generation_id: value.generation_id,
    carrier_id: value.carrier_id,
    carrier_kind: value.carrier_kind,
    config_path: resolve(value.config_path),
    generated_at: value.generated_at,
    activation: normalizeActivation({
      cutover_id: value.activation.cutover_id,
      marker_path: value.activation.marker_path,
      token_digest: value.activation.token_digest as Sha256Digest,
    }),
    runtime_proxy: runtimeProxy,
    bindings,
  });
  const expectedDigest = digest(unsigned);
  if (value.generation_digest !== expectedDigest) {
    throw new CarrierGenerationError(
      'carrier_generation_corrupt',
      'Carrier generation digest does not match its contents.',
      { expected_generation_digest: expectedDigest, actual_generation_digest: value.generation_digest },
    );
  }
  return { ...unsigned, generation_digest: expectedDigest };
}

export function readCarrierGeneration(path: string): CarrierGeneration {
  const resolved = resolve(path);
  try {
    return parseCarrierGeneration(JSON.parse(readFileSync(resolved, 'utf8')));
  } catch (error) {
    if (error instanceof CarrierGenerationError) throw error;
    throw new CarrierGenerationError(
      'carrier_generation_missing',
      'The immutable V3 carrier generation is missing or unreadable.',
      { carrier_generation_path: resolved },
      { cause: error },
    );
  }
}

function syncDirectory(path: string): void {
  try {
    const descriptor = openSync(path, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    // Windows does not support fsync on directory handles; EPERM is that
    // platform capability refusal, while all other errors remain fatal.
    if (!['EINVAL', 'EISDIR', 'EBADF', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(code)) {
      throw error;
    }
  }
}

function writeImmutableCarrierFile(input: {
  path: string;
  content: string;
  collision_code: string;
  collision_message: string;
  collision_details: JsonRecord;
}): void {
  const resolved = resolve(input.path);
  mkdirSync(dirname(resolved), { recursive: true });
  if (existsSync(resolved)) {
    if (readFileSync(resolved, 'utf8') === input.content) return;
    throw new CarrierGenerationError(
      input.collision_code,
      input.collision_message,
      input.collision_details,
    );
  }
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor = openSync(temporary, 'wx');
  try {
    writeFileSync(descriptor, input.content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = -1;
    try {
      linkSync(temporary, resolved);
    } catch (error) {
      if (existsSync(resolved)) {
        if (readFileSync(resolved, 'utf8') !== input.content) {
          throw new CarrierGenerationError(
            input.collision_code,
            input.collision_message,
            input.collision_details,
            { cause: error },
          );
        }
      } else {
        throw error;
      }
    }
    syncDirectory(dirname(resolved));
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function writeCarrierGenerationImmutable(path: string, generationValue: unknown): void {
  const generation = parseCarrierGeneration(generationValue);
  const resolved = resolve(path);
  const content = `${canonicalJson(generation)}\n`;
  writeImmutableCarrierFile({
    path: resolved,
    content,
    collision_code: 'carrier_generation_collision',
    collision_message: 'Refusing to replace an immutable carrier generation.',
    collision_details: { carrier_generation_path: resolved },
  });
}

function activationMarkerUnsigned(
  marker: Omit<CarrierActivationMarker, 'marker_digest'>,
): Omit<CarrierActivationMarker, 'marker_digest'> {
  return {
    ...marker,
    generation_digests: [...new Set(marker.generation_digests)].sort(),
  };
}

export function buildCarrierActivationMarker(input: {
  cutover_id: string;
  activation_token: string;
  generation_digests: Sha256Digest[];
  activated_at?: string;
}): CarrierActivationMarker {
  if (!input.cutover_id.trim() || !input.activation_token || input.generation_digests.length === 0) {
    throw new CarrierGenerationError(
      'carrier_activation_invalid',
      'Carrier activation marker input is incomplete.',
    );
  }
  const unsigned = activationMarkerUnsigned({
    schema: MCP_CARRIER_ACTIVATION_SCHEMA,
    cutover_id: input.cutover_id,
    activation_token: input.activation_token,
    generation_digests: input.generation_digests,
    activated_at: input.activated_at ?? new Date().toISOString(),
  });
  return { ...unsigned, marker_digest: digest(unsigned) };
}

export function parseCarrierActivationMarker(value: unknown): CarrierActivationMarker {
  if (
    !isRecord(value)
    || value.schema !== MCP_CARRIER_ACTIVATION_SCHEMA
    || typeof value.cutover_id !== 'string'
    || typeof value.activation_token !== 'string'
    || !isStringArray(value.generation_digests)
    || typeof value.activated_at !== 'string'
    || typeof value.marker_digest !== 'string'
  ) {
    throw new CarrierGenerationError(
      'carrier_activation_invalid',
      'Carrier activation marker is malformed.',
    );
  }
  const unsigned = activationMarkerUnsigned({
    schema: MCP_CARRIER_ACTIVATION_SCHEMA,
    cutover_id: value.cutover_id,
    activation_token: value.activation_token,
    generation_digests: value.generation_digests as Sha256Digest[],
    activated_at: value.activated_at,
  });
  const markerDigest = digest(unsigned);
  if (value.marker_digest !== markerDigest) {
    throw new CarrierGenerationError(
      'carrier_activation_invalid',
      'Carrier activation marker digest does not match.',
    );
  }
  return { ...unsigned, marker_digest: markerDigest };
}

export function writeCarrierActivationMarkerImmutable(
  path: string,
  markerValue: unknown,
): void {
  const marker = parseCarrierActivationMarker(markerValue);
  const resolved = resolve(path);
  const content = `${canonicalJson(marker)}\n`;
  writeImmutableCarrierFile({
    path: resolved,
    content,
    collision_code: 'carrier_activation_collision',
    collision_message: 'Refusing to replace an immutable carrier activation marker.',
    collision_details: { activation_marker_path: resolved },
  });
}

export function assertCarrierGenerationActivated(generation: CarrierGeneration): void {
  let marker: CarrierActivationMarker;
  try {
    marker = parseCarrierActivationMarker(
      JSON.parse(readFileSync(generation.activation.marker_path, 'utf8')),
    );
  } catch (error) {
    if (error instanceof CarrierGenerationError) throw error;
    throw new CarrierGenerationError(
      'carrier_generation_not_activated',
      'Carrier generation has not been activated by its cutover coordinator.',
      {
        cutover_id: generation.activation.cutover_id,
        activation_marker_path: generation.activation.marker_path,
      },
      { cause: error },
    );
  }
  if (
    marker.cutover_id !== generation.activation.cutover_id
    || sha256Text(marker.activation_token) !== generation.activation.token_digest
    || !marker.generation_digests.includes(generation.generation_digest)
  ) {
    throw new CarrierGenerationError(
      'carrier_generation_not_activated',
      'Carrier activation marker does not authorize this generation.',
      {
        cutover_id: generation.activation.cutover_id,
        generation_digest: generation.generation_digest,
        activation_marker_path: generation.activation.marker_path,
      },
    );
  }
}

function stripJsonComments(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1] ?? '';
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else {
      output += char;
    }
  }
  return output;
}

function parseTomlString(value: string): string {
  return JSON.parse(value) as string;
}

function codexLaunch(content: string, serverKey: string): NormalizedCarrierLaunch | null {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  let active = false;
  let command: string | null = null;
  let args: string[] | null = null;
  for (const line of lines) {
    const header = /^\s*\[mcp_servers\.(.+)\]\s*$/u.exec(line);
    if (header) {
      const rawKey = header[1]!.trim();
      const key = rawKey.startsWith('"') ? parseTomlString(rawKey) : rawKey;
      if (active) break;
      active = key === serverKey;
      continue;
    }
    if (!active) continue;
    const commandMatch = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*")\s*$/u.exec(line);
    if (commandMatch) command = parseTomlString(commandMatch[1]!);
    const argsMatch = /^\s*args\s*=\s*(\[.*\])\s*$/u.exec(line);
    if (argsMatch) {
      const parsed = JSON.parse(argsMatch[1]!);
      if (isStringArray(parsed)) args = parsed;
    }
  }
  return active && command !== null && args !== null ? { command, args } : null;
}

function jsonLaunch(content: string, carrierKind: string, serverKey: string): NormalizedCarrierLaunch | null {
  const parsed = JSON.parse(stripJsonComments(content)) as unknown;
  if (!isRecord(parsed)) return null;
  const root = carrierKind === 'opencode' ? parsed.mcp : parsed.mcpServers;
  if (!isRecord(root) || !isRecord(root[serverKey])) return null;
  const record = root[serverKey];
  if (Array.isArray(record.command) && isStringArray(record.command) && record.command.length > 0) {
    return { command: record.command[0]!, args: record.command.slice(1) };
  }
  if (typeof record.command === 'string' && isStringArray(record.args)) {
    return { command: record.command, args: record.args };
  }
  return null;
}

export function readCarrierConfigLaunch(input: {
  carrier_kind: string;
  config_path: string;
  server_key: string;
}): NormalizedCarrierLaunch {
  let content: string;
  try {
    content = readFileSync(resolve(input.config_path), 'utf8');
  } catch (error) {
    throw new CarrierGenerationError(
      'carrier_config_missing',
      'Carrier configuration is missing or unreadable.',
      { config_path: resolve(input.config_path) },
      { cause: error },
    );
  }
  const launch = input.carrier_kind === 'codex'
    ? codexLaunch(content, input.server_key)
    : jsonLaunch(content, input.carrier_kind, input.server_key);
  if (launch === null) {
    throw new CarrierGenerationError(
      'carrier_binding_missing',
      `Carrier configuration has no complete launch for ${input.server_key}.`,
      { config_path: resolve(input.config_path), server_key: input.server_key },
    );
  }
  return normalizeLaunch(launch);
}

export function validateCarrierBindingLaunch(input: {
  generation: CarrierGeneration;
  binding: CarrierGenerationBinding;
}): void {
  const actual = readCarrierConfigLaunch({
    carrier_kind: input.generation.carrier_kind,
    config_path: input.generation.config_path,
    server_key: input.binding.server_key,
  });
  const actualDigest = carrierLaunchDigest(actual);
  if (actualDigest !== input.binding.proxy_launch_digest) {
    throw new CarrierGenerationError(
      'carrier_binding_stale',
      `Carrier launch for ${input.binding.server_key} changed after generation.`,
      {
        server_key: input.binding.server_key,
        expected_launch_digest: input.binding.proxy_launch_digest,
        actual_launch_digest: actualDigest,
      },
    );
  }
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function resolveCarrierBinding(input: {
  generation_path: string;
  server_key: string;
  artifact_store: string;
}): Promise<{
  generation: CarrierGeneration;
  binding: CarrierGenerationBinding;
  closure_path: string;
  child_entrypoint: string;
  closure_digest: Sha256Digest;
  receipt_digest: Sha256Digest;
}> {
  const generation = readCarrierGeneration(input.generation_path);
  assertCarrierGenerationActivated(generation);
  const binding = generation.bindings.find((candidate) => candidate.server_key === input.server_key);
  if (binding === undefined) {
    throw new CarrierGenerationError(
      'carrier_binding_missing',
      `Carrier generation has no binding for ${input.server_key}.`,
      { carrier_generation_path: resolve(input.generation_path), server_key: input.server_key },
    );
  }
  if (normalize(binding.artifact_selector.store_root) !== normalize(resolve(input.artifact_store))) {
    throw new CarrierGenerationError(
      'binding_artifact_incompatible',
      'Launch artifact store does not match the binding selector.',
      {
        expected_artifact_store: binding.artifact_selector.store_root,
        actual_artifact_store: resolve(input.artifact_store),
      },
    );
  }
  validateCarrierBindingLaunch({ generation, binding });
  try {
    const resolvedArtifact = await verifyArtifactPin({
      store_root: binding.artifact_selector.store_root,
      package_name: binding.artifact_selector.package_name,
      compatibility: binding.artifact_selector.compatibility,
      closure_digest: binding.closure_digest,
      receipt_digest: binding.receipt_digest,
    });
    if (!resolvedArtifact.closure.entrypoints.includes(binding.artifact_entrypoint)) {
      throw new CarrierGenerationError(
        'binding_artifact_incompatible',
        'Selected closure does not declare the binding entrypoint.',
        { artifact_entrypoint: binding.artifact_entrypoint },
      );
    }
    const childEntrypoint = join(resolvedArtifact.closure_path, binding.artifact_entrypoint);
    if (!pathInside(resolvedArtifact.closure_path, childEntrypoint)) {
      throw new CarrierGenerationError(
        'binding_artifact_incompatible',
        'Selected child entrypoint escapes the immutable closure.',
      );
    }
    return {
      generation,
      binding,
      closure_path: resolvedArtifact.closure_path,
      child_entrypoint: childEntrypoint,
      closure_digest: resolvedArtifact.closure.closure_digest,
      receipt_digest: resolvedArtifact.receipt.receipt_digest,
    };
  } catch (error) {
    if (error instanceof CarrierGenerationError) throw error;
    if (error instanceof ArtifactIntegrityError) {
      throw new CarrierGenerationError(error.code, error.message, error.details, { cause: error });
    }
    throw error;
  }
}

export function sha256Text(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
