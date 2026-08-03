import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
export { writeWorkerOutputSchema } from './output-contract.js';
import type { WorkerPolicy } from './policy.js';
import type { WorkerResolvedExecutionPolicy } from './worker-types.js';

export type RunRecordPaths = {
  runId: string;
  runDir: string;
  requestPath: string;
  executorRequestPath: string;
  resolvedConfigPath: string;
  promptPath: string;
  invocationPath: string;
  eventsPath: string;
  diagnosticPath: string;
  lastMessagePath: string;
  resultPath: string;
  schemaPath: string;
};

export type ActiveRunMarker = {
  schema: 'narada.worker.active_run.v1';
  run_id: string;
  run_dir: string;
  started_at: string;
  owner_pid: number;
  registered_at: string;
};

export type WorkerSessionRecord = {
  schema: 'narada.worker.session.v1';
  worker_session_id: string;
  origin_tool: string;
  created_run_id: string;
  updated_run_id: string;
  resolved_worker_config: WorkerResolvedExecutionPolicy;
  updated_at: string;
};

export function createRunRecord(policy: WorkerPolicy, requestedRunId?: string): RunRecordPaths {
  mkdirSync(policy.runRoot, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const runId = requestedRunId ?? `run-${stamp}-${randomBytes(4).toString('hex')}`;
  const runDir = resolve(policy.runRoot, runId);
  mkdirSync(runDir, { recursive: requestedRunId === undefined });
  return {
    runId,
    runDir,
    requestPath: join(runDir, 'request.json'),
    executorRequestPath: join(runDir, 'executor_request.json'),
    resolvedConfigPath: join(runDir, 'resolved_worker_config.json'),
    promptPath: join(runDir, 'worker_prompt.txt'),
    invocationPath: join(runDir, 'worker_invocation.json'),
    eventsPath: join(runDir, 'events.jsonl'),
    diagnosticPath: join(runDir, 'diagnostic.log'),
    lastMessagePath: join(runDir, 'last_message.json'),
    resultPath: join(runDir, 'result.json'),
    schemaPath: join(runDir, 'worker_output.schema.json'),
  };
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeText(path: string, value: string): void {
  writeFileSync(path, value, 'utf8');
}

export function activeRunDirectory(policy: Pick<WorkerPolicy, 'runRoot'>): string {
  return join(policy.runRoot, '.active');
}

export function activeRunMarkerPath(policy: Pick<WorkerPolicy, 'runRoot'>, runId: string): string {
  return join(activeRunDirectory(policy), `${encodeURIComponent(runId)}.json`);
}

export function registerActiveRun(policy: WorkerPolicy, marker: ActiveRunMarker): void {
  mkdirSync(activeRunDirectory(policy), { recursive: true });
  writeFileSync(activeRunMarkerPath(policy, marker.run_id), `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function unregisterActiveRun(policy: WorkerPolicy, runId: string): void {
  try {
    rmSync(activeRunMarkerPath(policy, runId), { force: true });
  } catch {
    // Terminal cleanup is best effort; a leftover marker is recoverable by
    // the next worker_runs_list pass.
  }
}

export function audit(policy: WorkerPolicy, payload: unknown): void {
  if (!policy.auditLogDir) return;
  mkdirSync(policy.auditLogDir, { recursive: true });
  appendFileSync(join(policy.auditLogDir, 'worker-delegation-mcp.jsonl'), `${JSON.stringify(payload)}\n`, 'utf8');
}

export function readWorkerSessionRecord(policy: WorkerPolicy, workerSessionId: string): WorkerSessionRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(workerSessionRecordPath(policy, workerSessionId), 'utf8')) as unknown;
    return isWorkerSessionRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeWorkerSessionRecord(policy: WorkerPolicy, record: WorkerSessionRecord): void {
  const dir = join(policy.runRoot, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, `${encodeURIComponent(record.worker_session_id)}.json`), record);
}

function workerSessionRecordPath(policy: WorkerPolicy, workerSessionId: string): string {
  return join(policy.runRoot, 'sessions', `${encodeURIComponent(workerSessionId)}.json`);
}

function isWorkerSessionRecord(value: unknown): value is WorkerSessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema === 'narada.worker.session.v1'
    && typeof record.worker_session_id === 'string'
    && typeof record.origin_tool === 'string'
    && typeof record.created_run_id === 'string'
    && typeof record.updated_run_id === 'string'
    && Boolean(record.resolved_worker_config && typeof record.resolved_worker_config === 'object' && !Array.isArray(record.resolved_worker_config));
}
