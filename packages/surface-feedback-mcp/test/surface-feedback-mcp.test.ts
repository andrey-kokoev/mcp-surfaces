import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'surface-feedback-mcp-behavior-'));
let state: any;

try {
  state = createServerState({ feedbackRoot: root, canonicalFeedbackRoot: root });

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as Promise<Record<string, any>>;
  }
  async function callWith(callState: any, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, callState) as Promise<Record<string, any>>;
  }
  function view(res: Record<string, any>): Record<string, any> {
    return res.result.structuredContent as Record<string, any>;
  }
  function errorCode(res: Record<string, any>): string {
    return (res.error as Record<string, any>)?.data?.code ?? '';
  }

  const doctor = await call('surface_feedback_doctor', {});
  assert.equal(view(doctor).status, 'ok');
  assert.equal(view(doctor).storage_posture, 'canonical_feedback_root');
  assert.equal(view(doctor).uses_canonical_store, true);
  assert.equal(view(doctor).feedback_root, root);
  assert.equal(view(doctor).canonical_feedback_root, root);
  assert.match(view(doctor).db_path, /surface-feedback\.db$/);

  const liveProofTemplate = await call('surface_feedback_live_proof_template', {
    surface_id: 'cloudflare-carrier',
    workflow: 'projection-live-proof',
  });
  const liveProofData = view(liveProofTemplate);
  assert.equal(liveProofData.schema, 'narada.surface_feedback.live_proof_template.v1');
  assert.equal(liveProofData.surface_id, 'cloudflare-carrier');
  assert.equal(liveProofData.workflow, 'projection-live-proof');
  assert.ok(liveProofData.live_proof_contract.authority_location.deployed);
  assert.ok(liveProofData.live_proof_contract.transport.replay_vs_live_delivery);
  assert.ok(liveProofData.live_proof_contract.exclusions.no_mock);
  assert.ok(liveProofData.live_proof_contract.negative_controls.revocation_or_refusal_proof);
  assert.ok(liveProofData.live_proof_contract.test_alignment.unit_tests_specify_deployed_transport);

  const noncanonicalState = createServerState({ feedbackRoot: join(root, 'site-local'), canonicalFeedbackRoot: root });
  const noncanonicalDoctor = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'surface_feedback_doctor', arguments: {} } }, noncanonicalState) as Record<string, any>;
  assert.equal(view(noncanonicalDoctor).status, 'warning');
  assert.equal(view(noncanonicalDoctor).storage_posture, 'noncanonical_feedback_root');
  assert.equal(view(noncanonicalDoctor).uses_canonical_store, false);
  assert.match(view(noncanonicalDoctor).diagnostic, /Cross-site feedback may be invisible/);
  assert.match(view(noncanonicalDoctor).remediation, /--feedback-root/);
  noncanonicalState.db.close();

  const sub = await call('surface_feedback_submit', {
    surface_id: 'sop',
    submitter_site_id: 'narada-sonar',
    submitter_principal: 'andrey-user.Kevin',
    kind: 'improvement',
    summary: 'Add agent step kind',
    details: 'SOP should support agent executor with blocking for agent-performed steps.',
  });
  const subData = view(sub);
  assert.equal(subData.status, 'submitted');
  assert.ok(subData.feedback_id);
  assert.equal(subData.surface_id, 'sop');

  const update = await call('surface_feedback_update_status', {
    feedback_id: subData.feedback_id,
    status: 'closed',
    resolved_by: 'andrey-user.test',
    resolution_note: 'Covered by behavior test.',
  });
  const updateData = view(update).feedback as Record<string, any>;
  assert.equal(updateData.status, 'closed');
  assert.equal(updateData.resolved_by, 'andrey-user.test');
  assert.equal(updateData.resolution_note, 'Covered by behavior test.');

  // --- update_status: converted_to_task ---
  const converted = await call('surface_feedback_submit', {
    surface_id: 'delegated-task',
    submitter_site_id: 'andrey-user',
    submitter_principal: 'test-agent',
    kind: 'bug',
    summary: 'Test converted_to_task status',
    details: 'Verifying the new status is accepted.',
  });
  const convertedId = view(converted).feedback_id;
  const convertUpdate = await call('surface_feedback_update_status', {
    feedback_id: convertedId,
    status: 'converted_to_task',
    resolved_by: 'andrey-user.test',
    resolution_note: 'Task #999 created to address this feedback.',
    task_ref: 'task #999',
    task_status: 'in_review',
  });
  const convertData = view(convertUpdate).feedback as Record<string, any>;
  assert.equal(convertData.status, 'converted_to_task');
  assert.equal(convertData.resolution_note, 'Task #999 created to address this feedback.');
  assert.equal(convertData.task_ref, 'task #999');
  assert.equal(convertData.task_status, 'in_review');

  const actionableQueue = await call('surface_feedback_actionable_queue', {
    caller_site_id: 'andrey-user',
    limit: 10,
  });
  const actionableData = view(actionableQueue);
  assert.equal(actionableData.schema, 'narada.surface_feedback.actionable_queue.v1');
  assert.equal(actionableData.total_count, 1);
  assert.equal(actionableData.count, 1);
  assert.equal(actionableData.has_more, false);
  assert.equal(actionableData.items[0].feedback_id, convertedId);
  assert.equal(actionableData.items[0].actionability, 'task_follow_up');
  assert.deepEqual(actionableData.items[0].task_link, {
    task_ref: 'task #999',
    lifecycle_state: 'in_review',
    lifecycle_state_source: 'feedback_projection',
  });

  const actionableStranger = await call('surface_feedback_actionable_queue', {
    caller_site_id: 'narada-revolution',
    limit: 10,
  });
  assert.equal(view(actionableStranger).total_count, 0);

  // --- convert_to_task: success, duplicate, visibility, and task-create failure ---
  const handoffRoot = join(root, 'handoff');
  const handoffCalls: string[] = [];
  const handoffRequests: any[] = [];
  let failHandoffTaskCreation = false;
  let nextHandoffTaskNumber = 1982;
  const handoffState = createServerState({
    feedbackRoot: handoffRoot,
    canonicalFeedbackRoot: handoffRoot,
    taskLifecycleRequest: async (request: any) => {
      handoffRequests.push(request);
      const name = request.params?.name;
      handoffCalls.push(name);
      if (name === 'mcp_payload_create') {
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: { structuredContent: { status: 'created', ref: 'mcp_payload:test-handoff@v1' } },
        };
      }
      if (name === 'task_lifecycle_create') {
        if (failHandoffTaskCreation) throw new Error('simulated_task_create_failure');
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            structuredContent: {
              schema: 'narada.task.create.v0',
              status: 'created',
              task_number: nextHandoffTaskNumber,
              task_id: `20260711-${nextHandoffTaskNumber}-feedback-handoff-test`,
              task_status: 'opened',
            },
          },
        };
      }
      throw new Error(`unexpected_task_lifecycle_tool:${name}`);
    },
  });
  try {
    const failedSource = await callWith(handoffState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'andrey-user',
      submitter_principal: 'handoff-test',
      kind: 'gap',
      summary: 'Task creation failure remains unlinked',
      details: 'The feedback must remain truthful when task creation fails.',
    });
    failHandoffTaskCreation = true;
    const failedConversion = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: view(failedSource).feedback_id,
      caller_site_id: 'andrey-user',
      resolved_by: 'handoff-test',
    });
    assert.equal(errorCode(failedConversion), 'feedback_task_create_failed');
    assert.equal(failedConversion.error.data.stage, 'task_lifecycle_create');
    const failedReadback = await callWith(handoffState, 'surface_feedback_show', { feedback_id: view(failedSource).feedback_id });
    assert.equal(view(failedReadback).status, 'submitted');
    assert.equal(view(failedReadback).task_ref, null);
    assert.equal(view(failedReadback).task_status, null);
    assert.deepEqual(handoffCalls, ['mcp_payload_create', 'task_lifecycle_create']);

    failHandoffTaskCreation = false;
    handoffCalls.length = 0;
    const successSource = await callWith(handoffState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'andrey-user',
      submitter_principal: 'handoff-test',
      kind: 'improvement',
      summary: 'Create one linked task from feedback',
      details: 'The successful conversion should return a lifecycle next action.',
    });
    const successFeedbackId = view(successSource).feedback_id;
    const successConversion = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: successFeedbackId,
      caller_site_id: 'andrey-user',
      resolved_by: 'handoff-test',
    });
    const successData = view(successConversion);
    assert.equal(successData.schema, 'narada.surface_feedback.convert_to_task.v1');
    assert.equal(successData.status, 'converted');
    assert.equal(successData.task_ref, 'task #1982');
    assert.equal(successData.task_number, 1982);
    assert.equal(successData.task_status, 'opened');
    assert.equal(successData.next_action.surface_id, 'task-lifecycle');
    assert.equal(successData.next_action.tool, 'task_lifecycle_show');
    assert.deepEqual(successData.next_action.arguments, { task_number: 1982 });
    assert.deepEqual(handoffCalls, ['mcp_payload_create', 'task_lifecycle_create']);
    assert.equal(handoffRequests[handoffRequests.length - 2].params.arguments.payload.idempotency_key, `surface-feedback:${successFeedbackId}`);

    const handoffReadback = await callWith(handoffState, 'surface_feedback_show', { feedback_id: successFeedbackId });
    assert.equal(view(handoffReadback).status, 'converted_to_task');
    assert.equal(view(handoffReadback).task_ref, 'task #1982');
    assert.equal(view(handoffReadback).task_status, 'opened');
    handoffCalls.length = 0;
    const duplicateConversion = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: successFeedbackId,
      caller_site_id: 'andrey-user',
      resolved_by: 'handoff-test',
    });
    assert.equal(view(duplicateConversion).status, 'already_linked');
    assert.equal(view(duplicateConversion).task_ref, 'task #1982');
    assert.deepEqual(handoffCalls, []);

    const privateSource = await callWith(handoffState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'narada-sonar',
      submitter_principal: 'handoff-test',
      kind: 'bug',
      summary: 'Inaccessible feedback must not convert',
    });
    const blockedConversion = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: view(privateSource).feedback_id,
      caller_site_id: 'andrey-user',
      resolved_by: 'handoff-test',
    });
    assert.equal(errorCode(blockedConversion), 'feedback_not_visible');
    const missingConversion = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: 'sfb_missing_convert',
      caller_site_id: 'andrey-user',
      resolved_by: 'handoff-test',
    });
    assert.equal(errorCode(missingConversion), 'feedback_not_found');
  } finally {
    handoffState.db.close();
  }

  const batchA = await call('surface_feedback_submit', {
    surface_id: 'surface-feedback',
    submitter_site_id: 'andrey-user',
    submitter_principal: 'test-agent',
    kind: 'improvement',
    summary: 'Batch convert first item',
    details: 'First batch item.',
  });
  const batchB = await call('surface_feedback_submit', {
    surface_id: 'task-lifecycle',
    submitter_site_id: 'andrey-user',
    submitter_principal: 'test-agent',
    kind: 'gap',
    summary: 'Batch convert second item',
    details: 'Second batch item.',
  });
  const batchUpdate = await call('surface_feedback_update_status_batch', {
    resolved_by: 'andrey-user.batch-test',
    updates: [
      { feedback_id: view(batchA).feedback_id, status: 'converted_to_task', task_ref: 'task #1276', resolution_note: 'Created task from feedback.' },
      { feedback_id: view(batchB).feedback_id, status: 'routed', resolution_note: 'Routed for follow-up.', resolved_by: 'andrey-user.router' },
      { feedback_id: 'sfb_missing_batch', status: 'converted_to_task', task_ref: 'task #9999', resolution_note: 'Missing item should not block successful updates.' },
    ],
  });
  const batchData = view(batchUpdate);
  assert.equal(batchData.status, 'partial');
  assert.equal(batchData.updated_count, 2);
  assert.equal(batchData.failed_count, 1);
  assert.equal(batchData.updates[0].task_ref, 'task #1276');
  assert.match(batchData.updates[0].feedback.resolution_note, /Task: task #1276/);
  assert.equal(batchData.updates[1].feedback.resolved_by, 'andrey-user.router');
  assert.equal(batchData.failures[0].code, 'feedback_not_found');

  // --- invalid status still rejected ---
  const invalidStatus = await call('surface_feedback_update_status', {
    feedback_id: convertedId,
    status: 'in_progress',
    resolved_by: 'andrey-user.test',
    resolution_note: 'Should be rejected.',
  });
  assert.equal(errorCode(invalidStatus), 'feedback_invalid_status');

  await call('surface_feedback_submit', {
    surface_id: 'scheduler',
    submitter_site_id: 'narada-proper',
    submitter_principal: 'test-agent',
    kind: 'bug',
    summary: 'Task create fails when arguments contain spaces',
    details: 'The space in arguments is not properly quoted when passing to schtasks.exe.',
  });

  await call('surface_feedback_submit', {
    surface_id: 'sop',
    submitter_site_id: 'andrey-user',
    submitter_principal: 'andrey',
    kind: 'gap',
    summary: 'SOP missing retry step kind',
    details: '',
  });

  await call('surface_feedback_submit', {
    surface_id: 'filesystem',
    submitter_site_id: 'narada-sonar',
    submitter_principal: 'andrey-user.Kevin',
    kind: 'observation',
    summary: 'Read file output ref truncated on large files',
    details: '',
  });

  // --- list: no scope (all visible) ---
  const listAll = await call('surface_feedback_list', {});
  assert.equal(view(listAll).count, 7);
  assert.equal(view(listAll).store.feedback_root, root);
  assert.equal(view(listAll).store.uses_canonical_store, true);

  // --- list: by surface_id ---
  const listSop = await call('surface_feedback_list', { surface_id: 'sop' });
  assert.equal(view(listSop).count, 2);

  // --- list: by submitter_site_id ---
  const listBySite = await call('surface_feedback_list', { submitter_site_id: 'narada-proper' });
  assert.equal(view(listBySite).count, 1);

  // --- list: pagination (limit + offset) ---
  const listPage1 = await call('surface_feedback_list', { limit: 2, offset: 0 });
  assert.equal(view(listPage1).count, 2);
  const listPage2 = await call('surface_feedback_list', { limit: 2, offset: 2 });
  assert.equal(view(listPage2).count, 2);
  const itemsP1 = view(listPage1).items as any[];
  const itemsP2 = view(listPage2).items as any[];
  assert.notDeepEqual(itemsP1.map((i: any) => i.feedback_id), itemsP2.map((i: any) => i.feedback_id));

  // --- visibility: caller site sees own submissions only (no owned surfaces) ---
  const listSonarOnly = await call('surface_feedback_list', { caller_site_id: 'narada-sonar' });
  assert.equal(view(listSonarOnly).count, 2); // 2 entries submitted by narada-sonar

  // --- visibility: caller with owned surfaces sees own + maintained surface feedback ---
  const listAndreyMaintainer = await call('surface_feedback_list', {
    caller_site_id: 'andrey-user',
    owned_surface_ids: ['sop'],
  });
  assert.equal(view(listAndreyMaintainer).count, 5); // andrey-user's own submissions overlap with sop surface ownership

  // --- visibility: different site with no owned surfaces sees nothing ---
  const listStranger = await call('surface_feedback_list', { caller_site_id: 'narada-revolution' });
  assert.equal(view(listStranger).count, 0);

  // --- show: visible (own submission) ---
  const show = await call('surface_feedback_show', { feedback_id: subData.feedback_id });
  assert.equal(view(show).summary, 'Add agent step kind');
  assert.equal(view(show).status, 'closed');
  assert.equal(view(show).details, 'SOP should support agent executor with blocking for agent-performed steps.');
  assert.equal(view(show).store.db_path, state.dbPath);

  // --- show: visible via owned surface ---
  const showSop = await call('surface_feedback_show', {
    feedback_id: subData.feedback_id,
    caller_site_id: 'andrey-user',
    owned_surface_ids: ['sop'],
  });
  assert.equal(view(showSop).feedback_id, subData.feedback_id);

  // --- show: not visible ---
  const showBlockedRes = await call('surface_feedback_show', {
    feedback_id: subData.feedback_id,
    caller_site_id: 'narada-revolution',
  });
  assert.equal(errorCode(showBlockedRes), 'feedback_not_visible');

  const showMissing = await call('surface_feedback_show', { feedback_id: 'sfb_missing' });
  assert.equal(errorCode(showMissing), 'feedback_not_found');
  assert.equal(showMissing.error.data.db_path.endsWith('surface-feedback.db'), true);
  assert.match(showMissing.error.data.store_hint, /feedback_root/);

  // --- import: repair explicit feedback IDs from a site-local split-brain store ---
  const siteLocalRoot = join(root, 'split-brain-site');
  const siteLocalState = createServerState({ feedbackRoot: siteLocalRoot, canonicalFeedbackRoot: root });
  try {
    const siteLocalSubmit = await callWith(siteLocalState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'narada-staccato',
      submitter_principal: 'staccato.test',
      kind: 'gap',
      summary: 'Local feedback is invisible to maintainers',
      details: 'Submitted through a site-local store before canonical feedback root was configured.',
    });
    const localFeedbackId = view(siteLocalSubmit).feedback_id;
    const localLinkUpdate = await callWith(siteLocalState, 'surface_feedback_update_status', {
      feedback_id: localFeedbackId,
      status: 'converted_to_task',
      resolved_by: 'staccato.test',
      resolution_note: 'Linked from site-local feedback.',
      task_ref: 'task #88',
      task_status: 'claimed',
    });
    assert.equal(view(localLinkUpdate).feedback.task_ref, 'task #88');
    const missingBeforeImport = await call('surface_feedback_show', { feedback_id: localFeedbackId });
    assert.equal(errorCode(missingBeforeImport), 'feedback_not_found');

    const importResult = await call('surface_feedback_import', {
      source_feedback_root: siteLocalRoot,
      feedback_ids: [localFeedbackId, 'sfb_missing_local'],
    });
    const importData = view(importResult);
    assert.equal(importData.status, 'partial');
    assert.equal(importData.imported_count, 1);
    assert.equal(importData.missing_count, 1);
    assert.equal(importData.imported[0].feedback_id, localFeedbackId);
    assert.equal(importData.store.feedback_root, root);
    assert.equal(importData.source_db_path, siteLocalState.dbPath);
    assert.equal(importData.target_db_path, state.dbPath);

    const importedShow = await call('surface_feedback_show', { feedback_id: localFeedbackId });
    assert.equal(view(importedShow).summary, 'Local feedback is invisible to maintainers');
    assert.equal(view(importedShow).task_ref, 'task #88');
    assert.equal(view(importedShow).task_status, 'claimed');
    assert.equal(view(importedShow).store.uses_canonical_store, true);

    const duplicateImport = await call('surface_feedback_import', {
      source_db_path: siteLocalState.dbPath,
      feedback_ids: [localFeedbackId],
    });
    assert.equal(view(duplicateImport).imported_count, 0);
    assert.equal(view(duplicateImport).skipped_count, 1);
    assert.equal(view(duplicateImport).skipped[0].reason, 'already_exists');
  } finally {
    siteLocalState.db.close();
  }

  // --- stats: no scope ---
  const statsAll = await call('surface_feedback_stats', {});
  const statsAllData = view(statsAll);
  assert.equal(statsAllData.total, 8);
  assert.ok(statsAllData.by_surface.sop >= 2);
  assert.ok(statsAllData.by_kind.improvement >= 1);
  assert.ok(statsAllData.by_kind.bug >= 1);
  assert.ok(statsAllData.by_kind.gap >= 1);
  assert.ok(statsAllData.by_status.submitted >= 3);
  assert.ok(statsAllData.by_status.routed >= 1);
  assert.ok(statsAllData.by_status.closed >= 1);
  assert.ok(statsAllData.by_status.converted_to_task >= 1);

  // --- stats: scoped to caller_site_id ---
  const statsSonar = await call('surface_feedback_stats', { caller_site_id: 'narada-sonar' });
  assert.equal(view(statsSonar).total, 2);

  // --- stats: scoped with owned surfaces ---
  const statsAndrey = await call('surface_feedback_stats', {
    caller_site_id: 'andrey-user',
    owned_surface_ids: ['sop'],
  });
  assert.equal(view(statsAndrey).total, 5); // overlaps: own submissions are also sop surface entries

  // --- stats: surface filter ---
  const statsSop = await call('surface_feedback_stats', { surface_id: 'sop' });
  assert.equal(view(statsSop).total, 2);

  console.log('surface-feedback-mcp behavior ok');
} finally {
  if (state) state.db.close();
  rmSync(root, { recursive: true, force: true });
}
