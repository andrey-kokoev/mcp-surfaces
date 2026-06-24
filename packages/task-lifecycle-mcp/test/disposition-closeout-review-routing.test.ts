import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import { handleTaskLifecycleMcpRequest } from '../src/task-lifecycle/task-mcp-server.js';

process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE = '1';

const siteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-closeout-review-routing-'));

try {
  mkdirSync(join(siteRoot, '.ai', 'agents'), { recursive: true });
  mkdirSync(join(siteRoot, '.ai', 'do-not-open', 'tasks'), { recursive: true });

  writeFileSync(
    join(siteRoot, '.ai', 'agents', 'roster.json'),
    JSON.stringify({
      version: 1,
      updated_at: '2026-06-04T00:00:00Z',
      agents: [
        {
          agent_id: 'smart-scheduling.builder',
          role: 'builder',
          capabilities: ['implementation_work'],
          first_seen_at: '2026-06-04T00:00:00Z',
          last_active_at: '2026-06-04T00:00:00Z',
        },
        {
          agent_id: 'smart-scheduling.architect',
          role: 'architect',
          capabilities: ['review'],
          first_seen_at: '2026-06-04T00:00:00Z',
          last_active_at: '2026-06-04T00:00:00Z',
        },
      ],
    }, null, 2),
  );

  const taskId = '20260604-9001-review-routing-closeout';
  writeFileSync(
    join(siteRoot, '.ai', 'do-not-open', 'tasks', `${taskId}.md`),
    `---
task_id: ${taskId}
task_number: 9001
status: claimed
governed_by: builder
---

# Review routing closeout regression

## Goal

Exercise disposition closeout with criteria proof and no distinct reviewer.

## Execution Notes

<!-- Record what was done, decisions made, and files changed during execution. -->

## Verification

<!-- Record commands run, results observed, and how correctness was checked. -->

## Acceptance Criteria

- [ ] Navigation contains a CSS Accountability section.
`,
  );

  const store = openTaskLifecycleStore(siteRoot);
  try {
    store.upsertRosterEntry({
      agent_id: 'smart-scheduling.builder',
      role: 'builder',
      capabilities_json: JSON.stringify(['implementation_work']),
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'busy',
      task_number: 9001,
      last_done: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.upsertRosterEntry({
      agent_id: 'smart-scheduling.architect',
      role: 'architect',
      capabilities_json: JSON.stringify(['review']),
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'idle',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.upsertLifecycle({
      task_id: taskId,
      task_number: 9001,
      status: 'claimed',
      governed_by: 'builder',
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.upsertLifecycle({
      task_id: '20260604-9002-db-only-task',
      task_number: 9002,
      status: 'claimed',
      governed_by: 'builder',
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.insertAssignment({
      assignment_id: 'assign-review-routing-closeout',
      task_id: taskId,
      agent_id: 'smart-scheduling.builder',
      claimed_at: '2026-06-04T00:00:00Z',
      released_at: null,
      release_reason: null,
      intent: 'primary',
    });
  } finally {
    store.db.close();
  }

  const runtimeOptions = {
    argv: ['--site-root', siteRoot],
    cwd: siteRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'smart-scheduling.builder' },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };

  async function readToolPayload(response: any, id: number): Promise<any> {
    void id;
    if (response.result.structuredContent) return response.result.structuredContent;
    const inline = JSON.parse(response.result.content[0].text);
    if (!inline.output_ref) return inline;
    throw new Error('unexpected_output_ref_without_structured_content');
  }

  const missingProjectionCloseout = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_disposition_closeout',
      arguments: {
        task_number: 9002,
        agent_id: 'smart-scheduling.builder',
        summary: 'DB-only task should return structured repair guidance.',
        no_files_changed: true,
      },
    },
  }, runtimeOptions);
  assert.equal(missingProjectionCloseout.error, undefined);
  const missingProjectionCloseoutPayload = await readToolPayload(missingProjectionCloseout, 13);
  assert.equal(missingProjectionCloseoutPayload.status, 'error');
  assert.equal(missingProjectionCloseoutPayload.error, 'task_file_resolution_failed');
  assert.equal(missingProjectionCloseoutPayload.lifecycle_row_exists, true);
  assert.equal(missingProjectionCloseoutPayload.task_id, '20260604-9002-db-only-task');
  assert.match(missingProjectionCloseoutPayload.expected_path, /20260604-9002-db-only-task\.md$/);
  assert.equal(missingProjectionCloseoutPayload.recommended_next_tool, 'task_lifecycle_show');

  const missingProjectionFinish = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9002,
        agent_id: 'smart-scheduling.builder',
        summary: 'DB-only finish should return structured repair guidance.',
        no_files_changed: true,
      },
    },
  }, runtimeOptions);
  assert.equal(missingProjectionFinish.error, undefined);
  const missingProjectionFinishPayload = await readToolPayload(missingProjectionFinish, 14);
  assert.equal(missingProjectionFinishPayload.status, 'error');
  assert.equal(missingProjectionFinishPayload.error, 'task_file_resolution_failed');
  assert.equal(missingProjectionFinishPayload.surface, 'task_lifecycle_finish');
  assert.equal(missingProjectionFinishPayload.lifecycle_row_exists, true);

  const response = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_disposition_closeout',
      arguments: {
        task_number: 9001,
        agent_id: 'smart-scheduling.builder',
        summary: 'Implemented navigation labels and checked references.',
        changed_files: ['app/menus/baseMenu.ts'],
        prove_criteria: true,
        finish: true,
      },
    },
  }, runtimeOptions);

  assert.equal(response.error, undefined);
  const payload = response.result.structuredContent;
  assert.equal(payload.status, 'prepared');
  assert.ok(payload.finish_result, JSON.stringify(payload, null, 2));
  assert.equal(payload.finish_result.status, 'success');
  assert.equal(payload.finish_result.close_action, 'skipped');
  assert.equal(payload.finish_result.new_status, 'in_review');
  assert.deepEqual(payload.lifecycle_store_paths, ['.ai/do-not-open/tasks/20260604-9001-review-routing-closeout.md']);
  assert.deepEqual(payload.commit_ready.stage_paths, []);
  assert.deepEqual(payload.commit_ready.non_committable_lifecycle_store_paths, ['.ai/do-not-open/tasks/20260604-9001-review-routing-closeout.md']);
  assert.deepEqual(payload.committable_path_set.ordinary_task_closeout_paths, []);

  const architectRuntimeOptions = {
    argv: ['--site-root', siteRoot],
    cwd: siteRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'smart-scheduling.architect' },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };

  const showResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_show',
      arguments: { task_number: 9001 },
    },
  }, runtimeOptions);
  assert.equal(showResponse.error, undefined);
  const showPayload = showResponse.result.structuredContent;
  assert.ok(Array.isArray(showPayload.eligible_reviewers));
  assert.ok(showPayload.eligible_reviewers.some((r) => r.agent_id === 'smart-scheduling.architect'));

  const reviewResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_review',
      arguments: {
        task_number: 9001,
        agent_id: 'smart-scheduling.architect',
        verdict: 'accepted',
        auto_accept_single_operator: true,
      },
    },
  }, architectRuntimeOptions);
  assert.equal(reviewResponse.error, undefined);
  const reviewPayload = reviewResponse.result.structuredContent;
  assert.equal(reviewPayload.status, 'success');
  assert.equal(reviewPayload.lifecycle_status, 'closed');

  const verifyStore = openTaskLifecycleStore(siteRoot);
  try {
    assert.equal(verifyStore.getLifecycle(taskId)?.status, 'closed');
    assert.equal(verifyStore.listDirectedObligationsForTask(taskId).length, 0);
  } finally {
    verifyStore.db.close();
  }
} finally {
  try {
    rmSync(siteRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EBUSY') {
      throw error;
    }
  }
}

console.log('task-lifecycle-mcp disposition closeout review routing regression ok');
