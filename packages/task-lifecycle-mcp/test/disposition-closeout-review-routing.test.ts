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
  const initialPayload = JSON.parse(response.result.content[0].text);
  const outputResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'mcp_output_show',
      arguments: {
        ref: initialPayload.output_ref,
        output_limit: 20000,
      },
    },
  }, runtimeOptions);

  assert.equal(outputResponse.error, undefined);
  const outputPayload = JSON.parse(outputResponse.result.content[0].text);
  const payload = JSON.parse(outputPayload.output_text);
  assert.equal(payload.status, 'prepared');
  assert.ok(payload.finish_result, JSON.stringify(payload, null, 2));
  assert.equal(payload.finish_result.status, 'success');
  assert.equal(payload.finish_result.close_action, 'skipped');
  assert.equal(payload.finish_result.new_status, 'in_review');

  const verifyStore = openTaskLifecycleStore(siteRoot);
  try {
    assert.equal(verifyStore.getLifecycle(taskId)?.status, 'in_review');
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
