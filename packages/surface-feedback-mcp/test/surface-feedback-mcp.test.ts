import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeServerState, createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'surface-feedback-mcp-behavior-'));
let state: any;

try {
  mkdirSync(join(root, '.ai'), { recursive: true });
  state = createServerState({
    feedbackRoot: root,
    canonicalFeedbackRoot: root,
    taskLifecycleRoot: root,
    authoritySiteId: 'andrey-user',
    authorityOwnedSurfaceIds: ['sop', 'delegated-task', 'surface-feedback', 'task-lifecycle'],
  });

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
  assert.equal(view(doctor).task_lifecycle_root_configured, true);
  assert.equal(view(doctor).task_lifecycle_health, 'unverified');
  assert.equal(view(doctor).task_lifecycle_integration, 'isolated_stdio_process');
  assert.equal(view(doctor).authority.site_id, 'andrey-user');
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

  state.db.exec("CREATE TRIGGER reject_submitted_audit BEFORE INSERT ON feedback_events WHEN NEW.event_type = 'submitted' BEGIN SELECT RAISE(ABORT, 'simulated_submitted_audit_failure'); END");
  const atomicSubmitFailure = await call('surface_feedback_submit', {
    surface_id: 'sop',
    submitter_site_id: 'andrey-user',
    submitter_principal: 'atomic-test',
    kind: 'bug',
    summary: 'This submission must roll back with its audit event',
  });
  assert.equal(errorCode(atomicSubmitFailure), 'surface_feedback_error');
  assert.equal(Number((state.db.prepare("SELECT COUNT(*) AS count FROM feedback_entries WHERE summary = 'This submission must roll back with its audit event'").get() as any).count), 0);
  state.db.exec('DROP TRIGGER reject_submitted_audit');

  const noncanonicalState = createServerState({
    feedbackRoot: join(root, 'site-local'),
    canonicalFeedbackRoot: root,
    taskLifecycleRoot: root,
    authoritySiteId: 'andrey-user',
  });
  const noncanonicalDoctor = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'surface_feedback_doctor', arguments: {} } }, noncanonicalState) as Record<string, any>;
  assert.equal(view(noncanonicalDoctor).status, 'warning');
  assert.equal(view(noncanonicalDoctor).storage_posture, 'noncanonical_feedback_root');
  assert.equal(view(noncanonicalDoctor).uses_canonical_store, false);
  assert.ok(view(noncanonicalDoctor).diagnostics.some((item: string) => /noncanonical/.test(item)));
  assert.ok(view(noncanonicalDoctor).remediation.some((item: string) => /--feedback-root/.test(item)));
  const noncanonicalRead = await callWith(noncanonicalState, 'surface_feedback_list', { scope: 'all_authorized' });
  assert.equal(errorCode(noncanonicalRead), 'feedback_global_read_requires_canonical_store');
  await closeServerState(noncanonicalState);

  const unconfiguredState = createServerState({
    feedbackRoot: join(root, 'unconfigured'),
    canonicalFeedbackRoot: join(root, 'unconfigured'),
    taskLifecycleRoot: root,
  });
  const unconfiguredRead = await callWith(unconfiguredState, 'surface_feedback_list', { scope: 'all_authorized' });
  assert.equal(errorCode(unconfiguredRead), 'feedback_global_read_requires_server_authority');
  await closeServerState(unconfiguredState);

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

  state.db.exec("CREATE TRIGGER reject_status_audit BEFORE INSERT ON feedback_events WHEN NEW.event_type = 'status_updated' BEGIN SELECT RAISE(ABORT, 'simulated_status_audit_failure'); END");
  const atomicStatusFailure = await call('surface_feedback_update_status', {
    feedback_id: subData.feedback_id,
    status: 'closed',
    resolved_by: 'spoofed-principal',
    resolution_note: 'This projection must roll back.',
  });
  assert.equal(errorCode(atomicStatusFailure), 'surface_feedback_error');
  const atomicStatusReadback = await call('surface_feedback_show', { feedback_id: subData.feedback_id, scope: 'all_authorized' });
  assert.equal(view(atomicStatusReadback).status, 'submitted');
  assert.equal(view(atomicStatusReadback).audit_events.length, 1);
  state.db.exec('DROP TRIGGER reject_status_audit');

  const update = await call('surface_feedback_update_status', {
    feedback_id: subData.feedback_id,
    status: 'closed',
    resolved_by: 'andrey-user.test',
    resolution_note: 'Covered by behavior test.',
  });
  const updateData = view(update).feedback as Record<string, any>;
  assert.equal(updateData.status, 'closed');
  assert.equal(updateData.resolved_by, 'surface-feedback@andrey-user');
  assert.equal(updateData.resolution_note, 'Covered by behavior test.');
  const updateReadback = await call('surface_feedback_show', { feedback_id: subData.feedback_id, scope: 'all_authorized' });
  assert.deepEqual(view(updateReadback).audit_events.map((event: any) => event.event_type), ['submitted', 'status_updated']);
  assert.equal(view(updateReadback).audit_events[1].actor_principal, 'surface-feedback@andrey-user');

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

  const crossSite = await call('surface_feedback_submit', {
    surface_id: 'structured-command',
    submitter_site_id: 'smart-scheduling',
    submitter_principal: 'smart-scheduling.test',
    kind: 'bug',
    summary: 'Cross-site feedback must remain discoverable',
    details: 'The actionable queue must not silently narrow to the caller site.',
  });
  const crossSiteId = view(crossSite).feedback_id;

  const actionableQueue = await call('surface_feedback_actionable_queue', {
    scope: 'all_authorized',
    limit: 10,
  });
  const actionableData = view(actionableQueue);
  assert.equal(actionableData.schema, 'narada.surface_feedback.actionable_queue.v1');
  assert.equal(actionableData.read_scope.mode, 'all_authorized');
  assert.equal(actionableData.read_scope.scope_limited, false);
  assert.equal(actionableData.total_count, 2);
  assert.equal(actionableData.count, 2);
  assert.equal(actionableData.has_more, false);
  assert.equal(actionableData.items.some((item: any) => item.feedback_id === crossSiteId), true);
  const actionableConverted = actionableData.items.find((item: any) => item.feedback_id === convertedId);
  assert.equal(actionableConverted.actionability, 'task_follow_up');
  assert.deepEqual(actionableConverted.task_link, {
    task_ref: 'task #999',
    lifecycle_state: 'in_review',
    lifecycle_state_source: 'feedback_projection',
  });

  const actionableMine = await call('surface_feedback_actionable_queue', {
    scope: 'authority_site_submissions',
    limit: 10,
  });
  assert.equal(view(actionableMine).read_scope.mode, 'authority_site_submissions');
  assert.equal(view(actionableMine).total_count, 1);
  assert.equal(view(actionableMine).items[0].feedback_id, convertedId);

  const actionableOwned = await call('surface_feedback_actionable_queue', {
    scope: 'owned_surfaces',
    limit: 10,
  });
  assert.equal(view(actionableOwned).read_scope.mode, 'owned_surfaces');
  assert.equal(view(actionableOwned).total_count, 1);
  assert.equal(view(actionableOwned).items[0].feedback_id, convertedId);

  const actionableAuthorityVisible = await call('surface_feedback_actionable_queue', {
    scope: 'authority_visible',
    limit: 10,
  });
  assert.equal(view(actionableAuthorityVisible).read_scope.mode, 'authority_visible');
  assert.ok(view(actionableAuthorityVisible).items.every((item: any) => item.submitter_site_id === 'andrey-user' || ['sop', 'delegated-task', 'surface-feedback', 'task-lifecycle'].includes(item.surface_id)));
  assert.equal(view(actionableAuthorityVisible).items.some((item: any) => item.feedback_id === crossSiteId), false);

  const legacyActionable = await call('surface_feedback_actionable_queue', { caller_site_id: 'andrey-user' });
  assert.equal(errorCode(legacyActionable), 'feedback_read_scope_server_bound');

  // --- convert_to_task: success, duplicate, visibility, and task-create failure ---
  const handoffRoot = join(root, 'handoff');
  const handoffCalls: string[] = [];
  const handoffRequests: any[] = [];
  let failHandoffTaskCreation = false;
  let nextHandoffTaskNumber = 1982;
  const handoffState = createServerState({
    feedbackRoot: handoffRoot,
    canonicalFeedbackRoot: handoffRoot,
    authoritySiteId: 'andrey-user',
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
        const taskNumber = nextHandoffTaskNumber++;
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            structuredContent: {
              schema: 'narada.task.create.v0',
              status: 'created',
              task_number: taskNumber,
              task_id: `20260711-${taskNumber}-feedback-handoff-test`,
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
      resolved_by: 'handoff-test',
    });
    assert.equal(errorCode(failedConversion), 'feedback_task_handoff_failed');
    assert.equal(failedConversion.error.data.stage, 'task_lifecycle_create');
    const failedReadback = await callWith(handoffState, 'surface_feedback_show', { feedback_id: view(failedSource).feedback_id, scope: 'all_authorized' });
    assert.equal(view(failedReadback).status, 'submitted');
    assert.equal(view(failedReadback).task_ref, null);
    assert.equal(view(failedReadback).task_status, null);
    assert.equal(view(failedReadback).task_handoff.status, 'failed');
    assert.equal(view(failedReadback).task_handoff.payload_ref, 'mcp_payload:test-handoff@v1');
    assert.deepEqual(handoffCalls, ['mcp_payload_create', 'task_lifecycle_create']);

    failHandoffTaskCreation = false;
    handoffCalls.length = 0;
    const recoveredConversion = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: view(failedSource).feedback_id,
      resolved_by: 'handoff-test',
    });
    assert.equal(view(recoveredConversion).status, 'recovered');
    assert.equal(view(recoveredConversion).task_ref, 'task #1982');
    assert.deepEqual(handoffCalls, ['task_lifecycle_create']);

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
      resolved_by: 'handoff-test',
    });
    const successData = view(successConversion);
    assert.equal(successData.schema, 'narada.surface_feedback.convert_to_task.v1');
    assert.equal(successData.status, 'converted');
    assert.equal(successData.task_ref, 'task #1983');
    assert.equal(successData.task_number, 1983);
    assert.equal(successData.task_status, 'opened');
    assert.equal(successData.next_action.surface_id, 'task-lifecycle');
    assert.equal(successData.next_action.tool, 'task_lifecycle_show');
    assert.deepEqual(successData.next_action.arguments, { task_number: 1983 });
    assert.deepEqual(handoffCalls, ['mcp_payload_create', 'task_lifecycle_create']);
    assert.equal(handoffRequests[handoffRequests.length - 2].params.arguments.payload.idempotency_key, `surface-feedback:${successFeedbackId}`);

    const handoffReadback = await callWith(handoffState, 'surface_feedback_show', { feedback_id: successFeedbackId, scope: 'all_authorized' });
    assert.equal(view(handoffReadback).status, 'converted_to_task');
    assert.equal(view(handoffReadback).task_ref, 'task #1983');
    assert.equal(view(handoffReadback).task_status, 'opened');
    handoffCalls.length = 0;
    const duplicateConversion = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: successFeedbackId,
      resolved_by: 'handoff-test',
    });
    assert.equal(view(duplicateConversion).status, 'already_linked');
    assert.equal(view(duplicateConversion).task_ref, 'task #1983');
    assert.deepEqual(handoffCalls, []);

    const linkFailureSource = await callWith(handoffState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'andrey-user',
      submitter_principal: 'handoff-test',
      kind: 'bug',
      summary: 'Recover a created task after link persistence failure',
    });
    const linkFailureId = view(linkFailureSource).feedback_id;
    handoffState.db.exec(`CREATE TRIGGER simulate_feedback_link_failure BEFORE UPDATE OF task_ref ON feedback_entries WHEN OLD.feedback_id = '${linkFailureId}' BEGIN SELECT RAISE(ABORT, 'simulated_link_failure'); END`);
    handoffCalls.length = 0;
    const linkFailure = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: linkFailureId,
      resolved_by: 'handoff-test',
    });
    assert.equal(errorCode(linkFailure), 'feedback_task_link_failed');
    assert.equal(linkFailure.error.data.handoff_status, 'task_created');
    assert.deepEqual(handoffCalls, ['mcp_payload_create', 'task_lifecycle_create']);
    const failedLinkReadback = await callWith(handoffState, 'surface_feedback_show', { feedback_id: linkFailureId, scope: 'all_authorized' });
    assert.equal(view(failedLinkReadback).status, 'submitted');
    assert.equal(view(failedLinkReadback).task_handoff.status, 'task_created');
    assert.equal(view(failedLinkReadback).task_handoff.task_ref, 'task #1984');
    handoffState.db.exec('DROP TRIGGER simulate_feedback_link_failure');
    handoffCalls.length = 0;
    const repairedLink = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: linkFailureId,
      resolved_by: 'handoff-test',
    });
    assert.equal(view(repairedLink).status, 'recovered');
    assert.equal(view(repairedLink).task_ref, 'task #1984');
    assert.deepEqual(handoffCalls, []);
    const repairedLinkReadback = await callWith(handoffState, 'surface_feedback_show', { feedback_id: linkFailureId, scope: 'all_authorized' });
    assert.deepEqual(
      view(repairedLinkReadback).audit_events.map((event: any) => event.event_type),
      ['submitted', 'task_handoff_reserved', 'task_payload_created', 'task_created', 'task_link_failed', 'task_handoff_resumed', 'task_linked'],
    );

    const postCreateSource = await callWith(handoffState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'andrey-user',
      submitter_principal: 'handoff-test',
      kind: 'bug',
      summary: 'Preserve returned task identity when local audit persistence fails',
    });
    const postCreateId = view(postCreateSource).feedback_id;
    handoffState.db.exec("CREATE TRIGGER reject_task_created_audit BEFORE INSERT ON feedback_events WHEN NEW.event_type = 'task_created' BEGIN SELECT RAISE(ABORT, 'simulated_task_created_audit_failure'); END");
    const postCreateFailure = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: postCreateId,
      resolved_by: 'spoofed-handoff-principal',
    });
    assert.equal(errorCode(postCreateFailure), 'feedback_task_post_create_persist_failed');
    assert.equal(postCreateFailure.error.data.stage, 'task_audit_persist');
    assert.equal(postCreateFailure.error.data.task_ref, 'task #1985');
    handoffState.db.exec('DROP TRIGGER reject_task_created_audit');
    const postCreateReadback = await callWith(handoffState, 'surface_feedback_show', { feedback_id: postCreateId, scope: 'all_authorized' });
    assert.equal(view(postCreateReadback).task_handoff.status, 'task_created');
    assert.equal(view(postCreateReadback).task_handoff.task_ref, 'task #1985');
    assert.equal(view(postCreateReadback).task_handoff.last_error_code, 'surface_feedback_error');

    const contentionSource = await callWith(handoffState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'andrey-user',
      submitter_principal: 'handoff-test',
      kind: 'observation',
      summary: 'An active handoff lease excludes concurrent conversion',
    });
    const contentionId = view(contentionSource).feedback_id;
    const leaseNow = new Date().toISOString();
    const leaseExpiry = new Date(Date.now() + 60_000).toISOString();
    handoffState.db.prepare('INSERT INTO feedback_task_handoffs (feedback_id, idempotency_key, status, payload_ref, attempt_count, lease_owner, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      contentionId,
      `surface-feedback:${contentionId}`,
      'payload_created',
      'mcp_payload:contention@v1',
      1,
      'other-converter',
      leaseExpiry,
      leaseNow,
      leaseNow,
    );
    handoffCalls.length = 0;
    const contention = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: contentionId,
      resolved_by: 'handoff-test',
    });
    assert.equal(errorCode(contention), 'feedback_task_handoff_in_progress');
    assert.deepEqual(handoffCalls, []);

    const sharedRaceSource = await callWith(handoffState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'andrey-user',
      submitter_principal: 'handoff-test',
      kind: 'bug',
      summary: 'Only one server process acquires a shared handoff lease',
    });
    const sharedRaceId = view(sharedRaceSource).feedback_id;
    const competingState = createServerState({
      feedbackRoot: handoffRoot,
      canonicalFeedbackRoot: handoffRoot,
      authoritySiteId: 'andrey-user',
      taskLifecycleRequest: async () => { throw new Error('competing_server_must_not_reach_task_lifecycle'); },
    });
    try {
      handoffCalls.length = 0;
      const [raceWinner, raceLoser] = await Promise.all([
        callWith(handoffState, 'surface_feedback_convert_to_task', { feedback_id: sharedRaceId, resolved_by: 'handoff-test' }),
        callWith(competingState, 'surface_feedback_convert_to_task', { feedback_id: sharedRaceId, resolved_by: 'handoff-test' }),
      ]);
      assert.equal(view(raceWinner).status, 'converted');
      assert.equal(errorCode(raceLoser), 'feedback_task_handoff_in_progress');
      assert.deepEqual(handoffCalls, ['mcp_payload_create', 'task_lifecycle_create']);
    } finally {
      await closeServerState(competingState);
    }

    const fallbackSource = await callWith(handoffState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'andrey-user',
      submitter_principal: 'handoff-test',
      kind: 'observation',
      summary: 'A task id requires search rather than numeric show',
    });
    const fallbackId = view(fallbackSource).feedback_id;
    await callWith(handoffState, 'surface_feedback_update_status', {
      feedback_id: fallbackId,
      status: 'converted_to_task',
      resolved_by: 'handoff-test',
      resolution_note: 'Linked by external reconciliation.',
      task_ref: '20260711-feedback-task-id',
      task_status: 'opened',
    });
    const fallbackConversion = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: fallbackId,
      resolved_by: 'handoff-test',
    });
    assert.equal(view(fallbackConversion).next_action.tool, 'task_lifecycle_search');
    assert.deepEqual(view(fallbackConversion).next_action.arguments, { query: '20260711-feedback-task-id', limit: 5 });

    const privateSource = await callWith(handoffState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'narada-sonar',
      submitter_principal: 'handoff-test',
      kind: 'bug',
      summary: 'Inaccessible feedback must not convert',
    });
    const blockedConversion = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: view(privateSource).feedback_id,
      resolved_by: 'handoff-test',
    });
    assert.equal(errorCode(blockedConversion), 'feedback_not_visible');
    const missingConversion = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: 'sfb_missing_convert',
      resolved_by: 'handoff-test',
    });
    assert.equal(errorCode(missingConversion), 'feedback_not_found');
    const spoofedAuthority = await callWith(handoffState, 'surface_feedback_convert_to_task', {
      feedback_id: successFeedbackId,
      resolved_by: 'handoff-test',
      caller_site_id: 'narada-sonar',
    });
    assert.equal(errorCode(spoofedAuthority), 'feedback_authority_must_be_server_bound');
  } finally {
    await closeServerState(handoffState);
  }

  const heartbeatRoot = join(root, 'heartbeat-handoff');
  const heartbeatAdapter = async (request: any) => {
    const name = request.params?.name;
    if (name === 'mcp_payload_create') {
      return { jsonrpc: '2.0', id: request.id, result: { structuredContent: { status: 'created', ref: 'mcp_payload:heartbeat@v1' } } };
    }
    if (name === 'task_lifecycle_create') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { jsonrpc: '2.0', id: request.id, result: { structuredContent: { status: 'created', task_number: 77, task_id: 'heartbeat-task', task_status: 'opened' } } };
    }
    throw new Error(`unexpected_heartbeat_tool:${name}`);
  };
  const heartbeatState = createServerState({
    feedbackRoot: heartbeatRoot,
    canonicalFeedbackRoot: heartbeatRoot,
    authoritySiteId: 'andrey-user',
    taskLifecycleRequest: heartbeatAdapter,
    handoffLeaseMs: 80,
    handoffLeaseRenewMs: 20,
  });
  const heartbeatCompetitor = createServerState({
    feedbackRoot: heartbeatRoot,
    canonicalFeedbackRoot: heartbeatRoot,
    authoritySiteId: 'andrey-user',
    taskLifecycleRequest: async () => { throw new Error('renewed_lease_must_exclude_competitor'); },
    handoffLeaseMs: 80,
    handoffLeaseRenewMs: 20,
  });
  try {
    const heartbeatSource = await callWith(heartbeatState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'andrey-user',
      submitter_principal: 'heartbeat-test',
      kind: 'bug',
      summary: 'Lease remains owned during a long lifecycle request',
    });
    const heartbeatId = view(heartbeatSource).feedback_id;
    const activeConversion = callWith(heartbeatState, 'surface_feedback_convert_to_task', { feedback_id: heartbeatId });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const excludedCompetitor = await callWith(heartbeatCompetitor, 'surface_feedback_convert_to_task', { feedback_id: heartbeatId });
    assert.equal(errorCode(excludedCompetitor), 'feedback_task_handoff_in_progress');
    assert.equal(view(await activeConversion).status, 'converted');
  } finally {
    await Promise.all([closeServerState(heartbeatState), closeServerState(heartbeatCompetitor)]);
  }

  const invalidTaskRoot = join(root, 'invalid-task-root');
  mkdirSync(invalidTaskRoot, { recursive: true });
  const invalidRootState = createServerState({
    feedbackRoot: invalidTaskRoot,
    canonicalFeedbackRoot: invalidTaskRoot,
    taskLifecycleRoot: invalidTaskRoot,
    authoritySiteId: 'andrey-user',
  });
  try {
    const invalidRootSource = await callWith(invalidRootState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'andrey-user',
      submitter_principal: 'root-test',
      kind: 'bug',
      summary: 'Invalid task lifecycle root is diagnosed before child startup',
    });
    const invalidRootConversion = await callWith(invalidRootState, 'surface_feedback_convert_to_task', {
      feedback_id: view(invalidRootSource).feedback_id,
      resolved_by: 'root-test',
    });
    assert.equal(errorCode(invalidRootConversion), 'feedback_task_lifecycle_root_invalid');
    assert.match(invalidRootConversion.error.data.remediation, /--task-lifecycle-root/);
  } finally {
    await closeServerState(invalidRootState);
  }

  const unhealthyRoot = join(root, 'unhealthy-task-child');
  mkdirSync(join(unhealthyRoot, '.ai'), { recursive: true });
  const unhealthyState = createServerState({
    feedbackRoot: unhealthyRoot,
    canonicalFeedbackRoot: unhealthyRoot,
    taskLifecycleRoot: unhealthyRoot,
    authoritySiteId: 'andrey-user',
    taskLifecycleRequest: async () => { throw new Error('simulated_task_lifecycle_startup_failure'); },
  });
  try {
    assert.equal(view(await callWith(unhealthyState, 'surface_feedback_doctor', {})).task_lifecycle_health, 'unverified');
    const unhealthySource = await callWith(unhealthyState, 'surface_feedback_submit', {
      surface_id: 'surface-feedback',
      submitter_site_id: 'andrey-user',
      submitter_principal: 'health-test',
      kind: 'bug',
      summary: 'Observed child failure changes health without changing root configuration validity',
    });
    await callWith(unhealthyState, 'surface_feedback_convert_to_task', { feedback_id: view(unhealthySource).feedback_id });
    const unhealthyDoctor = view(await callWith(unhealthyState, 'surface_feedback_doctor', {}));
    assert.equal(unhealthyDoctor.task_lifecycle_root_configured, true);
    assert.equal(unhealthyDoctor.task_lifecycle_health, 'unhealthy');
    assert.match(unhealthyDoctor.task_lifecycle_health_error, /simulated_task_lifecycle_startup_failure/);
    assert.equal(unhealthyDoctor.status, 'warning');
  } finally {
    await closeServerState(unhealthyState);
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
    assert.equal(batchData.updates[1].feedback.resolved_by, 'surface-feedback@andrey-user');
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

  // --- list: explicit canonical cross-site scope ---
  const missingReadScope = await call('surface_feedback_list', {});
  assert.equal(errorCode(missingReadScope), 'feedback_read_scope_required');
  const listAll = await call('surface_feedback_list', { scope: 'all_authorized' });
  assert.equal(view(listAll).count, 8);
  assert.equal(view(listAll).read_scope.mode, 'all_authorized');
  assert.equal(view(listAll).read_scope.scope_limited, false);
  assert.equal(view(listAll).store.feedback_root, root);
  assert.equal(view(listAll).store.uses_canonical_store, true);

  // --- list: by surface_id ---
  const listSop = await call('surface_feedback_list', { scope: 'all_authorized', surface_id: 'sop' });
  assert.equal(view(listSop).count, 2);

  // --- list: by declared submitter metadata ---
  const listBySite = await call('surface_feedback_list', { scope: 'all_authorized', submitter_site_id_filter: 'narada-proper' });
  assert.equal(view(listBySite).count, 1);
  const legacySiteFilter = await call('surface_feedback_list', { scope: 'all_authorized', submitter_site_id: 'narada-proper' });
  assert.equal(errorCode(legacySiteFilter), 'feedback_read_filter_renamed');

  // --- list: pagination (limit + offset) ---
  const listPage1 = await call('surface_feedback_list', { scope: 'all_authorized', limit: 2, offset: 0 });
  assert.equal(view(listPage1).count, 2);
  const listPage2 = await call('surface_feedback_list', { scope: 'all_authorized', limit: 2, offset: 2 });
  assert.equal(view(listPage2).count, 2);
  const itemsP1 = view(listPage1).items as any[];
  const itemsP2 = view(listPage2).items as any[];
  assert.notDeepEqual(itemsP1.map((i: any) => i.feedback_id), itemsP2.map((i: any) => i.feedback_id));

  // --- explicit read scopes: submitter is metadata, not the default queue boundary ---
  const listMine = await call('surface_feedback_list', { scope: 'authority_site_submissions' });
  assert.equal(view(listMine).read_scope.mode, 'authority_site_submissions');
  assert.equal(view(listMine).read_scope.metadata_only, true);
  assert.equal(view(listMine).read_scope.provenance_authenticated, false);
  assert.ok(view(listMine).items.every((item: any) => item.submitter_site_id === 'andrey-user'));
  assert.equal(view(listMine).items.some((item: any) => item.feedback_id === crossSiteId), false);

  const listOwned = await call('surface_feedback_list', { scope: 'owned_surfaces' });
  assert.equal(view(listOwned).read_scope.mode, 'owned_surfaces');
  assert.ok(view(listOwned).items.every((item: any) => ['sop', 'delegated-task', 'surface-feedback', 'task-lifecycle'].includes(item.surface_id)));
  assert.equal(view(listOwned).items.some((item: any) => item.feedback_id === crossSiteId), false);

  const listAuthorityVisible = await call('surface_feedback_list', { scope: 'authority_visible' });
  assert.equal(view(listAuthorityVisible).read_scope.mode, 'authority_visible');
  assert.equal(view(listAuthorityVisible).read_scope.provenance_authenticated, false);
  assert.ok(view(listAuthorityVisible).items.every((item: any) => item.submitter_site_id === 'andrey-user' || ['sop', 'delegated-task', 'surface-feedback', 'task-lifecycle'].includes(item.surface_id)));
  assert.equal(view(listAuthorityVisible).items.some((item: any) => item.feedback_id === subData.feedback_id), true);
  assert.equal(view(listAuthorityVisible).items.some((item: any) => item.feedback_id === crossSiteId), false);

  const legacyList = await call('surface_feedback_list', { caller_site_id: 'andrey-user' });
  assert.equal(errorCode(legacyList), 'feedback_read_scope_server_bound');

  // --- show: visible (own submission) ---
  const show = await call('surface_feedback_show', { feedback_id: subData.feedback_id, scope: 'all_authorized' });
  assert.equal(view(show).summary, 'Add agent step kind');
  assert.equal(view(show).status, 'closed');
  assert.equal(view(show).read_scope.mode, 'all_authorized');
  assert.equal(view(show).details, 'SOP should support agent executor with blocking for agent-performed steps.');
  assert.equal(view(show).store.db_path, state.dbPath);

  // --- show: visible via server-bound owned surface scope ---
  const showSop = await call('surface_feedback_show', {
    feedback_id: subData.feedback_id,
    scope: 'owned_surfaces',
  });
  assert.equal(view(showSop).feedback_id, subData.feedback_id);

  // --- show: outside server-bound submitter scope is indistinguishable from missing ---
  const showBlockedRes = await call('surface_feedback_show', {
    feedback_id: subData.feedback_id,
    scope: 'authority_site_submissions',
  });
  assert.equal(errorCode(showBlockedRes), 'feedback_not_found');

  const showCrossSite = await call('surface_feedback_show', { feedback_id: crossSiteId, scope: 'all_authorized' });
  assert.equal(view(showCrossSite).feedback_id, crossSiteId);
  assert.equal(view(showCrossSite).read_scope.mode, 'all_authorized');

  const showMissing = await call('surface_feedback_show', { feedback_id: 'sfb_missing', scope: 'all_authorized' });
  assert.equal(errorCode(showMissing), 'feedback_not_found');
  assert.equal(showMissing.error.data.db_path.endsWith('surface-feedback.db'), true);
  assert.match(showMissing.error.data.store_hint, /feedback_root/);

  // --- import: repair explicit feedback IDs from a site-local split-brain store ---
  const siteLocalRoot = join(root, 'split-brain-site');
  const siteLocalState = createServerState({
    feedbackRoot: siteLocalRoot,
    canonicalFeedbackRoot: root,
    authoritySiteId: 'narada-staccato',
  });
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
    const missingBeforeImport = await call('surface_feedback_show', { feedback_id: localFeedbackId, scope: 'all_authorized' });
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

    const importedShow = await call('surface_feedback_show', { feedback_id: localFeedbackId, scope: 'all_authorized' });
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
    await closeServerState(siteLocalState);
  }

  // --- stats: explicit canonical cross-site scope ---
  const statsAll = await call('surface_feedback_stats', { scope: 'all_authorized' });
  const statsAllData = view(statsAll);
  assert.equal(statsAllData.total, 9);
  assert.equal(statsAllData.read_scope.mode, 'all_authorized');
  assert.ok(statsAllData.by_surface.sop >= 2);
  assert.ok(statsAllData.by_kind.improvement >= 1);
  assert.ok(statsAllData.by_kind.bug >= 1);
  assert.ok(statsAllData.by_kind.gap >= 1);
  assert.ok(statsAllData.by_status.submitted >= 3);
  assert.ok(statsAllData.by_status.routed >= 1);
  assert.ok(statsAllData.by_status.closed >= 1);
  assert.ok(statsAllData.by_status.converted_to_task >= 1);

  // --- stats: explicit server-bound scopes ---
  const statsMine = await call('surface_feedback_stats', { scope: 'authority_site_submissions' });
  assert.equal(view(statsMine).read_scope.mode, 'authority_site_submissions');
  assert.ok(view(statsMine).total > 0);
  const statsOwned = await call('surface_feedback_stats', { scope: 'owned_surfaces' });
  assert.equal(view(statsOwned).read_scope.mode, 'owned_surfaces');
  assert.ok(view(statsOwned).total > 0);

  const legacyStats = await call('surface_feedback_stats', { caller_site_id: 'andrey-user' });
  assert.equal(errorCode(legacyStats), 'feedback_read_scope_server_bound');

  // --- stats: surface filter ---
  const statsSop = await call('surface_feedback_stats', { scope: 'all_authorized', surface_id: 'sop' });
  assert.equal(view(statsSop).total, 2);

  console.log('surface-feedback-mcp behavior ok');
} finally {
  if (state) await closeServerState(state);
  rmSync(root, { recursive: true, force: true });
}
