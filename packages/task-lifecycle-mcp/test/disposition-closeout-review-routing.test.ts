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
    const structured = response.result.structuredContent;
    if (structured?.output_ref) {
      let offset = 0;
      let outputText = '';
      while (true) {
        const pageResponse = await handleTaskLifecycleMcpRequest({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'mcp_output_show',
            arguments: { ref: structured.output_ref, offset, limit: 20000 },
          },
        }, runtimeOptions);
        if (pageResponse.error) throw new Error('output_ref_read_error: ' + (pageResponse.error.message ?? JSON.stringify(pageResponse.error)));
        const page = pageResponse.result?.structuredContent;
        if (!page?.output_text) throw new Error('output_ref_page_missing_output_text');
        outputText += page.output_text;
        if (page.next_offset === null || page.next_offset === undefined) break;
        offset = page.next_offset;
      }
      return JSON.parse(outputText);
    }
    if (structured) return structured;
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
  const payload = await readToolPayload(response, 15);
  assert.equal(payload.status, 'prepared');
  assert.ok(payload.finish_result, JSON.stringify(payload, null, 2));
  assert.equal(payload.finish_result.status, 'success');
  assert.equal(payload.finish_result.close_action, 'skipped');
  assert.equal(payload.finish_result.new_status, 'awaiting_dependencies');
  assert.equal(payload.finish_result.review_action, 'dependency_requested');
  assert.equal(payload.finish_result.blocked_by, 'dependencies');
  assert.equal(payload.finish_result.review_dependency.dependency_kind, 'review');
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
  const showPayload = await readToolPayload(showResponse, 16);
  assert.equal(Object.hasOwn(showPayload, 'eligible_reviewers'), false);
  assert.ok(Array.isArray(showPayload.dependencies_blocking_this_task));
  assert.ok(Array.isArray(showPayload.dependency_context));
  assert.equal(showPayload.dependency_satisfaction.all_satisfied, false);
  assert.equal(showPayload.dependency_satisfaction.unsatisfied_count, 1);

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
  const reviewPayload = await readToolPayload(reviewResponse, 17);
  assert.equal(reviewPayload.status, 'success');
  assert.equal(reviewPayload.completion_mode, 'review_compatibility_dependency_outcome');
  assert.equal(reviewPayload.close_action, 'skipped');
  const reviewCompatibilityOutcome = reviewPayload.review_compatibility_dependency_outcome;
  assert.equal(reviewCompatibilityOutcome.outcome_contract.outcome_type, 'review');
  assert.equal(reviewCompatibilityOutcome.task_outcome.outcome, 'accepted');
  assert.equal(reviewCompatibilityOutcome.dependency_satisfaction.all_satisfied, true);

  const verifyStore = openTaskLifecycleStore(siteRoot);
  try {
    assert.notEqual(verifyStore.getLifecycle(taskId)?.status, 'closed');
    const dependencies = verifyStore.listTaskDependenciesForParent(taskId);
    assert.equal(dependencies.length, 1);
    assert.equal(dependencies[0].kind, 'review');
    const latestReviewOutcome = verifyStore.getLatestTaskOutcome(dependencies[0].required_task_id);
    assert.equal(latestReviewOutcome?.outcome, 'accepted');
    assert.equal(verifyStore.listDirectedObligationsForTask(taskId).length, 0);
  } finally {
    verifyStore.db.close();
  }

  const legacySchemaTaskId = '20260604-9003-legacy-roster-report';
  writeFileSync(
    join(siteRoot, '.ai', 'do-not-open', 'tasks', `${legacySchemaTaskId}.md`),
    `---
task_id: ${legacySchemaTaskId}
task_number: 9003
status: claimed
governed_by: builder
---

# Legacy roster report regression

## Goal

Submit report with an old agent_roster schema.

## Execution Notes

<!-- Record what was done, decisions made, and files changed during execution. -->

## Verification

<!-- Record commands run, results observed, and how correctness was checked. -->

## Acceptance Criteria

- [x] Report submission does not fail on missing operator_identity column.
`,
  );
  const legacyStore = openTaskLifecycleStore(siteRoot);
  try {
    let legacyLifecycle = legacyStore.getLifecycleByNumber(9003);
    if (!legacyLifecycle) {
      legacyStore.upsertLifecycle({
        task_id: legacySchemaTaskId,
        task_number: 9003,
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
      legacyLifecycle = legacyStore.getLifecycleByNumber(9003);
    }
    legacyStore.insertAssignment({
      assignment_id: 'assign-legacy-roster-report',
      task_id: legacyLifecycle?.task_id ?? legacySchemaTaskId,
      agent_id: 'smart-scheduling.builder',
      claimed_at: '2026-06-04T00:00:00Z',
      released_at: null,
      release_reason: null,
      intent: 'primary',
    });
    legacyStore.db.prepare('ALTER TABLE agent_roster DROP COLUMN operator_identity').run();
  } finally {
    legacyStore.db.close();
  }
  const legacyReportResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9003,
        agent_id: 'smart-scheduling.builder',
        reviewer: 'smart-scheduling.architect',
        summary: 'Verified legacy roster schema report path.',
        no_files_changed: true,
      },
    },
  }, runtimeOptions);
  assert.equal(legacyReportResponse.error, undefined);
  const legacyReportPayload = legacyReportResponse.result.structuredContent;
  assert.notEqual(legacyReportPayload.status, 'error');
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
