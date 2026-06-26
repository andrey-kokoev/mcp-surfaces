import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { diagnosticError } from './errors.js';
import { enrichFailedRunDiagnostics, readDiagnosticTail, readJsonPreview, readTextTail, withFreshProgress, withProgressObservability, withRunningLiveness } from './diagnostics.js';
import { recoverCompletedRunFromEvents, recoverExpiredRunningRun, recoverOrphanedRunningRun } from './recovery.js';
import type { RunRecordPaths } from './run-record.js';
import type { WorkerMcpState } from './state.js';

export type LocatedRunResult = { runRoot: string; runDir: string; resultPath: string; primary: boolean };

export function listRunIds(state: WorkerMcpState): string[] {
  return uniqueStrings(candidateRunRoots(state).flatMap((root) => {
    if (!existsSync(root)) return [];
    try {
      return readdirSync(root).filter((entry) => entry.startsWith('run-') && statSync(resolve(root, entry)).isDirectory());
    } catch {
      return [];
    }
  }));
}

export function locateRunResult(state: WorkerMcpState, runId: string): LocatedRunResult | null {
  const primaryRoot = resolve(state.policy.runRoot);
  for (const runRoot of candidateRunRoots(state)) {
    const runDir = resolve(runRoot, runId);
    const resultPath = resolve(runDir, 'result.json');
    if (existsSync(resultPath)) return { runRoot, runDir, resultPath, primary: runRoot === primaryRoot };
  }
  return null;
}

export function readRunResult(state: WorkerMcpState, runId: string, required = true): Record<string, unknown> | null {
  if (!/^run-[A-Za-z0-9TZ-]+$/.test(runId)) throw diagnosticError('worker_run_id_invalid', 'worker_run_id_invalid', { run_id: runId });
  const located = locateRunResult(state, runId);
  if (!located) {
    if (!required) return null;
    throw diagnosticError('worker_run_not_found', 'worker_run_not_found', { run_id: runId, searched_run_roots: candidateRunRoots(state) });
  }
  try {
    const run = JSON.parse(readFileSync(located.resultPath, 'utf8')) as Record<string, unknown>;
    const recovered = recoverCompletedRunFromEvents(run, located.resultPath);
    const orphanRecovered = recoverOrphanedRunningRun(recovered, state);
    const expiredRecovered = recoverExpiredRunningRun(orphanRecovered, state, located.resultPath);
    const progressRefreshed = withFreshProgress(expiredRecovered);
    const livenessEnriched = withRunningLiveness(progressRefreshed, state.policy.maxRunMs);
    const progressObserved = withProgressObservability(livenessEnriched);
    const diagnosticsEnriched = enrichFailedRunDiagnostics(progressObserved);
    return withArtifactReadback(diagnosticsEnriched, located);
  } catch (error) {
    if (!required) return null;
    const message = error instanceof Error ? error.message : String(error);
    throw diagnosticError('worker_run_result_unreadable', 'worker_run_result_unreadable', { run_id: runId, error: message });
  }
}

export function candidateRunRoots(state: WorkerMcpState): string[] {
  const roots = [resolve(state.policy.runRoot)];
  const userHome = process.env.USERPROFILE || process.env.HOME;
  const codeHome = process.env.CODEX_HOME;
  if (process.env.NARADA_SITE_ROOT) roots.push(resolve(process.env.NARADA_SITE_ROOT, '.narada', 'runtime', 'worker-delegation'));
  if (userHome) {
    roots.push(resolve(userHome, 'Narada', '.narada', 'runtime', 'worker-delegation'));
    roots.push(resolve(userHome, 'worker-delegation', 'runs'));
  }
  if (codeHome) roots.push(resolve(codeHome, 'worker-delegation', 'runs'));
  return uniqueStrings(roots);
}

export function runArtifacts(runRecord: RunRecordPaths): Record<string, unknown>[] {
  return [
    { name: 'request.json', path: runRecord.requestPath },
    { name: 'executor_request.json', path: runRecord.executorRequestPath },
    { name: 'resolved_worker_config.json', path: runRecord.resolvedConfigPath },
    { name: 'worker_prompt.txt', path: runRecord.promptPath },
    { name: 'worker_invocation.json', path: runRecord.invocationPath },
    { name: 'events.jsonl', path: runRecord.eventsPath },
    { name: 'diagnostic.log', path: runRecord.diagnosticPath },
    { name: 'last_message.json', path: runRecord.lastMessagePath },
    { name: 'result.json', path: runRecord.resultPath },
    { name: 'worker_output.schema.json', path: runRecord.schemaPath },
  ];
}

export function withArtifactReadback(run: Record<string, unknown>, located: { runRoot: string; runDir: string; primary: boolean }): Record<string, unknown> {
  const artifactReadback = {
    readable_via_worker_delegation: true,
    local_filesystem_access_required: false,
    run_root: located.runRoot,
    run_root_source: located.primary ? 'policy.runRoot' : 'rediscovered_run_root',
    rediscovered: !located.primary,
    resources_available: located.primary,
    diagnostic_tail: readDiagnosticTail(resolve(located.runDir, 'diagnostic.log')),
    events_tail: readTextTail(resolve(located.runDir, 'events.jsonl'), 1200),
    worker_invocation_preview: readJsonPreview(resolve(located.runDir, 'worker_invocation.json')),
    resolved_worker_config_preview: readJsonPreview(resolve(located.runDir, 'resolved_worker_config.json')),
  };
  return { ...run, artifact_readback: artifactReadback };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
