import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  canonicalBuild,
  discoverPackageSourceRoots,
  resolveArtifactSelector,
  type ArtifactCompatibility,
  type ArtifactSelector,
  type Sha256Digest,
} from '@narada2/artifact-integrity';
import {
  surfaceDescriptorDigest,
  surfaceInterfaceDigest,
  type SurfaceDescriptorV3,
} from '@narada2/mcp-fabric-contracts';
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  MCP_RUNTIME_PROXY_ARTIFACT_PROFILE,
  MCP_RUNTIME_PROXY_PACKAGE,
  buildCarrierGeneration,
  runtimeProxyCompatibility,
  writeCarrierGenerationImmutable,
  type CarrierGeneration,
  type CarrierGenerationActivation,
  type CarrierGenerationSource,
  type CarrierRuntimeProxyPin,
  type NormalizedCarrierLaunch,
} from '@narada2/mcp-runtime-proxy/carrier-generation';

export const MCP_SURFACE_ARTIFACT_PROFILE = 'mcp-surface-v3' as const;

export type V3CarrierBindingSpec = {
  binding_id: string;
  server_key: string;
  surface_id: string;
  projection_id: string;
  descriptor: SurfaceDescriptorV3;
  source: CarrierGenerationSource;
  artifact_entrypoint: string;
  child_args: string[];
  child_env_names: string[];
  client_tool_names: string[];
  runtime_proxy_options?: {
    request_timeout_ms?: number;
    tool_timeout_grace_ms?: number;
    diagnostics_dir?: string;
    liveness_check_ms?: number;
  };
};

export type PreparedV3CarrierGeneration = {
  generation: CarrierGeneration;
  generation_path: string;
  artifact_store: string;
  runtime_proxy_entrypoint: string;
  launches: ReadonlyMap<string, NormalizedCarrierLaunch>;
};

type PackageArtifactDeclaration = {
  profile: string;
  entrypoints: string[];
  build_script: string;
};

function packageArtifactDeclaration(packageRoot: string): PackageArtifactDeclaration {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    narada?: { artifact?: Partial<PackageArtifactDeclaration> };
  };
  const declaration = manifest.narada?.artifact;
  if (
    typeof declaration?.profile !== 'string'
    || !Array.isArray(declaration.entrypoints)
    || declaration.entrypoints.length === 0
    || declaration.entrypoints.some((entrypoint) => typeof entrypoint !== 'string')
    || typeof declaration.build_script !== 'string'
  ) {
    throw new Error(`mcp_carrier_artifact_declaration_invalid:${resolve(packageRoot)}`);
  }
  return declaration as PackageArtifactDeclaration;
}

function compatibility(
  descriptor: SurfaceDescriptorV3,
  artifactProfile: string,
): ArtifactCompatibility {
  return {
    artifact_profile: artifactProfile,
    descriptor_digest: `sha256:${surfaceDescriptorDigest(descriptor)}` as Sha256Digest,
    interface_digest: `sha256:${surfaceInterfaceDigest(descriptor)}` as Sha256Digest,
  };
}

function selector(input: {
  package_name: string;
  package_root: string;
  artifact_store: string;
  descriptor: SurfaceDescriptorV3;
}): ArtifactSelector {
  const declaration = packageArtifactDeclaration(input.package_root);
  if (declaration.profile !== MCP_SURFACE_ARTIFACT_PROFILE) {
    throw new Error(
      `mcp_carrier_artifact_profile_invalid:${input.package_name}:${declaration.profile}`,
    );
  }
  return {
    mode: 'latest_compatible',
    store_root: resolve(input.artifact_store),
    package_name: input.package_name,
    compatibility: compatibility(input.descriptor, declaration.profile),
    source_policy: 'require_fresh',
  };
}

function runtimeProxySelector(input: {
  artifact_store: string;
  runtime_proxy_package_root: string;
}): ArtifactSelector {
  const declaration = packageArtifactDeclaration(input.runtime_proxy_package_root);
  if (declaration.profile !== MCP_RUNTIME_PROXY_ARTIFACT_PROFILE) {
    throw new Error(
      `mcp_carrier_runtime_proxy_profile_invalid:${declaration.profile}`,
    );
  }
  return {
    mode: 'latest_compatible',
    store_root: resolve(input.artifact_store),
    package_name: MCP_RUNTIME_PROXY_PACKAGE,
    compatibility: runtimeProxyCompatibility(),
    source_policy: 'require_fresh',
  };
}

function normalizeArtifactEntrypoint(packageRoot: string, entrypoint: string): string {
  const result = relative(resolve(packageRoot), resolve(entrypoint)).replaceAll('\\', '/');
  if (!result || result === '..' || result.startsWith('../')) {
    throw new Error(`mcp_carrier_entrypoint_outside_package:${entrypoint}`);
  }
  const declaration = packageArtifactDeclaration(packageRoot);
  if (!declaration.entrypoints.includes(result)) {
    throw new Error(`mcp_carrier_entrypoint_undeclared:${result}`);
  }
  return result;
}

function generationPath(
  generationRoot: string,
  carrierId: string,
  generationId: string,
): string {
  const safeCarrier = carrierId.replace(/[^A-Za-z0-9._-]/gu, '_');
  return join(resolve(generationRoot), safeCarrier, `${generationId}.json`);
}

function runtimeProxyOptionArgs(
  options: V3CarrierBindingSpec['runtime_proxy_options'],
): string[] {
  if (options === undefined) return [];
  const args: string[] = [];
  const integerOption = (name: string, value: number | undefined) => {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`mcp_carrier_runtime_proxy_option_invalid:${name}`);
    }
    args.push(name, String(value));
  };
  integerOption('--request-timeout-ms', options.request_timeout_ms);
  integerOption('--tool-timeout-grace-ms', options.tool_timeout_grace_ms);
  if (options.diagnostics_dir !== undefined) {
    if (!options.diagnostics_dir.trim()) {
      throw new Error('mcp_carrier_runtime_proxy_option_invalid:--diagnostics-dir');
    }
    args.push('--diagnostics-dir', resolve(options.diagnostics_dir));
  }
  integerOption('--liveness-check-ms', options.liveness_check_ms);
  return args;
}

export async function prepareV3CarrierGeneration(input: {
  carrier_id: string;
  carrier_kind: string;
  config_path: string;
  artifact_store: string;
  generation_root: string;
  runtime_proxy_package_root: string;
  runtime_proxy_workspace_root: string;
  bindings: V3CarrierBindingSpec[];
  activation: CarrierGenerationActivation;
  generation_id?: string;
  generated_at?: string;
}): Promise<PreparedV3CarrierGeneration> {
  if (input.bindings.length === 0) {
    throw new Error(`mcp_carrier_has_no_bindings:${input.carrier_id}`);
  }
  const artifactStore = resolve(input.artifact_store);
  const proxySelector = runtimeProxySelector({
    artifact_store: artifactStore,
    runtime_proxy_package_root: input.runtime_proxy_package_root,
  });
  const proxySource = await discoverPackageSourceRoots({
    package_root: input.runtime_proxy_package_root,
    workspace_root: input.runtime_proxy_workspace_root,
  });
  const proxyArtifact = await resolveArtifactSelector({
    selector: proxySelector,
    source_roots: proxySource.source_roots,
  });
  const proxyDeclaration = packageArtifactDeclaration(input.runtime_proxy_package_root);
  const proxyArtifactEntrypoint = proxyDeclaration.entrypoints[0]!;
  if (!proxyArtifact.closure.entrypoints.includes(proxyArtifactEntrypoint)) {
    throw new Error(`mcp_carrier_runtime_proxy_entrypoint_missing:${proxyArtifactEntrypoint}`);
  }
  const runtimeProxyEntrypoint = join(proxyArtifact.closure_path, proxyArtifactEntrypoint);
  const generationId = input.generation_id ?? randomUUID();
  const carrierGenerationPath = generationPath(
    input.generation_root,
    input.carrier_id,
    generationId,
  );
  const launches = new Map<string, NormalizedCarrierLaunch>();
  const generationBindings = [];

  for (const binding of input.bindings) {
    if (binding.descriptor.surface_id !== binding.surface_id) {
      throw new Error(`mcp_carrier_binding_descriptor_mismatch:${binding.server_key}`);
    }
    const artifactSelector = selector({
      package_name: binding.descriptor.package,
      package_root: binding.source.package_root,
      artifact_store: artifactStore,
      descriptor: binding.descriptor,
    });
    const source = await discoverPackageSourceRoots({
      package_root: binding.source.package_root,
      workspace_root: binding.source.workspace_root,
    });
    const artifact = await resolveArtifactSelector({
      selector: artifactSelector,
      source_roots: source.source_roots,
    });
    const artifactEntrypoint = normalizeArtifactEntrypoint(
      binding.source.package_root,
      binding.artifact_entrypoint,
    );
    if (!artifact.closure.entrypoints.includes(artifactEntrypoint)) {
      throw new Error(`mcp_carrier_artifact_entrypoint_missing:${binding.server_key}`);
    }
    const launch: NormalizedCarrierLaunch = {
      command: process.execPath,
      args: [
        runtimeProxyEntrypoint,
        '--runtime-contract-version',
        String(MCP_RUNTIME_CONTRACT_VERSION),
        '--carrier-generation',
        carrierGenerationPath,
        '--server-key',
        binding.server_key,
        '--artifact-store',
        artifactStore,
        ...runtimeProxyOptionArgs(binding.runtime_proxy_options),
      ],
    };
    launches.set(binding.server_key, launch);
    generationBindings.push({
      binding_id: binding.binding_id,
      server_key: binding.server_key,
      surface_id: binding.surface_id,
      projection_id: binding.projection_id,
      descriptor: binding.descriptor,
      artifact_selector: artifactSelector,
      closure_digest: artifact.closure.closure_digest,
      receipt_digest: artifact.receipt.receipt_digest,
      source: binding.source,
      artifact_entrypoint: artifactEntrypoint,
      child_args: binding.child_args,
      child_env_names: binding.child_env_names,
      client_tool_names: binding.client_tool_names,
      proxy_launch: launch,
    });
  }

  const runtimeProxyPin: CarrierRuntimeProxyPin = {
    artifact_selector: proxySelector,
    source: {
      package_root: resolve(input.runtime_proxy_package_root),
      workspace_root: resolve(input.runtime_proxy_workspace_root),
    },
    artifact_entrypoint: proxyArtifactEntrypoint,
    closure_digest: proxyArtifact.closure.closure_digest,
    receipt_digest: proxyArtifact.receipt.receipt_digest,
  };
  const generation = buildCarrierGeneration({
    generation_id: generationId,
    carrier_id: input.carrier_id,
    carrier_kind: input.carrier_kind,
    config_path: input.config_path,
    generated_at: input.generated_at,
    activation: input.activation,
    runtime_proxy: runtimeProxyPin,
    bindings: generationBindings,
  });
  return {
    generation,
    generation_path: carrierGenerationPath,
    artifact_store: artifactStore,
    runtime_proxy_entrypoint: runtimeProxyEntrypoint,
    launches,
  };
}

export function writePreparedV3CarrierGeneration(
  prepared: PreparedV3CarrierGeneration,
): void {
  writeCarrierGenerationImmutable(prepared.generation_path, prepared.generation);
}

export async function buildV3Artifact(input: {
  descriptor: SurfaceDescriptorV3;
  package_root: string;
  workspace_root: string;
  artifact_store: string;
}) {
  const declaration = packageArtifactDeclaration(input.package_root);
  return canonicalBuild({
    package_root: input.package_root,
    workspace_root: input.workspace_root,
    store_root: input.artifact_store,
    compatibility: compatibility(input.descriptor, declaration.profile),
  });
}

export async function buildV3RuntimeProxyArtifact(input: {
  package_root: string;
  workspace_root: string;
  artifact_store: string;
}) {
  return canonicalBuild({
    package_root: input.package_root,
    workspace_root: input.workspace_root,
    store_root: input.artifact_store,
    compatibility: runtimeProxyCompatibility(),
  });
}
