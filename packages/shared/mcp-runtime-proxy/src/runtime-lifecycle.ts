import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';

type JsonRecord = Record<string, unknown>;

export const RUNTIME_STATUS_TOOL_NAME = 'mcp_runtime_proxy_status';
export const RUNTIME_INSTANCE_SCHEMA = 'narada.mcp_runtime_proxy.instance.v1';
export const RUNTIME_FRESHNESS_SCHEMA = 'narada.mcp_runtime_proxy.runtime_freshness.v1';

type FileSnapshot = {
  path: string;
  exists: boolean;
  mtime_ms: number | null;
  size: number | null;
};

export type RuntimeFreshnessTracker = {
  started_at: string;
  proxy_runtime: FileSnapshot;
  child_runtime: FileSnapshot;
  source_files: FileSnapshot[];
};

export type RuntimeInstanceRecord = {
  schema: string;
  surface_id: string | null;
  proxy_pid: number;
  parent_pid: number;
  child_pid: number | null;
  entrypoint: string;
  started_at: string;
  heartbeat_at: string;
  lease_expires_at: string;
  state: 'live' | 'stale' | 'reclaiming' | 'reclaimed' | 'closed';
  liveness_evidence: JsonRecord;
  runtime_freshness?: JsonRecord;
  closed_at?: string | null;
};

export function captureRuntimeFreshness(input: {
  proxyRuntimePath: string;
  childEntrypoint: string;
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
    source_files: sourceFiles,
  };
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
    if (pair.started.mtime_ms !== pair.current.mtime_ms || pair.started.size !== pair.current.size) {
      reasons.push({
        code: 'runtime_changed_since_process_start',
        name: pair.name,
        path: pair.current.path,
        started_mtime_ms: pair.started.mtime_ms,
        current_mtime_ms: pair.current.mtime_ms,
      });
    }
  }
  const sourceFiles = input.tracker.source_files.map((source) => fileSnapshot(source.path));
  for (const source of sourceFiles) {
    const runtime = runtimePairs.find((pair) => sameCompiledSource(pair.current.path, source.path))?.current;
    if (source.exists && runtime?.exists && Number(source.mtime_ms) > Number(runtime.mtime_ms)) {
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
    source_files: sourceFiles,
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
    return { path: absolute, exists: true, mtime_ms: stat.mtimeMs, size: stat.size };
  } catch {
    return { path: absolute, exists: false, mtime_ms: null, size: null };
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
