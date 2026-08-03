import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';

type JsonRecord = Record<string, unknown>;

export const RUNTIME_STATUS_TOOL_NAME = 'mcp_runtime_proxy_status';
export const RUNTIME_INSTANCE_SCHEMA = 'narada.mcp_runtime_proxy.instance.v2';
export const LEGACY_RUNTIME_INSTANCE_SCHEMA = 'narada.mcp_runtime_proxy.instance.v1';
export const RUNTIME_FRESHNESS_SCHEMA = 'narada.mcp_runtime_proxy.runtime_freshness.v2';
export const LEGACY_RUNTIME_FRESHNESS_SCHEMA = 'narada.mcp_runtime_proxy.runtime_freshness.v1';

type FileSnapshot = {
  path: string;
  exists: boolean;
  mtime_ms: number | null;
  size: number | null;
  sha256: string | null;
};

export type RuntimeFreshnessTracker = {
  started_at: string;
  proxy_runtime: FileSnapshot;
  child_runtime: FileSnapshot;
  artifact_manifest: FileSnapshot | null;
  artifact_manifest_fingerprint: string | null;
  source_files: FileSnapshot[];
};

export type RuntimeInstanceRecord = {
  schema: string;
  surface_id: string | null;
  proxy_pid: number;
  parent_pid: number;
  child_pid: number | null;
  supervisor_pid?: number | null;
  managed_child_pid?: number | null;
  server_pid?: number | null;
  entrypoint: string;
  started_at: string;
  heartbeat_at: string;
  lease_expires_at: string;
  state: 'live' | 'stale' | 'reclaiming' | 'reclaimed' | 'closed';
  liveness_evidence: JsonRecord;
  runtime_freshness?: JsonRecord;
  artifact_manifest_path?: string | null;
  artifact_manifest_fingerprint?: string | null;
  generation_id?: string | null;
  supervisor_identity_path?: string | null;
  closed_at?: string | null;
};

export function captureRuntimeFreshness(input: {
  proxyRuntimePath: string;
  childEntrypoint: string;
  artifactManifestPath?: string | null;
  startedAt?: string;
}): RuntimeFreshnessTracker {
  const proxyRuntime = fileSnapshot(input.proxyRuntimePath);
  const childRuntime = fileSnapshot(input.childEntrypoint);
  const sourceFiles = [deriveSourcePath(input.proxyRuntimePath), deriveSourcePath(input.childEntrypoint)]
    .filter((value): value is string => Boolean(value))
    .map(fileSnapshot);
  return {
    started_at: input.startedAt ?? new Date().toISOString(),
    proxy_runtime: proxyRuntime,
    child_runtime: childRuntime,
    artifact_manifest: input.artifactManifestPath ? fileSnapshot(input.artifactManifestPath) : null,
    artifact_manifest_fingerprint: input.artifactManifestPath ? readManifestFingerprint(input.artifactManifestPath) : null,
    source_files: sourceFiles,
  };
}

function readManifestFingerprint(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
    return typeof parsed.manifest_fingerprint === 'string' ? parsed.manifest_fingerprint : null;
  } catch {
    return null;
  }
}

export function evaluateRuntimeFreshness(input: {
  tracker: RuntimeFreshnessTracker;
  surfaceId: string | null;
  proxyPid?: number;
  childPid?: number | null;
}): JsonRecord {
  const runtimePairs = [
    { name: 'proxy_runtime', started: input.tracker.proxy_runtime, current: fileSnapshot(input.tracker.proxy_runtime.path) },
    { name: 'child_runtime', started: input.tracker.child_runtime, current: fileSnapshot(input.tracker.child_runtime.path) },
  ];
  const reasons: JsonRecord[] = [];
  let evidenceUnknown = false;
  for (const pair of runtimePairs) {
    if (!pair.current.exists) {
      evidenceUnknown = true;
      reasons.push({ code: 'runtime_file_missing', evidence: 'unknown', name: pair.name, path: pair.current.path });
      continue;
    }
    if (pair.started.sha256 !== pair.current.sha256) {
      reasons.push({
        code: 'runtime_changed_since_process_start',
        name: pair.name,
        path: pair.current.path,
        started_sha256: pair.started.sha256,
        current_sha256: pair.current.sha256,
        started_size: pair.started.size,
        current_size: pair.current.size,
      });
    }
  }
  let artifactManifestCurrent: FileSnapshot | null = null;
  if (input.tracker.artifact_manifest) {
    artifactManifestCurrent = fileSnapshot(input.tracker.artifact_manifest.path);
    if (!artifactManifestCurrent.exists) {
      evidenceUnknown = true;
      reasons.push({ code: 'artifact_manifest_missing', evidence: 'unknown', path: artifactManifestCurrent.path });
    } else if (input.tracker.artifact_manifest_fingerprint !== readManifestFingerprint(artifactManifestCurrent.path)) {
      reasons.push({
        code: 'artifact_manifest_changed_since_process_start',
        path: artifactManifestCurrent.path,
        started_fingerprint: input.tracker.artifact_manifest_fingerprint,
        current_fingerprint: readManifestFingerprint(artifactManifestCurrent.path),
      });
    }
  }
  const sourceFiles = input.tracker.source_files.map((started) => ({ started, current: fileSnapshot(started.path) }));
  for (const sourcePair of sourceFiles) {
    const source = sourcePair.current;
    const runtimePair = runtimePairs.find((pair) => sameCompiledSource(pair.current.path, source.path));
    const runtime = runtimePair?.current;
    if (sourcePair.started.sha256 !== source.sha256) {
      reasons.push({
        code: 'source_changed_since_process_start',
        source_path: source.path,
        started_sha256: sourcePair.started.sha256,
        current_sha256: source.sha256,
      });
    }
    const sourceWasNewerAtStart = sourcePair.started.exists
      && runtimePair?.started.exists
      && Number(sourcePair.started.mtime_ms) > Number(runtimePair.started.mtime_ms);
    const sourceMtimeChanged = sourcePair.started.mtime_ms !== source.mtime_ms;
    if (source.exists && runtime?.exists && Number(source.mtime_ms) > Number(runtime.mtime_ms)
      && (sourceWasNewerAtStart || sourcePair.started.sha256 !== source.sha256 || !sourceMtimeChanged)) {
      reasons.push({
        code: 'source_newer_than_runtime_build',
        source_path: source.path,
        source_mtime_ms: source.mtime_ms,
        runtime_path: runtime.path,
        runtime_mtime_ms: runtime.mtime_ms,
      });
    }
  }
  const staleEvidence = reasons.some((reason) => reason.evidence !== 'unknown');
  const status = staleEvidence ? 'stale' : evidenceUnknown ? 'unknown' : 'current';
  return {
    schema: RUNTIME_FRESHNESS_SCHEMA,
    status,
    observed_at: new Date().toISOString(),
    process_started_at: input.tracker.started_at,
    proxy_pid: input.proxyPid ?? process.pid,
    child_pid: input.childPid ?? null,
    surface_id: input.surfaceId,
    runtime_files: runtimePairs.map((pair) => ({ name: pair.name, started: pair.started, current: pair.current })),
    source_files: sourceFiles.map((pair) => pair.current),
    reasons,
    reload_action: {
      schema: 'narada.mcp_runtime_proxy.supervisor_restart_action.v1',
      kind: 'restart_carrier_bound_surface',
      operation: 'restart',
      owner: 'carrier_or_runtime_supervisor',
      target: {
        scope: 'carrier_bound_surface',
        surface_id: input.surfaceId,
        proxy_pid: input.proxyPid ?? process.pid,
        child_pid: input.childPid ?? null,
      },
      automatic: false,
      guidance: 'Restart this carrier-bound proxy/server pair through the carrier or runtime supervisor. Restarting an mcp-loader child does not replace this process.',
    },
  };
}

export function runtimeStatusToolDefinition(): JsonRecord {
  return {
    name: RUNTIME_STATUS_TOOL_NAME,
    description: 'Inspect carrier-bound proxy/server liveness and build/runtime freshness, including the machine-readable supervisor restart action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: RUNTIME_STATUS_TOOL_NAME,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export function runtimeInstancePath(diagnosticsDir: string, proxyPid = process.pid): string {
  return join(resolve(diagnosticsDir), `instance-${proxyPid}.json`);
}

export function writeRuntimeInstance(path: string, record: RuntimeInstanceRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  try {
    renameSync(temporary, path);
  } catch {
    rmSync(path, { force: true });
    renameSync(temporary, path);
  }
}

export function classifyRuntimeInstance(
  record: RuntimeInstanceRecord,
  options: { now?: Date; isPidAlive?: (pid: number) => boolean } = {},
): RuntimeInstanceRecord & { observed_state: string; stale_reasons: string[] } {
  const now = options.now ?? new Date();
  const isPidAlive = options.isPidAlive ?? processIsAlive;
  const staleReasons: string[] = [];
  if (['reclaimed', 'closed'].includes(record.state)) {
    return { ...record, observed_state: record.state, stale_reasons: staleReasons };
  }
  if (!isPidAlive(record.proxy_pid)) staleReasons.push('proxy_pid_not_alive');
  if (!isPidAlive(record.parent_pid)) staleReasons.push('parent_carrier_pid_not_alive');
  if (record.child_pid !== null && !isPidAlive(record.child_pid)) staleReasons.push('child_pid_not_alive');
  if (Date.parse(record.lease_expires_at) < now.getTime()) staleReasons.push('heartbeat_lease_expired');
  return {
    ...record,
    observed_state: staleReasons.length > 0 || record.state !== 'live' ? 'stale' : 'live',
    stale_reasons: staleReasons,
  };
}

export function listRuntimeInstances(
  diagnosticsDir: string,
  options: { now?: Date; isPidAlive?: (pid: number) => boolean } = {},
): JsonRecord {
  const root = resolve(diagnosticsDir);
  const instances = existsSync(root)
    ? readdirSync(root)
        .filter((name) => /^instance-\d+\.json$/.test(name))
        .flatMap((name) => {
          try {
            const value = JSON.parse(readFileSync(join(root, name), 'utf8')) as RuntimeInstanceRecord;
            return [classifyRuntimeInstance(value, options)];
          } catch {
            return [];
          }
        })
    : [];
  return {
    schema: 'narada.mcp_runtime_proxy.instance_list.v1',
    status: 'ok',
    diagnostics_dir: root,
    observed_at: (options.now ?? new Date()).toISOString(),
    counts: {
      total: instances.length,
      live: instances.filter((entry) => entry.observed_state === 'live').length,
      stale: instances.filter((entry) => entry.observed_state === 'stale').length,
      reclaimed: instances.filter((entry) => entry.observed_state === 'reclaimed').length,
      closed: instances.filter((entry) => entry.observed_state === 'closed').length,
    },
    instances,
  };
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function fileSnapshot(path: string): FileSnapshot {
  const absolute = resolve(path);
  try {
    const stat = statSync(absolute);
    return { path: absolute, exists: true, mtime_ms: stat.mtimeMs, size: stat.size, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') };
  } catch {
    return { path: absolute, exists: false, mtime_ms: null, size: null, sha256: null };
  }
}

function deriveSourcePath(runtimePath: string): string | null {
  const absolute = resolve(runtimePath);
  const segments = absolute.split(sep);
  const distIndex = segments.lastIndexOf('dist');
  if (distIndex < 0) return null;
  segments.splice(distIndex, 1);
  const extension = extname(segments[segments.length - 1]);
  if (['.js', '.mjs', '.cjs'].includes(extension)) {
    segments[segments.length - 1] = `${segments[segments.length - 1].slice(0, -extension.length)}.ts`;
  }
  return segments.join(sep);
}

function sameCompiledSource(runtimePath: string, sourcePath: string): boolean {
  const derived = deriveSourcePath(runtimePath);
  return Boolean(derived && resolve(derived).toLowerCase() === resolve(sourcePath).toLowerCase());
}
