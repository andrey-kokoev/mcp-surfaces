import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describeUnknownError } from './error-description.js';

export const MCP_RUNTIME_CONTRACT_VERSION = 2 as const;
export const MATERIALIZATION_GENERATION_SCHEMA = 'narada.mcp_materialization_generation.v1' as const;

type JsonRecord = Record<string, unknown>;

export type MaterializationGeneration = {
  schema: typeof MATERIALIZATION_GENERATION_SCHEMA;
  contract_version: number;
  carrier_id: string;
  carrier_kind: string;
  config_path: string;
  config_sha256: string;
  artifact_manifest_path: string;
  artifact_manifest_fingerprint: string | null;
  registrar_entrypoint: string;
  registrar_fingerprint: string | null;
  server_count: number;
  proxy_count: number;
  generation_fingerprint: string;
  generated_at: string;
};

export type MaterializationValidation = {
  schema: 'narada.mcp_materialization_validation.v1';
  ok: boolean;
  contract_version: number;
  server_count: number;
  proxy_count: number;
  errors: Array<{ code: string; server_key: string; detail?: JsonRecord }>;
};

export type MaterializationPreflight = {
  ok: boolean;
  code?: 'materialization_generation_missing' | 'materialization_generation_stale';
  reason?: string;
  generation_fingerprint: string | null;
  details?: JsonRecord;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalizeMaterializedConfiguration(carrierKind: string, content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n');
  if (carrierKind !== 'codex') return normalized;

  // The registrar owns the Codex MCP launch projection. Codex may add or update
  // unrelated user settings (including project trust, approvals, TUI, and
  // Windows tables) after materialization. Fingerprint only the MCP sections so
  // those carrier-owned settings cannot invalidate an otherwise unchanged MCP
  // launch configuration.
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
  // Preserve the old whole-file behavior for malformed/non-TOML fixtures that
  // contain no MCP table; otherwise an empty projection could mask deletion of
  // the managed launch configuration.
  return (sawMcpTable ? canonical.join('\n') : normalized).replace(/\n+$/, '');
}

export function materializationConfigFingerprint(input: { carrierKind: string; content: string }): string {
  return sha256(canonicalizeMaterializedConfiguration(input.carrierKind, input.content));
}

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function materializationConfigFileFingerprint(path: string, carrierKind: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return materializationConfigFingerprint({ carrierKind, content: readFileSync(path, 'utf8') });
  } catch {
    return null;
  }
}

function argValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1]! : null;
}

function pathEquals(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function launchRecords(structured: JsonRecord): Array<[string, JsonRecord]> {
  const root = isRecord(structured.mcpServers)
    ? structured.mcpServers
    : isRecord(structured.mcp)
      ? structured.mcp
      : {};
  return Object.entries(root).flatMap(([key, value]): Array<[string, JsonRecord]> => isRecord(value) ? [[key, value]] : []);
}

function launchCommand(record: JsonRecord): { command: string; args: string[] } | null {
  if (Array.isArray(record.command)) {
    const values = record.command.filter((value): value is string => typeof value === 'string');
    if (values.length === 0) return null;
    return { command: values[0]!, args: values.slice(1) };
  }
  if (typeof record.command !== 'string') return null;
  return {
    command: record.command,
    args: Array.isArray(record.args) ? record.args.filter((value): value is string => typeof value === 'string') : [],
  };
}

export function materializationSidecarPath(configPath: string): string {
  return `${resolve(configPath)}.narada-generation.json`;
}

export function validateMaterializedConfiguration(input: {
  structured: JsonRecord;
  artifactManifestPath: string;
  runtimeProxyEntrypoint: string;
  expectedSidecarPath?: string;
  requireSidecar: boolean;
}): MaterializationValidation {
  const errors: MaterializationValidation['errors'] = [];
  const records = launchRecords(input.structured);
  let proxyCount = 0;
  for (const [serverKey, record] of records) {
    const launch = launchCommand(record);
    if (!launch) continue;
    const isProxy = launch.args.includes('--surface-id') || launch.args.some((arg) => arg.includes('mcp-runtime-proxy'));
    if (!isProxy) continue;
    proxyCount += 1;
    const version = argValue(launch.args, '--runtime-contract-version');
    if (version !== String(MCP_RUNTIME_CONTRACT_VERSION)) {
      errors.push({ code: 'materialized_config_contract_version_mismatch', server_key: serverKey, detail: { actual: version, expected: MCP_RUNTIME_CONTRACT_VERSION } });
    }
    const manifestPath = argValue(launch.args, '--artifact-manifest');
    if (!manifestPath) {
      errors.push({ code: 'materialized_config_missing_artifact_manifest', server_key: serverKey });
    } else if (!pathEquals(manifestPath, input.artifactManifestPath)) {
      errors.push({ code: 'materialized_config_artifact_manifest_mismatch', server_key: serverKey, detail: { actual: manifestPath, expected: input.artifactManifestPath } });
    } else if (!existsSync(manifestPath)) {
      errors.push({ code: 'materialized_config_artifact_manifest_missing', server_key: serverKey, detail: { path: manifestPath } });
    }
    const proxyPath = launch.args.find((arg) => arg.includes('mcp-runtime-proxy')) ?? launch.command;
    if (!pathEquals(proxyPath, input.runtimeProxyEntrypoint)) {
      errors.push({ code: 'materialized_config_runtime_proxy_mismatch', server_key: serverKey, detail: { actual: proxyPath, expected: input.runtimeProxyEntrypoint } });
    }
    if (!existsSync(proxyPath)) {
      errors.push({ code: 'materialized_config_runtime_proxy_missing', server_key: serverKey, detail: { path: proxyPath } });
    }
    const childEntrypoint = argValue(launch.args, '--entrypoint');
    if (!childEntrypoint) {
      errors.push({ code: 'materialized_config_child_entrypoint_missing', server_key: serverKey });
    } else if (!existsSync(childEntrypoint)) {
      errors.push({ code: 'materialized_config_child_entrypoint_missing', server_key: serverKey, detail: { path: childEntrypoint } });
    }
    const sidecarPath = argValue(launch.args, '--materialization-sidecar');
    if (input.requireSidecar && !sidecarPath) {
      errors.push({ code: 'materialized_config_missing_generation_sidecar', server_key: serverKey });
    } else if (sidecarPath && input.expectedSidecarPath && !pathEquals(sidecarPath, input.expectedSidecarPath)) {
      errors.push({ code: 'materialized_config_generation_sidecar_mismatch', server_key: serverKey, detail: { actual: sidecarPath, expected: input.expectedSidecarPath } });
    }
  }
  return {
    schema: 'narada.mcp_materialization_validation.v1',
    ok: errors.length === 0,
    contract_version: MCP_RUNTIME_CONTRACT_VERSION,
    server_count: records.length,
    proxy_count: proxyCount,
    errors,
  };
}

export function buildMaterializationGeneration(input: {
  carrierId: string;
  carrierKind: string;
  configPath: string;
  content: string;
  artifactManifestPath: string;
  artifactManifestFingerprint: string | null;
  registrarEntrypoint: string;
  serverCount: number;
  proxyCount: number;
}): MaterializationGeneration {
  const unsigned = {
    schema: MATERIALIZATION_GENERATION_SCHEMA,
    contract_version: MCP_RUNTIME_CONTRACT_VERSION,
    carrier_id: input.carrierId,
    carrier_kind: input.carrierKind,
    config_path: resolve(input.configPath),
    config_sha256: materializationConfigFingerprint({ carrierKind: input.carrierKind, content: input.content }),
    artifact_manifest_path: resolve(input.artifactManifestPath),
    artifact_manifest_fingerprint: input.artifactManifestFingerprint,
    registrar_entrypoint: resolve(input.registrarEntrypoint),
    registrar_fingerprint: sha256File(input.registrarEntrypoint),
    server_count: input.serverCount,
    proxy_count: input.proxyCount,
    generated_at: new Date().toISOString(),
  };
  return {
    ...unsigned,
    generation_fingerprint: sha256(JSON.stringify(unsigned)),
  };
}

export function writeMaterializationGeneration(path: string, generation: MaterializationGeneration): void {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, JSON.stringify(generation, null, 2) + '\n', 'utf8');
  try {
    renameSync(temporary, resolved);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function preflightMaterializationGeneration(input: {
  sidecarPath: string | null;
  manifestPath: string;
  manifestFingerprint: string | null;
}): MaterializationPreflight {
  if (!input.sidecarPath || !existsSync(input.sidecarPath)) {
    return { ok: false, code: 'materialization_generation_missing', reason: 'The materialization generation sidecar is missing.', generation_fingerprint: null, details: { sidecar_path: input.sidecarPath } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(input.sidecarPath, 'utf8'));
  } catch (error) {
    return { ok: false, code: 'materialization_generation_stale', reason: 'The materialization generation sidecar is unreadable.', generation_fingerprint: null, details: { error: describeUnknownError(error, 'materialization_generation_read_error') } };
  }
  if (!isRecord(parsed) || parsed.schema !== MATERIALIZATION_GENERATION_SCHEMA || typeof parsed.generation_fingerprint !== 'string') {
    return { ok: false, code: 'materialization_generation_stale', reason: 'The materialization generation sidecar has an unsupported schema.', generation_fingerprint: null };
  }
  const generation = parsed as unknown as MaterializationGeneration;
  if (
    typeof generation.contract_version !== 'number' ||
    typeof generation.carrier_id !== 'string' ||
    typeof generation.carrier_kind !== 'string' ||
    typeof generation.config_path !== 'string' ||
    typeof generation.config_sha256 !== 'string' ||
    typeof generation.artifact_manifest_path !== 'string' ||
    (generation.artifact_manifest_fingerprint !== null && typeof generation.artifact_manifest_fingerprint !== 'string') ||
    typeof generation.registrar_entrypoint !== 'string' ||
    (generation.registrar_fingerprint !== null && typeof generation.registrar_fingerprint !== 'string') ||
    typeof generation.server_count !== 'number' ||
    typeof generation.proxy_count !== 'number' ||
    typeof generation.generated_at !== 'string'
  ) {
    return { ok: false, code: 'materialization_generation_stale', reason: 'The materialization generation sidecar is structurally incomplete.', generation_fingerprint: generation.generation_fingerprint };
  }
  const generationContext: JsonRecord = {
    carrier_id: generation.carrier_id,
    carrier_kind: generation.carrier_kind,
    config_path: resolve(generation.config_path),
    registrar_entrypoint: resolve(generation.registrar_entrypoint),
    registrar_fingerprint: generation.registrar_fingerprint,
    materialization_generated_at: generation.generated_at,
  };
  const stale = (reason: string, details: JsonRecord = {}): MaterializationPreflight => ({
    ok: false,
    code: 'materialization_generation_stale',
    reason,
    generation_fingerprint: generation.generation_fingerprint,
    details: { ...generationContext, ...details },
  });
  const unsigned = {
    schema: generation.schema,
    contract_version: generation.contract_version,
    carrier_id: generation.carrier_id,
    carrier_kind: generation.carrier_kind,
    config_path: generation.config_path,
    config_sha256: generation.config_sha256,
    artifact_manifest_path: generation.artifact_manifest_path,
    artifact_manifest_fingerprint: generation.artifact_manifest_fingerprint,
    registrar_entrypoint: generation.registrar_entrypoint,
    registrar_fingerprint: generation.registrar_fingerprint,
    server_count: generation.server_count,
    proxy_count: generation.proxy_count,
    generated_at: generation.generated_at,
  };
  if (sha256(JSON.stringify(unsigned)) !== generation.generation_fingerprint) {
    return stale('The materialization generation fingerprint does not match its contents.');
  }
  const sidecarSuffix = '.narada-generation.json';
  const expectedConfigPath = input.sidecarPath.endsWith(sidecarSuffix)
    ? input.sidecarPath.slice(0, -sidecarSuffix.length)
    : null;
  if (!expectedConfigPath || !pathEquals(generation.config_path, expectedConfigPath)) {
    return stale('The materialization generation sidecar is not paired with its carrier configuration.', { expected_config_path: expectedConfigPath, actual_config_path: generation.config_path });
  }
  const configPath = resolve(generation.config_path);
  const configFingerprint = materializationConfigFileFingerprint(configPath, generation.carrier_kind);
  if (!configFingerprint || configFingerprint !== generation.config_sha256) {
    return stale('The materialized configuration changed after generation.', { config_path: configPath });
  }
  if (!pathEquals(generation.artifact_manifest_path, input.manifestPath) || generation.artifact_manifest_fingerprint !== input.manifestFingerprint) {
    return stale('The materialization generation references a different workspace artifact manifest.', { expected_manifest_path: input.manifestPath, actual_manifest_path: generation.artifact_manifest_path, expected_manifest_fingerprint: input.manifestFingerprint, actual_manifest_fingerprint: generation.artifact_manifest_fingerprint });
  }
  const currentRegistrarFingerprint = sha256File(generation.registrar_entrypoint);
  if (!currentRegistrarFingerprint || currentRegistrarFingerprint !== generation.registrar_fingerprint) {
    return stale('The registrar build changed after configuration generation.', { registrar_entrypoint: generation.registrar_entrypoint });
  }
  if (generation.contract_version !== MCP_RUNTIME_CONTRACT_VERSION) {
    return stale('The materialization contract version is obsolete.', { actual: generation.contract_version, expected: MCP_RUNTIME_CONTRACT_VERSION });
  }
  return { ok: true, generation_fingerprint: generation.generation_fingerprint };
}
