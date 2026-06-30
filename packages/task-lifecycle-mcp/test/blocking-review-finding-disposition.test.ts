import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import { handleTaskLifecycleMcpRequest } from '../src/task-lifecycle/task-mcp-server.js';

process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE = '1';

const siteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-blocking-review-finding-'));

function writeTask(taskNumber: number, taskId: string, status: string) {
  writeFileSync(
    join(siteRoot, '.ai', 'do-not-open', 'tasks', `${taskId}.md`),
    `---
task_id: ${taskId}
task_number: ${taskNumber}
status: ${status}
---

# Task ${taskNumber}

## Goal

Test review disposition handling.

## Execution Notes

Done.

## Verification

Checked.

## Acceptance Criteria

- [x] Criterion.
`,
  );
}

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
          agent_id: 'smart-scheduling.architect',
          role: 'architect',
          capabilities: ['task_review', 'architect_as_reviewer'],
          first_seen_at: '2026-06-04T00:00:00Z',
          last_active_at: '2026-06-04T00:00:00Z',
        },
      ],
    }, null, 2),
  );

  const reviewTaskId = '20260604-9101-review-target';
  const remediationTaskId = '20260604-9102-remediation-target';
  writeTask(9101, reviewTaskId, 'in_review');
  writeTask(9102, remediationTaskId, 'opened');

  const store = openTaskLifecycleStore(siteRoot);
  try {
    store.upsertRosterEntry({
      agent_id: 'smart-scheduling.architect',
      role: 'architect',
      capabilities_json: JSON.stringify(['task_review', 'architect_as_reviewer']),
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'active',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    for (const [task_number, task_id, status, governed_by] of [
      [9101, reviewTaskId, 'in_review', 'builder'],
      [9102, remediationTaskId, 'opened', 'builder'],
    ] as const) {
      store.upsertLifecycle({
        task_id,
        task_number,
        status,
        governed_by,
        closed_at: null,
        closed_by: null,
        closure_mode: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-06-04T00:00:00Z',
      });
    }
  } finally {
    store.db.close();
  }

  const runtimeOptions = {
    argv: ['--site-root', siteRoot],
    cwd: siteRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'smart-scheduling.architect' },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };

  async function responsePayload(response: any, id: number) {
    void id;
    if (response.result.structuredContent) return response.result.structuredContent;
    const initialPayload = JSON.parse(response.result.content[0].text);
    if (!initialPayload.output_ref) return initialPayload;
    throw new Error('unexpected_output_ref_without_structured_content');
  }

  const invalidResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_review',
      arguments: {
        task_number: 9101,
        agent_id: 'smart-scheduling.architect',
        verdict: 'rejected',
        findings: [
          {
            severity: 'blocking',
            description: 'Builder must repair this but no executable work was routed.',
            location: 'review',
          },
        ],
      },
    },
  }, runtimeOptions);
  assert.equal(invalidResponse.error, undefined);
  const invalidPayload = await responsePayload(invalidResponse, 2);
  assert.equal(invalidPayload.status, 'blocked');
  assert.equal(invalidPayload.error, 'blocking_outcome_disposition_required');
  assert.equal(invalidPayload.compatibility_error, 'blocking_review_finding_disposition_required');
  assert.match(invalidPayload.close_blockers[0], /no executable or explicitly deferred disposition/);
  assert.equal(invalidPayload.next_tool, 'task_lifecycle_dependency_disposition_record');
  assert.equal(invalidPayload.example_args.kind, 'remediation_task');

  const validResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_review',
      arguments: {
        task_number: 9101,
        agent_id: 'smart-scheduling.architect',
        verdict: 'rejected',
        findings: [
          {
            severity: 'blocking',
            description: 'Builder must repair this and the remediation task is visible.',
            location: 'review',
            remediation_task: {
              task_number: 9102,
              responsible_role: 'builder',
            },
          },
        ],
      },
    },
  }, runtimeOptions);
  assert.equal(validResponse.error, undefined);
  const validPayload = await responsePayload(validResponse, 4);
  assert.notEqual(validPayload.error, 'blocking_outcome_disposition_required');
} finally {
  try {
    rmSync(siteRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EBUSY') {
      throw error;
    }
  }
}

console.log('task-lifecycle-mcp blocking review finding disposition regression ok');
