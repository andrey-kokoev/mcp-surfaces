#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SqliteDirectiveRuntimeStore,
  leaseExpiryIso,
  leaseId,
} from '@narada2/task-governance-core/directive-runtime-store';
import { openTaskLifecycleStoreWithDiscipline } from './sqlite-discipline.js';
import { loadSonarEmailResidentOperatingPolicy } from '../site-loop/operating-loop-policy.js';

type AnyRecord = Record<string, any>;

export function dispatchPendingDirectives({
  cwd,
  agentId = 'sonar.resident',
  role = 'resident',
  limit = 25,
  dryRun = false,
  requireLiveCarrier = true,
  blockBusyCarrier = true,
}) {
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(cwd, { write: true });
  const store = new SqliteDirectiveRuntimeStore({ db: lifecycleStore.db });
  store.initSchema();
  const receiptReconciliation = reconcileCarrierReceipts(cwd, store);
  const leaseRecovery = recoverExpiredLeases(store);
  const carrier: AnyRecord | null = findLatestResidentControlTarget(cwd, agentId, { requireLiveCarrier }) as AnyRecord | null;
  const controlPath = carrier?.controlPath ?? null;
  const pending = dedupeDirectives([
    ...store.listPending({ target: { kind: 'agent', id: agentId }, limit }),
    ...store.listPending({ target: { kind: 'role', id: role }, limit }),
  ]).slice(0, limit);
  const dispatched: AnyRecord[] = [];
  const skipped: AnyRecord[] = [];

  if (!controlPath) {
    lifecycleStore.db.close();
    return {
      schema: 'narada.sonar.directive_dispatch.v0',
      status: 'ok',
      dry_run: dryRun,
      agent_id: agentId,
      role,
      control_path: null,
      carrier,
      pending_count: pending.length,
      receipt_reconciliation: receiptReconciliation,
      lease_recovery: leaseRecovery,
      dispatched: [],
      skipped: pending.map((directive) => ({ directive_id: directive.directive_id, reason: carrier?.reason ?? 'no_live_agent_cli_control_path' })),
    };
  }

  const sessionState = carrier?.carrierSessionId ? inferAgentCliSessionState(cwd, carrier.carrierSessionId) : { active_turn_state: 'unknown' };
  const host = carrier?.carrierSessionId ? readResidentHostEvidence(cwd, carrier.carrierSessionId) : null;
  const policy = loadSonarEmailResidentOperatingPolicy(cwd).policy;
  const carrierState = classifyResidentCarrierState({ carrier, sessionState, host, policy });
  if (blockBusyCarrier && ['busy', 'stale_busy', 'policy_stale'].includes(carrierState.state)) {
    lifecycleStore.db.close();
    return {
      schema: 'narada.sonar.directive_dispatch.v0',
      status: 'ok',
      dry_run: dryRun,
      agent_id: agentId,
      role,
      control_path: controlPath,
      carrier,
      carrier_state: carrierState,
      carrier_session_state: sessionState,
      pending_count: pending.length,
      receipt_reconciliation: receiptReconciliation,
      lease_recovery: leaseRecovery,
      dispatched: [],
      skipped: pending.map((directive) => ({ directive_id: directive.directive_id, reason: carrierState.dispatch_skip_reason })),
    };
  }

  for (const directive of pending) {
    const terminalOutcome = latestTerminalDirectiveOutcome(lifecycleStore.db, directive.directive_id);
    if (terminalOutcome) {
      failDirectiveDelivery(store, directive.directive_id, `terminal_outcome_${terminalOutcome.outcome}`);
      skipped.push({
        directive_id: directive.directive_id,
        reason: 'terminal_outcome_not_deliverable',
        outcome: terminalOutcome.outcome,
      });
      continue;
    }
    const carrierSessionId = carrier.carrierSessionId ?? carrierSessionIdFromControlPath(controlPath) ?? 'agent-cli-control-jsonl';
    const lease = {
      leaseId: leaseId(directive.directive_id, carrierSessionId),
      leasedUntil: leaseExpiryIso(5),
      transport: 'agent_cli_control_jsonl',
      carrierSessionId,
    };
    if (dryRun) {
      skipped.push({ directive_id: directive.directive_id, reason: 'dry_run' });
      continue;
    }
    const attempt = store.leaseDelivery(directive.directive_id, lease);
    try {
      appendControlFrame(controlPath, {
        id: `directive-${directive.directive_id}`,
        method: 'system_directive.deliver',
        params: {
          directive_id: directive.directive_id,
          directive,
          message: directiveDeliveryMessage(directive),
          authority_ref: directive.directive_id,
        },
      });
    } catch (error) {
      failDirectiveDelivery(store, directive.directive_id, 'control_jsonl_append_failed');
      skipped.push({
        directive_id: directive.directive_id,
        reason: 'control_jsonl_append_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    dispatched.push({
      directive_id: directive.directive_id,
      attempt_id: attempt.attempt_id,
      lease_id: attempt.lease_id ?? lease.leaseId,
      control_path: controlPath,
      carrier_session_id: carrierSessionId,
      receipt_recorded: false,
    });
  }

  lifecycleStore.db.close();
  return {
    schema: 'narada.sonar.directive_dispatch.v0',
    status: 'ok',
    dry_run: dryRun,
    agent_id: agentId,
    role,
    control_path: controlPath,
    carrier,
    carrier_state: carrierState,
    carrier_session_state: sessionState,
    pending_count: pending.length,
    receipt_reconciliation: receiptReconciliation,
    lease_recovery: leaseRecovery,
    dispatched,
    skipped,
  };
}

function directiveDeliveryMessage(directive) {
  const text = String(directive?.content?.text ?? '').trim();
  const directiveId = String(directive?.directive_id ?? '').trim();
  if (!directiveId) return text;
  const mailboxTicketGuidance = directiveLooksLikeMailboxTicketDraftWork(directive)
    ? [
        'Mailbox ticket rule: do not create or send a mere confirmation or acknowledgement for stale customer mail.',
        'If the inbound message is from a prior local day or otherwise old, inspect the ticket evidence first and create only a substantive follow-up draft, or record why no customer draft is appropriate.',
        'Use ticket draft create/replace for Outlook drafts; do not send without operator approval.',
      ].join(' ')
    : null;
  return [
    `Directive id: ${directiveId}`,
    text,
    mailboxTicketGuidance,
    [
      'Use task_lifecycle_claim first when the task is unclaimed.',
      'Then call task_lifecycle_disposition_closeout with task_number, agent_id="sonar.resident", disposition="acknowledged", and a short summary so task-owned evidence is written.',
      `Then call task_lifecycle_submit_report with task_number, agent_id="sonar.resident", summary under 180 characters, directive_id="${directiveId}", reviewer="reviewer-agent", and changed_files from the closeout result. If closeout reports no task file change, use no_files_changed=true.`,
      'Do not include reviewer_agent_id, execution_notes, verification_notes, envelope_id, or disposition in task_lifecycle_submit_report.',
      `If the tool does not expose directive_id, include this exact fallback token in the report summary: directive_id:${directiveId}`,
    ].join(' '),
  ].filter(Boolean).join('\n\n');
}

function directiveLooksLikeMailboxTicketDraftWork(directive) {
  const haystack = [
    directive?.title,
    directive?.source_id,
    directive?.sourceId,
    directive?.content?.title,
    directive?.content?.text,
  ].filter(Boolean).join('\n').toLowerCase();
  return haystack.includes('mailbox ticket')
    || haystack.includes('needs_draft')
    || haystack.includes('customer-facing reply')
    || haystack.includes('ticket draft')
    || /\bmail:[a-z0-9._-]+\b/.test(haystack);
}

function dedupeDirectives(directives) {
  const seen = new Set();
  const deduped = [];
  for (const directive of directives) {
    if (!directive?.directive_id || seen.has(directive.directive_id)) continue;
    seen.add(directive.directive_id);
    deduped.push(directive);
  }
  return deduped;
}

function latestTerminalDirectiveOutcome(db, directiveId) {
  try {
    const row = db.prepare(`
      SELECT outcome
      FROM directive_outcome_latest
      WHERE loop_id = 'sonar.email-resident'
        AND directive_id = ?
      LIMIT 1
    `).get(directiveId);
    return row && ['reported', 'superseded', 'refused'].includes(String(row.outcome))
      ? { outcome: String(row.outcome) }
      : null;
  } catch {
    return null;
  }
}

export function getResidentStatus(cwd, { agentId = 'sonar.resident', requireLiveCarrier = true }: AnyRecord = {}) {
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(cwd, { write: false });
  try {
    const carrier: AnyRecord | null = findLatestResidentControlTarget(cwd, agentId, { requireLiveCarrier }) as AnyRecord | null;
    const latestReceipt = latestResidentReceipt(lifecycleStore.db, agentId);
    const latestReport = lifecycleStore.db.prepare(`
      SELECT report_id, task_id, agent_id, submitted_at, summary
      FROM task_reports
      WHERE agent_id = ?
      ORDER BY submitted_at DESC
      LIMIT 1
    `).get(agentId) ?? null;
    const sessionState = carrier?.carrierSessionId ? inferAgentCliSessionState(cwd, carrier.carrierSessionId) : { active_turn_state: 'unknown' };
    const host = carrier?.carrierSessionId ? readResidentHostEvidence(cwd, carrier.carrierSessionId) : null;
    const policy = loadSonarEmailResidentOperatingPolicy(cwd).policy;
    const carrierState = classifyResidentCarrierState({ carrier, sessionState, host, policy });
    const status = residentAvailabilityStatus(carrier, sessionState, carrierState);
    const proofDriver = host?.started_event?.resident_proof_driver === true;
    const activeRuntime = carrier?.status === 'available' ? carrier.runtime ?? null : null;
    const terminalWorkInflight = detectTerminalWorkInflight(lifecycleStore.db, { sessionState, host });
    const runtimeCoherent = ['available_idle', 'busy'].includes(carrierState?.state)
      && terminalWorkInflight.status !== 'terminal_inflight';
    return {
      schema: 'narada.sonar.resident_status.v1',
      status,
      agent_id: agentId,
      carrier,
      carrier_state: carrierState,
      active_turn_state: sessionState.active_turn_state,
      availability_detail: residentAvailabilityDetail(carrier),
      runtime_coherent: runtimeCoherent,
      production_ready: false,
      active_runtime: activeRuntime,
      preferred_runtime: 'interactive_agent_cli',
      fallback_active: carrier?.preference === 'agent_runtime_server_fallback',
      proof_driver_active: proofDriver,
      stale_carrier_count: residentStaleCarrierCount(carrier),
      terminal_work_inflight: terminalWorkInflight,
      host,
      latest_receipt: latestReceipt,
      latest_report: latestReport,
    };
  } finally {
    lifecycleStore.db.close();
  }
}

function latestResidentReceipt(db, agentId) {
  const table = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'directive_receipts'
  `).get();
  if (!table) return null;
  return db.prepare(`
    SELECT receipt_id, directive_id, received_at, carrier_session_id, agent_id, transport
    FROM directive_receipts
    WHERE agent_id = ?
    ORDER BY received_at DESC
    LIMIT 1
  `).get(agentId) ?? null;
}

function residentAvailabilityDetail(carrier) {
  if (carrier?.status === 'available') {
    return {
      state: 'live_carrier',
      runtime: carrier.runtime ?? null,
      preference: carrier.preference ?? null,
      carrier_session_id: carrier.carrierSessionId ?? null,
    };
  }
  if (carrier?.reason === 'no_resident_control_target') return { state: 'no_launch_record' };
  if (carrier?.reason === 'no_live_resident_control_target') {
    return {
      state: 'stale_launch_records_only',
      preferred_interactive_reason: carrier.preferred_interactive?.reason ?? null,
      fallback_nars_reason: carrier.fallback_nars?.reason ?? null,
    };
  }
  return { state: carrier?.reason ?? 'unknown' };
}

function residentAvailabilityStatus(carrier, sessionState: AnyRecord = {}, carrierState = null) {
  if (carrierState?.state === 'policy_stale') return 'blocked';
  if (carrierState?.state === 'stale_busy') return 'blocked';
  if (carrier?.status === 'available') {
    return sessionState.active_turn_state === 'running' ? 'busy' : 'available';
  }
  if (carrier?.reason === 'no_live_agent_cli_carrier'
    || carrier?.reason === 'no_live_nars_carrier'
    || carrier?.reason === 'no_live_resident_control_target') {
    return 'stale_launch';
  }
  if (carrier?.reason === 'no_resident_control_target'
    || carrier?.reason === 'agent_start_results_missing'
    || String(carrier?.reason ?? '').endsWith('_launch_result')) {
    return 'not_started';
  }
  if (carrier?.reason === 'restart_rate_limited') return 'rate_limited';
  if (carrier?.reason === 'loop_paused') return 'blocked';
  return 'blocked';
}

function detectTerminalWorkInflight(db, { sessionState = {}, host = null }: AnyRecord = {}) {
  if (sessionState.active_turn_state !== 'running') {
    return { status: 'none', directive_id: null, outcome: null };
  }
  const directiveId = runningTurnDirectiveId(host, sessionState)
    ?? sameTurnDirectiveId(host?.last_protocol_event, sessionState)
    ?? sameTurnDirectiveId(host?.last_host_event, sessionState)
    ?? null;
  if (!directiveId) return { status: 'unknown_running_directive', directive_id: null, outcome: null };
  const terminal = latestTerminalDirectiveOutcome(db, directiveId);
  return terminal
    ? { status: 'terminal_inflight', directive_id: directiveId, outcome: terminal.outcome }
    : { status: 'nonterminal_inflight', directive_id: directiveId, outcome: null };
}

function runningTurnDirectiveId(host, sessionState) {
  const turnId = sessionState.turn_id ?? null;
  const paths = [host?.paths?.protocol_stdout, host?.paths?.host_log].filter(Boolean);
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-300).reverse();
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if ((event.event ?? event.type) !== 'turn_started') continue;
      const eventTurnId = event.turn_id ?? event.turnId ?? event.request_id ?? event.id ?? null;
      if (turnId && eventTurnId !== turnId) continue;
      return event.directive_id ?? directiveIdFromRequestId(event.request_id) ?? null;
    }
  }
  return null;
}

function sameTurnDirectiveId(event, sessionState) {
  if (!event) return null;
  const turnId = sessionState?.turn_id ?? null;
  if (turnId) {
    const eventTurnId = event.turn_id ?? event.turnId ?? event.request_id ?? event.id ?? null;
    if (eventTurnId !== turnId) return null;
  }
  return event.directive_id ?? directiveIdFromRequestId(event.request_id) ?? null;
}

function directiveIdFromRequestId(requestId) {
  const match = String(requestId ?? '').match(/directive-(dir_[A-Za-z0-9]+)/);
  return match?.[1] ?? null;
}

function residentStaleCarrierCount(carrier) {
  if (!carrier) return 0;
  return Number(carrier.stale_candidate_count ?? 0)
    + Number(carrier.preferred_interactive?.stale_candidate_count ?? 0)
    + Number(carrier.fallback_nars?.stale_candidate_count ?? 0);
}

export function classifyResidentCarrierState({ carrier, sessionState = {}, host = null, policy = null }: AnyRecord = {}) {
  if (!carrier || carrier.status !== 'available') {
    return {
      schema: 'narada.sonar.resident_carrier_state.v1',
      state: 'unavailable',
      reason: carrier?.reason ?? 'no_carrier',
      dispatch_skip_reason: carrier?.reason ?? 'no_live_resident_control_target',
    };
  }
  const policyLoaded = policy ?? loadSonarEmailResidentOperatingPolicy(process.cwd()).policy;
  if (policyLoaded?.carrier?.require_policy_current !== false && carrierPolicyStale(carrier, host)) {
    return {
      schema: 'narada.sonar.resident_carrier_state.v1',
      state: 'policy_stale',
      runtime: carrier.runtime ?? null,
      preference: carrier.preference ?? null,
      carrier_session_id: carrier.carrierSessionId ?? null,
      dispatch_skip_reason: 'resident_carrier_policy_stale',
    };
  }
  if (sessionState.active_turn_state === 'running') {
    const startedAt = Date.parse(sessionState.turn_started_at ?? '');
    const ageMs = Number.isFinite(startedAt) ? Date.now() - startedAt : null;
    const timeoutMs = Number(policyLoaded?.cadence?.busy_turn_timeout_ms ?? 10 * 60_000);
    const stale = ageMs != null && ageMs > timeoutMs;
    return {
      schema: 'narada.sonar.resident_carrier_state.v1',
      state: stale ? 'stale_busy' : 'busy',
      runtime: carrier.runtime ?? null,
      preference: carrier.preference ?? null,
      carrier_session_id: carrier.carrierSessionId ?? null,
      active_turn_age_ms: ageMs,
      busy_turn_timeout_ms: timeoutMs,
      dispatch_skip_reason: stale ? 'resident_carrier_stale_busy' : 'resident_carrier_busy',
    };
  }
  return {
    schema: 'narada.sonar.resident_carrier_state.v1',
    state: 'available_idle',
    runtime: carrier.runtime ?? null,
    preference: carrier.preference ?? null,
    carrier_session_id: carrier.carrierSessionId ?? null,
    dispatch_skip_reason: null,
  };
}

function carrierPolicyStale(carrier, host) {
  const siteRoot = host?.session_dir ? resolve(host.session_dir, '..', '..', '..', '..') : null;
  const policyPath = siteRoot ? join(siteRoot, '.narada', 'capabilities', 'mcp-surfaces.json') : null;
  if (!policyPath || !existsSync(policyPath)) return false;
  const policyMtime = statSync(policyPath).mtimeMs;
  const startedAt = Date.parse(host?.started_event?.timestamp ?? carrier?.startedAt ?? '');
  return Number.isFinite(startedAt) && startedAt < policyMtime;
}

export function reconcileCarrierReceipts(cwd, store) {
  const sessionPaths = receiptSessionPaths(cwd);
  const recorded = [];
  const carrierAccepted = [];
  const skipped = [];
  if (sessionPaths.length === 0) {
    return { status: 'ok', scanned: 0, recorded: [], carrier_accepted: [], skipped: [], reason: 'session_paths_missing' };
  }
  const events = [];
  for (const sessionPath of sessionPaths) {
    if (!existsSync(sessionPath)) continue;
    const lines = readFileSync(sessionPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!['directive_receipt_recorded', 'directive_accepted_recorded', 'directive_carrier_accepted_recorded'].includes(event.event) || !event.directive_id) continue;
      events.push({ event, sessionPath });
    }
  }
  for (const { event, sessionPath } of events.filter((item) => item.event.event === 'directive_receipt_recorded')) {
      const directive = store.getDirective(event.directive_id);
      if (!directive) {
        skipped.push({ directive_id: event.directive_id, reason: 'directive_not_found' });
        continue;
      }
      const validation = validateCarrierEventForDirective(directive, event, sessionPath);
      if (validation.status !== 'ok') {
        skipped.push({ directive_id: event.directive_id, reason: validation.reason, session_path: sessionPath });
        continue;
      }
      if (directive.delivery?.receipt_id) {
        skipped.push({ directive_id: event.directive_id, reason: 'receipt_already_recorded', receipt_id: directive.delivery.receipt_id });
        continue;
      }
      const receipt = store.recordReceipt(event.directive_id, {
        received_at: event.received_at ?? event.timestamp ?? new Date().toISOString(),
        carrier_session_id: event.carrier_session_id ?? carrierSessionIdFromSessionPath(sessionPath) ?? 'agent-cli',
        agent_id: event.agent_id ?? 'sonar.resident',
        transport: event.transport ?? 'agent_cli_control_jsonl',
      });
      recorded.push({ directive_id: event.directive_id, receipt_id: receipt.receipt_id, session_path: sessionPath });
  }
  for (const { event, sessionPath } of events.filter((item) => ['directive_accepted_recorded', 'directive_carrier_accepted_recorded'].includes(item.event.event))) {
      const directive = store.getDirective(event.directive_id);
      if (!directive) {
        skipped.push({ directive_id: event.directive_id, reason: 'directive_not_found' });
        continue;
      }
      const validation = validateCarrierEventForDirective(directive, event, sessionPath);
      if (validation.status !== 'ok') {
        skipped.push({ directive_id: event.directive_id, reason: validation.reason, session_path: sessionPath });
        continue;
      }
      if (!directive.delivery?.receipt_id) {
        skipped.push({ directive_id: event.directive_id, reason: 'receipt_required_before_carrier_acceptance', session_path: sessionPath });
        continue;
      }
      const triage = store.recordTriage(event.directive_id, {
        triaged_at: event.accepted_at ?? event.timestamp ?? new Date().toISOString(),
        agent_id: event.agent_id ?? 'sonar.resident',
        status: 'carrier_accepted',
        reason: event.acceptance_semantics ?? 'carrier_started_directive_turn',
        selected_work_ref: directiveTaskRef(directive),
      });
      carrierAccepted.push({ directive_id: event.directive_id, triage_id: triage.triage_id, session_path: sessionPath, status: 'carrier_accepted' });
    }
  return { status: 'ok', scanned: sessionPaths.length, recorded, carrier_accepted: carrierAccepted, skipped };
}

function validateCarrierEventForDirective(directive, event, sessionPath) {
  const sessionCarrierId = carrierSessionIdFromSessionPath(sessionPath);
  const eventCarrierId = event.carrier_session_id ? String(event.carrier_session_id) : null;
  const leasedCarrierId = directive.delivery?.carrier_session_id ? String(directive.delivery.carrier_session_id) : null;
  if (eventCarrierId && sessionCarrierId && eventCarrierId !== sessionCarrierId) {
    return { status: 'skipped', reason: 'carrier_session_mismatch_session_path' };
  }
  if (eventCarrierId && leasedCarrierId && eventCarrierId !== leasedCarrierId) {
    return { status: 'skipped', reason: 'carrier_session_mismatch_delivery_lease' };
  }
  const agentId = event.agent_id ? String(event.agent_id) : 'sonar.resident';
  const target = directive.target ?? {};
  if (target.kind === 'agent' && target.id && String(target.id) !== agentId) {
    return { status: 'skipped', reason: 'agent_mismatch_directive_target' };
  }
  if (target.kind === 'role' && target.id === 'resident' && agentId !== 'sonar.resident') {
    return { status: 'skipped', reason: 'agent_mismatch_resident_role' };
  }
  const transport = event.transport ? String(event.transport) : 'agent_cli_control_jsonl';
  if (!['agent_cli_control_jsonl', 'control_jsonl', 'jsonl_stdio'].includes(transport)) {
    return { status: 'skipped', reason: 'unsupported_carrier_event_transport' };
  }
  return { status: 'ok' };
}

function directiveTaskRef(directive) {
  const taskId = (directive?.content?.refs ?? []).find((ref) => ref.kind === 'task')?.id
    ?? directive?.content?.data?.task_id
    ?? null;
  return taskId ? { kind: 'task', id: taskId } : null;
}

export function recoverExpiredLeases(store, now = new Date().toISOString()) {
  const recovered = [];
  const rows = store.db.prepare(`
    select directive_id, directive_json
    from directive_records
    where delivery_status = 'leased'
  `).all();
  for (const row of rows) {
    const directive = JSON.parse(row.directive_json);
    const leasedUntil = directive.delivery?.leased_until;
    if (!leasedUntil || leasedUntil > now || directive.delivery?.receipt_id) continue;
    const recoveredDirective = {
      ...directive,
      delivery: {
        ...(directive.delivery ?? {}),
        status: 'failed',
        failure_reason: 'lease_expired_without_carrier_receipt',
        failed_at: now,
      },
    };
    store.upsertDirective(recoveredDirective);
    recovered.push({ directive_id: directive.directive_id, leased_until: leasedUntil, reason: 'lease_expired_without_carrier_receipt' });
  }
  return { status: 'ok', recovered };
}

export function findLatestResidentControlTarget(cwd, agentId, { requireLiveCarrier = true } = {}) {
  const policy = loadSonarEmailResidentOperatingPolicy(cwd).policy;
  const interactive = findLatestControlTargetByRuntime(cwd, agentId, 'agent-cli', { requireLiveCarrier });
  if (interactive.status === 'available') return { ...interactive, preference: 'interactive_agent_cli' };
  if (policy?.carrier?.fallback_enabled !== true) {
    return {
      status: 'unavailable',
      controlPath: null,
      reason: 'fallback_carrier_not_admitted_by_policy',
      preferred_interactive: interactive,
    };
  }
  const agentRuntimeServer = findLatestControlTargetByRuntime(cwd, agentId, 'agent-runtime-server', { requireLiveCarrier });
  if (agentRuntimeServer.status === 'available') return { ...agentRuntimeServer, preference: 'agent_runtime_server_fallback', preferred_interactive: interactive };
  const legacyNars = findLatestControlTargetByRuntime(cwd, agentId, 'nars', { requireLiveCarrier });
  if (legacyNars.status === 'available') return { ...legacyNars, preference: 'agent_runtime_server_fallback', preferred_interactive: interactive, legacy_runtime: 'nars' };
  return {
    status: 'unavailable',
    controlPath: null,
    reason: interactive.reason === 'no_agent_cli_launch_result' && agentRuntimeServer.reason === 'no_agent_runtime_server_launch_result' && legacyNars.reason === 'no_nars_launch_result'
      ? 'no_resident_control_target'
      : 'no_live_resident_control_target',
    preferred_interactive: interactive,
    fallback_agent_runtime_server: agentRuntimeServer,
    fallback_legacy_nars: legacyNars,
  };
}

export function findLatestAgentCliControlTarget(cwd, agentId, { requireLiveCarrier = true } = {}) {
  return findLatestControlTargetByRuntime(cwd, agentId, 'agent-cli', { requireLiveCarrier });
}

function findLatestControlTargetByRuntime(cwd, agentId, runtime, { requireLiveCarrier = true }: AnyRecord = {}) {
  const resultsDir = join(cwd, '.ai', 'runtime', 'agent-start-results');
  if (!existsSync(resultsDir)) return { status: 'unavailable', controlPath: null, reason: 'agent_start_results_missing' };
  const candidates: AnyRecord[] = readdirSync(resultsDir)
    .filter((name) => name.endsWith('.result.json'))
    .map((name) => {
      try {
        const path = join(resultsDir, name);
        const packet = JSON.parse(readFileSync(path, 'utf8'));
        const controlFlagIndex = Array.isArray(packet.runtime_args) ? packet.runtime_args.indexOf('--control-jsonl') : -1;
        const controlPath = (controlFlagIndex >= 0 ? packet.runtime_args[controlFlagIndex + 1] : null)
          ?? packet.agent_cli_launch?.control_path
          ?? packet.agent_runtime_server_launch?.control_path
          ?? packet.nars_launch?.control_path
          ?? packet.control_path
          ?? null;
        const carrierSessionId = packet.carrier_session?.carrier_session_id
          ?? packet.carrier_session_id
          ?? carrierSessionIdFromControlPath(controlPath);
        return packet.identity === agentId && packet.runtime === runtime && controlPath
          ? { path, controlPath, carrierSessionId, runtime, startedAt: packet.started_at ?? packet.agent_start_event ?? name }
          : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  for (const candidate of candidates) {
    const retirement = readCarrierRetirement(cwd, candidate.carrierSessionId);
    if (retirement) {
      candidate.retired = retirement;
      continue;
    }
    const live = requireLiveCarrier ? isResidentCarrierLive(candidate.carrierSessionId, cwd) : { status: 'skipped', live: true };
    if (!live.live) continue;
    return { status: 'available', ...candidate, live };
  }
  const activeStaleCandidates = candidates.filter((candidate) => !candidate.retired);
  return {
    status: 'unavailable',
    controlPath: null,
    reason: activeStaleCandidates.length > 0 ? `no_live_${runtime}_carrier` : `no_${runtime.replace(/[^a-z0-9]+/gi, '_')}_launch_result`,
    stale_candidate_count: activeStaleCandidates.length,
    retired_candidate_count: candidates.length - activeStaleCandidates.length,
    stale_candidates: activeStaleCandidates.map((candidate) => ({
      path: candidate.path,
      controlPath: candidate.controlPath,
      carrierSessionId: candidate.carrierSessionId,
      runtime: candidate.runtime,
    })),
  };
}

function readCarrierRetirement(cwd, carrierSessionId) {
  if (!carrierSessionId) return null;
  const path = join(cwd, '.narada', 'crew', 'nars-sessions', carrierSessionId, 'retired.json');
  if (!existsSync(path)) return null;
  try {
    return { path, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { path, status: 'retired', reason: 'retirement_record_unreadable' };
  }
}

function appendControlFrame(controlPath, frame) {
  mkdirSync(dirname(controlPath), { recursive: true });
  appendFileSync(controlPath, `${JSON.stringify(frame)}\n`, 'utf8');
}

function carrierSessionIdFromControlPath(controlPath) {
  const match = String(controlPath).match(/[\\/]([^\\/]+)[\\/]control\.jsonl$/);
  return match?.[1] ?? null;
}

function carrierSessionIdFromSessionPath(sessionPath) {
  const siteLocal = String(sessionPath).match(/[\\/]([^\\/]+)[\\/](?:session|events)\.jsonl$/);
  if (siteLocal) return siteLocal[1];
  const pcRuntime = String(sessionPath).match(/[\\/]([^\\/]+)\.jsonl$/);
  return pcRuntime?.[1] ?? null;
}

function receiptSessionPaths(cwd) {
  const paths = [];
  const siteSessionRoot = join(cwd, '.narada', 'crew', 'nars-sessions');
  if (existsSync(siteSessionRoot)) {
    for (const entry of readdirSync(siteSessionRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
      paths.push(join(siteSessionRoot, entry.name, 'session.jsonl'));
      paths.push(join(siteSessionRoot, entry.name, 'events.jsonl'));
    }
  }
  const pcSessionRoot = 'C:\\ProgramData\\Narada\\sites\\pc\\desktop-sunroom-2\\runtime\\agent-sessions';
  if (existsSync(pcSessionRoot)) {
    for (const sessionId of agentCliCarrierSessionIds(cwd)) {
      paths.push(join(pcSessionRoot, `${sessionId}.jsonl`));
    }
  }
  return paths;
}

function agentCliCarrierSessionIds(cwd) {
  const resultsDir = join(cwd, '.ai', 'runtime', 'agent-start-results');
  if (!existsSync(resultsDir)) return [];
  const ids = new Set();
  for (const name of readdirSync(resultsDir).filter((entry) => entry.endsWith('.result.json'))) {
    try {
      const packet = JSON.parse(readFileSync(join(resultsDir, name), 'utf8'));
      if (packet.runtime !== 'agent-cli') continue;
      const id = packet.carrier_session?.carrier_session_id
        ?? packet.carrier_session_id
        ?? packet.required_environment?.NARADA_CARRIER_SESSION_ID
        ?? null;
      if (id) ids.add(id);
    } catch {
      // Ignore malformed historical launch records.
    }
  }
  return [...ids];
}

function failDirectiveDelivery(store, directiveId, reason) {
  const directive = store.getDirective(directiveId);
  if (!directive) return null;
  const failed = {
    ...directive,
    delivery: {
      ...(directive.delivery ?? {}),
      status: 'failed',
      failure_reason: reason,
      failed_at: new Date().toISOString(),
    },
  };
  store.upsertDirective(failed);
  return failed;
}

export function isResidentCarrierLive(carrierSessionId, cwd) {
  if (!carrierSessionId) return { status: 'unavailable', live: false, reason: 'carrier_session_id_missing' };
  if (!cwd) return { status: 'unavailable', live: false, reason: 'site_root_required_for_carrier_liveness' };
  const heartbeat = readCarrierHeartbeat(cwd, carrierSessionId);
  if (heartbeat.live) {
    return {
      status: 'ok',
      live: true,
      reason: 'fresh_carrier_heartbeat',
      heartbeat,
    };
  }
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$needle=$env:NARADA_RESIDENT_CARRIER_PROBE_ID; $p = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine -like '*agent-cli*' -or $_.CommandLine -like '*agent-runtime-server-control-host*' -or $_.CommandLine -like '*nars-control-host*') -and $_.CommandLine.Contains($needle) } | Select-Object -First 1 -ExpandProperty ProcessId; if ($p) { $p }`,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, NARADA_RESIDENT_CARRIER_PROBE_ID: String(carrierSessionId) },
    }).trim();
    return output
      ? { status: 'ok', live: true, reason: 'process_command_line_match', pid: Number(output) || output, heartbeat }
      : { status: 'ok', live: false, reason: 'process_not_found', heartbeat };
  } catch (error) {
    return {
      status: 'error',
      live: false,
      reason: 'process_check_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readCarrierHeartbeat(cwd, carrierSessionId, maxAgeMs = 30000) {
  const path = join(cwd, '.narada', 'crew', 'nars-sessions', carrierSessionId, 'heartbeat.json');
  if (!existsSync(path)) return { status: 'missing', live: false, path };
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.status === 'stopped') {
      return { status: 'stopped', live: false, age_ms: null, max_age_ms: maxAgeMs, path, record };
    }
    const heartbeatMs = Date.parse(record.heartbeat_at ?? '');
    const age_ms = Number.isFinite(heartbeatMs) ? Date.now() - heartbeatMs : null;
    const matches = record.carrier_session_id === carrierSessionId;
    const live = matches && record.status === 'alive' && age_ms !== null && age_ms <= maxAgeMs;
    return { status: live ? 'fresh' : 'stale', live, age_ms, max_age_ms: maxAgeMs, path, record };
  } catch (error) {
    return { status: 'unreadable', live: false, path, error: error instanceof Error ? error.message : String(error) };
  }
}

function inferAgentCliSessionState(cwd, carrierSessionId) {
  const sessionDir = join(cwd, '.narada', 'crew', 'nars-sessions', carrierSessionId);
  const pcSessionRoot = 'C:\\ProgramData\\Narada\\sites\\pc\\desktop-sunroom-2\\runtime\\agent-sessions';
  const paths = [
    join(sessionDir, 'session.jsonl'),
    join(sessionDir, 'events.jsonl'),
    join(sessionDir, 'protocol.stdout.jsonl'),
    join(pcSessionRoot, `${carrierSessionId}.jsonl`),
  ];
  const readablePaths = paths.filter((path) => existsSync(path));
  if (readablePaths.length === 0) return { active_turn_state: 'unknown', reason: 'session_evidence_missing', session_dir: sessionDir };
  try {
    const lines = readablePaths.flatMap((path) =>
      readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-200).map((line) => ({ line, path })),
    );
    let lastTurnStarted = null;
    let lastTurnStartedAt = null;
    let lastTerminal = null;
    let lastPath = null;
    for (const { line, path } of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const eventName = event.event ?? event.type ?? null;
      if (eventName === 'turn_started') {
        lastTurnStarted = event.turn_id ?? event.turnId ?? event.request_id ?? event.id ?? null;
        lastTurnStartedAt = event.timestamp ?? event.started_at ?? event.created_at ?? statSync(path).mtime.toISOString();
        lastPath = path;
      }
      if (['turn_complete', 'turn_failed', 'turn_cancelled'].includes(eventName)) {
        lastTerminal = event.turn_id ?? event.turnId ?? event.request_id ?? event.id ?? null;
        lastPath = path;
      }
    }
    if (lastTurnStarted && lastTurnStarted !== lastTerminal) return { active_turn_state: 'running', turn_id: lastTurnStarted, turn_started_at: lastTurnStartedAt, session_path: lastPath, evidence_paths: readablePaths };
    return { active_turn_state: 'idle', session_path: lastPath ?? readablePaths[0], evidence_paths: readablePaths };
  } catch (error) {
    return { active_turn_state: 'unknown', reason: error instanceof Error ? error.message : String(error), session_dir: sessionDir, evidence_paths: readablePaths };
  }
}

function readResidentHostEvidence(cwd, carrierSessionId) {
  const sessionDir = join(cwd, '.narada', 'crew', 'nars-sessions', carrierSessionId);
  const hostLogPath = join(sessionDir, 'host.jsonl');
  const protocolPath = join(sessionDir, 'protocol.stdout.jsonl');
  const cursorPath = join(sessionDir, 'control.cursor.json');
  const controlPath = join(sessionDir, 'control.jsonl');
  return {
    schema: 'narada.sonar.resident_host_evidence.v1',
    carrier_session_id: carrierSessionId,
    session_dir: sessionDir,
    control_path: controlPath,
    cursor: readJsonIfExists(cursorPath),
    last_host_event: readLastJsonl(hostLogPath),
    last_protocol_event: readLastJsonl(protocolPath),
    paths: {
      host_log: hostLogPath,
      protocol_stdout: protocolPath,
      cursor: cursorPath,
    },
    started_event: readLastJsonlEvent(hostLogPath, 'started'),
  };
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error), path };
  }
}

function readLastJsonl(path) {
  if (!existsSync(path)) return null;
  try {
    const line = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).at(-1);
    return line ? JSON.parse(line) : null;
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error), path };
  }
}

function readLastJsonlEvent(path, eventName) {
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      const event = JSON.parse(line);
      if (event?.event === eventName) return event;
    }
    return null;
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error), path };
  }
}

function parseArgs(argv) {
  const parsed: AnyRecord = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agent') parsed.agent = argv[++i];
    else if (arg === '--role') parsed.role = argv[++i];
    else if (arg === '--limit') parsed.limit = Number(argv[++i]);
    else if (arg === '--dry-run') parsed.dry_run = true;
    else if (arg === '--allow-stale-carrier') parsed.require_live_carrier = false;
  }
  return parsed;
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  const cwd = resolve(process.argv[2] || process.cwd());
  const args = parseArgs(process.argv.slice(3));
  const agentId = args.agent ?? 'sonar.resident';
  const role = args.role ?? 'resident';
  const limit = Number(args.limit ?? 25);
  const dryRun = args.dry_run === true;
  const requireLiveCarrier = args.require_live_carrier !== false;

  let exitCode = 0;
  try {
    const result = dispatchPendingDirectives({ cwd, agentId, role, limit, dryRun, requireLiveCarrier });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      schema: 'narada.sonar.directive_dispatch.v0',
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    exitCode = 1;
  }
  process.exit(exitCode);
}
