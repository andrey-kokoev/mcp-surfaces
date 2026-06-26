import assert from 'node:assert/strict';
import { dashboardApiEndpoints, dashboardMode, dashboardPendingJoinGates, dashboardRun } from '../src/tool-handlers/dashboard.js';

const runningRun = {
  run_id: 'run-20260626T165000Z-running',
  status: 'running',
  runtime: 'codex',
  worker_session_id: 'session-1',
  resolved_worker_config: { authority: 'read' },
  timing: { started_at: '2026-06-26T16:50:00.000Z', finished_at: null, duration_ms: null },
  progress: { event_count: 3, latest_event_type: 'agent_message', latest_event_preview: 'reading files', latest_event_at: '2026-06-26T16:50:10.000Z', readable: true },
  status_liveness: { state: 'active' },
  progress_state: { state: 'reading' },
  budget_status: { remaining_ms: 1000 },
  recent_activity: [{ type: 'agent_message', preview: 'reading files' }],
};

assert.equal(dashboardMode(undefined, undefined), 'all_active');
assert.equal(dashboardMode(undefined, 'run-20260626T165000Z-running'), 'single_run');
assert.equal(dashboardMode('single_run', undefined), 'single_run');
assert.throws(() => dashboardMode('bad_mode', undefined), /worker_invalid_dashboard_mode/);

const compact = dashboardRun(runningRun);
assert.equal(compact.run_id, runningRun.run_id);
assert.equal(compact.requested_mode, 'audit_only');
assert.equal(compact.runtime, 'codex');
assert.equal(compact.authority, 'read');
assert.deepEqual(compact.progress, {
  event_count: 3,
  latest_event_type: 'agent_message',
  latest_event_preview: 'reading files',
  latest_event_at: '2026-06-26T16:50:10.000Z',
  readable: true,
});
assert.deepEqual(compact.events, []);
assert.deepEqual(compact.status_liveness, { state: 'active' });
assert.deepEqual(compact.progress_state, { state: 'reading' });
assert.deepEqual(compact.budget_status, { remaining_ms: 1000 });
assert.deepEqual(compact.recent_activity, [{ type: 'agent_message', preview: 'reading files' }]);

assert.deepEqual(dashboardPendingJoinGates([compact]), [{
  gate_id: `join:${runningRun.run_id}`,
  run_id: runningRun.run_id,
  status: 'pending',
  waiting_for: [runningRun.run_id],
}]);

const endpoints = dashboardApiEndpoints();
assert.equal(endpoints.length, 4);
assert.equal(endpoints[0].path, 'mcp://tools/worker_dashboard_describe');
