import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
        {
          agent_id: 'smart-scheduling.same-builder',
          role: 'builder',
          capabilities: ['implementation_work'],
          operator_identity: 'same-operator',
          first_seen_at: '2026-06-04T00:00:00Z',
          last_active_at: '2026-06-04T00:00:00Z',
        },
        {
          agent_id: 'smart-scheduling.same-architect',
          role: 'architect',
          capabilities: [],
          operator_identity: 'same-operator',
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
  mkdirSync(join(siteRoot, '.narada'), { recursive: true });
  writeFileSync(join(siteRoot, '.narada', 'task-lifecycle.toml'), '[roster]\nroles_are_obligation_targets = true\n', 'utf8');
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
  const submitWorkTaskId = '20260604-9208-submit-work-helper';
  writeTask(9208, submitWorkTaskId, 'opened');
  const payloadSubmitWorkTaskId = '20260604-9219-submit-work-payload-helper';
  writeTask(9219, payloadSubmitWorkTaskId, 'opened');
  const autoPayloadSubmitWorkTaskId = '20260604-9220-submit-work-auto-payload-helper';
  writeTask(9220, autoPayloadSubmitWorkTaskId, 'opened');
  const inlineSubmitWorkTaskId = '20260604-9225-submit-work-inline-threshold-helper';
  writeTask(9225, inlineSubmitWorkTaskId, 'opened');
  const nonRosterSubmitWorkTaskId = '20260604-9226-submit-work-non-roster-helper';
  writeTask(9226, nonRosterSubmitWorkTaskId, 'opened');
  const placeholderPayloadSubmitWorkTaskId = '20260604-9227-submit-work-placeholder-payload-helper';
  writeTask(9227, placeholderPayloadSubmitWorkTaskId, 'opened');
  const recoveryTruthfulnessFinishTaskId = '20260604-9228-recovery-truthfulness-inline-helper';
  writeTask(9228, recoveryTruthfulnessFinishTaskId, 'claimed');
  const outcomeContractTaskId = '20260604-9209-outcome-contract-finish';
  writeTask(9209, outcomeContractTaskId, 'claimed');
  const staleSearchTaskId = '20260604-9210-stale-search-only-projection';
  writeTask(9210, staleSearchTaskId, 'in_review');
  const advisoryReviewTaskId = '20260604-9211-advisory-review-policy';
  writeTask(9211, advisoryReviewTaskId, 'in_review');
  const disabledReviewTaskId = '20260604-9212-disabled-review-policy';
  writeTask(9212, disabledReviewTaskId, 'in_review');
  const legacyFinishOnlyReviewTaskId = '20260604-9224-legacy-finish-only-review';
  writeTask(9224, legacyFinishOnlyReviewTaskId, 'in_review');
  const blockingDependencyParentTaskId = '20260604-9213-blocking-dependency-parent';
  writeTask(9213, blockingDependencyParentTaskId, 'in_review');
  const blockingDependencyReviewTaskId = '20260604-9214-blocking-dependency-review';
  writeTask(9214, blockingDependencyReviewTaskId, 'claimed', 'outcome_type: review\ntarget_role: architect');
  const conflictDependencyParentTaskId = '20260604-9215-conflict-dependency-parent';
  writeTask(9215, conflictDependencyParentTaskId, 'in_review');
  const conflictDependencyReviewTaskId = '20260604-9216-conflict-dependency-review';
  writeTask(9216, conflictDependencyReviewTaskId, 'claimed', 'outcome_type: review\ntarget_role: architect');
  const declaredDependencyParentTaskId = '20260604-9217-declared-dependency-parent';
  writeTask(9217, declaredDependencyParentTaskId, 'opened');
  const declaredDependencyRequiredTaskId = '20260604-9218-declared-verification-required';
  writeTask(9218, declaredDependencyRequiredTaskId, 'claimed', 'outcome_type: verification\ntarget_role: builder');

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
      agent_id: 'smart-scheduling.same-builder',
      role: 'builder',
      capabilities_json: JSON.stringify(['implementation_work']),
      operator_identity: 'same-operator',
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'active',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.upsertRosterEntry({
      agent_id: 'smart-scheduling.same-architect',
      role: 'architect',
      capabilities_json: JSON.stringify([]),
      operator_identity: 'same-operator',
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'active',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.upsertLifecycle({
      task_id: outcomeContractTaskId,
      task_number: 9209,
      status: 'claimed',
      governed_by: 'architect',
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.insertAssignment({
      assignment_id: 'assign-outcome-contract-finish',
      task_id: outcomeContractTaskId,
      agent_id: 'smart-scheduling.architect',
      claimed_at: '2026-06-04T00:01:00Z',
      released_at: null,
      release_reason: null,
      intent: 'review',
    });
    store.upsertTaskOutcomeContract({
      contract_id: 'contract-outcome-review-9209',
      task_id: outcomeContractTaskId,
      outcome_type: 'review',
      allowed_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes', 'rejected']),
      satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
      blocking_outcomes_json: JSON.stringify(['rejected']),
      required_fields_json: JSON.stringify(['summary']),
      capability_requirement: 'review',
      created_by: 'test',
      created_at: '2026-06-04T00:00:00Z',
    });
    store.upsertLifecycle({
      task_id: declaredDependencyParentTaskId,
      task_number: 9217,
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
      task_id: declaredDependencyRequiredTaskId,
      task_number: 9218,
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
    for (const [taskId, taskNumber] of [[advisoryReviewTaskId, 9211], [disabledReviewTaskId, 9212], [legacyFinishOnlyReviewTaskId, 9224]] as const) {
      store.upsertLifecycle({
        task_id: taskId,
        task_number: taskNumber,
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
    }
    store.upsertLifecycle({
      task_id: blockingDependencyParentTaskId,
      task_number: 9213,
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
      task_id: blockingDependencyReviewTaskId,
      task_number: 9214,
      status: 'claimed',
      governed_by: 'architect',
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.insertAssignment({
      assignment_id: 'assign-blocking-dependency-review',
      task_id: blockingDependencyReviewTaskId,
      agent_id: 'smart-scheduling.architect',
      claimed_at: '2026-06-04T00:01:00Z',
      released_at: null,
      release_reason: null,
      intent: 'review',
    });
    store.upsertTaskDependency({
      dependency_id: 'dep-blocking-review-9213-9214',
      parent_task_id: blockingDependencyParentTaskId,
      required_task_id: blockingDependencyReviewTaskId,
      kind: 'review',
      satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
      status: 'open',
      created_by: 'test',
      created_at: '2026-06-04T00:00:00Z',
    });
    store.upsertTaskOutcomeContract({
      contract_id: 'contract-blocking-review-9214',
      task_id: blockingDependencyReviewTaskId,
      outcome_type: 'review',
      allowed_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes', 'rejected']),
      satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
      blocking_outcomes_json: JSON.stringify(['rejected']),
      required_fields_json: JSON.stringify(['summary']),
      capability_requirement: 'review',
      created_by: 'test',
      created_at: '2026-06-04T00:00:00Z',
    });
    store.upsertLifecycle({
      task_id: conflictDependencyParentTaskId,
      task_number: 9215,
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
    store.insertReport({
      report_id: 'report-conflict-parent-9215',
      task_id: conflictDependencyParentTaskId,
      agent_id: 'smart-scheduling.same-builder',
      summary: 'Parent work was finished by an agent sharing operator identity with the dependency completer.',
      changed_files_json: JSON.stringify(['src/conflict-parent.ts']),
      verification_json: JSON.stringify(['fixture report']),
      submitted_at: '2026-06-04T00:02:00Z',
    });
    store.upsertLifecycle({
      task_id: conflictDependencyReviewTaskId,
      task_number: 9216,
      status: 'claimed',
      governed_by: 'architect',
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
    store.insertAssignment({
      assignment_id: 'assign-conflict-dependency-review',
      task_id: conflictDependencyReviewTaskId,
      agent_id: 'smart-scheduling.same-architect',
      claimed_at: '2026-06-04T00:03:00Z',
      released_at: null,
      release_reason: null,
      intent: 'review',
    });
    store.upsertTaskDependency({
      dependency_id: 'dep-conflict-review-9215-9216',
      parent_task_id: conflictDependencyParentTaskId,
      required_task_id: conflictDependencyReviewTaskId,
      kind: 'review',
      satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
      status: 'open',
      created_by: 'test',
      created_at: '2026-06-04T00:00:00Z',
    });
    store.upsertTaskOutcomeContract({
      contract_id: 'contract-conflict-review-9216',
      task_id: conflictDependencyReviewTaskId,
      outcome_type: 'review',
      allowed_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes', 'rejected']),
      satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
      blocking_outcomes_json: JSON.stringify(['rejected']),
      required_fields_json: JSON.stringify(['summary']),
      capability_requirement: 'review',
      created_by: 'test',
      created_at: '2026-06-04T00:00:00Z',
    });
    store.upsertLifecycle({
      task_id: submitWorkTaskId,
      task_number: 9208,
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
      task_id: payloadSubmitWorkTaskId,
      task_number: 9219,
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
      task_id: autoPayloadSubmitWorkTaskId,
      task_number: 9220,
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
    for (const [taskId, taskNumber, status, governedBy] of [
      [inlineSubmitWorkTaskId, 9225, 'opened', null],
      [nonRosterSubmitWorkTaskId, 9226, 'opened', null],
      [placeholderPayloadSubmitWorkTaskId, 9227, 'opened', null],
      [recoveryTruthfulnessFinishTaskId, 9228, 'claimed', 'builder'],
    ] as const) {
      store.upsertLifecycle({
        task_id: taskId,
        task_number: taskNumber,
        status,
        governed_by: governedBy,
        closed_at: null,
        closed_by: null,
        closure_mode: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-06-04T00:00:00Z',
      });
    }
    store.insertAssignment({
      assignment_id: 'assign-recovery-truthfulness-finish',
      task_id: recoveryTruthfulnessFinishTaskId,
      agent_id: 'smart-scheduling.builder',
      claimed_at: '2026-06-04T00:01:00Z',
      released_at: null,
      release_reason: null,
      intent: 'primary',
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

  const sameArchitectRuntime = {
    argv: ['--site-root', siteRoot],
    cwd: siteRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'smart-scheduling.same-architect' },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };

  const policyDoctorResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 4200,
    method: 'tools/call',
    params: { name: 'task_lifecycle_doctor', arguments: {} },
  }, builderRuntime);
  const policyDoctorPayload = await responsePayload(policyDoctorResponse, builderRuntime, 4201);
  assert.equal(policyDoctorPayload.schema, 'narada.task_lifecycle.doctor.v1');
  assert.equal(policyDoctorPayload.detail, 'summary');
  assert.equal(policyDoctorPayload.site_policy.source, 'site_config');
  assert.equal(policyDoctorPayload.site_policy.roster.roles_are_obligation_targets, true);
  assert.equal(policyDoctorPayload.canonical_tools, undefined);
  assert.equal(policyDoctorPayload.allowed_tools, undefined);
  assert.equal(policyDoctorPayload.tool_posture.canonical_count > 0, true);
  assert.equal(JSON.stringify(policyDoctorPayload).length < 2000, true);

  const fullPolicyDoctorResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 4201,
    method: 'tools/call',
    params: { name: 'task_lifecycle_doctor', arguments: { detail: 'full' } },
  }, builderRuntime);
  const fullPolicyDoctorPayload = await responsePayload(fullPolicyDoctorResponse, builderRuntime, 4201);
  assert.equal(fullPolicyDoctorPayload.detail, 'full');
  assert.equal(Array.isArray(fullPolicyDoctorPayload.canonical_tools), true);
  assert.equal(fullPolicyDoctorPayload.site_policy.path.endsWith('task-lifecycle.toml'), true);

  const defaultPolicyRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-role-policy-default-'));
  mkdirSync(join(defaultPolicyRoot, '.ai', 'agents'), { recursive: true });
  mkdirSync(join(defaultPolicyRoot, '.ai', 'do-not-open', 'tasks'), { recursive: true });
  writeFileSync(join(defaultPolicyRoot, '.ai', 'agents', 'roster.json'), JSON.stringify({
    version: 1,
    agents: [
      { agent_id: 'policy.builder', role: 'builder', capabilities: ['implementation_work'] },
      { agent_id: 'policy.architect', role: 'architect', capabilities: ['review'] },
    ],
  }), 'utf8');
  const defaultPolicyRuntime = {
    argv: ['--site-root', defaultPolicyRoot],
    cwd: defaultPolicyRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'policy.architect' },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };
  const defaultPolicyDoctorResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 4202,
    method: 'tools/call',
    params: { name: 'task_lifecycle_doctor', arguments: {} },
  }, defaultPolicyRuntime);
  const defaultPolicyDoctorPayload = await responsePayload(defaultPolicyDoctorResponse, defaultPolicyRuntime, 4203);
  assert.equal(defaultPolicyDoctorPayload.site_policy.source, 'default');
  assert.equal(defaultPolicyDoctorPayload.site_policy.roster.roles_are_obligation_targets, false);

  const blockedCreatePayloadResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 4204,
    method: 'tools/call',
    params: { name: 'mcp_payload_create', arguments: { payload: { title: 'Blocked role target', required_work: 'Inspect policy.', acceptance_criteria: ['Blocked.'], target_role: 'builder' } } },
  }, defaultPolicyRuntime);
  const blockedCreatePayload = await responsePayload(blockedCreatePayloadResponse, defaultPolicyRuntime, 4205);
  const blockedCreateResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 4206,
    method: 'tools/call',
    params: { name: 'task_lifecycle_create', arguments: { payload_ref: blockedCreatePayload.ref } },
  }, defaultPolicyRuntime);
  const blockedCreate = await responsePayload(blockedCreateResponse, defaultPolicyRuntime, 4207);
  assert.equal(blockedCreate.status, 'blocked');
  assert.equal(blockedCreate.reason, 'roles_are_obligation_targets_false');

  const unroleCreatePayloadResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 4208,
    method: 'tools/call',
    params: { name: 'mcp_payload_create', arguments: { payload: { title: 'Unrole routed task', required_work: 'Inspect policy.', acceptance_criteria: ['Created.'] } } },
  }, defaultPolicyRuntime);
  const unroleCreatePayload = await responsePayload(unroleCreatePayloadResponse, defaultPolicyRuntime, 4209);
  const unroleCreateResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 4210,
    method: 'tools/call',
    params: { name: 'task_lifecycle_create', arguments: { payload_ref: unroleCreatePayload.ref } },
  }, defaultPolicyRuntime);
  const unroleCreate = await responsePayload(unroleCreateResponse, defaultPolicyRuntime, 4211);
  assert.equal(unroleCreate.status, 'created');

  const blockedRoutingResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 4212,
    method: 'tools/call',
    params: { name: 'task_lifecycle_set_routing', arguments: { task_number: unroleCreate.task_number, actor_agent_id: 'policy.architect', target_role: 'builder', reason: 'default policy blocks role targeting' } },
  }, defaultPolicyRuntime);
  const blockedRouting = await responsePayload(blockedRoutingResponse, defaultPolicyRuntime, 4213);
  assert.equal(blockedRouting.status, 'blocked');
  assert.equal(blockedRouting.reason, 'roles_are_obligation_targets_false');

  const clearRoutingResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 4214,
    method: 'tools/call',
    params: { name: 'task_lifecycle_set_routing', arguments: { task_number: unroleCreate.task_number, actor_agent_id: 'policy.architect', target_role: null, relative_priority: 5, reason: 'clearing role targeting is allowed' } },
  }, defaultPolicyRuntime);
  const clearRouting = await responsePayload(clearRoutingResponse, defaultPolicyRuntime, 4215);
  assert.equal(clearRouting.status, 'routed');
  assert.equal(clearRouting.routing.target_role, null);

  const driftSiteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-roster-drift-'));
  mkdirSync(join(driftSiteRoot, '.ai', 'agents'), { recursive: true });
  mkdirSync(join(driftSiteRoot, '.ai', 'do-not-open', 'tasks'), { recursive: true });
  const driftStore = openTaskLifecycleStore(driftSiteRoot);
  try {
    driftStore.db.prepare('ALTER TABLE agent_roster DROP COLUMN operator_identity').run();
  } finally {
    driftStore.db.close();
  }
  const driftRuntime = {
    argv: ['--site-root', driftSiteRoot],
    cwd: driftSiteRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'legacy-site.builder' },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };
  const driftRosterAdmitResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 650,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_roster_admit',
      arguments: {
        agent_id: 'legacy-site.builder',
        role: 'builder',
        actor_agent_id: 'legacy-site.builder',
        capabilities: ['implementation_work'],
        operator_identity: 'same-operator',
        authority_basis: { kind: 'operator_direct_instruction', summary: 'Verify old roster schema admission remains compatible.' },
      },
    },
  }, driftRuntime);
  const driftRosterAdmitPayload = await responsePayload(driftRosterAdmitResponse, driftRuntime, 651);
  assert.equal(driftRosterAdmitPayload.status, 'admitted');
  assert.equal(driftRosterAdmitPayload.agent_id, 'legacy-site.builder');
  const driftVerifyStore = openTaskLifecycleStore(driftSiteRoot);
  try {
    const driftColumns = driftVerifyStore.db.prepare('PRAGMA table_info(agent_roster)').all().map((column: any) => column.name);
    const driftRow = driftVerifyStore.db.prepare('SELECT agent_id, role, capabilities_json FROM agent_roster WHERE agent_id = ?').get('legacy-site.builder') as any;
    assert.equal(driftColumns.includes('operator_identity'), false);
    assert.equal(driftRow.role, 'builder');
    assert.deepEqual(JSON.parse(driftRow.capabilities_json), ['implementation_work']);
  } finally {
    driftVerifyStore.db.close();
  }

  const surfaceEngineerRuntime = {
    argv: ['--site-root', siteRoot],
    cwd: siteRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'mcp-surfaces.codex' },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };

  const nonRosterRuntime = {
    argv: ['--site-root', siteRoot],
    cwd: siteRoot,
    env: { ...process.env, NARADA_AGENT_ID: 'narada-launcher.agent' },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };

  // 1. task_lifecycle_show uses generic dependency/outcome readback, not review-only eligible reviewer readback.
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
  assert.equal(Object.hasOwn(showPayload, 'eligible_reviewers'), false);
  assert.ok(Array.isArray(showPayload.dependencies_blocking_this_task));
  assert.ok(Array.isArray(showPayload.dependency_context));
  assert.equal(showPayload.dependency_satisfaction.all_satisfied, true);

  const staleSearchResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 20001,
    method: 'tools/call',
    params: { name: 'task_lifecycle_search', arguments: { query: 'stale-search-only-projection', limit: 5 } },
  }, builderRuntime);
  const staleSearchPayload = await responsePayload(staleSearchResponse, builderRuntime, 20002);
  assert.ok(staleSearchPayload.results.some((item: Record<string, any>) => item.task_number === 9210 && item.authority?.status === 'stale_projection'));
  const staleStatusSearchResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 20003,
    method: 'tools/call',
    params: { name: 'task_lifecycle_search', arguments: { query: 'stale-search-only-projection', status: 'in_review', limit: 5 } },
  }, builderRuntime);
  const staleStatusSearchPayload = await responsePayload(staleStatusSearchResponse, builderRuntime, 20004);
  assert.equal(staleStatusSearchPayload.count, 0);

  // 2. Reviewer capability enforcement defaults to advisory when no site policy is present.
  const advisoryReviewResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_review',
      arguments: {
        task_number: 9211,
        agent_id: 'smart-scheduling.builder',
        verdict: 'accepted',
      },
    },
  }, builderRuntime);
  const advisoryReviewPayload = await responsePayload(advisoryReviewResponse, builderRuntime, 4);
  assert.equal(advisoryReviewPayload.status, 'success', JSON.stringify(advisoryReviewPayload));
  assert.equal(advisoryReviewPayload.outcome_capability_policy.capability_requirement, 'review');
  assert.equal(advisoryReviewPayload.outcome_capability_policy.agent_has_capability, false);
  assert.equal(advisoryReviewPayload.outcome_capability_policy.enforcement_result, 'advisory_warning');
  assert.equal(advisoryReviewPayload.reviewer_capability_policy.mode, 'advisory');
  assert.equal(advisoryReviewPayload.reviewer_capability_policy.reviewer_has_capability, false);
  assert.equal(advisoryReviewPayload.reviewer_capability_policy.enforcement_result, 'advisory_warning');

  writeFileSync(join(siteRoot, '.ai', 'task-lifecycle-policy.json'), JSON.stringify({ reviewer_capability_enforcement: 'open' }), 'utf8');
  const disabledReviewResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 30001,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_review',
      arguments: {
        task_number: 9212,
        agent_id: 'smart-scheduling.builder',
        verdict: 'accepted',
      },
    },
  }, builderRuntime);
  const disabledReviewPayload = await responsePayload(disabledReviewResponse, builderRuntime, 30002);
  assert.equal(disabledReviewPayload.status, 'success');
  assert.equal(disabledReviewPayload.outcome_capability_policy.capability_requirement, 'review');
  assert.equal(disabledReviewPayload.outcome_capability_policy.enforcement_result, 'skipped_by_site_policy');
  assert.equal(disabledReviewPayload.reviewer_capability_policy.mode, 'disabled');
  assert.equal(disabledReviewPayload.reviewer_capability_policy.enforcement_result, 'skipped_by_site_policy');

  writeFileSync(join(siteRoot, '.ai', 'task-lifecycle-policy.json'), JSON.stringify({ reviewer_capability_enforcement: 'strict' }), 'utf8');
  const unauthorizedReviewResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 30003,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_review',
      arguments: {
        task_number: 9224,
        agent_id: 'smart-scheduling.builder',
        verdict: 'accepted',
      },
    },
  }, builderRuntime);
  const unauthorizedReviewPayload = await responsePayload(unauthorizedReviewResponse, builderRuntime, 30004);
  assert.equal(unauthorizedReviewPayload.status, 'error');
  assert.equal(unauthorizedReviewPayload.error, 'outcome_capability_not_admitted');
  assert.equal(unauthorizedReviewPayload.required_capability, 'review');
  assert.equal(unauthorizedReviewPayload.outcome_capability_policy.capability_requirement, 'review');
  assert.equal(unauthorizedReviewPayload.outcome_capability_policy.agent_has_capability, false);
  assert.equal(unauthorizedReviewPayload.outcome_capability_policy.enforcement_result, 'blocked');
  assert.equal(unauthorizedReviewPayload.reviewer_capability_policy.mode, 'strict');
  assert.equal(unauthorizedReviewPayload.reviewer_capability_policy.enforcement_result, 'blocked');
  assert.equal(Object.hasOwn(unauthorizedReviewPayload, 'eligible_reviewers'), false);
  assert.ok(Array.isArray(unauthorizedReviewPayload.eligible_alternative_agents));
  assert.ok(unauthorizedReviewPayload.eligible_alternative_agents.some((r) => r.agent_id === 'smart-scheduling.architect'));

  // 3. Review compatibility by the sole reviewer admits a dependency outcome in one call.
  const autoAcceptResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_review',
      arguments: {
        task_number: 9224,
        agent_id: 'smart-scheduling.architect',
        verdict: 'accepted',
        auto_accept_single_operator: true,
      },
    },
  }, architectRuntime);
  const autoAcceptPayload = await responsePayload(autoAcceptResponse, architectRuntime, 6);
  assert.equal(autoAcceptPayload.status, 'success');
  assert.equal(autoAcceptPayload.completion_mode, 'review_compatibility_dependency_outcome');
  assert.equal(autoAcceptPayload.close_action, 'skipped');
  assert.equal(autoAcceptPayload.single_operator_review, true);
  assert.equal(autoAcceptPayload.conflict_policy_conflict_detected, true);
  assert.equal(autoAcceptPayload.conflict_policy_kind, autoAcceptPayload.single_operator_kind);
  assert.ok(Array.isArray(autoAcceptPayload.conflict_policy_evidence));
  assert.equal(autoAcceptPayload.review_compatibility_dependency_outcome.dependency.kind, 'review');
  assert.equal(autoAcceptPayload.review_compatibility_dependency_outcome.task_outcome.outcome, 'accepted');
  assert.equal(autoAcceptPayload.review_compatibility_dependency_outcome.outcome_contract.outcome_type, 'review');
  assert.equal(autoAcceptPayload.review_compatibility_dependency_outcome.parent_dependency_wait_status.new_status, 'awaiting_dependencies');
  assert.equal(autoAcceptPayload.review_compatibility_dependency_outcome.dependency_satisfaction.all_satisfied, true);
  assert.equal(autoAcceptPayload.review_compatibility_dependency_outcome.conflict_policy_evidence[0].annotation_recorded, true);
  const migratedReviewShowResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 601,
    method: 'tools/call',
    params: { name: 'task_lifecycle_show', arguments: { task_number: 9224 } },
  }, architectRuntime);
  const migratedReviewShow = await responsePayload(migratedReviewShowResponse, architectRuntime, 602);
  assert.equal(Object.hasOwn(migratedReviewShow, 'reviews'), false);
  assert.ok(Array.isArray(migratedReviewShow.legacy_review_rows));
  assert.equal(migratedReviewShow.review_authority.primary_authority, 'task_dependencies.task_outcomes');
  assert.equal(migratedReviewShow.review_authority.legacy_review_rows_authority, 'compatibility_projection_only');
  assert.equal(migratedReviewShow.lifecycle.status, 'awaiting_dependencies');
  assert.equal(migratedReviewShow.dependency_satisfaction.all_satisfied, true);
  assert.equal(migratedReviewShow.dependencies_blocking_this_task[0].latest_outcome, 'accepted');

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
  assert.equal(schemaPayload.schemas.task_lifecycle_review.compatibility_only, true);
  assert.equal(schemaPayload.schemas.task_lifecycle_review.preferred_tool_for_new_review_work, 'task_lifecycle_finish');

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


  const finishSchemaResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10141,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_payload_schema',
      arguments: { tool: 'task_lifecycle_finish' },
    },
  }, builderRuntime);
  const finishSchemaPayload = await responsePayload(finishSchemaResponse, builderRuntime, 10142);
  assert.equal(finishSchemaPayload.status, 'ok');
  assert.equal(finishSchemaPayload.schemas.task_lifecycle_finish.payload_ref_shape.outcome, '<contract outcome when applicable>');
  assert.deepEqual(finishSchemaPayload.schemas.task_lifecycle_finish.payload_ref_shape.findings, []);
  assert.match(finishSchemaPayload.schemas.task_lifecycle_finish.inline_payload_limit.remediation, /findings/);

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

  const guidanceResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1018,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_guidance',
      arguments: { workflow: 'ordinary_task', tool: 'task_lifecycle_submit_work' },
    },
  }, builderRuntime);
  const guidancePayload = await responsePayload(guidanceResponse, builderRuntime, 1019);
  assert.equal(guidancePayload.status, 'ok');
  assert.equal(guidancePayload.schema, 'narada.task_lifecycle.guidance.v0');
  assert.deepEqual(Object.keys(guidancePayload.sections), ['ordinary_task']);
  assert.match(guidancePayload.sections.ordinary_task.intent, /explicit lifecycle records/);
  assert.match(guidancePayload.tool_specific_note.caveat, /in_review/);
  assert.equal(guidancePayload.first_use_decision_tree[0].sequence[0], 'task_lifecycle_show');
  assert.match(guidancePayload.state_truth_table.in_review, /do not report this as closed/);
  assert.equal(guidancePayload.tool_preference_table.some((entry: any) => entry.tool === 'task_lifecycle_submit_work'), true);
  assert.equal(guidancePayload.happy_path_examples.ordinary_submit_work_inline.arguments.changed_files[0], 'packages/example/src/main.ts');
  assert.equal(guidancePayload.anti_patterns.some((entry: any) => /payload/.test(entry.mistake)), true);
  assert.equal(guidancePayload.recovery_guidance.some((entry: any) => /payload_schema/.test(entry.action)), true);

  const payloadGuidanceResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1020,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_guidance',
      arguments: { workflow: 'payloads' },
    },
  }, builderRuntime);
  const payloadGuidance = await responsePayload(payloadGuidanceResponse, builderRuntime, 1021);
  assert.equal(payloadGuidance.status, 'ok');
  assert.deepEqual(payloadGuidance.sections.payloads.top_level_authority_fields, ['task_number', 'agent_id', 'authority_basis when required']);
  assert.equal(payloadGuidance.sections.payloads.examples[0].create_payload.payload.execution_notes, '<long execution notes>');
  assert.equal(payloadGuidance.sections.payloads.examples[0].consume_payload_ref.arguments.task_number, 123);
  assert.equal(Object.hasOwn(payloadGuidance.sections.payloads.examples[0].create_payload.payload, 'task_number'), false);

  const toolsListResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1011,
    method: 'tools/list',
    params: {},
  }, builderRuntime);
  const guidanceTool = toolsListResponse.result.tools.find((tool: any) => tool.name === 'task_lifecycle_guidance');
  assert.equal(guidanceTool.annotations.readOnlyHint, true);
  assert.equal(guidanceTool.inputSchema.properties.workflow.type, 'string');
  const reviewTool = toolsListResponse.result.tools.find((tool: any) => tool.name === 'task_lifecycle_review');
  assert.equal(reviewTool.inputSchema.properties.findings.type, 'array');
  assert.equal(reviewTool.inputSchema.properties.findings.items.type, 'object');
  assert.match(reviewTool.inputSchema.properties.findings.description, /finding objects/);
  const finishTool = toolsListResponse.result.tools.find((tool: any) => tool.name === 'task_lifecycle_finish');
  assert.equal(finishTool.inputSchema.properties.outcome.type, 'string');
  assert.equal(finishTool.inputSchema.properties.findings.type, 'array');
  assert.equal(Object.hasOwn(finishTool.inputSchema.properties, 'verdict'), false);
  assert.match(finishTool.description, /outcome contract/);
  const blockedReportTool = toolsListResponse.result.tools.find((tool: any) => tool.name === 'task_lifecycle_report_blocked');
  assert.equal(blockedReportTool.inputSchema.required.includes('reason'), true);
  assert.match(blockedReportTool.description, /without implying finish/);
  assert.match(blockedReportTool.inputSchema.properties.next_action.description, /governed inline threshold/);
  assert.match(blockedReportTool.inputSchema.properties.payload_ref.description, /long reason/);

  const finishWithVerdictResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10131,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9202,
        agent_id: 'smart-scheduling.builder',
        verdict: 'accepted',
        summary: 'Legacy finish verdict should not create review authority.',
      },
    },
  }, builderRuntime);
  const finishWithVerdictPayload = await responsePayload(finishWithVerdictResponse, builderRuntime, 10132);
  assert.equal(finishWithVerdictPayload.status, 'blocked');
  assert.equal(finishWithVerdictPayload.error, 'finish_verdict_disallowed');
  assert.equal(finishWithVerdictPayload.compatibility_tool, 'task_lifecycle_review');
  assert.equal(finishWithVerdictPayload.example_outcome_args.outcome, 'accepted');

  const finishLegacyInReviewResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10133,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9201,
        agent_id: 'smart-scheduling.architect',
        summary: 'Legacy in_review state should not enter review-native finish mode.',
      },
    },
  }, architectRuntime);
  const finishLegacyInReviewPayload = await responsePayload(finishLegacyInReviewResponse, architectRuntime, 10134);
  assert.equal(finishLegacyInReviewPayload.status, 'blocked', JSON.stringify(finishLegacyInReviewPayload));
  assert.equal(finishLegacyInReviewPayload.error, 'finish_in_review_legacy_state_disallowed');
  assert.equal(finishLegacyInReviewPayload.compatibility_tool, 'task_lifecycle_review');

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

  const unauthorizedOutcomeContractFinishResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10221,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9209,
        agent_id: 'smart-scheduling.same-architect',
        outcome: 'accepted',
        summary: 'Agent without review capability attempts to finish a review-contract task.',
        findings: [],
        no_files_changed: true,
      },
    },
  }, sameArchitectRuntime);
  const unauthorizedOutcomeContractFinish = await responsePayload(unauthorizedOutcomeContractFinishResponse, sameArchitectRuntime, 10222);
  assert.equal(unauthorizedOutcomeContractFinish.status, 'blocked', JSON.stringify(unauthorizedOutcomeContractFinish));
  assert.equal(unauthorizedOutcomeContractFinish.error, 'outcome_contract_capability_required');
  assert.equal(unauthorizedOutcomeContractFinish.outcome_capability_policy.capability_requirement, 'review');
  assert.equal(unauthorizedOutcomeContractFinish.outcome_capability_policy.agent_has_capability, false);
  assert.equal(unauthorizedOutcomeContractFinish.outcome_capability_policy.enforcement_result, 'blocked');
  assert.ok(unauthorizedOutcomeContractFinish.outcome_capability_policy.eligible_alternative_agents.some((agent: any) => agent.agent_id === 'smart-scheduling.architect'));
  assert.equal(unauthorizedOutcomeContractFinish.example_override_args.authority_basis.kind, 'operator_direct_instruction');

  const wrongAssigneeOutcomeContractFinishResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10223,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9209,
        agent_id: 'smart-scheduling.builder',
        outcome: 'accepted',
        summary: 'Review-capable builder attempts to finish a task assigned to architect.',
        findings: [],
        no_files_changed: true,
      },
    },
  }, builderRuntime);
  const wrongAssigneeOutcomeContractFinish = await responsePayload(wrongAssigneeOutcomeContractFinishResponse, builderRuntime, 10224);
  assert.equal(wrongAssigneeOutcomeContractFinish.status, 'blocked', JSON.stringify(wrongAssigneeOutcomeContractFinish));
  assert.equal(wrongAssigneeOutcomeContractFinish.error, 'outcome_contract_active_assignment_mismatch');
  assert.equal(wrongAssigneeOutcomeContractFinish.outcome_capability_policy.agent_has_capability, true);
  assert.equal(wrongAssigneeOutcomeContractFinish.active_assignment.agent_id, 'smart-scheduling.architect');
  assert.equal(wrongAssigneeOutcomeContractFinish.actor_agent_id, 'smart-scheduling.builder');
  assert.equal(wrongAssigneeOutcomeContractFinish.example_override_args.authority_basis.kind, 'operator_direct_instruction');

  const outcomeContractFinishResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1024,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9209,
        agent_id: 'smart-scheduling.architect',
        outcome: 'accepted_with_notes',
        summary: 'Review-contract task accepted the parent work with one non-blocking note.',
        findings: [{ severity: 'note', description: 'Non-blocking follow-up remains tracked elsewhere.' }],
        no_files_changed: true,
      },
    },
  }, architectRuntime);
  const outcomeContractFinishPayload = await responsePayload(outcomeContractFinishResponse, architectRuntime, 1025);
  assert.equal(outcomeContractFinishPayload.status, 'success', JSON.stringify(outcomeContractFinishPayload));
  assert.equal(outcomeContractFinishPayload.task_outcome.outcome, 'accepted_with_notes');
  assert.equal(outcomeContractFinishPayload.task_outcome.contract_id, 'contract-outcome-review-9209');
  assert.equal(outcomeContractFinishPayload.outcome_contract.outcome_type, 'review');
  assert.equal(outcomeContractFinishPayload.outcome_capability_policy.capability_requirement, 'review');
  assert.equal(outcomeContractFinishPayload.outcome_capability_policy.agent_has_capability, true);
  assert.equal(outcomeContractFinishPayload.outcome_capability_policy.enforcement_result, 'allowed');

  const outcomeStore = openTaskLifecycleStore(siteRoot);
  try {
    const admittedOutcome = outcomeStore.getLatestTaskOutcome(outcomeContractTaskId);
    assert.equal(admittedOutcome?.outcome, 'accepted_with_notes');
    assert.deepEqual(JSON.parse(admittedOutcome?.findings_json ?? '[]'), [{ severity: 'note', description: 'Non-blocking follow-up remains tracked elsewhere.' }]);
  } finally {
    outcomeStore.db.close();
  }
  const outcomeAuditResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10251,
    method: 'tools/call',
    params: { name: 'task_lifecycle_audit', arguments: { since: '2026-01-01T00:00:00.000Z' } },
  }, architectRuntime);
  const outcomeAuditPayload = await responsePayload(outcomeAuditResponse, architectRuntime, 10252);
  assert.ok(outcomeAuditPayload.events.some((event: Record<string, unknown>) => event.event_type === 'task_outcome' && event.task === '9209' && event.result === 'accepted_with_notes'));
  const legacyReviewAuditEvent = outcomeAuditPayload.events.find((event: Record<string, unknown>) => event.event_type === 'legacy_review');
  assert.equal(legacyReviewAuditEvent.authority_role, 'legacy_compatibility_projection');
  assert.equal(legacyReviewAuditEvent.primary_authority, false);
  assert.equal(legacyReviewAuditEvent.migration_target, 'task_dependencies.task_outcomes');

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
  assert.equal(unDeferBlockedPayload.status, 'un_deferred', JSON.stringify(unDeferBlockedPayload));

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
        reviewer: 'smart-scheduling.architect',
      },
    },
  }, builderRuntime);
  const freshCompletionAfterBlockedPayload = await responsePayload(freshCompletionAfterBlockedResponse, builderRuntime, 1021);
  assert.equal(freshCompletionAfterBlockedPayload.status, 'success', JSON.stringify(freshCompletionAfterBlockedPayload));

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

  const closedHistoricalStore = openTaskLifecycleStore(siteRoot);
  try {
    closedHistoricalStore.updateStatus(blockedTaskId, 'closed', 'smart-scheduling.builder', { closed_at: '2026-06-04T05:00:00Z', closed_by: 'smart-scheduling.builder', closure_mode: 'agent_finish' });
    closedHistoricalStore.upsertDirectedObligation({
      obligation_id: 'review-obligation-historical-after-close-9205',
      source_kind: 'task_lifecycle_finish',
      source_ref: 'historical-review-request',
      source_agent_id: 'smart-scheduling.builder',
      target_agent_id: null,
      target_role: 'architect',
      target_ref: null,
      kind: 'review_request',
      status: 'open',
      task_id: blockedTaskId,
      task_number: 9205,
      evidence_json: '{}',
      consumption_rule_json: '{}',
      created_at: '2026-06-04T04:30:00Z',
      updated_at: '2026-06-04T04:30:00Z',
      consumed_at: null,
      consumed_by: null,
      consumption_ref: null,
    });
  } finally {
    closedHistoricalStore.db.close();
  }
  const closedHistoricalInspectResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10231,
    method: 'tools/call',
    params: { name: 'task_lifecycle_inspect', arguments: { task_number: 9205 } },
  }, builderRuntime);
  const closedHistoricalInspect = await responsePayload(closedHistoricalInspectResponse, builderRuntime, 10232);
  assert.equal(closedHistoricalInspect.blocked_work_posture.state, 'closed_supersedes_blocked_report');
  assert.equal(closedHistoricalInspect.blocked_work_posture.next_action, null);
  const historicalReviewObligation = closedHistoricalInspect.obligations.find((item: any) => item.obligation_id === 'review-obligation-historical-after-close-9205');
  assert.equal(historicalReviewObligation.active, false);
  assert.equal(historicalReviewObligation.status, 'historical_open_superseded_by_task_closure');

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
  const claimIdentityStore = openTaskLifecycleStore(siteRoot);
  try {
    const lifecycle = claimIdentityStore.getLifecycleByNumber(9207);
    const assignment = claimIdentityStore.getActiveAssignment(lifecycle.task_id);
    const identityRef = JSON.parse(assignment.agent_identity_ref_json);
    assert.equal(assignment.agent_id, 'mcp-surfaces.codex');
    assert.equal(identityRef.schema, 'narada.agent_identity_ref.v2');
    assert.equal(identityRef.identity_scope.site_id, 'mcp-surfaces');
    assert.equal(identityRef.local_agent_id, 'codex');
    assert.equal(identityRef.legacy_agent_id, 'mcp-surfaces.codex');
  } finally {
    claimIdentityStore.db.close();
  }
  assert.equal(genericEngineerWithAuthorityPayload.role_mismatch_authority.kind, 'operator_direct_instruction');
  assert.equal(genericEngineerWithAuthorityPayload.role_mismatch_authority.target_role, 'engineer');
  assert.equal(genericEngineerWithAuthorityPayload.role_mismatch_authority.agent_role, 'mcp-surfaces-engineer');
  assert.equal(genericEngineerWithAuthorityPayload.intent_recording_warning, undefined);

  const submitWorkToolList = await handleTaskLifecycleMcpRequest({ jsonrpc: '2.0', id: 10560, method: 'tools/list' }, builderRuntime);
  assert.ok(submitWorkToolList.result.tools.some((tool: any) => tool.name === 'task_lifecycle_submit_work'));

  const submitWorkResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1057,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_submit_work',
      arguments: {
        task_number: 9208,
        agent_id: 'smart-scheduling.builder',
        summary: 'Submitted compound helper work through the governed primitive lifecycle path.',
        execution_notes: 'Implemented the requested work and recorded the concrete execution steps through the compound helper.',
        verification: 'Verified by exercising task_lifecycle_submit_work inside the task lifecycle ergonomics regression suite.',
        changed_files: [`.ai/do-not-open/tasks/${submitWorkTaskId}.md`],
        reviewer: 'smart-scheduling.architect',
      },
    },
  }, builderRuntime);
  const submitWorkPayload = await responsePayload(submitWorkResponse, builderRuntime, 1058);
  assert.equal(submitWorkPayload.status, 'submitted', JSON.stringify(submitWorkPayload));
  assert.equal(submitWorkPayload.final_lifecycle_status, 'awaiting_dependencies');
  assert.equal(submitWorkPayload.closure_status, 'submitted_for_review_not_closed');
  assert.equal(submitWorkPayload.submitted_for_review_not_closed, true);
  assert.deepEqual(submitWorkPayload.primitive_results.map((entry: any) => entry.tool), [
    'task_lifecycle_claim',
    'task_lifecycle_submit_work.write_task_notes',
    'task_lifecycle_prove_criteria',
    'task_lifecycle_admit_evidence',
    'task_lifecycle_finish',
    'task_lifecycle_submit_work.create_review_dependency',
  ]);
  const submitWorkFinishResult = submitWorkPayload.primitive_results.find((entry: any) => entry.tool === 'task_lifecycle_finish').result;
  assert.equal(submitWorkFinishResult.status, 'success');
  assert.equal(submitWorkFinishResult.new_status, 'awaiting_dependencies');
  assert.equal(submitWorkFinishResult.legacy_review_routing_suppressed, true);
  assert.equal(submitWorkFinishResult.dependency_native_review_routing, true);
  assert.equal(submitWorkFinishResult.obligation_id, null);
  assert.equal(submitWorkFinishResult.outcome_contract.outcome_type, 'completion');
  assert.equal(submitWorkFinishResult.task_outcome.outcome, 'completed');
  assert.equal(submitWorkFinishResult.task_outcome.contract_id, submitWorkFinishResult.outcome_contract.contract_id);
  const generatedReviewDependency = submitWorkPayload.primitive_results.at(-1).result;
  assert.equal(generatedReviewDependency.status, 'created');
  assert.equal(generatedReviewDependency.dependency_kind, 'review');
  assert.equal(generatedReviewDependency.parent_task_id, submitWorkTaskId);
  assert.equal(generatedReviewDependency.parent_dependency_wait_status.new_status, 'awaiting_dependencies');
  assert.equal(generatedReviewDependency.parent_dependency_wait_status.blocked_by, 'dependencies');
  assert.equal(generatedReviewDependency.outcome_contract.outcome_type, 'review');
  assert.deepEqual(generatedReviewDependency.outcome_contract.allowed_outcomes, ['accepted', 'accepted_with_notes', 'rejected']);

  const submitWorkSchemaTool = submitWorkToolList.result.tools.find((tool: any) => tool.name === 'task_lifecycle_submit_work');
  assert.match(submitWorkSchemaTool.inputSchema.properties.payload_ref.description, /long execution_notes/);
  assert.equal(submitWorkSchemaTool.inputSchema.properties.auto_materialize_payload.type, 'boolean');
  assert.deepEqual(submitWorkSchemaTool.inputSchema.required, ['task_number', 'agent_id']);
  const ordinaryInlineExecutionNotes = `Implemented a detailed submit_work note that is comfortably larger than the old tiny threshold while remaining ordinary inline closeout prose. ${'This sentence adds realistic operational detail without requiring payload transport. '.repeat(12)}`;
  const ordinaryInlineSubmitWorkResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105801,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_submit_work',
      arguments: {
        task_number: 9225,
        agent_id: 'smart-scheduling.builder',
        summary: 'Submitted ordinary inline helper work under the governed threshold.',
        execution_notes: ordinaryInlineExecutionNotes,
        verification: 'Verified ordinary inline submit_work prose no longer requires payload ceremony.',
        changed_files: [`.ai/do-not-open/tasks/${inlineSubmitWorkTaskId}.md`],
      },
    },
  }, builderRuntime);
  const ordinaryInlineSubmitWork = await responsePayload(ordinaryInlineSubmitWorkResponse, builderRuntime, 105802);
  assert.equal(ordinaryInlineSubmitWork.status, 'submitted', JSON.stringify(ordinaryInlineSubmitWork));
  assert.equal(ordinaryInlineSubmitWork.long_field_transport, 'inline');
  assert.equal(ordinaryInlineSubmitWork.payload_source, null);

  const longExecutionNotes = `Implemented a deliberately long submit_work execution note that exceeds the governed inline transport threshold while remaining ordinary closeout prose. ${'This sentence exists only to cross the inline threshold without adding semantic requirements. '.repeat(260)}`;
  assert.equal(longExecutionNotes.length > 20_000, true);
  const longInlineSubmitWorkResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105805,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_submit_work',
      arguments: {
        task_number: 9220,
        agent_id: 'smart-scheduling.builder',
        summary: 'Submitted long inline helper work without fallback.',
        execution_notes: longExecutionNotes,
        verification: 'Verified default long inline submit_work refusal remains active.',
        changed_files: [`.ai/do-not-open/tasks/${autoPayloadSubmitWorkTaskId}.md`],
      },
    },
  }, builderRuntime);
  assert.match(longInlineSubmitWorkResponse.error?.message ?? '', /inline_payload_too_long/);
  assert.match(longInlineSubmitWorkResponse.error?.data?.message ?? longInlineSubmitWorkResponse.error?.message ?? '', /20000/);
  const submitWorkPayloadCreateResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10581,
    method: 'tools/call',
    params: {
      name: 'mcp_payload_create',
      arguments: {
        payload: {
          summary: 'Submitted payload-backed compound helper work through the governed primitive lifecycle path.',
          execution_notes: 'Implemented the requested payload-backed work and recorded concrete execution steps in a long field carried by payload_ref.',
          verification: 'Verified payload-backed submit_work by exercising the merge_args payload transport path in the ergonomics regression suite.',
          changed_files: [`.ai/do-not-open/tasks/${payloadSubmitWorkTaskId}.md`],
        },
      },
    },
  }, builderRuntime);
  const submitWorkPayloadRef = await responsePayload(submitWorkPayloadCreateResponse, builderRuntime, 10582);
  const payloadSubmitWorkResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10583,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_submit_work',
      arguments: {
        payload_ref: submitWorkPayloadRef.ref,
        task_number: 9219,
        agent_id: 'smart-scheduling.builder',
        no_files_changed: false,
      },
    },
  }, builderRuntime);
  const payloadSubmitWork = await responsePayload(payloadSubmitWorkResponse, builderRuntime, 10584);
  assert.equal(payloadSubmitWork.status, 'submitted', JSON.stringify(payloadSubmitWork));
  assert.equal(payloadSubmitWork.payload_source.ref, submitWorkPayloadRef.ref);
  assert.equal(payloadSubmitWork.long_field_transport, 'payload_ref');
  assert.equal(payloadSubmitWork.final_lifecycle_status, 'claimed');
  assert.equal(payloadSubmitWork.closure_status, 'submitted_not_closed');
  const autoPayloadSubmitWorkResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10585,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_submit_work',
      arguments: {
        task_number: 9220,
        agent_id: 'smart-scheduling.builder',
        summary: 'Submitted one-call auto-materialized helper work through governed payload fallback.',
        execution_notes: longExecutionNotes,
        verification: 'Verified auto-materialized submit_work by exercising the one-call fallback path in the ergonomics regression suite.',
        changed_files: [`.ai/do-not-open/tasks/${autoPayloadSubmitWorkTaskId}.md`],
        auto_materialize_payload: true,
      },
    },
  }, builderRuntime);
  const autoPayloadSubmitWork = await responsePayload(autoPayloadSubmitWorkResponse, builderRuntime, 10586);
  assert.equal(autoPayloadSubmitWork.status, 'submitted', JSON.stringify(autoPayloadSubmitWork));
  assert.equal(autoPayloadSubmitWork.long_field_transport, 'auto_materialized_payload');
  assert.equal(autoPayloadSubmitWork.payload_source.kind, 'auto_materialized_payload');
  assert.match(autoPayloadSubmitWork.payload_source.ref, /^mcp_payload:submit-work-9220-/);
  assert.match(autoPayloadSubmitWork.payload_source.sha256, /^[0-9a-f]{64}$/);

  const placeholderPayloadCreateResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10587,
    method: 'tools/call',
    params: {
      name: 'mcp_payload_create',
      arguments: {
        payload: {
          summary: 'Submitted payload-backed helper work while top-level placeholder fields remained in the call.',
          execution_notes: 'Real execution notes came from payload_ref and must not be overwritten by top-level placeholder text.',
          verification: 'Real verification came from payload_ref and must not be overwritten by top-level placeholder text.',
          changed_files: [`.ai/do-not-open/tasks/${placeholderPayloadSubmitWorkTaskId}.md`],
        },
      },
    },
  }, builderRuntime);
  const placeholderPayloadRef = await responsePayload(placeholderPayloadCreateResponse, builderRuntime, 10588);
  const placeholderPayloadSubmitWorkResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10589,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_submit_work',
      arguments: {
        payload_ref: placeholderPayloadRef.ref,
        task_number: 9227,
        agent_id: 'smart-scheduling.builder',
        execution_notes: '<!-- placeholder execution notes -->',
        verification: '<move original verification here>',
      },
    },
  }, builderRuntime);
  const placeholderPayloadSubmitWork = await responsePayload(placeholderPayloadSubmitWorkResponse, builderRuntime, 10590);
  assert.equal(placeholderPayloadSubmitWork.status, 'submitted', JSON.stringify(placeholderPayloadSubmitWork));
  assert.equal(placeholderPayloadSubmitWork.payload_source.ref, placeholderPayloadRef.ref);
  assert.equal(placeholderPayloadSubmitWork.long_field_transport, 'payload_ref');

  const nonRosterSubmitWorkResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10591,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_submit_work',
      arguments: {
        task_number: 9226,
        agent_id: 'narada-launcher.agent',
        summary: 'Attempted submit_work from an agent that is not in the task lifecycle roster.',
        execution_notes: 'This must fail before claim so it cannot leave a task assigned to an unfinishable identity.',
        verification: 'Verified submit_work roster preflight blocks before mutation.',
        changed_files: [`.ai/do-not-open/tasks/${nonRosterSubmitWorkTaskId}.md`],
      },
    },
  }, nonRosterRuntime);
  const nonRosterSubmitWork = await responsePayload(nonRosterSubmitWorkResponse, nonRosterRuntime, 10592);
  assert.equal(nonRosterSubmitWork.status, 'blocked', JSON.stringify(nonRosterSubmitWork));
  assert.equal(nonRosterSubmitWork.blocked_at, 'task_lifecycle_submit_work.roster_preflight');
  assert.equal(nonRosterSubmitWork.primitive_results[0].result.error, 'submit_work_agent_not_in_roster');
  const nonRosterStore = openTaskLifecycleStore(siteRoot);
  try {
    const nonRosterLifecycle = nonRosterStore.getLifecycle(nonRosterSubmitWorkTaskId);
    assert.equal(nonRosterLifecycle?.status, 'opened');
    assert.equal(nonRosterLifecycle?.governed_by, null);
    assert.equal(nonRosterStore.getActiveAssignment(nonRosterSubmitWorkTaskId), undefined);
  } finally {
    nonRosterStore.db.close();
  }

  const recoveryTruthfulnessBlockedResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10593,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9228,
        agent_id: 'smart-scheduling.builder',
        summary: 'Recovery task supplied an incomplete recovery truthfulness packet.',
        changed_files: [`.ai/do-not-open/tasks/${recoveryTruthfulnessFinishTaskId}.md`],
        recovery_truthfulness: { known_facts: 'The fixture intentionally omits the rest of the required packet.', state: 'corrective_in_progress' },
      },
    },
  }, builderRuntime);
  const recoveryTruthfulnessBlocked = await responsePayload(recoveryTruthfulnessBlockedResponse, builderRuntime, 10594);
  assert.equal(recoveryTruthfulnessBlocked.status, 'blocked', JSON.stringify(recoveryTruthfulnessBlocked));
  assert.equal(recoveryTruthfulnessBlocked.error, 'recovery_truthfulness_guard_failed');
  assert.match(recoveryTruthfulnessBlocked.remediation, /governed inline threshold/);

  const recoveryTruthfulnessFinishResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10595,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9228,
        agent_id: 'smart-scheduling.builder',
        summary: 'Recovery task supplied the required truthfulness packet inline.',
        changed_files: [`.ai/do-not-open/tasks/${recoveryTruthfulnessFinishTaskId}.md`],
        reviewer: 'smart-scheduling.architect',
        recovery_truthfulness: {
          known_facts: 'The guard required a structured recovery packet for serious failure closeout.',
          inferences: 'Inline packets below the governed threshold should be accepted without payload_ref ceremony.',
          uncertainty: 'No independent review has been performed in this fixture.',
          changed: 'The fixture supplied the required recovery truthfulness fields.',
          not_changed: 'No external repository state was changed by this fixture.',
          remaining_work: 'Review remains pending outside this helper assertion.',
          evidence_limits: 'The evidence is limited to this regression fixture.',
          capa_open_status: 'corrective work remains open in review',
          state: 'corrective_in_progress',
        },
      },
    },
  }, builderRuntime);
  const recoveryTruthfulnessFinish = await responsePayload(recoveryTruthfulnessFinishResponse, builderRuntime, 10596);
  assert.equal(recoveryTruthfulnessFinish.status, 'success', JSON.stringify(recoveryTruthfulnessFinish));
  assert.equal(recoveryTruthfulnessFinish.new_status, 'awaiting_dependencies');
  const submitWorkReviewStore = openTaskLifecycleStore(siteRoot);
  try {
    const dependencies = submitWorkReviewStore.listTaskDependenciesForParent(submitWorkTaskId);
    assert.equal(dependencies.length, 1);
    assert.equal(dependencies[0].kind, 'review');
    assert.equal(dependencies[0].required_task_id, generatedReviewDependency.required_task_id);
    const implementationOutcome = submitWorkReviewStore.getLatestTaskOutcome(submitWorkTaskId);
    assert.equal(implementationOutcome?.outcome, 'completed');
    assert.equal(implementationOutcome?.contract_id, submitWorkFinishResult.outcome_contract.contract_id);
    const contract = submitWorkReviewStore.getLatestTaskOutcomeContract(generatedReviewDependency.required_task_id);
    assert.equal(contract?.outcome_type, 'review');
    assert.deepEqual(JSON.parse(contract?.satisfying_outcomes_json ?? '[]'), ['accepted', 'accepted_with_notes']);
    const routing = submitWorkReviewStore.db.prepare('select target_role, preferred_agent_id from narada_andrey_task_role_preferences where task_id = ?').get(generatedReviewDependency.required_task_id) as Record<string, unknown> | undefined;
    assert.equal(routing?.target_role, 'architect');
    assert.equal(routing?.preferred_agent_id, 'smart-scheduling.architect');
    submitWorkReviewStore.upsertDirectedObligation({
      obligation_id: 'legacy-review-request-obligation-9208',
      source_kind: 'task_lifecycle_submit_work.compat',
      source_ref: submitWorkTaskId,
      source_agent_id: 'smart-scheduling.builder',
      target_agent_id: 'smart-scheduling.architect',
      target_role: 'architect',
      target_ref: generatedReviewDependency.required_task_id,
      kind: 'review_request',
      status: 'open',
      task_id: generatedReviewDependency.required_task_id,
      task_number: generatedReviewDependency.required_task_number,
      evidence_json: JSON.stringify({ dependency_id: generatedReviewDependency.dependency_id }),
      consumption_rule_json: JSON.stringify({ outcome_type: 'review' }),
      created_at: '2026-06-04T00:02:00Z',
      updated_at: '2026-06-04T00:02:00Z',
      consumed_at: null,
      consumed_by: null,
      consumption_ref: null,
    });
  } finally {
    submitWorkReviewStore.db.close();
  }
  const dependencyPreflightResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10561,
    method: 'tools/call',
    params: { name: 'task_lifecycle_evidence_preflight', arguments: { task_number: 9208 } },
  }, builderRuntime);
  const dependencyPreflight = await responsePayload(dependencyPreflightResponse, builderRuntime, 10562);
  assert.equal(dependencyPreflight.dependency_satisfaction.all_satisfied, false);
  assert.equal(dependencyPreflight.dependency_satisfaction.unsatisfied_count, 1);
  assert.equal(dependencyPreflight.requirements.find((item: any) => item.id === 'dependencies').satisfied, false);

  const parentDependencyShowResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105624,
    method: 'tools/call',
    params: { name: 'task_lifecycle_show', arguments: { task_number: 9208 } },
  }, builderRuntime);
  const parentDependencyShow = await responsePayload(parentDependencyShowResponse, builderRuntime, 105625);
  assert.equal(parentDependencyShow.lifecycle.status, 'awaiting_dependencies');
  assert.equal(parentDependencyShow.dependency_satisfaction.unsatisfied_count, 1);
  assert.equal(parentDependencyShow.dependencies_blocking_this_task[0].dependency_kind, 'review');
  assert.equal(parentDependencyShow.dependencies_blocking_this_task[0].required_task_number, generatedReviewDependency.required_task_number);

  const reviewDependencyShowResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105626,
    method: 'tools/call',
    params: { name: 'task_lifecycle_show', arguments: { task_number: generatedReviewDependency.required_task_number } },
  }, architectRuntime);
  const reviewDependencyShow = await responsePayload(reviewDependencyShowResponse, architectRuntime, 105627);
  assert.equal(reviewDependencyShow.dependency_context[0].dependency_kind, 'review');
  assert.equal(reviewDependencyShow.dependency_context[0].gates_task_number, 9208);
  assert.equal(reviewDependencyShow.dependency_context[0].next_tool, 'task_lifecycle_claim');
  assert.equal(reviewDependencyShow.outcome_contract.outcome_type, 'review');
  assert.deepEqual(reviewDependencyShow.outcome_contract.satisfying_outcomes, ['accepted', 'accepted_with_notes']);

  const reviewDependencyInspectResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105628,
    method: 'tools/call',
    params: { name: 'task_lifecycle_inspect', arguments: { task_number: generatedReviewDependency.required_task_number } },
  }, architectRuntime);
  const reviewDependencyInspect = await responsePayload(reviewDependencyInspectResponse, architectRuntime, 105629);
  assert.equal(reviewDependencyInspect.dependency_context[0].dependency_id, generatedReviewDependency.dependency_id);
  assert.equal(reviewDependencyInspect.dependency_context[0].example_args.task_number, generatedReviewDependency.required_task_number);
  assert.equal(reviewDependencyInspect.dependency_context[0].dependency_satisfaction.all_satisfied, false);

  const reviewDependencyObligationsResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105619,
    method: 'tools/call',
    params: { name: 'task_lifecycle_obligations', arguments: { agent_id: 'smart-scheduling.architect', limit: 20 } },
  }, architectRuntime);
  const reviewDependencyObligations = await responsePayload(reviewDependencyObligationsResponse, architectRuntime, 1056191);
  const normalizedDirectedObligation = reviewDependencyObligations.obligations.find((item: any) => item.obligation_id === 'legacy-review-request-obligation-9208');
  assert.equal(normalizedDirectedObligation.kind, 'dependency_request');
  assert.equal(normalizedDirectedObligation.legacy_kind, 'review_request');
  assert.equal(normalizedDirectedObligation.dependency_kind, 'review');
  assert.ok(Array.isArray(reviewDependencyObligations.dependency_work), JSON.stringify(reviewDependencyObligations));
  const dependencyObligation = reviewDependencyObligations.dependency_work.find((item: any) => item.task_number === generatedReviewDependency.required_task_number);
  assert.equal(dependencyObligation.dependency_kind, 'review');
  assert.equal(dependencyObligation.gates_task_number, 9208);
  assert.equal(dependencyObligation.next_tool, 'task_lifecycle_claim');
  assert.equal(dependencyObligation.example_args.task_number, generatedReviewDependency.required_task_number);

  const reviewDependencyNextResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105620,
    method: 'tools/call',
    params: { name: 'task_lifecycle_next', arguments: { agent_id: 'smart-scheduling.architect', limit: 20 } },
  }, architectRuntime);
  const reviewDependencyNext = await responsePayload(reviewDependencyNextResponse, architectRuntime, 105621);
  assert.equal(reviewDependencyNext.counts.dependency_waiting_parents >= 1, true);
  assert.equal(reviewDependencyNext.dependency_waiting_parents.some((item: any) => item.task_number === 9208), true);
  assert.equal(reviewDependencyNext.counts.dependency_tasks >= 1, true);
  assert.equal(reviewDependencyNext.dependency_tasks.some((item: any) => item.task_number === generatedReviewDependency.required_task_number), true);
  const reviewDependencySnapshotResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1056201,
    method: 'tools/call',
    params: { name: 'task_lifecycle_workboard_snapshot', arguments: { agent_id: 'smart-scheduling.architect', limit: 20 } },
  }, architectRuntime);
  const reviewDependencySnapshot = await responsePayload(reviewDependencySnapshotResponse, architectRuntime, 1056202);
  assert.equal(reviewDependencySnapshot.counts.dependency_tasks >= 1, true);
  assert.equal(reviewDependencySnapshot.active_state.dependency_tasks.some((item: any) => item.task_number === generatedReviewDependency.required_task_number), true);
  assert.equal(reviewDependencyNext.dependency_waiting_parents.find((item: any) => item.task_number === 9208).blocked_by, 'dependencies');
  const nextDependencyObligation = reviewDependencyNext.dependency_obligations.find((item: any) => item.obligation_id === 'legacy-review-request-obligation-9208');
  assert.equal(nextDependencyObligation.kind, 'dependency_request');
  assert.equal(nextDependencyObligation.legacy_kind, 'review_request');
  assert.equal(nextDependencyObligation.dependency_kind, 'review');
  assert.equal(reviewDependencyNext.legacy_pending_reviews.some((item: any) => item.task_number === 9208), false);
  assert.equal(reviewDependencyNext.pending_reviews_compat.some((item: any) => item.task_number === 9208), false);
  assert.equal(Object.hasOwn(reviewDependencyNext, 'pending_reviews'), false);
  assert.equal(Object.hasOwn(reviewDependencyNext.counts, 'pending_reviews'), false);
  const openedReviewRecommendation = reviewDependencyNext.recommendations.find((item: any) => item.task_number === generatedReviewDependency.required_task_number);
  assert.equal(openedReviewRecommendation.dependency_kind, 'review');
  assert.equal(openedReviewRecommendation.gates_task_number, 9208);
  assert.deepEqual(openedReviewRecommendation.allowed_outcomes, ['accepted', 'accepted_with_notes', 'rejected']);
  assert.equal(openedReviewRecommendation.conflict_of_interest_risk.conflict_detected, false);
  assert.equal(openedReviewRecommendation.conflict_of_interest_risk.authorization_required, false);
  assert.equal(openedReviewRecommendation.next_tool, 'task_lifecycle_claim');
  assert.equal(openedReviewRecommendation.example_args.task_number, generatedReviewDependency.required_task_number);

  const reviewTaskNumber = generatedReviewDependency.required_task_number;
  const claimReviewDependencyResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10563,
    method: 'tools/call',
    params: { name: 'task_lifecycle_claim', arguments: { task_number: reviewTaskNumber, agent_id: 'smart-scheduling.architect' } },
  }, architectRuntime);
  const claimReviewDependencyPayload = await responsePayload(claimReviewDependencyResponse, architectRuntime, 10564);
  assert.equal(claimReviewDependencyPayload.status, 'claimed', JSON.stringify(claimReviewDependencyPayload));
  const claimedReviewDependencyNextResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105622,
    method: 'tools/call',
    params: { name: 'task_lifecycle_next', arguments: { agent_id: 'smart-scheduling.architect', limit: 8 } },
  }, architectRuntime);
  const claimedReviewDependencyNext = await responsePayload(claimedReviewDependencyNextResponse, architectRuntime, 105623);
  const claimedReviewWork = claimedReviewDependencyNext.in_progress.find((item: any) => item.task_number === reviewTaskNumber);
  assert.equal(claimedReviewWork.dependency_kind, 'review');
  assert.equal(claimedReviewWork.next_tool, 'task_lifecycle_finish');
  assert.equal(claimedReviewWork.example_args.outcome, 'accepted');
  assert.deepEqual(claimedReviewWork.allowed_outcomes, ['accepted', 'accepted_with_notes', 'rejected']);
  const finishReviewDependencyResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10565,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: reviewTaskNumber,
        agent_id: 'smart-scheduling.architect',
        outcome: 'accepted',
        summary: 'Generated review dependency accepts the submitted work.',
        findings: [],
        no_files_changed: true,
      },
    },
  }, architectRuntime);
  const finishReviewDependencyPayload = await responsePayload(finishReviewDependencyResponse, architectRuntime, 10566);
  assert.equal(finishReviewDependencyPayload.status, 'success', JSON.stringify(finishReviewDependencyPayload));
  assert.equal(finishReviewDependencyPayload.task_outcome.outcome, 'accepted');
  assert.equal(finishReviewDependencyPayload.review_evidence_backfill.status, 'backfilled');
  assert.equal(finishReviewDependencyPayload.review_evidence_backfill.criteria_proof.status, 'proved');
  const finishedReviewDependencyInspectResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105661,
    method: 'tools/call',
    params: { name: 'task_lifecycle_inspect', arguments: { task_number: reviewTaskNumber } },
  }, architectRuntime);
  const finishedReviewDependencyInspect = await responsePayload(finishedReviewDependencyInspectResponse, architectRuntime, 105662);
  assert.equal(finishedReviewDependencyInspect.evidence.verdict, 'complete');
  assert.equal(finishedReviewDependencyInspect.evidence.has_execution_notes, true);
  assert.equal(finishedReviewDependencyInspect.evidence.has_verification, true);
  assert.equal(finishedReviewDependencyInspect.evidence.all_criteria_checked, true);
  assert.equal(finishedReviewDependencyInspect.evidence.violations.includes('terminal_without_execution_notes'), false);
  assert.equal(finishedReviewDependencyInspect.evidence.violations.includes('terminal_with_unchecked_criteria'), false);
  assert.equal(finishedReviewDependencyInspect.evidence.violations.includes('terminal_without_verification'), false);
  const satisfiedDependencyPreflightResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10567,
    method: 'tools/call',
    params: { name: 'task_lifecycle_evidence_preflight', arguments: { task_number: 9208 } },
  }, builderRuntime);
  const satisfiedDependencyPreflight = await responsePayload(satisfiedDependencyPreflightResponse, builderRuntime, 10568);
  assert.equal(satisfiedDependencyPreflight.dependency_satisfaction.all_satisfied, true);
  assert.equal(satisfiedDependencyPreflight.requirements.find((item: any) => item.id === 'dependencies').satisfied, true);

  const declareGenericDependencyResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105681,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_dependency_declare',
      arguments: {
        parent_task_number: 9217,
        required_task_number: 9218,
        agent_id: 'smart-scheduling.builder',
        kind: 'verification',
        satisfying_outcomes: ['passed'],
        outcome_contract: {
          outcome_type: 'verification',
          allowed_outcomes: ['passed', 'failed'],
          satisfying_outcomes: ['passed'],
          blocking_outcomes: ['failed'],
          required_fields: ['summary'],
          capability_requirement: 'implementation_work',
        },
      },
    },
  }, builderRuntime);
  const declareGenericDependencyPayload = await responsePayload(declareGenericDependencyResponse, builderRuntime, 105682);
  assert.equal(declareGenericDependencyPayload.status, 'declared', JSON.stringify(declareGenericDependencyPayload));
  assert.equal(declareGenericDependencyPayload.dependency.kind, 'verification');
  assert.equal(declareGenericDependencyPayload.parent_dependency_wait_status.new_status, 'awaiting_dependencies');
  assert.equal(declareGenericDependencyPayload.outcome_contract.outcome_type, 'verification');
  assert.deepEqual(JSON.parse(declareGenericDependencyPayload.outcome_contract.satisfying_outcomes_json), ['passed']);
  assert.equal(declareGenericDependencyPayload.dependency_satisfaction.all_satisfied, false);

  const declaredParentShowResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105683,
    method: 'tools/call',
    params: { name: 'task_lifecycle_show', arguments: { task_number: 9217 } },
  }, builderRuntime);
  const declaredParentShow = await responsePayload(declaredParentShowResponse, builderRuntime, 105684);
  assert.equal(declaredParentShow.lifecycle.status, 'awaiting_dependencies');
  assert.equal(declaredParentShow.dependencies_blocking_this_task[0].dependency_kind, 'verification');
  assert.equal(declaredParentShow.dependency_satisfaction.unsatisfied_count, 1);

  const genericDependencyObligationStore = openTaskLifecycleStore(siteRoot);
  try {
    genericDependencyObligationStore.upsertDirectedObligation({
      obligation_id: 'generic-verification-dependency-obligation-9217',
      source_kind: 'task_lifecycle_dependency_declare',
      source_ref: declareGenericDependencyPayload.dependency.dependency_id,
      source_agent_id: 'smart-scheduling.builder',
      target_agent_id: null,
      target_role: 'builder',
      target_ref: null,
      kind: 'dependency_request',
      status: 'open',
      task_id: declareGenericDependencyPayload.dependency.required_task_id,
      task_number: 9218,
      evidence_json: JSON.stringify({
        dependency_id: declareGenericDependencyPayload.dependency.dependency_id,
        dependency_kind: 'verification',
      }),
      consumption_rule_json: JSON.stringify({ mode: 'dependency_outcome' }),
      created_at: '2026-06-04T00:00:00Z',
      updated_at: '2026-06-04T00:00:00Z',
      consumed_at: null,
      consumed_by: null,
      consumption_ref: null,
    });
  } finally {
    genericDependencyObligationStore.db.close();
  }
  const genericDependencyObligationsResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10568401,
    method: 'tools/call',
    params: { name: 'task_lifecycle_obligations', arguments: { agent_id: 'smart-scheduling.builder', limit: 20 } },
  }, builderRuntime);
  const genericDependencyObligations = await responsePayload(genericDependencyObligationsResponse, builderRuntime, 10568402);
  const genericVerificationObligation = genericDependencyObligations.obligations.find((item: any) => item.obligation_id === 'generic-verification-dependency-obligation-9217');
  assert.equal(genericVerificationObligation.kind, 'dependency_request');
  assert.equal(genericVerificationObligation.legacy_kind, 'dependency_request');
  assert.equal(genericVerificationObligation.dependency_kind, 'verification');

  const blockedDeclaredParentCloseResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1056841,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_close',
      arguments: {
        task_number: 9217,
        agent_id: 'smart-scheduling.builder',
      },
    },
  }, builderRuntime);
  const blockedDeclaredParentClose = await responsePayload(blockedDeclaredParentCloseResponse, builderRuntime, 1056842);
  assert.equal(blockedDeclaredParentClose.status, 'blocked', JSON.stringify(blockedDeclaredParentClose));
  assert.equal(blockedDeclaredParentClose.close_blocked, true);
  assert.equal(blockedDeclaredParentClose.error, 'task_close_dependencies_unsatisfied');
  assert.equal(blockedDeclaredParentClose.dependency_satisfaction.all_satisfied, false);
  assert.equal(blockedDeclaredParentClose.dependency_satisfaction.unsatisfied_count, 1);
  assert.equal(blockedDeclaredParentClose.evidence_preflight.requirements.find((item: any) => item.id === 'dependencies').satisfied, false);

  const finishDeclaredRequiredResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105685,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9218,
        agent_id: 'smart-scheduling.builder',
        outcome: 'passed',
        summary: 'Verification dependency passed.',
        findings: [],
      },
    },
  }, builderRuntime);
  const finishDeclaredRequiredPayload = await responsePayload(finishDeclaredRequiredResponse, builderRuntime, 105686);
  assert.equal(finishDeclaredRequiredPayload.status, 'success', JSON.stringify(finishDeclaredRequiredPayload));
  assert.equal(finishDeclaredRequiredPayload.task_outcome.outcome, 'passed');

  const declaredDependencySatisfiedResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105687,
    method: 'tools/call',
    params: { name: 'task_lifecycle_evidence_preflight', arguments: { task_number: 9217 } },
  }, builderRuntime);
  const declaredDependencySatisfied = await responsePayload(declaredDependencySatisfiedResponse, builderRuntime, 105688);
  assert.equal(declaredDependencySatisfied.dependency_satisfaction.all_satisfied, true);

  const rejectBlockingDependencyResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10569,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9214,
        agent_id: 'smart-scheduling.architect',
        outcome: 'rejected',
        summary: 'Blocking dependency review rejects the parent work and requires explicit disposition.',
        findings: [{ severity: 'blocking', description: 'Parent work does not yet meet the review dependency contract.' }],
        no_files_changed: true,
      },
    },
  }, architectRuntime);
  const rejectBlockingDependencyPayload = await responsePayload(rejectBlockingDependencyResponse, architectRuntime, 10570);
  assert.equal(rejectBlockingDependencyPayload.status, 'success', JSON.stringify(rejectBlockingDependencyPayload));
  assert.equal(rejectBlockingDependencyPayload.task_outcome.outcome, 'rejected');
  const blockingDependencyPreflightResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10571,
    method: 'tools/call',
    params: { name: 'task_lifecycle_evidence_preflight', arguments: { task_number: 9213 } },
  }, builderRuntime);
  const blockingDependencyPreflight = await responsePayload(blockingDependencyPreflightResponse, builderRuntime, 10572);
  const blockingDependency = blockingDependencyPreflight.dependency_satisfaction.dependencies[0];
  assert.equal(blockingDependencyPreflight.dependency_satisfaction.all_satisfied, false);
  assert.equal(blockingDependency.state, 'blocking_outcome');
  assert.equal(blockingDependency.disposition_required, true);
  assert.deepEqual(blockingDependency.blocking_outcomes, ['rejected']);
  assert.match(blockingDependency.blocking_reason, /requires explicit disposition/);
  assert.ok(blockingDependency.remediation_options.some((option: any) => option.tool === 'task_lifecycle_create'));
  assert.ok(blockingDependency.remediation_options.some((option: any) => option.tool === 'task_lifecycle_defer'));

  const rejectedDependencyParentCloseResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105721,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_close',
      arguments: {
        task_number: 9213,
        agent_id: 'smart-scheduling.builder',
      },
    },
  }, builderRuntime);
  const rejectedDependencyParentClose = await responsePayload(rejectedDependencyParentCloseResponse, builderRuntime, 105722);
  assert.equal(rejectedDependencyParentClose.status, 'blocked', JSON.stringify(rejectedDependencyParentClose));
  assert.equal(rejectedDependencyParentClose.error, 'task_close_dependencies_unsatisfied');
  const closeBlockingDependency = rejectedDependencyParentClose.dependency_satisfaction.dependencies[0];
  assert.equal(closeBlockingDependency.state, 'blocking_outcome');
  assert.equal(closeBlockingDependency.disposition_required, true);
  assert.ok(closeBlockingDependency.remediation_options.some((option: any) => option.tool === 'task_lifecycle_create'));
  assert.ok(closeBlockingDependency.remediation_options.some((option: any) => option.tool === 'task_lifecycle_defer'));
  assert.equal(rejectedDependencyParentClose.evidence_preflight.requirements.find((item: any) => item.id === 'dependencies').satisfied, false);

  const dependencyDispositionResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10573,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_dependency_disposition_record',
      arguments: {
        dependency_id: 'dep-blocking-review-9213-9214',
        agent_id: 'smart-scheduling.architect',
        kind: 'operator_deferred',
        summary: 'Operator explicitly defers remediation for this rejected dependency outcome.',
        authority_basis: { kind: 'operator_direct_instruction', summary: 'Regression fixture authorizes deferred disposition.' },
      },
    },
  }, architectRuntime);
  const dependencyDispositionPayload = await responsePayload(dependencyDispositionResponse, architectRuntime, 10574);
  assert.equal(dependencyDispositionPayload.status, 'recorded', JSON.stringify(dependencyDispositionPayload));
  assert.equal(dependencyDispositionPayload.dependency_satisfaction.all_satisfied, true);
  const dispositionDependency = dependencyDispositionPayload.dependency_satisfaction.dependencies[0];
  assert.equal(dispositionDependency.state, 'blocking_outcome');
  assert.equal(dispositionDependency.satisfied, true);
  assert.equal(dispositionDependency.disposition_required, false);
  assert.equal(dispositionDependency.blocking_reason, null);
  assert.equal(dispositionDependency.latest_disposition.kind, 'operator_deferred');
  assert.equal(dispositionDependency.latest_disposition.status, 'deferred');
  assert.deepEqual(dispositionDependency.remediation_options, []);

  const dispositionSatisfiedParentCloseResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105741,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_close',
      arguments: {
        task_number: 9213,
        agent_id: 'smart-scheduling.builder',
      },
    },
  }, builderRuntime);
  const dispositionSatisfiedParentClose = await responsePayload(dispositionSatisfiedParentCloseResponse, builderRuntime, 105742);
  assert.notEqual(dispositionSatisfiedParentClose.error, 'task_close_dependencies_unsatisfied', JSON.stringify(dispositionSatisfiedParentClose));

  const conflictRosterStore = openTaskLifecycleStore(siteRoot);
  try {
    conflictRosterStore.upsertRosterEntry({
      agent_id: 'smart-scheduling.same-builder',
      role: 'builder',
      capabilities_json: JSON.stringify(['implementation_work']),
      operator_identity: 'same-operator',
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'active',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:10:00Z',
    });
    conflictRosterStore.upsertRosterEntry({
      agent_id: 'smart-scheduling.same-architect',
      role: 'architect',
      capabilities_json: JSON.stringify(['review']),
      operator_identity: 'same-operator',
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'active',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:10:00Z',
    });
    assert.equal(conflictRosterStore.getRosterEntry('smart-scheduling.same-builder')?.operator_identity, 'same-operator');
    assert.equal(conflictRosterStore.getRosterEntry('smart-scheduling.same-architect')?.operator_identity, 'same-operator');
  } finally {
    conflictRosterStore.db.close();
  }

  const conflictReviewNextResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 105745,
    method: 'tools/call',
    params: { name: 'task_lifecycle_next', arguments: { agent_id: 'smart-scheduling.same-architect', limit: 20 } },
  }, sameArchitectRuntime);
  const conflictReviewNext = await responsePayload(conflictReviewNextResponse, sameArchitectRuntime, 105746);
  const conflictRecommendation = conflictReviewNext.recommendations.find((item: any) => item.task_number === 9216);
  assert.equal(conflictRecommendation.conflict_of_interest_risk.conflict_detected, true);
  assert.equal(conflictRecommendation.conflict_of_interest_risk.effective_operator_identity, 'same-operator');
  assert.equal(conflictRecommendation.conflict_of_interest_risk.gated_work_operator_identity, 'same-operator');
  assert.equal(conflictRecommendation.conflict_of_interest_risk.authorization_required, true);

  const conflictBlockedFinishResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10575,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9216,
        agent_id: 'smart-scheduling.same-architect',
        outcome: 'accepted',
        summary: 'Same-operator review dependency attempts to accept without explicit authority.',
        findings: [],
        no_files_changed: true,
      },
    },
  }, sameArchitectRuntime);
  const conflictBlockedFinishPayload = await responsePayload(conflictBlockedFinishResponse, sameArchitectRuntime, 10576);
  assert.equal(conflictBlockedFinishPayload.status, 'blocked', JSON.stringify(conflictBlockedFinishPayload));
  assert.equal(conflictBlockedFinishPayload.error, 'dependency_conflict_policy_authorization_required');
  assert.equal(conflictBlockedFinishPayload.conflicts[0].dependency_id, 'dep-conflict-review-9215-9216');
  assert.equal(conflictBlockedFinishPayload.conflicts[0].effective_operator_identity, 'same-operator');
  assert.equal(conflictBlockedFinishPayload.conflicts[0].gated_work_operator_identity, 'same-operator');
  assert.equal(conflictBlockedFinishPayload.override_allowed, true);
  assert.ok(conflictBlockedFinishPayload.eligible_alternatives.some((agent: any) => agent.agent_id === 'smart-scheduling.architect'));

  const conflictAuthorizedFinishResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10577,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: 9216,
        agent_id: 'smart-scheduling.same-architect',
        outcome: 'accepted',
        summary: 'Same-operator review dependency accepts with explicit operator authority.',
        findings: [],
        no_files_changed: true,
        authority_basis: { kind: 'operator_direct_instruction', summary: 'Regression fixture authorizes same-operator dependency completion.' },
      },
    },
  }, sameArchitectRuntime);
  const conflictAuthorizedFinishPayload = await responsePayload(conflictAuthorizedFinishResponse, sameArchitectRuntime, 10578);
  assert.equal(conflictAuthorizedFinishPayload.status, 'success', JSON.stringify(conflictAuthorizedFinishPayload));
  assert.equal(conflictAuthorizedFinishPayload.conflict_policy_evidence[0].conflict_detected, true);
  assert.equal(conflictAuthorizedFinishPayload.conflict_policy_evidence[0].authorization_required, true);
  assert.ok(conflictAuthorizedFinishPayload.conflict_policy_evidence[0].authorization_basis_json);
  const conflictDependencyPreflightResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 10579,
    method: 'tools/call',
    params: { name: 'task_lifecycle_evidence_preflight', arguments: { task_number: 9215 } },
  }, sameArchitectRuntime);
  const conflictDependencyPreflight = await responsePayload(conflictDependencyPreflightResponse, sameArchitectRuntime, 10580);
  const conflictDependency = conflictDependencyPreflight.dependency_satisfaction.dependencies[0];
  assert.equal(conflictDependency.satisfied, true);
  assert.equal(conflictDependency.conflict_policy_evidence.conflict_detected, true);
  assert.equal(conflictDependency.conflict_policy_evidence.authorization_satisfied, true);

  const submitWorkPlaceholderResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 1059,
    method: 'tools/call',
    params: {
      name: 'task_lifecycle_submit_work',
      arguments: {
        task_number: 9208,
        agent_id: 'smart-scheduling.builder',
        summary: 'Placeholder rejection check.',
        execution_notes: '<!-- Record what was done -->',
        verification: 'Verified by attempting placeholder text rejection.',
        changed_files: [`.ai/do-not-open/tasks/${submitWorkTaskId}.md`],
      },
    },
  }, builderRuntime);
  assert.match(submitWorkPlaceholderResponse.error?.message ?? '', /task_lifecycle_submit_work_execution_notes_not_substantive/);

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

  // 8. Reopened tasks ignore pre-reopen reports and create fresh dependency work.
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
  assert.equal(reopenedFinishPayload.review_action, 'dependency_requested');
  assert.equal(reopenedFinishPayload.close_action, 'skipped');
  assert.equal(reopenedFinishPayload.new_status, 'awaiting_dependencies');
  assert.equal(reopenedFinishPayload.blocked_by, 'dependencies');
  assert.equal(reopenedFinishPayload.review_dependency.dependency_kind, 'review');

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
  assert.equal(reopenedReviewPayload.completion_mode, 'review_compatibility_dependency_outcome');
  assert.equal(reopenedReviewPayload.close_action, 'skipped');
  assert.notEqual(reopenedReviewPayload.review_compatibility_dependency_outcome.task_outcome.outcome_id, 'review-reopened-stale-pre-reopen');
  assert.equal(reopenedReviewPayload.review_compatibility_dependency_outcome.task_outcome.outcome, 'accepted');
  assert.equal(reopenedReviewPayload.review_compatibility_dependency_outcome.dependency_satisfaction.all_satisfied, true);

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
  assert.equal(inspectRangePayload.tasks.find((task: Record<string, unknown>) => task.task_number === 9201).closure_evidence_posture.state, 'open_or_reviewing_with_current_preflight_blockers');
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
  mkdirSync(join(scopedSiteRoot, '.narada'), { recursive: true });
  mkdirSync(join(scopedSiteRoot, 'packages', 'example', 'src'), { recursive: true });
  mkdirSync(join(scopedSiteRoot, '.ai', 'tmp'), { recursive: true });
  writeFileSync(join(scopedSiteRoot, '.narada', 'task-lifecycle.toml'), '[roster]\nroles_are_obligation_targets = true\n', 'utf8');
  writeFileSync(
    join(scopedSiteRoot, '.ai', 'agents', 'roster.json'),
    JSON.stringify({
      version: 1,
      updated_at: '2026-06-04T00:00:00Z',
      agents: [
        {
          agent_id: '_site',
          role: 'site_metadata',
          capabilities: { default_reviewer_role: 'reviewer' },
          first_seen_at: '2026-06-04T00:00:00Z',
          last_active_at: '2026-06-04T00:00:00Z',
        },
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
  const payloadRefCompanionTaskId = '20260604-9305-payload-ref-companion-only-finish';
  const freshServerTaskId = '20260604-9306-fresh-server-finish-roster-capabilities';
  for (const [taskId, taskNumber] of [[scopedTaskId, 9301], [fullTaskId, 9302], [payloadRefTaskId, 9303], [payloadRefCompanionTaskId, 9305], [freshServerTaskId, 9306]] as const) {
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
      agent_id: '_site',
      role: 'site_metadata',
      capabilities_json: JSON.stringify({ default_reviewer_role: 'reviewer' }),
      first_seen_at: '2026-06-04T00:00:00Z',
      last_active_at: '2026-06-04T00:00:00Z',
      status: 'active',
      task_number: null,
      last_done: null,
      updated_at: '2026-06-04T00:00:00Z',
    });
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
    for (const [taskId, taskNumber] of [[scopedTaskId, 9301], [fullTaskId, 9302], [payloadRefTaskId, 9303], [followUpTaskId, 9304], [payloadRefCompanionTaskId, 9305], [freshServerTaskId, 9306]] as const) {
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

  const companionPayloadCreateResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 221,
    method: 'tools/call',
    params: {
      name: 'mcp_payload_create',
      arguments: {
        payload: {
          summary: 'Payload summary without identity fields should merge with authoritative top-level task_number and agent_id.',
          no_files_changed: true,
        },
      },
    },
  }, scopedRuntime);
  const companionPayload = await responsePayload(companionPayloadCreateResponse, scopedRuntime, 222);
  const companionPayloadFinishResponse = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: 223,
    method: 'tools/call',
    params: { name: 'task_lifecycle_finish', arguments: { payload_ref: companionPayload.ref, task_number: 9305, agent_id: 'scoped.builder' } },
  }, scopedRuntime);
  const companionPayloadFinish = await responsePayload(companionPayloadFinishResponse, scopedRuntime, 224);
  assert.equal(companionPayloadFinish.status, 'success');

  const freshServerPath = fileURLToPath(new URL('../src/task-lifecycle/task-mcp-server.js', import.meta.url));
  const freshInit = JSON.stringify({ jsonrpc: '2.0', id: 301, method: 'initialize', params: { protocolVersion: '2026-04-18', capabilities: {} } });
  const freshFinish = JSON.stringify({
    jsonrpc: '2.0',
    id: 302,
    method: 'tools/call',
    params: { name: 'task_lifecycle_finish', arguments: { task_number: 9306, agent_id: 'scoped.builder', summary: 'Fresh server finish.' } },
  });
  const freshServerFinish = spawnSync(process.execPath, [freshServerPath, '--site-root', scopedSiteRoot], {
    cwd: scopedSiteRoot,
    input: `${freshInit}\n${freshFinish}\n`,
    encoding: 'utf8',
    env: { ...process.env, NARADA_AGENT_ID: 'scoped.builder' },
    timeout: 10_000,
  });
  assert.equal(freshServerFinish.status, 0, freshServerFinish.stderr);
  const freshFrames = freshServerFinish.stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line));
  const freshFinishResponse = freshFrames.find((frame) => frame.id === 302);
  assert.ifError(freshFinishResponse.error);
  const freshFinishPayload = freshFinishResponse.result.structuredContent;
  assert.equal(freshFinishPayload.status, 'success');

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
    params: { name: 'task_lifecycle_audit', arguments: { since: '2026-01-01T00:00:00.000Z' } },
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
