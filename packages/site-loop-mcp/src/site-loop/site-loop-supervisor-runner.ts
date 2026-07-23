import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { superviseSiteLoop } from './site-loop-engine.js';
import { runSiteLoopSupervisorWithCanonicalRuntimeHost } from './site-operating-runtime-host.js';

export const SITE_LOOP_SUPERVISOR_RUNNER_SCHEMA = 'narada.site_loop.supervisor_runner.v1';

export type SiteLoopSupervisorOptions = Record<string, any> & {
  cwd: string;
  supervise: true;
};

function numberValue(value: string | undefined) {
  return Number(value);
}

export function parseSiteLoopSupervisorArgs(argv: string[], defaultCwd = process.cwd()): SiteLoopSupervisorOptions {
  const parsed: Record<string, any> = { cwd: defaultCwd, supervise: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--supervise') parsed.supervise = true;
    else if (arg === '--source-sync') parsed.sourceSync = true;
    else if (arg === '--ensure-resident') parsed.ensureResident = true;
    else if (arg === '--cycles') parsed.cycles = numberValue(argv[++index]);
    else if (arg === '--interval-ms' || arg === '--intervalMs') parsed.intervalMs = numberValue(argv[++index]);
    else if (arg === '--jitter-ms' || arg === '--jitterMs') parsed.jitterMs = numberValue(argv[++index]);
    else if (arg === '--supervisor-heartbeat-path' || arg === '--supervisorHeartbeatPath') parsed.supervisorHeartbeatPath = argv[++index];
    else if (arg === '--supervisor-heartbeat-interval-ms' || arg === '--supervisorHeartbeatIntervalMs') parsed.supervisorHeartbeatIntervalMs = numberValue(argv[++index]);
    else if (arg === '--source-sync-timeout-ms' || arg === '--sourceSyncTimeoutMs') parsed.sourceSyncTimeoutMs = numberValue(argv[++index]);
    else if (arg === '--ticket-task-reconciliation-timeout-ms' || arg === '--ticketTaskReconciliationTimeoutMs') parsed.ticketTaskReconciliationTimeoutMs = numberValue(argv[++index]);
    else if (arg === '--limit') parsed.limit = numberValue(argv[++index]);
    else if (arg === '--threshold') parsed.threshold = numberValue(argv[++index]);
    else if (arg === '--owner-id' || arg === '--ownerId') parsed.ownerId = argv[++index];
    else if (arg === '--runtime-id' || arg === '--runtimeId') parsed.runtimeId = argv[++index];
    else if (arg === '--runtime-lease-ttl-ms' || arg === '--runtimeLeaseTtlMs') parsed.runtimeLeaseTtlMs = numberValue(argv[++index]);
    else if (arg === '--cwd' || arg === '--site-root') parsed.cwd = argv[++index];
    else if (!arg.startsWith('--')) parsed.cwd = arg;
  }
  return parsed as SiteLoopSupervisorOptions;
}

export async function runSiteLoopSupervisor(
  cwd: string,
  options: SiteLoopSupervisorOptions,
) {
  return runSiteLoopSupervisorWithCanonicalRuntimeHost(
    cwd,
    () => superviseSiteLoop(cwd, options),
    options,
  ) as Promise<Record<string, any>>;
}

function sameEntrypointPath(left: string, right: string) {
  try {
    return realpathSync.native(resolve(left)).toLowerCase() === realpathSync.native(resolve(right)).toLowerCase();
  } catch {
    return resolve(left).toLowerCase() === resolve(right).toLowerCase();
  }
}

const isEntrypoint = process.argv[1]
  ? sameEntrypointPath(fileURLToPath(import.meta.url), process.argv[1])
    || import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  const args = parseSiteLoopSupervisorArgs(process.argv.slice(2));
  runSiteLoopSupervisor(args.cwd, args)
    .then((result) => {
      console.log(JSON.stringify({
        schema: SITE_LOOP_SUPERVISOR_RUNNER_SCHEMA,
        ...result,
      }, null, 2));
      process.exit(result.status === 'ok' && result.health_status !== 'degraded' ? 0 : 1);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
}
