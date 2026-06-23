import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import { handleTaskLifecycleMcpRequest } from '../src/task-lifecycle/task-mcp-server.js';

process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE = '1';

const siteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-ergonomics-'));

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

Test lifecycle ergonomics and coherence improvements.

## Execution Notes

Done.

## Verification

Checked.

## Acceptance Criteria

- [x] Criterion.
`,
  );
}

function seedRoster() {
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
}

async function responsePayload(response: any, runtimeOptions: any, id: number) {
  void runtimeOptions;
  void id;
  if (response.result.structuredContent) return response.result.structuredContent;
  const initialPayload = JSON.parse(response.result.content[0].text);
  if (!initialPayload.output_ref) return initialPayload;
  throw new Error('unexpected_output_ref_without_structured_content');
}

try {
  mkdirSync(join(siteRoot, '.ai', 'agents'), { recursive: true });
  mkdirSync(join(siteRoot, '.ai', 'do-not-open', 'tasks'), { recursive: true });
  seedRoster();

  const inReviewTaskId = '20260604-9201-ergonomics-in-review';
  writeTask(9201, inReviewTaskId, 'in_review');

  const store = openTaskLifecycleStore(siteRoot);
  try {
    store.upsertRosterEntry({
      agent_id: 'smart-scheduling.builder',
      role: 'builder',
      capabilities_json: JSON.stringify(['implementation_work']),
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'active',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.upsertRosterEntry({
      agent_id: 'smart-scheduling.architect',
      role: 'architect',
      capabilities_json: JSON.stringify(['review']),
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'active',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.upsertLifecycle({
      task_id: inReviewTaskId,
      task_number: 9201,
      status: 'in_review',
      governed_by: 'builder',
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
  } finally {
    store.db.close();
  }

  const builderRuntime = {
    argv: ['--site-root', siteRoot],
    cwd: siteRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'smart-scheduling.builder' },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };

  const architectRuntime = {
    argv: ['--site-root', siteRoot],
    cwd: siteRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'smart-scheduling.architect' },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };

  // 1. task_lifecycle_show surfaces eligible reviewers for in_review tasks.
  const showResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_show',
      arguments: { task_number: 9201 },
    },
  }, builderRuntime);
  const showPayload = await responsePayload(showResponse, builderRuntime, 2);
  assert.equal(showPayload.status, 'ok');
  assert.ok(Array.isArray(showPayload.eligible_reviewers));
  assert.ok(showPayload.eligible_reviewers.some((r) => r.agent_id === 'smart-scheduling.architect'));

  // 2. Review by a non-reviewer surfaces eligible reviewers.
  const unauthorizedReviewResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_review',
      arguments: {
        task_number: 9201,
        agent_id: 'smart-scheduling.builder',
        verdict: 'accepted',
      },
    },
  }, builderRuntime);
  const unauthorizedReviewPayload = await responsePayload(unauthorizedReviewResponse, builderRuntime, 4);
  assert.equal(unauthorizedReviewPayload.status, 'error');
  assert.equal(unauthorizedReviewPayload.error, 'review_authority_not_admitted');
  assert.ok(Array.isArray(unauthorizedReviewPayload.eligible_reviewers));
  assert.ok(unauthorizedReviewPayload.eligible_reviewers.some((r) => r.agent_id === 'smart-scheduling.architect'));

  // 3. Review by the sole reviewer with auto_accept_single_operator closes in one call.
  const autoAcceptResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_review',
      arguments: {
        task_number: 9201,
        agent_id: 'smart-scheduling.architect',
        verdict: 'accepted',
        auto_accept_single_operator: true,
      },
    },
  }, architectRuntime);
  const autoAcceptPayload = await responsePayload(autoAcceptResponse, architectRuntime, 6);
  assert.equal(autoAcceptPayload.status, 'success');
  assert.equal(autoAcceptPayload.lifecycle_status, 'closed');
  assert.equal(autoAcceptPayload.single_operator_review, true);

  // 4. roster_admit reports capability updates clearly.
  const rosterAdmitResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_roster_admit',
      arguments: {
        agent_id: 'smart-scheduling.builder',
        role: 'builder',
        actor_agent_id: 'smart-scheduling.builder',
        capabilities: ['implementation_work', 'review'],
        authority_basis: { kind: 'operator_direct_instruction', summary: 'Grant review capability for testing.' },
      },
    },
  }, builderRuntime);
  const rosterAdmitPayload = await responsePayload(rosterAdmitResponse, builderRuntime, 8);
  assert.equal(rosterAdmitPayload.status, 'updated');
  assert.equal(rosterAdmitPayload.capabilities_changed, true);

  const rosterAdmitNoopResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_roster_admit',
      arguments: {
        agent_id: 'smart-scheduling.builder',
        role: 'builder',
        actor_agent_id: 'smart-scheduling.builder',
        capabilities: ['implementation_work', 'review'],
        authority_basis: { kind: 'operator_direct_instruction', summary: 'Re-admit same capabilities.' },
      },
    },
  }, builderRuntime);
  const rosterAdmitNoopPayload = await responsePayload(rosterAdmitNoopResponse, builderRuntime, 10);
  assert.equal(rosterAdmitNoopPayload.status, 'already_present');
  assert.equal(rosterAdmitNoopPayload.capabilities_changed, false);
} finally {
  try {
    rmSync(siteRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EBUSY') {
      throw error;
    }
  }
}

console.log('task-lifecycle-mcp ergonomics and coherence ok');

// 5. Changed-file evidence is scoped by default and can include unrelated files when requested.
const scopedSiteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-scoped-changed-files-'));
try {
  mkdirSync(join(scopedSiteRoot, '.ai', 'agents'), { recursive: true });
  mkdirSync(join(scopedSiteRoot, '.ai', 'do-not-open', 'tasks'), { recursive: true });
  mkdirSync(join(scopedSiteRoot, 'packages', 'example', 'src'), { recursive: true });
  mkdirSync(join(scopedSiteRoot, '.ai', 'tmp'), { recursive: true });
  writeFileSync(
    join(scopedSiteRoot, '.ai', 'agents', 'roster.json'),
    JSON.stringify({
      version: 1,
      updated_at: '2026-06-04T00:00:00Z',
      agents: [
        {
          agent_id: 'scoped.builder',
          role: 'builder',
          capabilities: ['implementation_work'],
          first_seen_at: '2026-06-04T00:00:00Z',
          last_active_at: '2026-06-04T00:00:00Z',
        },
        {
          agent_id: 'scoped.architect',
          role: 'reviewer',
          capabilities: ['review'],
          first_seen_at: '2026-06-04T00:00:00Z',
          last_active_at: '2026-06-04T00:00:00Z',
        },
      ],
    }, null, 2),
  );
  const scopedTaskId = '20260604-9301-scoped-changed-files';
  const fullTaskId = '20260604-9302-full-changed-files';
  const payloadRefTaskId = '20260604-9303-payload-ref-finish';
  const followUpTaskId = '20260604-9304-follow-up-ledger';
  for (const [taskId, taskNumber] of [[scopedTaskId, 9301], [fullTaskId, 9302], [payloadRefTaskId, 9303]] as const) {
    writeFileSync(
      join(scopedSiteRoot, '.ai', 'do-not-open', 'tasks', `${taskId}.md`),
      `---\ntask_id: ${taskId}\ntask_number: ${taskNumber}\nstatus: claimed\ngoverned_by: builder\n---\n\n# Task ${taskNumber}\n\n## Goal\n\nTest changed-file scoping.\n\n## Execution Notes\n\nDone.\n\n## Verification\n\nChecked.\n\n## Acceptance Criteria\n\n- [x] Criterion.\n`,
    );
  }
  writeFileSync(
    join(scopedSiteRoot, '.ai', 'do-not-open', 'tasks', `${followUpTaskId}.md`),
    `---\ntask_id: ${followUpTaskId}\ntask_number: 9304\nstatus: claimed\ngoverned_by: builder\n---\n\n# Task 9304\n\n## Goal\n\nTest follow-up ledger remediation.\n\n## Execution Notes\n\nDisposition preserves a remaining follow-up item for later triage.\n\n## Verification\n\nChecked.\n\n## Acceptance Criteria\n\n- [x] Criterion.\n`,
  );
  const scopedStore = openTaskLifecycleStore(scopedSiteRoot);
  try {
    scopedStore.upsertRosterEntry({
      agent_id: 'scoped.builder',
      role: 'builder',
      capabilities_json: JSON.stringify(['implementation_work']),
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'active',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    scopedStore.upsertRosterEntry({
      agent_id: 'scoped.architect',
      role: 'reviewer',
      capabilities_json: JSON.stringify(['review']),
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'active',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    for (const [taskId, taskNumber] of [[scopedTaskId, 9301], [fullTaskId, 9302], [payloadRefTaskId, 9303], [followUpTaskId, 9304]] as const) {
      scopedStore.upsertLifecycle({
        task_id: taskId,
        task_number: taskNumber,
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
      scopedStore.insertAssignment({
        assignment_id: `assign-${taskNumber}`,
        task_id: taskId,
        agent_id: 'scoped.builder',
        claimed_at: '2026-06-04T00:00:00Z',
        released_at: null,
        release_reason: null,
        intent: 'primary',
      });
    }
  } finally {
    scopedStore.db.close();
  }

  spawnSync('git', ['init'], { cwd: scopedSiteRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: scopedSiteRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: scopedSiteRoot, stdio: 'ignore' });
  writeFileSync(join(scopedSiteRoot, 'README.md'), '# base\n');
  writeFileSync(join(scopedSiteRoot, 'packages', 'example', 'src', 'index.ts'), 'export const a = 1;\n');
  writeFileSync(join(scopedSiteRoot, '.ai', 'tmp', 'scratch.json'), '{}\n');
  spawnSync('git', ['add', '.'], { cwd: scopedSiteRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: scopedSiteRoot, stdio: 'ignore' });

  writeFileSync(join(scopedSiteRoot, 'packages', 'example', 'src', 'index.ts'), 'export const a = 2;\n');
  writeFileSync(join(scopedSiteRoot, '.ai', 'tmp', 'scratch.json'), '{"changed":true}\n');

  const scopedRuntime = {
    argv: ['--site-root', scopedSiteRoot],
    cwd: scopedSiteRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'scoped.builder' },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };

  const scopedResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9301,
        agent_id: 'scoped.builder',
        summary: 'Scoped changed files test.',
      },
    },
  }, scopedRuntime);
  const scopedPayload = await responsePayload(scopedResponse, scopedRuntime, 12);
  if (scopedPayload.status !== 'success') {
    console.error('scoped finish error:', JSON.stringify(scopedPayload, null, 2));
  }
  assert.equal(scopedPayload.status, 'success');
  const scopedPreflightResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_evidence_preflight',
      arguments: { task_number: 9301 },
    },
  }, scopedRuntime);
  const scopedPreflight = await responsePayload(scopedPreflightResponse, scopedRuntime, 16);
  const scopedChangedFiles = scopedPreflight.requirements.find((r) => r.id === 'changed_files')?.observed?.changed_files ?? [];
  assert.ok(scopedChangedFiles.includes('packages/example/src/index.ts'));
  assert.ok(!scopedChangedFiles.includes('.ai/tmp/scratch.json'));

  const fullResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9302,
        agent_id: 'scoped.builder',
        summary: 'Full changed files test.',
        include_unrelated_changed_files: true,
      },
    },
  }, scopedRuntime);
  const fullPayload = await responsePayload(fullResponse, scopedRuntime, 14);
  if (fullPayload.status !== 'success') {
    console.error('full finish error:', JSON.stringify(fullPayload, null, 2));
  }
  assert.equal(fullPayload.status, 'success');
  const fullPreflightResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 17,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_evidence_preflight',
      arguments: { task_number: 9302 },
    },
  }, scopedRuntime);
  const fullPreflight = await responsePayload(fullPreflightResponse, scopedRuntime, 18);
  const fullChangedFiles = fullPreflight.requirements.find((r) => r.id === 'changed_files')?.observed?.changed_files ?? [];
  assert.ok(fullChangedFiles.includes('packages/example/src/index.ts'));
  assert.ok(fullChangedFiles.includes('.ai/tmp/scratch.json'));

  const payloadCreateResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 19,
    method: 'tools/call',
    params: {
      name: 'mcp_payload_create',
      arguments: {
        payload: {
          task_number: 9999,
          agent_id: 'payload.agent',
          summary: 'Payload summary should be merged with authoritative top-level fields.',
          no_files_changed: true,
        },
      },
    },
  }, scopedRuntime);
  const payloadCreatePayload = await responsePayload(payloadCreateResponse, scopedRuntime, 20);
  const payloadRefFinishResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        payload_ref: payloadCreatePayload.ref,
        task_number: 9303,
        agent_id: 'scoped.builder',
      },
    },
  }, scopedRuntime);
  const payloadRefFinishPayload = await responsePayload(payloadRefFinishResponse, scopedRuntime, 22);
  assert.equal(payloadRefFinishPayload.status, 'success');

  const followUpPreflightResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 23,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_evidence_preflight',
      arguments: { task_number: 9304 },
    },
  }, scopedRuntime);
  const followUpPreflight = await responsePayload(followUpPreflightResponse, scopedRuntime, 24);
  assert.equal(followUpPreflight.status, 'blocked');
  assert.ok(followUpPreflight.remediation_summary.some((item: string) => item.includes('follow_up_ledger')));
  const followUpFinishResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 25,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9304,
        agent_id: 'scoped.builder',
        summary: 'Attempt closeout to exercise readable follow-up remediation.',
        no_files_changed: true,
      },
    },
  }, scopedRuntime);
  const followUpFinishPayload = await responsePayload(followUpFinishResponse, scopedRuntime, 26);
  assert.equal(followUpFinishPayload.error, 'follow_up_ledger_required');
  assert.match(followUpFinishPayload.remediation, /Follow-Up Ledger/);
} finally {
  try {
    rmSync(scopedSiteRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EBUSY') {
      throw error;
    }
  }
}

console.log('task-lifecycle-mcp scoped changed files ok');
