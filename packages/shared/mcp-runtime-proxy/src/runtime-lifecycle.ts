import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;

export const RUNTIME_INSTANCE_SCHEMA = 'narada.mcp_runtime_proxy.instance.v3' as const;
export const RUNTIME_FRESHNESS_SCHEMA = 'narada.mcp_runtime_proxy.runtime_freshness.v3' as const;
const TERMINABLE_RUNTIME_INSTANCE_SCHEMAS = new Set([
  'narada.mcp_runtime_proxy.instance.v2',
  RUNTIME_INSTANCE_SCHEMA,
]);

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
  carrier_generation: FileSnapshot;
  carrier_generation_digest: string;
};

export type RuntimeInstanceRecord = {
  schema: typeof RUNTIME_INSTANCE_SCHEMA;
  surface_id: string;
  server_key: string;
  proxy_pid: number;
  parent_pid: number;
  child_pid: number | null;
  supervisor_pid: number | null;
  managed_child_pid: number | null;
  server_pid: number | null;
  entrypoint: string;
  started_at: string;
  heartbeat_at: string;
  lease_expires_at: string;
  state: 'live' | 'stale' | 'reclaiming' | 'reclaimed' | 'closed';
  liveness_evidence: JsonRecord;
  runtime_freshness: JsonRecord;
  carrier_generation_path: string;
  carrier_generation_digest: string;
  closure_digest: string;
  receipt_digest: string;
  generation_id: string;
  closed_at: string | null;
};

type RecordedRuntimeInstance = {
  path: string;
  schema: string;
  proxy_pid: number;
  child_pid: number | null;
  supervisor_pid: number | null;
  managed_child_pid: number | null;
  server_pid: number | null;
  heartbeat_at: string;
  lease_expires_at: string;
};

export class RuntimeLifecycleError extends Error {
  readonly code: string;
  readonly details: JsonRecord;

  constructor(code: string, message: string, details: JsonRecord = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeLifecycleError';
    this.code = code;
    this.details = details;
  }
}

export function defaultRuntimeDiagnosticsDir(): string {
  return resolve(
    process.env.LOCALAPPDATA
      ?? process.env.XDG_STATE_HOME
      ?? process.env.HOME
      ?? process.cwd(),
    'Narada',
    'mcp-runtime-proxy',
  );
}

function fileSnapshot(path: string): FileSnapshot {
  const absolute = resolve(path);
  try {
    const stat = statSync(absolute);
    return {
      path: absolute,
      exists: true,
      mtime_ms: stat.mtimeMs,
      size: stat.size,
      sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
    };
  } catch {
    return { path: absolute, exists: false, mtime_ms: null, size: null, sha256: null };
  }
}

export function captureRuntimeFreshness(input: {
  proxyRuntimePath: string;
  childEntrypoint: string;
  carrierGenerationPath: string;
  carrierGenerationDigest: string;
  startedAt?: string;
}): RuntimeFreshnessTracker {
  return {
    started_at: input.startedAt ?? new Date().toISOString(),
    proxy_runtime: fileSnapshot(input.proxyRuntimePath),
    child_runtime: fileSnapshot(input.childEntrypoint),
    carrier_generation: fileSnapshot(input.carrierGenerationPath),
    carrier_generation_digest: input.carrierGenerationDigest,
  };
}

export function evaluateRuntimeFreshness(input: {
  tracker: RuntimeFreshnessTracker;
  surfaceId: string;
  proxyPid?: number;
  childPid?: number | null;
}): JsonRecord {
  const files = [
    { name: 'proxy_runtime', started: input.tracker.proxy_runtime },
    { name: 'child_runtime', started: input.tracker.child_runtime },
    { name: 'carrier_generation', started: input.tracker.carrier_generation },
  ].map((entry) => ({ ...entry, current: fileSnapshot(entry.started.path) }));
  const reasons: JsonRecord[] = [];
  for (const file of files) {
    if (!file.current.exists) {
      reasons.push({ code: 'sealed_runtime_file_missing', name: file.name, path: file.current.path });
    } else if (file.started.sha256 !== file.current.sha256) {
      reasons.push({
        code: 'sealed_runtime_file_changed',
        name: file.name,
        path: file.current.path,
        started_sha256: file.started.sha256,
        current_sha256: file.current.sha256,
      });
    }
  }
  return {
    schema: RUNTIME_FRESHNESS_SCHEMA,
    status: reasons.length === 0 ? 'pinned' : 'corrupt',
    observed_at: new Date().toISOString(),
    process_started_at: input.tracker.started_at,
    proxy_pid: input.proxyPid ?? process.pid,
    child_pid: input.childPid ?? null,
    surface_id: input.surfaceId,
    carrier_generation_digest: input.tracker.carrier_generation_digest,
    runtime_files: files,
    reasons,
    source_policy: 'validated_at_process_start',
    update_policy: 'restart_to_select_latest_compatible',
    restart_action: {
      kind: 'restart_carrier_bound_surface',
      owner: 'carrier_or_runtime_supervisor',
      automatic: false,
    },
  };
}

export function runtimeInstancePath(diagnosticsDir: string, proxyPid = process.pid): string {
  return join(resolve(diagnosticsDir), `instance-${proxyPid}.json`);
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

export function writeRuntimeInstance(path: string, record: RuntimeInstanceRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx');
  try {
    writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (!existsSync(path)) throw error;
    // Keep the previous complete lease rather than creating a visibility gap.
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function classifyRuntimeInstance(
  record: RuntimeInstanceRecord,
  options: { now?: Date; isPidAlive?: (pid: number) => boolean } = {},
): RuntimeInstanceRecord & { observed_state: string; stale_reasons: string[] } {
  const now = options.now ?? new Date();
  const isPidAlive = options.isPidAlive ?? processIsAlive;
  const staleReasons: string[] = [];
  if (record.state === 'reclaimed' || record.state === 'closed') {
    return { ...record, observed_state: record.state, stale_reasons: staleReasons };
  }
  if (!isPidAlive(record.proxy_pid)) staleReasons.push('proxy_pid_not_alive');
  if (!isPidAlive(record.parent_pid)) staleReasons.push('parent_carrier_pid_not_alive');
  if (record.child_pid !== null && !isPidAlive(record.child_pid)) staleReasons.push('child_pid_not_alive');
  if (Date.parse(record.lease_expires_at) < now.getTime()) staleReasons.push('heartbeat_lease_expired');
  if (record.runtime_freshness.status === 'corrupt') staleReasons.push('sealed_runtime_corrupt');
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
        .filter((name) => /^instance-\d+\.json$/u.test(name))
        .flatMap((name) => {
          try {
            const value = JSON.parse(readFileSync(join(root, name), 'utf8')) as RuntimeInstanceRecord;
            if (value.schema !== RUNTIME_INSTANCE_SCHEMA) return [];
            return [classifyRuntimeInstance(value, options)];
          } catch {
            return [];
          }
        })
    : [];
  return {
    schema: 'narada.mcp_runtime_proxy.instance_list.v3',
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

function optionalPid(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function readRecordedRuntimeInstances(diagnosticsDir: string): RecordedRuntimeInstance[] {
  const root = resolve(diagnosticsDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^instance-\d+\.json$/u.test(name))
    .map((name) => {
      const path = join(root, name);
      let value: JsonRecord;
      try {
        value = JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
      } catch (error) {
        throw new RuntimeLifecycleError(
          'runtime_instance_corrupt',
          'Runtime instance record is unreadable during hard cutover.',
          { instance_path: path },
          { cause: error },
        );
      }
      const proxyPid = optionalPid(value.proxy_pid);
      if (
        typeof value.schema !== 'string'
        || !TERMINABLE_RUNTIME_INSTANCE_SCHEMAS.has(value.schema)
        || proxyPid === null
        || name !== `instance-${proxyPid}.json`
        || typeof value.heartbeat_at !== 'string'
        || typeof value.lease_expires_at !== 'string'
      ) {
        throw new RuntimeLifecycleError(
          'runtime_instance_corrupt',
          'Runtime instance record cannot safely identify its proxy process.',
          { instance_path: path },
        );
      }
      return {
        path,
        schema: value.schema,
        proxy_pid: proxyPid,
        child_pid: optionalPid(value.child_pid),
        supervisor_pid: optionalPid(value.supervisor_pid),
        managed_child_pid: optionalPid(value.managed_child_pid),
        server_pid: optionalPid(value.server_pid),
        heartbeat_at: value.heartbeat_at,
        lease_expires_at: value.lease_expires_at,
      };
    });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function terminateRecordedRuntimeInstances(input: {
  diagnostics_dir?: string;
  now?: Date;
  identity_grace_ms?: number;
  graceful_timeout_ms?: number;
  force_timeout_ms?: number;
  poll_interval_ms?: number;
  is_pid_alive?: (pid: number) => boolean;
  terminate_pid?: (pid: number, force: boolean) => void;
  wait?: (milliseconds: number) => Promise<void>;
} = {}): Promise<JsonRecord> {
  const diagnosticsDir = resolve(input.diagnostics_dir ?? defaultRuntimeDiagnosticsDir());
  const now = input.now ?? new Date();
  const identityGraceMs = input.identity_grace_ms ?? 30_000;
  const gracefulTimeoutMs = input.graceful_timeout_ms ?? 5_000;
  const forceTimeoutMs = input.force_timeout_ms ?? 5_000;
  const pollIntervalMs = input.poll_interval_ms ?? 100;
  const isPidAlive = input.is_pid_alive ?? processIsAlive;
  const terminatePid = input.terminate_pid ?? ((pid: number, force: boolean) => {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  });
  const wait = input.wait ?? delay;
  const records = readRecordedRuntimeInstances(diagnosticsDir);
  const recordPids = (record: RecordedRuntimeInstance) => [
    record.proxy_pid,
    record.child_pid,
    record.supervisor_pid,
    record.managed_child_pid,
    record.server_pid,
  ].filter((pid): pid is number => pid !== null);
  const actionableRecords = records.filter((record) => recordPids(record).some(isPidAlive));
  for (const record of actionableRecords) {
    const leaseExpiry = Date.parse(record.lease_expires_at);
    const heartbeat = Date.parse(record.heartbeat_at);
    if (
      !Number.isFinite(leaseExpiry)
      || !Number.isFinite(heartbeat)
      || now.getTime() > leaseExpiry + identityGraceMs
    ) {
      throw new RuntimeLifecycleError(
        'runtime_instance_identity_stale',
        'Refusing to signal a live PID from an expired runtime identity record.',
        {
          instance_path: record.path,
          proxy_pid: record.proxy_pid,
          live_recorded_pids: recordPids(record).filter(isPidAlive),
          heartbeat_at: record.heartbeat_at,
          lease_expires_at: record.lease_expires_at,
        },
      );
    }
  }

  const signalled: number[] = [];
  for (const record of actionableRecords) {
    if (!isPidAlive(record.proxy_pid)) continue;
    terminatePid(record.proxy_pid, false);
    signalled.push(record.proxy_pid);
  }

  async function waitUntilDead(pids: number[], timeoutMs: number): Promise<number[]> {
    const deadline = Date.now() + timeoutMs;
    let remaining = pids.filter(isPidAlive);
    while (remaining.length > 0 && Date.now() < deadline) {
      await wait(pollIntervalMs);
      remaining = remaining.filter(isPidAlive);
    }
    return remaining;
  }

  let remaining = await waitUntilDead(signalled, gracefulTimeoutMs);
  const forceCandidates = new Set<number>(remaining);
  for (const record of actionableRecords) {
    for (const pid of [
      record.child_pid,
      record.supervisor_pid,
      record.managed_child_pid,
      record.server_pid,
    ]) {
      if (pid !== null && isPidAlive(pid)) forceCandidates.add(pid);
    }
  }
  for (const pid of forceCandidates) terminatePid(pid, true);
  remaining = await waitUntilDead([...forceCandidates], forceTimeoutMs);
  if (remaining.length > 0) {
    throw new RuntimeLifecycleError(
      'runtime_cutover_termination_failed',
      'One or more MCP runtime processes survived hard-cutover termination.',
      { remaining_pids: remaining, diagnostics_dir: diagnosticsDir },
    );
  }

  for (const record of records) rmSync(record.path, { force: true });
  if (records.length > 0) syncDirectory(diagnosticsDir);
  return {
    schema: 'narada.mcp_runtime_proxy.hard_cutover_termination.v3',
    status: 'terminated',
    diagnostics_dir: diagnosticsDir,
    instance_count: records.length,
    live_instance_count: actionableRecords.length,
    terminated_proxy_pids: signalled.sort((left, right) => left - right),
    forced_pids: [...forceCandidates].sort((left, right) => left - right),
  };
}
