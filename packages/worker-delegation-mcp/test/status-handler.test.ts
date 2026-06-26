import assert from 'node:assert/strict';
import { includeRunByStatus, modeWithInference, runListItem, runSortKey, runWaitPayload } from '../src/tool-handlers/status.js';

const completedRun = {
  run_id: 'run-20260626T160000Z-completed',
  status: 'completed',
  summary: 'completed work',
  timing: { started_at: '2026-06-26T16:00:00.000Z', finished_at: '2026-06-26T16:01:00.000Z', duration_ms: 60000 },
  resolved_worker_config: { authority: 'write' },
  progress: { latest_event_preview: 'done', latest_event_type: 'assistant_message' },
};

assert.equal(includeRunByStatus('running', { includeCompleted: true, includeRunning: false }), false);
assert.equal(includeRunByStatus('completed', { includeCompleted: true, includeRunning: false }), true);
assert.equal(runSortKey(completedRun), '2026-06-26T16:01:00.000Z');
assert.deepEqual(modeWithInference(completedRun), { requestedMode: 'implement', inferred: true });

const compact = runListItem(completedRun, { verbose: false, includeSummary: true });
assert.equal(compact.run_id, 'run-20260626T160000Z-completed');
assert.equal(compact.requested_mode, 'implement');
assert.equal(compact.summary, 'completed work');
assert.equal(compact.progress_preview, 'done');

const waitPayload = runWaitPayload(completedRun, { status: 'finished', timeoutMs: 1000, elapsedMs: 50, verbose: false, summaryOnly: true });
assert.equal(waitPayload.schema, 'narada.worker.run_wait.v1');
assert.deepEqual(waitPayload.wait, { status: 'finished', timeout_ms: 1000, elapsed_ms: 50 });
assert.deepEqual(waitPayload.run, {
  run_id: 'run-20260626T160000Z-completed',
  status: 'completed',
  summary: 'completed work',
  error_preview: null,
  progress: completedRun.progress,
});
