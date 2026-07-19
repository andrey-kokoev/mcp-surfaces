import assert from 'node:assert/strict';
import { createTaskLifecycleReadHandlers } from '../src/task-lifecycle/task-lifecycle-read-handlers.js';

let savepointAttempts = 0;
const lifecycleRows = [
  {
    task_number: 42,
    task_id: 'fixture-legacy-review-42',
    status: 'opened',
    governed_by: 'review',
    closed_at: null,
    closed_by: null,
    closure_mode: null,
    updated_at: '2026-07-19T00:00:00Z',
  },
  {
    task_number: 41,
    task_id: 'fixture-ordinary-41',
    status: 'opened',
    governed_by: null,
    closed_at: null,
    closed_by: null,
    closure_mode: null,
    updated_at: '2026-07-19T00:00:00Z',
  },
];

const store = {
  db: {
    exec(sql: string) {
      if (sql.startsWith('SAVEPOINT')) {
        savepointAttempts += 1;
        if (savepointAttempts === 1) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }
    },
    prepare(sql: string) {
      if (sql.includes('FROM task_lifecycle')) return { all: () => lifecycleRows };
      if (sql.includes('FROM task_assignments')) return { get: () => null };
      throw new Error(`unexpected_sql: ${sql}`);
    },
  },
  getTaskSpec(taskId: string) {
    return { title: taskId, tags_json: '[]' };
  },
  getLatestTaskOutcome(taskId: string) {
    return taskId === 'fixture-legacy-review-42' ? { outcome: 'accepted' } : null;
  },
  getRoster() {
    return [];
  },
};

const handlers = createTaskLifecycleReadHandlers({
  store,
  siteRoot: 'D:/code/mcp-surfaces',
  jsonToolResult: (value: unknown) => value,
  stringField: (args: Record<string, unknown>, field: string) => typeof args?.[field] === 'string' ? args[field] : undefined,
  numberField: (args: Record<string, unknown>, field: string) => typeof args?.[field] === 'number' ? args[field] : undefined,
  getSitePolicy: () => ({}),
});

const listed = await handlers.task_lifecycle_list({});
assert.equal(listed.status, 'ok');
assert.equal(listed.count, 2);
assert.equal(listed.projection_consistency.status, 'stale');
assert.equal(listed.projection_consistency.stale, true);
assert.equal(listed.projection_consistency.snapshot_isolation, 'sqlite_savepoint');
assert.equal(listed.projection_consistency.contention.attempts, 2);
assert.equal(listed.projection_consistency.contention.retries, 1);
assert.equal(listed.projection_consistency.stale_count, 1);
assert.equal(listed.projection_consistency.stale_tasks[0].task_number, 42);
assert.equal(listed.projection_consistency.stale_tasks[0].expected_status, 'closed');
assert.deepEqual(listed.tasks[0].projection_consistency.reasons, ['admitted_review_outcome_not_projected_to_lifecycle']);
assert.equal(listed.tasks[1].projection_consistency.status, 'coherent');

const closedOnly = await handlers.task_lifecycle_list({ status: 'closed' });
assert.equal(closedOnly.count, 0);
assert.equal(closedOnly.projection_consistency.status, 'snapshot_coherent');
assert.equal(closedOnly.projection_consistency.stale, false);
assert.equal(closedOnly.projection_consistency.returned_count, 0);
assert.equal(closedOnly.projection_consistency.stale_count, 0);

console.log('task lifecycle list projection consistency tests passed');
