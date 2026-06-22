import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
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

export type WorkerSessionRecord = {
  schema: 'narada.worker.session.v1';
  worker_session_id: string;
  origin_tool: string;
  created_run_id: string;
  updated_run_id: string;
  resolved_worker_config: WorkerResolvedExecutionPolicy;
  updated_at: string;
};

export function createRunRecord(policy: WorkerPolicy): RunRecordPaths {
  mkdirSync(policy.runRoot, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const runId = `run-${stamp}-${randomBytes(4).toString('hex')}`;
  const runDir = resolve(policy.runRoot, runId);
  mkdirSync(runDir, { recursive: true });
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

export function writeWorkerOutputSchema(path: string): void {
  writeJson(path, {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'deliverables', 'open_questions', 'next_actions', 'edits_performed', 'target_state_changed', 'changes', 'verification', 'verification_budget_respected', 'broad_unrelated_failures', 'exit_interview'],
    properties: {
      summary: { type: 'string' },
      deliverables: { type: 'array', items: { type: 'object', required: ['path', 'description'], properties: { path: { type: 'string' }, description: { type: 'string' } }, additionalProperties: false } },
      open_questions: { type: 'array', items: { type: 'string' } },
      next_actions: { type: 'array', items: { type: 'string' } },
      edits_performed: { type: 'boolean' },
      target_state_changed: { type: 'boolean' },
      changes: { type: 'array', items: { type: 'object', required: ['path', 'status', 'summary'], properties: { path: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' } }, additionalProperties: false } },
      verification: { type: 'array', items: { type: 'object', required: ['tool', 'command', 'status', 'summary', 'command_classification'], properties: { tool: { type: ['string', 'null'] }, command: { type: ['string', 'null'] }, status: { type: 'string' }, summary: { type: 'string' }, command_classification: { type: 'string', enum: ['focused', 'broad', 'not_applicable'] } }, additionalProperties: false } },
      verification_budget_respected: { type: ['boolean', 'null'] },
      broad_unrelated_failures: { type: 'array', items: { type: 'object', required: ['command', 'status', 'summary'], properties: { command: { type: ['string', 'null'] }, status: { type: 'string' }, summary: { type: 'string' } }, additionalProperties: false } },
      exit_interview: {
        type: ['object', 'null'],
        required: ['ergonomics_feedback', 'friction_points', 'missing_affordances', 'observed_incoherencies', 'suggested_improvements'],
        properties: {
          ergonomics_feedback: { type: 'string' },
          friction_points: { type: 'array', items: { type: 'string' } },
          missing_affordances: { type: 'array', items: { type: 'string' } },
          observed_incoherencies: { type: 'array', items: { type: 'string' } },
          suggested_improvements: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
  });
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
