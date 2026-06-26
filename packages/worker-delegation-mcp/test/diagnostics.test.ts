import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRuntimeError, partialFailurePosture, readRunProgress, runtimeFailurePhase, workerBudgetStatus, workerProgressState } from '../src/diagnostics.js';

assert.equal(classifyRuntimeError('API error 429: rate_limit_exceeded'), 'provider_rate_limited');
assert.equal(classifyRuntimeError('Missing API key for provider'), 'provider_auth');
assert.equal(classifyRuntimeError('not inside a trusted directory; pass --skip-git-repo-check'), 'codex_untrusted_directory');

assert.equal(
  runtimeFailurePhase(
    { exit_code: 0, error: 'agent_runtime_completed_without_assistant_output', event_error: null, runtime_error: null },
    { ok: false, reason: 'missing_file', message: 'missing last message' },
    'agent_runtime_completed_without_assistant_output',
  ),
  'completed_without_assistant_output',
);

assert.equal(
  runtimeFailurePhase(
    { exit_code: 0, error: null, event_error: null, runtime_error: null },
    { ok: false, reason: 'missing_file', message: 'missing last message' },
    null,
  ),
  'pre_first_assistant_failure',
);

const root = mkdtempSync(join(tmpdir(), 'worker-diagnostics-'));
const eventsPath = join(root, 'events.jsonl');
writeFileSync(eventsPath, [
  JSON.stringify({ event: 'tool_call', message: 'reading files', timestamp: '2026-06-26T16:00:00.000Z' }),
  JSON.stringify({ event: 'assistant_message', content: 'done', timestamp: '2026-06-26T16:00:01.000Z' }),
].join('\n'));
const progress = readRunProgress(eventsPath);
assert.equal(progress.event_count, 2);
assert.equal(progress.latest_event_type, 'assistant_message');
assert.equal(progress.latest_event_preview, 'done');
assert.equal(progress.latest_event_at, '2026-06-26T16:00:01.000Z');

const partialFailure = partialFailurePosture({
  status: 'failed',
  changes: [{ path: 'src/main.ts' }],
  progress: { event_count: 3 },
  error: 'API error 429: rate limit',
});
assert.equal(partialFailure.status, 'productive_partial_failure');
assert.equal(partialFailure.provider_quota_limited, true);

const activeRun = {
  status: 'running',
  timing: { started_at: '2026-06-26T16:00:00.000Z' },
  status_liveness: { state: 'active', started_at: '2026-06-26T16:00:00.000Z', elapsed_ms: 1000, max_run_ms: 5000 },
  progress: { event_count: 1, latest_event_type: 'tool_call', latest_event_preview: 'reading files', latest_event_at: '2026-06-26T16:00:01.000Z' },
};
const budget = workerBudgetStatus(activeRun);
assert.equal(budget.remaining_ms, 4000);
assert.equal(workerProgressState(activeRun, [{ summary: 'reading files' }], budget).state, 'reading');
