import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import { handleTaskLifecycleMcpRequest } from '../src/task-lifecycle/task-mcp-server.js';

process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE = '1';

const siteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-ergonomics-'));

function writeTask(taskNumber: number, taskId: string, status: string, extraFrontMatter = '') {
  writeFileSync(
    join(siteRoot, '.ai', 'do-not-open', 'tasks', `${taskId}.md`),
    `---
task_id: ${taskId}
task_number: ${taskNumber}
status: ${status}
${extraFrontMatter}
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
        {
          agent_id: 'mcp-surfaces.codex',
          role: 'mcp-surfaces-engineer',
          capabilities: ['implementation_work'],
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
  if (response.error) throw new Error(`json_rpc_error: ${response.error.message ?? JSON.stringify(response.error)}`);
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
  const roleMismatchTaskId = '20260604-9202-role-mismatch-diagnostics';
  writeTask(9202, roleMismatchTaskId, 'opened', 'target_role: qa');
  const chapterTaskId = '20260604-9203-chapter-membership';
  writeTask(9203, chapterTaskId, 'opened');
  const reopenedTaskId = '20260604-9204-reopened-fresh-review';
  writeTask(9204, reopenedTaskId, 'claimed', 'reopened_at: 2026-06-04T02:00:00Z\nreopened_by: operator');
  const blockedTaskId = '20260604-9205-blocked-claimed-work';
  writeTask(9205, blockedTaskId, 'claimed');
  const blockedPayloadTaskId = '20260604-9206-blocked-payload-ref-work';
  writeTask(9206, blockedPayloadTaskId, 'claimed');
  const genericEngineerTaskId = '20260604-9207-generic-engineer-parent-role';
  writeTask(9207, genericEngineerTaskId, 'opened', 'target_role: engineer');

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
      agent_id: 'mcp-surfaces.codex',
      role: 'mcp-surfaces-engineer',
      capabilities_json: JSON.stringify(['implementation_work']),
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'active',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.upsertLifecycle({
      task_id: chapterTaskId,
      task_number: 9203,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.upsertLifecycle({
      task_id: genericEngineerTaskId,
      task_number: 9207,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
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
    store.upsertLifecycle({
      task_id: roleMismatchTaskId,
      task_number: 9202,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.upsertLifecycle({
      task_id: reopenedTaskId,
      task_number: 9204,
      status: 'claimed',
      governed_by: 'builder',
      closed_at: '2026-06-04T01:00:00Z',
      closed_by: 'smart-scheduling.architect',
      closure_mode: 'peer_reviewed',
      reopened_at: '2026-06-04T02:00:00Z',
      reopened_by: 'operator',
      continuation_packet_json: null,
      updated_at: '2026-06-04T02:00:00Z',
    });
    store.insertAssignment({
      assignment_id: 'assign-reopened-fresh-review',
      task_id: reopenedTaskId,
      agent_id: 'smart-scheduling.builder',
      claimed_at: '2026-06-04T02:05:00Z',
      released_at: null,
      release_reason: null,
      intent: 'primary',
    });
    store.upsertLifecycle({
      task_id: blockedTaskId,
      task_number: 9205,
      status: 'claimed',
      governed_by: 'builder',
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-06-04T03:00:00Z',
    });
    store.insertAssignment({
      assignment_id: 'assign-blocked-claimed-work',
      task_id: blockedTaskId,
      agent_id: 'smart-scheduling.builder',
      claimed_at: '2026-06-04T03:05:00Z',
      released_at: null,
      release_reason: null,
      intent: 'primary',
    });
    store.upsertLifecycle({
      task_id: blockedPayloadTaskId,
      task_number: 9206,
      status: 'claimed',
      governed_by: 'builder',
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-06-04T03:10:00Z',
    });
    store.insertAssignment({
      assignment_id: 'assign-blocked-payload-ref-work',
      task_id: blockedPayloadTaskId,
      agent_id: 'smart-scheduling.builder',
      claimed_at: '2026-06-04T03:11:00Z',
      released_at: null,
      release_reason: null,
      intent: 'primary',
    });
    const staleReport = {
      report_id: 'report-reopened-stale-pre-reopen',
      task_number: 9204,
      task_id: reopenedTaskId,
      agent_id: 'smart-scheduling.builder',
      assignment_id: 'assign-reopened-before-reopen',
      directive_id: null,
      reported_at: '2026-06-04T00:20:00Z',
      summary: 'Stale pre-reopen implementation report.',
      changed_files: ['src/stale.ts'],
      verification: [{ command: 'stale', result: 'passed before reopen' }],
      known_residuals: [],
      ready_for_review: true,
      report_status: 'accepted',
    };
    store.upsertReportRecord({
      report_id: staleReport.report_id,
      task_id: reopenedTaskId,
      assignment_id: staleReport.assignment_id,
      agent_id: staleReport.agent_id,
      reported_at: staleReport.reported_at,
      report_json: JSON.stringify(staleReport),
    });
    store.insertReview({
      review_id: 'review-reopened-stale-pre-reopen',
      task_id: reopenedTaskId,
      reviewer_agent_id: 'smart-scheduling.architect',
      verdict: 'accepted',
      findings_json: null,
      reviewed_at: '2026-06-04T00:30:00Z',
    });
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS narada_andrey_task_role_preferences (
        task_id TEXT PRIMARY KEY,
        preferred_role TEXT,
        target_role TEXT,
        preferred_agent_id TEXT,
        updated_at TEXT
      )
    `);
    store.db.prepare(`
      INSERT INTO narada_andrey_task_role_preferences (task_id, preferred_role, target_role, preferred_agent_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(roleMismatchTaskId, 'qa', 'qa', null, '2026-06-04T00:00:00Z');
    store.db.prepare(`
      INSERT INTO narada_andrey_task_role_preferences (task_id, preferred_role, target_role, preferred_agent_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(genericEngineerTaskId, 'engineer', 'engineer', null, '2026-06-04T00:00:00Z');
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

  const surfaceEngineerRuntime = {
    argv: ['--site-root', siteRoot],
    cwd: siteRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'mcp-surfaces.codex' },
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

  // 5. Payload schema and validation diagnostics expose accepted findings shape.
  const schemaResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 101,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_payload_schema',
      arguments: { tool: 'task_lifecycle_review' },
    },
  }, builderRuntime);
  const schemaPayload = await responsePayload(schemaResponse, builderRuntime, 102);
  assert.equal(schemaPayload.status, 'ok');
  assert.deepEqual(schemaPayload.schemas.task_lifecycle_review.payload_ref_shape.findings[0].description, '<finding text>');

  const createSchemaResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1014,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_payload_schema',
      arguments: { tool: 'task_lifecycle_create' },
    },
  }, builderRuntime);
  const createSchemaPayload = await responsePayload(createSchemaResponse, builderRuntime, 1015);
  assert.equal(createSchemaPayload.status, 'ok');
  assert.equal(createSchemaPayload.schemas.task_lifecycle_create.payload_ref_required, true);
  assert.match(createSchemaPayload.schemas.task_lifecycle_create.payload_ref_shape.required_work, /string\[\]/);
  assert.match(createSchemaPayload.schemas.task_lifecycle_create.normalized_fields.required_work, /joins with newline/);

  const closeoutSchemaResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1016,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_payload_schema',
      arguments: { tool: 'task_lifecycle_report_blocked' },
    },
  }, builderRuntime);
  const blockedSchemaPayload = await responsePayload(closeoutSchemaResponse, builderRuntime, 1017);
  assert.equal(blockedSchemaPayload.status, 'ok');
  assert.deepEqual(blockedSchemaPayload.schemas.task_lifecycle_report_blocked.top_level_fields_remain_required, ['task_number', 'agent_id']);
  assert.match(blockedSchemaPayload.schemas.task_lifecycle_report_blocked.inline_payload_limit.remediation, /payload_ref/);

  const admitSchemaResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1012,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_payload_schema',
      arguments: { tool: 'task_lifecycle_admit_evidence' },
    },
  }, builderRuntime);
  const admitSchemaPayload = await responsePayload(admitSchemaResponse, builderRuntime, 1013);
  assert.equal(admitSchemaPayload.status, 'ok');
  assert.deepEqual(Object.keys(admitSchemaPayload.schemas.task_lifecycle_admit_evidence.payload_ref_shape), ['self_certification']);
  assert.match(admitSchemaPayload.schemas.task_lifecycle_admit_evidence.note, /lifecycle store/);

  const toolsListResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1011,
    method: 'tools/list',
    params: {},
  }, builderRuntime);
  const reviewTool = toolsListResponse.result.tools.find((tool: any) => tool.name === 'task_lifecycle_review');
  assert.equal(reviewTool.inputSchema.properties.findings.type, 'array');
  assert.equal(reviewTool.inputSchema.properties.findings.items.type, 'object');
  assert.match(reviewTool.inputSchema.properties.findings.description, /finding objects/);
  const blockedReportTool = toolsListResponse.result.tools.find((tool: any) => tool.name === 'task_lifecycle_report_blocked');
  assert.equal(blockedReportTool.inputSchema.required.includes('reason'), true);
  assert.match(blockedReportTool.description, /without implying finish/);
  assert.match(blockedReportTool.inputSchema.properties.next_action.description, /200 chars/);
  assert.match(blockedReportTool.inputSchema.properties.payload_ref.description, /long reason/);

  const blockedReportResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1014,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_report_blocked',
      arguments: {
        task_number: 9205,
        agent_id: 'smart-scheduling.builder',
        reason: 'Blocked on operator approval for external credential rotation.',
        blockers: [{ kind: 'operator_decision_required', question: 'Approve credential rotation window.' }],
        next_action: 'Operator selects the credential rotation window.',
      },
    },
  }, builderRuntime);
  const blockedReportPayload = await responsePayload(blockedReportResponse, builderRuntime, 1015);
  assert.equal(blockedReportPayload.status, 'blocked_reported');
  assert.equal(blockedReportPayload.report_status, 'blocked');
  assert.equal(blockedReportPayload.lifecycle_status, 'deferred');
  assert.equal(blockedReportPayload.blockers.length, 1);

  const longBlockedPayloadResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1018,
    method: 'tools/call',
    params: {
      name: 'mcp_payload_create',
      arguments: {
        payload: {
          reason: 'Blocked on an external approval.',
          blockers: [{ kind: 'operator_decision_required', detail: 'A deliberately detailed blocker packet belongs in payload_ref.' }],
          next_action: 'Operator reviews the proposed external approval window, confirms the exact acceptable time, records the decision in the task thread, and then the assigned agent resumes the deferred work with the decision as explicit authority.',
        },
      },
    },
  }, builderRuntime);
  const longBlockedPayload = await responsePayload(longBlockedPayloadResponse, builderRuntime, 1019);
  assert.equal(longBlockedPayload.status, 'created');
  const longBlockedReportResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1020,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_report_blocked',
      arguments: {
        task_number: 9206,
        agent_id: 'smart-scheduling.builder',
        payload_ref: longBlockedPayload.ref,
      },
    },
  }, builderRuntime);
  const longBlockedReportPayload = await responsePayload(longBlockedReportResponse, builderRuntime, 1021);
  assert.equal(longBlockedReportPayload.status, 'blocked_reported');
  assert.match(longBlockedReportPayload.next_action, /records the decision/);

  const blockedInspectResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1016,
    method: 'tools/call',
    params: { name: 'task_lifecycle_inspect', arguments: { task_number: 9205 } },
  }, builderRuntime);
  const blockedInspectPayload = await responsePayload(blockedInspectResponse, builderRuntime, 1017);
  assert.equal(blockedInspectPayload.lifecycle.status, 'deferred');
  assert.equal(blockedInspectPayload.blocked_work_posture.state, 'blocked_reported');
  assert.equal(blockedInspectPayload.blocked_work_posture.report_id, blockedReportPayload.report_id);
  assert.equal(blockedInspectPayload.evidence_preflight.blocked_work_posture.state, 'blocked_reported');
  assert.match(blockedInspectPayload.evidence_preflight.next_action, /Blocked report is recorded/);

  const unDeferBlockedResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1018,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_un_defer',
      arguments: {
        task_number: 9205,
        agent_id: 'smart-scheduling.builder',
        reason: 'Operator supplied the missing decision; continue with completion evidence.',
      },
    },
  }, builderRuntime);
  const unDeferBlockedPayload = await responsePayload(unDeferBlockedResponse, builderRuntime, 1019);
  assert.equal(unDeferBlockedPayload.status, 'un_deferred');

  const freshCompletionAfterBlockedResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1020,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9205,
        agent_id: 'smart-scheduling.builder',
        summary: 'Fresh completion evidence after the stale blocker was resolved.',
        changed_files: ['src/resolved-blocker.ts'],
      },
    },
  }, builderRuntime);
  const freshCompletionAfterBlockedPayload = await responsePayload(freshCompletionAfterBlockedResponse, builderRuntime, 1021);
  assert.equal(freshCompletionAfterBlockedPayload.status, 'success');

  const supersedingReport = {
    report_id: 'report-blocked-superseding-completion',
    task_number: 9205,
    task_id: blockedTaskId,
    agent_id: 'smart-scheduling.builder',
    assignment_id: 'assign-blocked-claimed-work',
    directive_id: null,
    reported_at: '2026-06-04T04:00:00Z',
    summary: 'Fresh completion evidence after the stale blocker was resolved.',
    changed_files: ['src/resolved-blocker.ts'],
    verification: [{ command: 'focused regression', result: 'passed' }],
    known_residuals: [],
    ready_for_review: true,
    report_status: 'accepted',
  };
  const supersessionStore = openTaskLifecycleStore(siteRoot);
  try {
    supersessionStore.upsertReportRecord({
      report_id: supersedingReport.report_id,
      task_id: blockedTaskId,
      assignment_id: supersedingReport.assignment_id,
      agent_id: supersedingReport.agent_id,
      reported_at: supersedingReport.reported_at,
      report_json: JSON.stringify(supersedingReport),
    });
  } finally {
    supersessionStore.db.close();
  }

  const supersededBlockedInspectResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1022,
    method: 'tools/call',
    params: { name: 'task_lifecycle_inspect', arguments: { task_number: 9205 } },
  }, builderRuntime);
  const supersededBlockedInspectPayload = await responsePayload(supersededBlockedInspectResponse, builderRuntime, 1023);
  assert.equal(supersededBlockedInspectPayload.evidence_preflight.blocked_work_posture.state, 'stale_blocked_report_superseded');
  assert.equal(supersededBlockedInspectPayload.evidence_preflight.blocked_work_posture.report_id, blockedReportPayload.report_id);
  assert.equal(supersededBlockedInspectPayload.evidence_preflight.blocked_work_posture.superseded_by.evidence.changed_files_count, 1);
  assert.equal(supersededBlockedInspectPayload.evidence_preflight.requirements.find((item: any) => item.id === 'changed_files').observed.blocked_report_present, false);
  assert.doesNotMatch(supersededBlockedInspectPayload.evidence_preflight.next_action, /Blocked report is recorded/);

  const invalidFindingsResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 103,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_review',
      arguments: {
        task_number: 9201,
        agent_id: 'smart-scheduling.architect',
        verdict: 'accepted_with_notes',
        findings: ['not an object'],
      },
    },
  }, architectRuntime);
  const invalidFindingsPayload = await responsePayload(invalidFindingsResponse, architectRuntime, 104);
  assert.equal(invalidFindingsPayload.status, 'error');
  assert.equal(invalidFindingsPayload.validation_errors[0].field, 'findings[0]');
  assert.match(invalidFindingsPayload.accepted_payload_shapes[0].rule, /array of finding objects/);

  // 6. Role-target claim failures include MCP-native remediation paths.
  const roleMismatchClaimResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_claim',
      arguments: { task_number: 9202, agent_id: 'smart-scheduling.builder' },
    },
  }, builderRuntime);
  const roleMismatchClaimPayload = await responsePayload(roleMismatchClaimResponse, builderRuntime, 106);
  assert.equal(roleMismatchClaimPayload.status, 'role_mismatch');
  assert.equal(roleMismatchClaimPayload.remediation.roster_admit.tool, 'task_lifecycle_roster_admit');
  assert.equal(roleMismatchClaimPayload.remediation.reroute.tool, 'task_lifecycle_set_routing');
  assert.equal(roleMismatchClaimPayload.remediation.claim_with_authority.required_authority_basis.kind, 'operator_direct_instruction');

  const qaTargetWithAuthorityResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1051,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_claim',
      arguments: {
        task_number: 9202,
        agent_id: 'mcp-surfaces.codex',
        authority_basis: { kind: 'operator_direct_instruction', summary: 'Operator asked this repo-specific engineer to try claiming QA work.' },
      },
    },
  }, surfaceEngineerRuntime);
  const qaTargetWithAuthorityPayload = await responsePayload(qaTargetWithAuthorityResponse, surfaceEngineerRuntime, 1052);
  assert.equal(qaTargetWithAuthorityPayload.status, 'role_mismatch');

  const genericEngineerWithoutAuthorityResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1053,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_claim',
      arguments: { task_number: 9207, agent_id: 'mcp-surfaces.codex' },
    },
  }, surfaceEngineerRuntime);
  const genericEngineerWithoutAuthorityPayload = await responsePayload(genericEngineerWithoutAuthorityResponse, surfaceEngineerRuntime, 1054);
  assert.equal(genericEngineerWithoutAuthorityPayload.status, 'role_mismatch');
  assert.equal(genericEngineerWithoutAuthorityPayload.remediation.claim_with_authority.example_args.agent_id, 'mcp-surfaces.codex');

  const genericEngineerWithAuthorityResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1055,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_claim',
      arguments: {
        task_number: 9207,
        agent_id: 'mcp-surfaces.codex',
        authority_basis: { kind: 'operator_direct_instruction', summary: 'Operator instructed this repo-specific engineer to do generic engineer work.' },
      },
    },
  }, surfaceEngineerRuntime);
  const genericEngineerWithAuthorityPayload = await responsePayload(genericEngineerWithAuthorityResponse, surfaceEngineerRuntime, 1056);
  assert.equal(genericEngineerWithAuthorityPayload.status, 'claimed');
  assert.equal(genericEngineerWithAuthorityPayload.role_claim_warning.kind, 'generic_engineer_role_claim');
  assert.equal(genericEngineerWithAuthorityPayload.role_mismatch_authority.kind, 'operator_direct_instruction');
  assert.equal(genericEngineerWithAuthorityPayload.role_mismatch_authority.target_role, 'engineer');
  assert.equal(genericEngineerWithAuthorityPayload.role_mismatch_authority.agent_role, 'mcp-surfaces-engineer');

  // 7. run_tests reports configured Test MCP paths instead of surfacing MODULE_NOT_FOUND.
  const runTestsResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 107,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_run_tests',
      arguments: { selector: 'task-lifecycle', agent_id: 'smart-scheduling.builder' },
    },
  }, builderRuntime);
  const runTestsPayload = await responsePayload(runTestsResponse, builderRuntime, 108);
  assert.equal(runTestsPayload.status, 'failed');
  assert.equal(runTestsPayload.error, 'test_mcp_server_not_found');
  assert.match(runTestsPayload.configured_test_server_path, /tools[\\/]mcp-servers[\\/]test[\\/]test-mcp-server\.js/);
  assert.match(runTestsPayload.remediation, /structured-command/);

  // 8. Reopened tasks ignore pre-reopen reports/reviews and create a fresh review epoch.
  const reopenedFinishResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 120,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9204,
        agent_id: 'smart-scheduling.builder',
        summary: 'Fresh post-reopen implementation report.',
        changed_files: ['src/fresh.ts'],
        reviewer: 'smart-scheduling.architect',
      },
    },
  }, builderRuntime);
  const reopenedFinishPayload = await responsePayload(reopenedFinishResponse, builderRuntime, 121);
  assert.equal(reopenedFinishPayload.status, 'success');
  assert.equal(reopenedFinishPayload.completion_mode, 'report');
  assert.equal(reopenedFinishPayload.report_action, 'submitted');
  assert.notEqual(reopenedFinishPayload.report_id, 'report-reopened-stale-pre-reopen');
  assert.equal(reopenedFinishPayload.review_action, 'skipped');
  assert.equal(reopenedFinishPayload.close_action, 'skipped');
  assert.equal(reopenedFinishPayload.new_status, 'in_review');

  const reopenedReviewResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 122,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_review',
      arguments: {
        task_number: 9204,
        agent_id: 'smart-scheduling.architect',
        verdict: 'accepted',
        auto_accept_single_operator: true,
      },
    },
  }, architectRuntime);
  const reopenedReviewPayload = await responsePayload(reopenedReviewResponse, architectRuntime, 123);
  assert.equal(reopenedReviewPayload.status, 'success');
  assert.notEqual(reopenedReviewPayload.review_id, 'review-reopened-stale-pre-reopen');
  assert.equal(reopenedReviewPayload.lifecycle_status, 'closed');

  // 9. Chapter membership add defaults to append and preserves explicit insertion order.
  const chapterAppendResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 109,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_chapter_add_task',
      arguments: { chapter_id: 'launch-plan', task_number: 9201, actor_agent_id: 'smart-scheduling.builder' },
    },
  }, builderRuntime);
  const chapterAppendPayload = await responsePayload(chapterAppendResponse, builderRuntime, 110);
  assert.equal(chapterAppendPayload.status, 'added');
  assert.equal(chapterAppendPayload.order_index, 1);
  assert.equal(chapterAppendPayload.append_mode, true);

  const chapterAppendSecondResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 111,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_chapter_add_task',
      arguments: { chapter_id: 'launch-plan', task_number: 9202, actor_agent_id: 'smart-scheduling.builder' },
    },
  }, builderRuntime);
  const chapterAppendSecondPayload = await responsePayload(chapterAppendSecondResponse, builderRuntime, 112);
  assert.equal(chapterAppendSecondPayload.status, 'added');
  assert.equal(chapterAppendSecondPayload.order_index, 2);

  const chapterInsertResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 113,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_chapter_add_task',
      arguments: { chapter_id: 'launch-plan', task_number: 9203, order_index: 2, append: false, actor_agent_id: 'smart-scheduling.builder' },
    },
  }, builderRuntime);
  const chapterInsertPayload = await responsePayload(chapterInsertResponse, builderRuntime, 114);
  assert.equal(chapterInsertPayload.status, 'added');
  assert.equal(chapterInsertPayload.append_mode, false);
  assert.deepEqual(chapterInsertPayload.memberships.map((item: Record<string, unknown>) => item.task_number), [9201, 9203, 9202]);
  assert.deepEqual(chapterInsertPayload.memberships.map((item: Record<string, unknown>) => item.order_index), [1, 2, 3]);

  const chapterDuplicateResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 115,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_chapter_add_task',
      arguments: { chapter_id: 'launch-plan', task_number: 9203, actor_agent_id: 'smart-scheduling.builder' },
    },
  }, builderRuntime);
  const chapterDuplicatePayload = await responsePayload(chapterDuplicateResponse, builderRuntime, 116);
  assert.equal(chapterDuplicatePayload.status, 'already_present');
  assert.equal(chapterDuplicatePayload.membership_count, 3);

  const chapterShowResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 117,
    method: 'tools/call',
    params: { name: 'task_lifecycle_chapter_show', arguments: { chapter_id: 'launch-plan' } },
  }, builderRuntime);
  const chapterShowPayload = await responsePayload(chapterShowResponse, builderRuntime, 118);
  assert.deepEqual(chapterShowPayload.memberships.map((item: Record<string, unknown>) => item.task_number), [9201, 9203, 9202]);

  const inspectRangeResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 119,
    method: 'tools/call',
    params: { name: 'task_lifecycle_inspect_range', arguments: { start_task_number: 9201, end_task_number: 9204 } },
  }, builderRuntime);
  const inspectRangePayload = await responsePayload(inspectRangeResponse, builderRuntime, 120);
  assert.equal(inspectRangePayload.schema, 'narada.task.mcp.inspect_range.v0');
  assert.equal(inspectRangePayload.read_only, true);
  assert.deepEqual(inspectRangePayload.tasks.map((task: Record<string, unknown>) => task.task_number), [9201, 9202, 9203, 9204]);
  assert.equal(inspectRangePayload.tasks.find((task: Record<string, unknown>) => task.task_number === 9201).closure_evidence_posture.state, 'closed_current_authority_consistent');
  const inspectChapterResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 121,
    method: 'tools/call',
    params: { name: 'task_lifecycle_inspect_range', arguments: { chapter_id: 'launch-plan' } },
  }, builderRuntime);
  const inspectChapterPayload = await responsePayload(inspectChapterResponse, builderRuntime, 122);
  assert.deepEqual(inspectChapterPayload.tasks.map((task: Record<string, unknown>) => task.task_number), [9201, 9203, 9202]);
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
  assert.equal(payloadCreatePayload.status, 'created');

  const emptyPayloadCreateResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 201,
    method: 'tools/call',
    params: {
      name: 'mcp_payload_create',
      arguments: {
        payload: {},
        allow_empty: true,
      },
    },
  }, scopedRuntime);
  assert.equal(emptyPayloadCreateResponse.error?.message, 'task_lifecycle_payload_create_empty_payload_rejected: payload object must include at least one field');

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

  const createPayloadResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 210,
    method: 'tools/call',
    params: {
      name: 'mcp_payload_create',
      arguments: {
        payload: {
          title: 'Payload-ref create normalization',
          goal: 'Exercise list-like create payload fields.',
          required_work: ['Inspect the payload.', 'Create the task.'],
          non_goals: ['Do not loosen routing validation.'],
          acceptance_criteria: ['Task is created with normalized markdown fields.'],
          target_role: 'builder',
        },
      },
    },
  }, scopedRuntime);
  const createPayload = await responsePayload(createPayloadResponse, scopedRuntime, 211);
  assert.equal(createPayload.status, 'created');
  const createResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 212,
    method: 'tools/call',
    params: { name: 'task_lifecycle_create', arguments: { payload_ref: createPayload.ref } },
  }, scopedRuntime);
  const createdTask = await responsePayload(createResponse, scopedRuntime, 213);
  assert.equal(createdTask.status, 'created');
  const createdShowResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 214,
    method: 'tools/call',
    params: { name: 'task_lifecycle_show', arguments: { task_number: createdTask.task_number } },
  }, scopedRuntime);
  const createdShow = await responsePayload(createdShowResponse, scopedRuntime, 215);
  assert.equal(createdShow.spec.required_work_markdown, 'Inspect the payload.\nCreate the task.');
  assert.equal(createdShow.spec.non_goals_markdown, 'Do not loosen routing validation.');

  const closeoutPayloadResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 216,
    method: 'tools/call',
    params: {
      name: 'mcp_payload_create',
      arguments: {
        payload: {
          summary: 'This closeout summary is intentionally long enough to exceed the inline ergonomics threshold while remaining semantically ordinary task execution prose, so it should travel through payload_ref instead of being rejected by inline payload governance.',
          no_files_changed: true,
          dry_run: true,
        },
      },
    },
  }, scopedRuntime);
  const closeoutPayload = await responsePayload(closeoutPayloadResponse, scopedRuntime, 217);
  assert.equal(closeoutPayload.status, 'created');
  const closeoutResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 218,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_closeout',
      arguments: { task_number: 9303, agent_id: 'scoped.builder', payload_ref: closeoutPayload.ref },
    },
  }, scopedRuntime);
  const closeoutPayloadResult = await responsePayload(closeoutResponse, scopedRuntime, 219);
  assert.equal(closeoutPayloadResult.status, 'dry_run');
  assert.equal(closeoutPayloadResult.task_number, 9303);

  const observationResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 230,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_submit_observation',
      arguments: {
        task_number: 9303,
        agent_id: 'scoped.builder',
        artifact_uri: 'artifact://task-9303/observation',
        content: { note: 'Observation readback regression' },
      },
    },
  }, scopedRuntime);
  const observationPayload = await responsePayload(observationResponse, scopedRuntime, 231);
  assert.equal(observationPayload.status, 'submitted');
  const observationShowResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 232,
    method: 'tools/call',
    params: { name: 'task_lifecycle_show', arguments: { task_number: 9303 } },
  }, scopedRuntime);
  const observationShowPayload = await responsePayload(observationShowResponse, scopedRuntime, 233);
  assert.equal(observationShowPayload.observations.length, 1);
  assert.equal(observationShowPayload.observations[0].artifact_uri, 'artifact://task-9303/observation');
  const observationInspectResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 234,
    method: 'tools/call',
    params: { name: 'task_lifecycle_inspect', arguments: { task_number: 9303 } },
  }, scopedRuntime);
  const observationInspectPayload = await responsePayload(observationInspectResponse, scopedRuntime, 235);
  assert.equal(observationInspectPayload.observation_artifact_count, 1);
  assert.equal(observationInspectPayload.observations[0].artifact_uri, 'artifact://task-9303/observation');
  const observationAuditResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 236,
    method: 'tools/call',
    params: { name: 'task_lifecycle_audit', arguments: {} },
  }, scopedRuntime);
  const observationAuditPayload = await responsePayload(observationAuditResponse, scopedRuntime, 237);
  assert.ok(observationAuditPayload.events.some((event: Record<string, unknown>) => event.event_type === 'observation' && event.task === '9303'));

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
