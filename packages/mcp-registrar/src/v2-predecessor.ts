import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;

export type V2PredecessorLaunch = {
  server_key: string;
  launch: {
    command: string;
    args: string[];
  };
};

export type V2PredecessorRecords = {
  carrier_id: string;
  carrier_kind: string;
  config_path: string;
  config_content: string;
  server_count: number;
  launches: V2PredecessorLaunch[];
  sidecar_path: string;
  sidecar: JsonRecord;
  manifest_path: string;
  manifest: JsonRecord;
  runtime_proxy_entrypoint: string;
  registrar_entrypoint: string;
  workspace_root: string;
};

type ArtifactRecord = {
  path: string;
  sha256: string;
  size: number;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalizeLegacyMaterializedConfiguration(
  carrierKind: string,
  content: string,
): string {
  const normalized = content.replace(/\r\n?/g, '\n');
  if (carrierKind !== 'codex') return normalized;

  const lines = normalized.split('\n');
  const canonical: string[] = [];
  let inMcpTable = false;
  let sawMcpTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[mcp_servers.') && trimmed.endsWith(']')) {
      inMcpTable = true;
      sawMcpTable = true;
      canonical.push(line);
      continue;
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) inMcpTable = false;
    if (inMcpTable) canonical.push(line);
  }
  return (sawMcpTable ? canonical.join('\n') : normalized).replace(/\n+$/, '');
}

export function legacyMaterializationConfigFingerprint(input: {
  carrier_kind: string;
  content: string;
}): string {
  return sha256(canonicalizeLegacyMaterializedConfiguration(
    input.carrier_kind,
    input.content,
  ));
}

function samePath(left: string, right: string): boolean {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  return process.platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function refuse(
  reason: string,
  message: string,
  details: JsonRecord = {},
): never {
  const error = new Error(message);
  Object.assign(error, {
    codeName: 'registrar_v2_predecessor_unverifiable',
    details: { reason, ...details },
  });
  throw error;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    refuse(
      'fingerprint_invalid',
      'A runtime V2 predecessor fingerprint is malformed.',
      { field },
    );
  }
  return value;
}

function launchArgument(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] ?? null : null;
}

function artifactIndex(manifest: JsonRecord): Map<string, ArtifactRecord> {
  if (!Array.isArray(manifest.artifacts)) {
    refuse(
      'manifest_artifacts_missing',
      'The runtime V2 workspace artifact manifest has no artifact inventory.',
    );
  }
  const artifacts = new Map<string, ArtifactRecord>();
  for (const value of manifest.artifacts) {
    const record = asRecord(value);
    if (
      !record
      || typeof record.path !== 'string'
      || !isAbsolute(record.path)
      || !Number.isSafeInteger(record.size)
      || Number(record.size) < 0
    ) {
      refuse(
        'manifest_artifact_invalid',
        'The runtime V2 workspace artifact manifest contains a malformed artifact record.',
      );
    }
    const artifact: ArtifactRecord = {
      path: resolve(record.path),
      sha256: requireSha256(record.sha256, 'manifest.artifacts[].sha256'),
      size: Number(record.size),
    };
    const key = process.platform === 'win32'
      ? artifact.path.toLowerCase()
      : artifact.path;
    if (artifacts.has(key)) {
      refuse(
        'manifest_artifact_duplicate',
        'The runtime V2 workspace artifact manifest contains duplicate artifact paths.',
        { path: artifact.path },
      );
    }
    artifacts.set(key, artifact);
  }
  return artifacts;
}

function requireArtifact(
  artifacts: Map<string, ArtifactRecord>,
  path: string,
  role: string,
): ArtifactRecord {
  const resolved = resolve(path);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const artifact = artifacts.get(key);
  if (!artifact) {
    refuse(
      'manifest_artifact_cross_link_missing',
      'A runtime V2 predecessor executable is not cross-linked to its workspace artifact manifest.',
      { role, path: resolved },
    );
  }
  return artifact;
}

function assertManifest(input: V2PredecessorRecords): {
  fingerprint: string;
  artifacts: Map<string, ArtifactRecord>;
} {
  const { manifest } = input;
  const fingerprint = requireSha256(
    manifest.manifest_fingerprint,
    'manifest.manifest_fingerprint',
  );
  const unsigned = { ...manifest };
  delete unsigned.manifest_fingerprint;
  if (
    manifest.schema !== 'narada.workspace_artifact_manifest.v1'
    || sha256(JSON.stringify(unsigned)) !== fingerprint
    || typeof manifest.workspace_root !== 'string'
    || !samePath(manifest.workspace_root, input.workspace_root)
  ) {
    refuse(
      'manifest_not_self_consistent',
      'The runtime V2 workspace artifact manifest is not self-consistent.',
      { artifact_manifest_path: resolve(input.manifest_path) },
    );
  }
  return { fingerprint, artifacts: artifactIndex(manifest) };
}

function assertLaunches(
  input: V2PredecessorRecords,
  artifacts: Map<string, ArtifactRecord>,
): void {
  assertLaunchShape(input);
  for (const { server_key: serverKey, launch } of input.launches) {
    const childEntrypoint = launchArgument(launch.args, '--entrypoint');
    requireArtifact(artifacts, childEntrypoint!, `child:${serverKey}`);
  }
}

function assertLaunchShape(input: V2PredecessorRecords): void {
  for (const { server_key: serverKey, launch } of input.launches) {
    const surfaceId = launchArgument(launch.args, '--surface-id');
    const childEntrypoint = launchArgument(launch.args, '--entrypoint');
    if (
      launch.command !== 'node'
      || !surfaceId
      || !childEntrypoint
      || !isAbsolute(childEntrypoint)
      || launch.args.length < 12
      || !samePath(launch.args[0] ?? '', input.runtime_proxy_entrypoint)
      || launch.args[1] !== '--surface-id'
      || launch.args[2] !== surfaceId
      || launch.args[3] !== '--artifact-manifest'
      || !samePath(launch.args[4] ?? '', input.manifest_path)
      || launch.args[5] !== '--runtime-contract-version'
      || launch.args[6] !== '2'
      || launch.args[7] !== '--materialization-sidecar'
      || !samePath(launch.args[8] ?? '', input.sidecar_path)
      || launch.args[9] !== '--entrypoint'
      || !samePath(launch.args[10] ?? '', childEntrypoint)
      || launch.args[11] !== '--'
    ) {
      refuse(
        'launch_contract_mismatch',
        'A runtime V2 predecessor launch does not match the complete materialization contract.',
        {
          carrier_id: input.carrier_id,
          server_key: serverKey,
          command: launch.command,
          args: launch.args,
        },
      );
    }
  }
}

function assertSidecarShape(input: V2PredecessorRecords): void {
  const { sidecar } = input;
  const unsigned = {
    schema: sidecar.schema,
    contract_version: sidecar.contract_version,
    carrier_id: sidecar.carrier_id,
    carrier_kind: sidecar.carrier_kind,
    config_path: sidecar.config_path,
    config_sha256: sidecar.config_sha256,
    artifact_manifest_path: sidecar.artifact_manifest_path,
    artifact_manifest_fingerprint: sidecar.artifact_manifest_fingerprint,
    registrar_entrypoint: sidecar.registrar_entrypoint,
    registrar_fingerprint: sidecar.registrar_fingerprint,
    server_count: sidecar.server_count,
    proxy_count: sidecar.proxy_count,
    generated_at: sidecar.generated_at,
  };
  const generatedAt = typeof sidecar.generated_at === 'string'
    ? sidecar.generated_at
    : '';
  const parsedGeneratedAt = Date.parse(generatedAt);
  const valid = (
    sidecar.schema === 'narada.mcp_materialization_generation.v1'
    && sidecar.contract_version === 2
    && sidecar.carrier_id === input.carrier_id
    && sidecar.carrier_kind === input.carrier_kind
    && typeof sidecar.config_path === 'string'
    && samePath(sidecar.config_path, input.config_path)
    && sidecar.config_sha256 === legacyMaterializationConfigFingerprint({
      carrier_kind: input.carrier_kind,
      content: input.config_content,
    })
    && typeof sidecar.artifact_manifest_path === 'string'
    && samePath(sidecar.artifact_manifest_path, input.manifest_path)
    && typeof sidecar.artifact_manifest_fingerprint === 'string'
    && SHA256_PATTERN.test(sidecar.artifact_manifest_fingerprint)
    && typeof sidecar.registrar_entrypoint === 'string'
    && samePath(sidecar.registrar_entrypoint, input.registrar_entrypoint)
    && typeof sidecar.registrar_fingerprint === 'string'
    && SHA256_PATTERN.test(sidecar.registrar_fingerprint)
    && Number.isSafeInteger(sidecar.server_count)
    && sidecar.server_count === input.server_count
    && Number.isSafeInteger(sidecar.proxy_count)
    && sidecar.proxy_count === input.launches.length
    && Number.isFinite(parsedGeneratedAt)
    && new Date(parsedGeneratedAt).toISOString() === generatedAt
    && typeof sidecar.generation_fingerprint === 'string'
    && SHA256_PATTERN.test(sidecar.generation_fingerprint)
    && sidecar.generation_fingerprint === sha256(JSON.stringify(unsigned))
  );
  if (!valid) {
    refuse(
      'sidecar_not_self_consistent',
      'The runtime V2 materialization generation is not self-consistent with the installed carrier config.',
      {
        carrier_id: input.carrier_id,
        sidecar_path: resolve(input.sidecar_path),
      },
    );
  }
}

function assertSidecar(
  input: V2PredecessorRecords,
  manifestFingerprint: string,
  registrarArtifact: ArtifactRecord,
): void {
  assertSidecarShape(input);
  if (
    input.sidecar.artifact_manifest_fingerprint !== manifestFingerprint
    || input.sidecar.registrar_fingerprint !== registrarArtifact.sha256
  ) {
    refuse(
      'sidecar_not_self_consistent',
      'The runtime V2 materialization generation is not self-consistent with the installed carrier config.',
      {
        carrier_id: input.carrier_id,
        sidecar_path: resolve(input.sidecar_path),
      },
    );
  }
}

export function validateV2PredecessorForHardCutover(
  input: V2PredecessorRecords,
): void {
  if (
    !Number.isSafeInteger(input.server_count)
    || input.server_count < 0
    || !Array.isArray(input.launches)
  ) {
    refuse(
      'validation_input_invalid',
      'Runtime V2 predecessor validation input is malformed.',
    );
  }
  assertSidecarShape(input);
  assertLaunchShape(input);
  const workspaceRoot = resolve(input.workspace_root);
  if (!pathInside(workspaceRoot, input.runtime_proxy_entrypoint)) {
    refuse(
      'runtime_proxy_outside_workspace',
      'The runtime V2 predecessor proxy is outside the workspace authority.',
      { runtime_proxy_entrypoint: resolve(input.runtime_proxy_entrypoint) },
    );
  }
  for (const { server_key: serverKey, launch } of input.launches) {
    const childEntrypoint = launchArgument(launch.args, '--entrypoint');
    if (childEntrypoint === null || !pathInside(workspaceRoot, childEntrypoint)) {
      refuse(
        'child_entrypoint_outside_workspace',
        'A runtime V2 predecessor child is outside the workspace authority.',
        { server_key: serverKey, child_entrypoint: childEntrypoint },
      );
    }
  }
}

export function validateV2PredecessorRecords(input: V2PredecessorRecords): void {
  if (
    !Number.isSafeInteger(input.server_count)
    || input.server_count < 0
    || !Array.isArray(input.launches)
  ) {
    refuse(
      'validation_input_invalid',
      'Runtime V2 predecessor validation input is malformed.',
    );
  }
  const { fingerprint, artifacts } = assertManifest(input);
  const registrarArtifact = requireArtifact(
    artifacts,
    input.registrar_entrypoint,
    'registrar',
  );
  assertLaunches(input, artifacts);
  assertSidecar(input, fingerprint, registrarArtifact);
}

function pathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}
