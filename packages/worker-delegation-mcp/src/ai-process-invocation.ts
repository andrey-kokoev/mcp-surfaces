import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Invocation } from './codex-adapter.js';

export type AiProcessAdmission = Record<string, unknown> & {
  admitted: boolean;
  reason?: string;
  artifact_path?: string;
  lease_path?: string;
  site_root: string;
  cwd: string;
};

const SECRET_NAME = /(key|token|secret|password|credential|cookie|authorization)/i;

export function admitWorkerAiProcessInvocation(invocation: Invocation, options: { projection: string; purpose: string; siteRoot?: string } = { projection: 'worker-delegation', purpose: 'worker_runtime' }): AiProcessAdmission {
  const siteRoot = resolve(options.siteRoot ?? invocation.environment.NARADA_SITE_ROOT ?? invocation.cwd);
  const cwd = resolve(invocation.cwd ?? siteRoot);
  const keyParts = {
    adapter_kind: 'codex',
    projection: options.projection,
    purpose: options.purpose,
    site_root: siteRoot,
    cwd,
    command: invocation.command,
    argv: invocation.argv,
  };
  const key = createHash('sha256').update(JSON.stringify(keyParts)).digest('hex');
  const root = join(siteRoot, '.ai', 'runtime', 'ai-process-invocation');
  const leaseDir = join(root, 'leases');
  const artifactDir = join(root, 'artifacts');
  mkdirSync(leaseDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  const leasePath = join(leaseDir, `${key}.json`);
  const record: AiProcessAdmission = {
    schema: 'narada.ai_process_invocation.v1',
    id: key.slice(0, 16),
    key,
    key_parts: keyParts,
    adapter_kind: 'codex',
    projection: options.projection,
    purpose: options.purpose,
    site_root: siteRoot,
    cwd,
    command: invocation.command,
    argv: invocation.argv,
    env: summarizeEnv(invocation.environment),
    owner_pid: process.pid,
    created_at: new Date().toISOString(),
    lease_path: leasePath,
    admitted: true,
  };
  const existing = readJson(leasePath);
  const allowDuplicate = Boolean(process.env.NARADA_AI_PROCESS_INVOCATION_ALLOW_DUPLICATE);
  if (existing && pidAlive(Number(existing.owner_pid)) && !allowDuplicate) {
    const refusal: AiProcessAdmission = {
      ...record,
      event: 'refused',
      admitted: false,
      reason: 'duplicate_live_invocation',
      existing_invocation: existing,
      cleanup_hint: 'Stop the existing invocation or set NARADA_AI_PROCESS_INVOCATION_ALLOW_DUPLICATE=1 for an explicit duplicate launch.',
    };
    refusal.artifact_path = writeArtifact(artifactDir, refusal);
    return refusal;
  }
  if (existing) rmSync(leasePath, { force: true });
  const admitted = { ...record, event: 'admitted' };
  writeFileSync(leasePath, `${JSON.stringify(admitted, null, 2)}\n`, 'utf8');
  admitted.artifact_path = writeArtifact(artifactDir, admitted);
  return admitted;
}

export function releaseWorkerAiProcessInvocation(admission: AiProcessAdmission | null, result: { exitCode: number | null; signal: string | null } = { exitCode: null, signal: null }): void {
  if (!admission?.admitted || !admission.lease_path) return;
  rmSync(admission.lease_path, { force: true });
  writeArtifact(join(admission.site_root, '.ai', 'runtime', 'ai-process-invocation', 'artifacts'), {
    ...admission,
    event: 'exited',
    exit_code: result.exitCode,
    signal: result.signal,
    exited_at: new Date().toISOString(),
  });
}

export function workerAiProcessRefusalError(admission: AiProcessAdmission): string {
  return `ai_process_invocation_refused: ${admission.reason ?? 'refused'}${admission.artifact_path ? ` artifact=${admission.artifact_path}` : ''}`;
}

function summarizeEnv(env: Record<string, string>): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_NAME.test(key)) summary[key] = '<redacted>';
    else if (['CODEX_HOME', 'CODEX_CONFIG_DIR', 'NARADA_SITE_ROOT', 'NARADA_WORKSPACE_ROOT', 'NARADA_AGENT_ID'].includes(key)) summary[key] = value;
  }
  return summary;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function writeArtifact(dir: string, evidence: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const path = join(dir, `${stamp}-${String(evidence.event)}-${String(evidence.id)}.json`);
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return path;
}
