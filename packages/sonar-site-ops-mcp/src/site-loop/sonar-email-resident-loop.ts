#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqliteDirectiveRuntimeStore } from '@narada2/task-governance-core/directive-runtime-store';
import { findTaskFile, readTaskFile, writeTaskProjection } from '@narada2/task-governance-core/task-governance';
import { openTaskLifecycleStoreWithDiscipline, taskLifecycleDbHealth } from '../task-lifecycle/sqlite-discipline.js';
import { pollInboxBridge } from '@narada2/task-lifecycle-mcp/task-lifecycle-runtime/inbox-bridge';
import { dispatchPendingDirectives, getResidentStatus } from '../task-lifecycle/dispatch-directives.js';
import { taskLifecycleTools } from '../task-lifecycle/task-mcp-tool-registry.js';
import { loadSonarEmailResidentOperatingPolicy } from './operating-loop-policy.js';
import {
  REQUIRED_RESIDENT_MUTATING_TASK_TOOLS,
  REQUIRED_RESIDENT_TASK_TOOLS,
  RESIDENT_AGENT_ID,
  RESIDENT_ROLE,
  SONAR_EMAIL_RESIDENT_LOOP_ID,
} from './sonar-email-resident-constants.js';
import {
  acknowledgeLoopAttention,
  acquireLoopLock,
  beginLoopRun,
  countRecentConsecutiveLoopClassificationObservations,
  finishLoopRun,
  getLoopAttention,
  getLoopAttentionSummary,
  getLoopControl,
  getLoopEscalation,
  getLoopHealth,
  getLoopRun,
  getLoopStatus,
  getDirectiveOutcomeSummary,
  ensureSiteLoopTables,
  listDirectiveOutcomes,
  listLoopAttention,
  listLoopRuns,
  openSiteLoopStore,
  recordDirectiveOutcome,
  resolveDirectiveOutcome,
  recordLoopClassificationObservation,
  recordLoopEscalation,
  recordLoopHealthFailure,
  recordLoopHealthSuccess,
  recordLoopStep,
  releaseLoopLock,
  setLoopControl,
} from './site-loop-store.js';

export { SONAR_EMAIL_RESIDENT_LOOP_ID } from './sonar-email-resident-constants.js';
const MAILBOX_PROOF_FRESHNESS_MS = 24 * 60 * 60_000;
type SiteLoopPayload = Record<string, any>;
type SiteLoopOptions = SiteLoopPayload;
type ResidentLoopStep = SiteLoopPayload;
type ResidentCarrier = SiteLoopPayload;
type ResidentRunResult = SiteLoopPayload;
type SurfacePolicyNoise = SiteLoopPayload;
type OperatorAttentionResult = SiteLoopPayload;
type EnrichedProcessError = Error & SiteLoopPayload;

export async function runSonarEmailResidentLoop(cwd, options: SiteLoopOptions = {}) {
  const siteRoot = resolve(cwd);
  const dryRun = options.dryRun === true || options.dry_run === true;
  const limit = Number(options.limit ?? 25);
  const threshold = options.threshold == null ? undefined : Number(options.threshold);
  const sourceSyncRequested = options.sourceSync === true || options.source_sync === true;
  const drain = options.drain === true;
  const runId = options.runId ?? makeRunId();
  const startedAt = new Date().toISOString();
  const operatingPolicy = loadSonarEmailResidentOperatingPolicy(siteRoot).policy;
  const steps: ResidentLoopStep[] = [];
  let failedStep: ResidentLoopStep | null = null;
  mkdirSync(resolve(siteRoot, '.ai', 'state'), { recursive: true });
  let store = null;
  let lock = null;

  try {
    store = dryRun ? null : openSiteLoopStore(siteRoot);
    if (store) {
      lock = acquireLoopLock(store, {
        loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
        runId,
        ttlMs: Number(options.lockTtlMs ?? options.lock_ttl_ms ?? operatingPolicy.cadence.lock_ttl_ms),
      });
      if (lock.status === 'contended') {
        const health = getLoopHealth(store, SONAR_EMAIL_RESIDENT_LOOP_ID);
        return {
          schema: 'narada.sonar.site_loop_run.v2',
          status: 'locked',
          loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
          run_id: runId,
          dry_run: false,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          lock,
          health,
          steps: [],
        };
      }
      beginLoopRun(store, {
        run_id: runId,
        loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
        status: 'running',
        dry_run: false,
        started_at: startedAt,
        summary: lock?.status === 'stale_recovered' ? { stale_lock_recovered: lock } : null,
      });
    }
    const control = store ? getLoopControl(store, SONAR_EMAIL_RESIDENT_LOOP_ID) : null;
    if (control?.paused && !drain) {
      const finishedAt = new Date().toISOString();
      const summary = { paused: true, step_count: 0 };
      finishLoopRun(store, runId, {
        status: 'paused',
        finished_at: finishedAt,
        summary,
      });
      const health = getLoopHealth(store, SONAR_EMAIL_RESIDENT_LOOP_ID);
      return {
        schema: 'narada.sonar.site_loop_run.v2',
        status: 'paused',
        loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
        run_id: runId,
        dry_run: dryRun,
        started_at: startedAt,
        finished_at: finishedAt,
        control,
        lock,
        health,
        summary,
        steps: [],
      };
    }

    const sourceSync = sourceSyncRequested;

    if (sourceSync && !drain) {
      const sourceSyncStep = await runStep({
        store,
        runId,
        onFailedStep: (step) => {
          failedStep = step;
          steps.push(step);
        },
        stepId: 'source_sync',
        inputRefs: [{ kind: 'site_root', ref: siteRoot }],
        execute: () => runSourceSync(siteRoot, { dryRun, runner: options.sourceSyncRunner }),
        outputRefs: (result) => sourceSyncRefs(result),
        evidence: (result) => summarizeSourceSync(result),
      });
      steps.push(sourceSyncStep);
    }

    let bridge = null;
    if (!drain) {
      bridge = await runStep({
        store,
        runId,
        onFailedStep: (step) => {
          failedStep = step;
          steps.push(step);
        },
        stepId: 'inbox_bridge',
        inputRefs: [{ kind: 'site_root', ref: siteRoot }],
        execute: () => pollInboxBridge(siteRoot, { dryRun, limit, threshold }),
        outputRefs: (result) => bridgeOutputRefs(result),
        evidence: (result) => summarizeBridgeResult(result),
      });
      steps.push(bridge);

      steps.push(recordSyntheticStep({
        store,
        runId,
        stepId: 'task_materialization',
        inputRefs: [{ kind: 'step', ref: 'inbox_bridge' }],
        outputRefs: materializedTaskRefs(bridge.result),
        evidence: summarizeTaskMaterialization(bridge.result),
      }));

      steps.push(recordSyntheticStep({
        store,
        runId,
        stepId: 'resident_directive_emission',
        inputRefs: materializedTaskRefs(bridge.result),
        outputRefs: residentDirectiveRefs(bridge.result),
        evidence: summarizeResidentDirectiveEmission(bridge.result),
      }));
    }

    const ticketTaskReconciliation: SiteLoopPayload = dryRun || drain || !sourceSync
      ? {
          schema: 'narada.sonar.ticket_task_reconciliation.v1',
          status: 'skipped',
          reason: dryRun ? 'dry_run' : drain ? 'drain' : 'source_sync_not_run',
          created: 0,
          existing: 0,
          planned: 0,
          results: [],
        }
      : await runStep({
          store,
          runId,
          onFailedStep: (step) => {
            failedStep = step;
            steps.push(step);
          },
          stepId: 'ticket_task_reconciliation',
          inputRefs: [
            ...(steps.find((step) => step.step_id === 'source_sync')?.output_refs ?? []),
            { kind: 'mailbox_ticket_projection', ref: 'help-global-maxima' },
          ],
          execute: () => runTicketTaskReconcile(siteRoot, {
            dryRun,
            limit,
            preferredRole: RESIDENT_ROLE,
            runner: options.ticketTaskReconcileRunner,
          }),
          outputRefs: (result) => ticketTaskRefs(result),
          evidence: (result) => summarizeTicketTaskReconciliation(result),
        });
    if (ticketTaskReconciliation?.step_id) {
      steps.push(ticketTaskReconciliation);
    } else {
      steps.push(recordSyntheticStep({
        store,
        runId,
        stepId: 'ticket_task_reconciliation',
        status: ticketTaskReconciliation.status === 'skipped' ? 'skipped' : 'ok',
        inputRefs: [{ kind: 'mailbox_ticket_projection', ref: 'help-global-maxima' }],
        outputRefs: ticketTaskRefs(ticketTaskReconciliation),
        evidence: summarizeTicketTaskReconciliation(ticketTaskReconciliation),
      }));
    }

    const preBacklogDirectiveIds = bridge ? residentDirectiveRefs(bridge.result).map((ref) => ref.ref) : [];
    const preBacklogResident = dryRun
      ? { status: 'skipped', reason: 'dry_run' }
      : getResidentStatus(siteRoot);
    const preBacklogOutcome = dryRun
      ? {
          schema: 'narada.sonar.agent_outcome_reconciliation.v1',
          status: 'skipped',
          reason: 'dry_run',
          output_refs: [],
          classifications: [],
          counts: {},
        }
      : runAgentOutcomeReconciliation(siteRoot, {
          nowIso: options.nowIso,
          actionStaleMinutes: options.actionStaleMinutes,
          deliveryStaleMinutes: options.deliveryStaleMinutes,
          directiveIds: preBacklogDirectiveIds,
          includeBacklog: true,
          resident: preBacklogResident,
        });
    steps.push(recordSyntheticStep({
      store,
      runId,
      stepId: 'pre_backlog_outcome_reconciliation',
      inputRefs: preBacklogDirectiveIds.map((ref) => ({ kind: 'directive', ref })),
      outputRefs: preBacklogOutcome.output_refs ?? [],
      evidence: preBacklogOutcome,
    }));

    const reportedTaskStateReconciliation = dryRun
      ? { schema: 'narada.sonar.reported_resident_task_state_reconciliation.v1', status: 'skipped', reason: 'dry_run', repaired: [] }
      : await reconcileReportedResidentTaskLifecycleState(siteRoot, { limit: 100 });
    steps.push(recordSyntheticStep({
      store,
      runId,
      stepId: 'reported_resident_task_state_reconciliation',
      inputRefs: [{ kind: 'resident_backlog', ref: RESIDENT_AGENT_ID }],
      outputRefs: (reportedTaskStateReconciliation.repaired ?? []).map((item) => ({ kind: 'task', ref: item.task_id })),
      evidence: reportedTaskStateReconciliation,
    }));

    const backlogRecovery = dryRun
      ? {
          schema: 'narada.sonar.resident_backlog_recovery.v1',
          status: 'skipped',
          reason: 'dry_run',
          emitted: [],
          skipped: [],
        }
      : emitResidentBacklogRecoveryDirectives(siteRoot, {
          nowIso: options.nowIso,
          actionStaleMinutes: options.actionStaleMinutes,
          limit: Math.min(limit, Number(operatingPolicy.rate_limits?.max_directives_per_cycle ?? limit)),
        });
    steps.push(recordSyntheticStep({
      store,
      runId,
      stepId: 'resident_backlog_recovery_emission',
      inputRefs: [{ kind: 'resident_backlog', ref: RESIDENT_AGENT_ID }],
      outputRefs: residentBacklogRecoveryDirectiveRefs(backlogRecovery),
      evidence: summarizeResidentBacklogRecovery(backlogRecovery),
    }));

    const residentSupervisor: SiteLoopPayload = dryRun || !options.ensureResident
      ? { status: 'skipped', reason: dryRun ? 'dry_run' : 'not_enabled' }
      : await runStep({
          store,
          runId,
          onFailedStep: (step) => {
            failedStep = step;
            steps.push(step);
          },
          stepId: 'resident_supervisor',
          inputRefs: [{ kind: 'agent', ref: RESIDENT_AGENT_ID }],
          execute: () => ensureResidentCarrier(siteRoot, {
            runner: options.residentSupervisorRunner,
            requireLiveCarrier: options.requireLiveCarrier !== false,
          }),
          outputRefs: (result) => result.launch?.event_path ? [{ kind: 'agent_start_event', ref: result.launch.event_path }] : [],
          evidence: (result) => result,
        });
    if (residentSupervisor?.step_id) steps.push(residentSupervisor);

    let dispatch = null;
    if (dryRun) {
      dispatch = {
        schema: 'narada.sonar.directive_dispatch.v0',
        status: 'skipped',
        dry_run: true,
        reason: 'dry_run',
        dispatched: [],
        skipped: [],
        receipt_reconciliation: { status: 'skipped', reason: 'dry_run' },
        lease_recovery: { status: 'skipped', reason: 'dry_run' },
      };
      steps.push(recordSyntheticStep({
        store,
        runId,
        onFailedStep: (step) => {
          failedStep = step;
          steps.push(step);
        },
        stepId: 'resident_directive_dispatch',
        status: 'skipped',
        inputRefs: bridge ? residentDirectiveRefs(bridge.result) : [],
        outputRefs: [],
        evidence: dispatch,
      }));
    } else if (!drain) {
      const dispatchStep = await runStep({
        store,
        runId,
        onFailedStep: (step) => {
          failedStep = step;
          steps.push(step);
        },
        stepId: 'resident_directive_dispatch',
        inputRefs: [
          ...(bridge ? residentDirectiveRefs(bridge.result) : []),
          ...residentBacklogRecoveryDirectiveRefs(backlogRecovery),
        ],
        execute: () => (options.dispatchRunner ?? dispatchPendingDirectives)({
          cwd: siteRoot,
          agentId: RESIDENT_AGENT_ID,
          role: RESIDENT_ROLE,
          limit,
          dryRun: false,
          requireLiveCarrier: options.requireLiveCarrier !== false,
        }),
        outputRefs: (result) => dispatchedDirectiveRefs(result),
        evidence: (result) => summarizeDirectiveDispatch(result),
      });
      dispatch = dispatchStep.result;
      steps.push(dispatchStep);
    } else {
      const drainStep = await runStep({
        store,
        runId,
        onFailedStep: (step) => {
          failedStep = step;
          steps.push(step);
        },
        stepId: 'resident_directive_dispatch',
        inputRefs: [],
        execute: () => (options.dispatchRunner ?? dispatchPendingDirectives)({
          cwd: siteRoot,
          agentId: RESIDENT_AGENT_ID,
          role: RESIDENT_ROLE,
          limit: 0,
          dryRun: false,
        }),
        outputRefs: () => [],
        evidence: (result) => ({ ...summarizeDirectiveDispatch(result), drain: true }),
      });
      dispatch = drainStep.result;
      steps.push(drainStep);
    }

    steps.push(recordSyntheticStep({
      store,
      runId,
      stepId: 'receipt_reconciliation',
      inputRefs: dispatchedDirectiveRefs(dispatch),
      outputRefs: receiptRefs(dispatch),
      evidence: summarizeReceiptReconciliation(dispatch),
    }));

    const resident = dryRun
      ? { status: 'skipped', reason: 'dry_run' }
      : getResidentStatus(siteRoot);
    const directiveIds = bridge ? residentDirectiveRefs(bridge.result).map((ref) => ref.ref) : [];
    const outcome = dryRun
      ? {
          schema: 'narada.sonar.agent_outcome_reconciliation.v1',
          status: 'skipped',
          reason: 'dry_run',
          output_refs: [],
          classifications: [],
          counts: {},
        }
      : runAgentOutcomeReconciliation(siteRoot, {
          nowIso: options.nowIso,
          actionStaleMinutes: options.actionStaleMinutes,
          deliveryStaleMinutes: options.deliveryStaleMinutes,
          directiveIds,
          includeBacklog: true,
          resident,
        });
    const escalation = store && !dryRun
      ? reconcileLoopEscalations(siteRoot, store, outcome, { runId, nowIso: options.nowIso })
      : { status: 'skipped', reason: dryRun ? 'dry_run' : 'store_unavailable', created: [] };
    steps.push(recordSyntheticStep({
      store,
      runId,
      stepId: 'agent_outcome_reconciliation',
      inputRefs: directiveIds.map((ref) => ({ kind: 'directive', ref })),
      outputRefs: outcome.output_refs,
      evidence: outcome,
    }));

    steps.push(recordSyntheticStep({
      store,
      runId,
      stepId: 'stale_escalation_reconciliation',
      inputRefs: outcome.output_refs ?? [],
      outputRefs: (escalation.created ?? []).map((item) => ({ kind: 'operator_attention_envelope', ref: item.envelope_id, directive_id: item.directive_id })),
      evidence: escalation,
    }));

    const operatingAlerts = store && !dryRun
      ? persistOperatingLayerAlerts(siteRoot, store, {
          runId,
          nowIso: options.nowIso,
          requireFreshProductionProof: options.requireFreshProductionProof === true || options.require_fresh_production_proof === true,
        })
      : { status: 'skipped', reason: dryRun ? 'dry_run' : 'store_unavailable', created: [] };
    steps.push(recordSyntheticStep({
      store,
      runId,
      stepId: 'operating_alert_reconciliation',
      inputRefs: [],
      outputRefs: (operatingAlerts.created ?? []).map((item) => ({ kind: 'operator_attention_envelope', ref: item.envelope_id, classification: item.classification })),
      evidence: operatingAlerts,
    }));

    const finishedAt = new Date().toISOString();
    const summary = summarizeRun({ bridge: bridge?.result ?? null, dispatch, steps, outcome });
    let health = null;
    if (store) {
      finishLoopRun(store, runId, {
        status: 'ok',
        finished_at: finishedAt,
        summary,
      });
      health = recordLoopHealthSuccess(store, {
        loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
        runId,
        at: finishedAt,
      });
    }
    return {
      schema: 'narada.sonar.site_loop_run.v2',
      status: 'ok',
      loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
      run_id: runId,
      dry_run: dryRun,
      started_at: startedAt,
      finished_at: finishedAt,
      lock,
      health,
      control,
      summary,
      steps: steps.map(publicStep),
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const errorPayload = errorToPayload(error);
    if (store) {
      finishLoopRun(store, runId, {
        status: 'failed',
        finished_at: finishedAt,
        summary: { step_count: steps.length },
        error: errorPayload,
      });
      recordLoopHealthFailure(store, {
        loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
        runId,
        failingStep: failedStep?.step_id ?? null,
        error: errorPayload,
        at: finishedAt,
      });
    }
    return {
      schema: 'narada.sonar.site_loop_run.v2',
      status: 'failed',
      loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
      run_id: runId,
      dry_run: dryRun,
      started_at: startedAt,
      finished_at: finishedAt,
      error: errorPayload,
      steps: steps.map(publicStep),
    };
  } finally {
    if (store) {
      if (lock?.status === 'acquired' || lock?.status === 'stale_recovered') {
        releaseLoopLock(store, { loopId: SONAR_EMAIL_RESIDENT_LOOP_ID, runId });
      }
      store.close();
    }
  }
}

async function runSourceSync(siteRoot, { dryRun, runner }: SiteLoopPayload = {}) {
  if (typeof runner === 'function') {
    return runner({ cwd: siteRoot, dryRun });
  }
  const args = ['cli', '--', '--json', 'sync'];
  if (dryRun) args.push('--dry-run');
  const result = spawnSync('pnpm', args, {
    cwd: siteRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    const error: EnrichedProcessError = new Error(`source sync failed: ${result.stderr || result.stdout || result.status}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return parseJsonOutput(result.stdout, {
    schema: 'narada.sonar.source_sync.v1',
    status: 'ok',
    stdout: result.stdout,
  });
}

async function runTicketTaskReconcile(siteRoot, { dryRun, limit, preferredRole, runner }: SiteLoopPayload = {}) {
  if (typeof runner === 'function') {
    return runner({ cwd: siteRoot, dryRun, limit, preferredRole });
  }
  const args = [
    'cli',
    '--',
    '--json',
    'ticket',
    'task',
    'reconcile',
    '--preferred-role',
    preferredRole ?? RESIDENT_ROLE,
  ];
  if (Number.isFinite(Number(limit))) args.push('--limit', String(Number(limit)));
  if (dryRun) args.push('--dry-run');
  const result = spawnSync('pnpm', args, {
    cwd: siteRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    const error: EnrichedProcessError = new Error(`ticket task reconcile failed: ${result.stderr || result.stdout || result.status}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return {
    schema: 'narada.sonar.ticket_task_reconciliation.v1',
    ...parseJsonOutput(result.stdout, {
      status: 'success',
      stdout: result.stdout,
    }),
  };
}

export function listSonarEmailResidentLoopRuns(cwd, options: SiteLoopPayload = {}) {
  const store = openSiteLoopStore(resolve(cwd), { write: false });
  try {
    return {
      schema: 'narada.sonar.site_loop_runs.v1',
      loop_id: options.loopId ?? SONAR_EMAIL_RESIDENT_LOOP_ID,
      runs: listLoopRuns(store, {
        limit: Number(options.limit ?? 10),
        loopId: options.loopId ?? SONAR_EMAIL_RESIDENT_LOOP_ID,
      }),
    };
  } finally {
    store.close();
  }
}

export function showSonarEmailResidentLoopRun(cwd, runId) {
  const store = openSiteLoopStore(resolve(cwd), { write: false });
  try {
    const run = getLoopRun(store, runId);
    return {
      schema: 'narada.sonar.site_loop_show.v1',
      status: run ? 'ok' : 'not_found',
      run,
    };
  } finally {
    store.close();
  }
}

export function sonarEmailResidentLoopStatus(cwd) {
  const store = openSiteLoopStore(resolve(cwd), { write: false });
  try {
    return getLoopStatus(store, { loopId: SONAR_EMAIL_RESIDENT_LOOP_ID });
  } finally {
    store.close();
  }
}

export function sonarEmailResidentLoopHealth(cwd) {
  const store = openSiteLoopStore(resolve(cwd), { write: false });
  try {
    return getLoopHealth(store, SONAR_EMAIL_RESIDENT_LOOP_ID);
  } finally {
    store.close();
  }
}

export function sonarEmailResidentOperatingLayerStatus(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const nowMs = Date.parse(options.now ?? options.nowIso ?? options.now_iso ?? new Date().toISOString());
  const loop = sonarEmailResidentLoopStatus(siteRoot);
  const resident = sonarResidentStatus(siteRoot);
  const pending = sonarResidentPending(siteRoot, { limit: options.limit ?? 25 });
  const receipts = sonarResidentReceipts(siteRoot, { limit: 1 });
  const outcomes = sonarResidentOutcomes(siteRoot, { limit: options.outcomeLimit ?? options.outcome_limit ?? 500 });
  const proofFreshnessWindowMs = Number(options.productionProofFreshnessMs ?? options.production_proof_freshness_ms ?? MAILBOX_PROOF_FRESHNESS_MS);
  const mailboxProofFreshnessWindowMs = Number(options.mailboxProofFreshnessMs ?? options.mailbox_proof_freshness_ms ?? MAILBOX_PROOF_FRESHNESS_MS);
  const policy = loadSonarEmailResidentOperatingPolicy(siteRoot);
  const dbHealth = taskLifecycleDbHealth(siteRoot);
  const surfacePolicyNoise = recentSurfacePolicyNoise(siteRoot, {
    carrierStartedAt: resident?.host?.started_event?.timestamp ?? null,
    includeEvidence: options.includeSurfacePolicyEvidence === true || options.include_surface_policy_evidence === true,
  });
  const mailboxProof = latestResidentMailboxProof(siteRoot, {
    nowMs,
    freshnessMs: mailboxProofFreshnessWindowMs,
  });
  const latestSummary = loop.latest?.summary ?? {};
  const health = loop.health ?? null;
  const openAttention = loop.attention?.open_count ?? health?.attention?.open_count ?? 0;
  const unresolved = health?.unresolved_backlog?.unresolved_count ?? 0;
  const pendingCount = Number(pending.pending_count ?? 0);
  const stalePendingThresholdMs = Number(options.stalePendingThresholdMs ?? options.stale_pending_threshold_ms ?? 10 * 60_000);
  const stalePending = stalePendingDirectives(pending.directives ?? [], {
    now: options.now ?? options.nowIso ?? options.now_iso,
    thresholdMs: stalePendingThresholdMs,
  });
  const healthOk = ['healthy', 'unknown'].includes(health?.status ?? 'unknown');
  const carrierUsable = ['available', 'busy'].includes(resident.status);
  const proofDriver = resident.host?.started_event?.resident_proof_driver === true;
  const carrier: ResidentCarrier = resident.carrier ?? {};
  const agentCliControlPath = carrier.preferred_interactive?.controlPath ?? (carrier.runtime === 'agent-cli' ? carrier.controlPath ?? null : null);
  const agentCliReady = Boolean(agentCliControlPath && existsSync(agentCliControlPath))
    && (carrier.preferred_interactive?.status === 'available' || carrier.runtime === 'agent-cli');
  const primaryRuntimeReady = carrier.runtime === 'agent-cli'
    && carrier.preference === 'interactive_agent_cli'
    && proofDriver !== true;
  const latestProductionOutcome = latestProductionReportedOutcome(outcomes.outcomes ?? []);
  const latestProductionProof = Boolean(latestProductionOutcome);
  const productionProofAgeMs = latestProductionOutcome?.event_at
    ? nowMs - Date.parse(latestProductionOutcome.event_at)
    : null;
  const productionProofFresh = latestProductionProof
    && Number.isFinite(productionProofAgeMs)
    && productionProofAgeMs <= proofFreshnessWindowMs;
  const surfacePolicyOk = surfacePolicyNoise.status === 'ok';
  const dbOk = dbHealth.status === 'ok';
  const policyOk = policy.status === 'ok';
  const alertSignals = operatingLayerAlertSignals({
    resident,
    dbHealth,
    health,
    pending,
    stalePending,
    requireFreshProductionProof: options.requireFreshProductionProof === true || options.require_fresh_production_proof === true,
    productionProofFresh,
  });
  const transportStatus = !healthOk || !surfacePolicyOk || !dbOk || !policyOk || openAttention > 0 || !carrierUsable || alertSignals.some((item) => item.severity === 'critical' || item.severity === 'error')
    ? 'attention_needed'
    : pendingCount > 0 && resident.status === 'busy'
      ? 'backpressure'
      : 'transport_ready';
  const productionStatus = primaryRuntimeReady && productionProofFresh
    ? 'production_ready'
    : primaryRuntimeReady
      ? 'production_unproven'
      : 'transport_only';
  return {
    schema: 'narada.sonar.operating_layer_status.v1',
    status: transportStatus === 'transport_ready' && productionStatus === 'production_ready'
      ? 'production_ready'
      : transportStatus,
    transport_status: transportStatus,
    production_status: productionStatus,
    loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
    health: {
      status: health?.status ?? 'unknown',
      stored_status: health?.stored_status ?? null,
      consecutive_failures: health?.consecutive_failures ?? 0,
      last_run_id: health?.last_run_id ?? null,
      last_run_at: health?.last_run_at ?? null,
      failing_step: health?.failing_step ?? null,
    },
    resident: {
      agent_id: resident.agent_id,
      status: resident.status,
      runtime: carrier.runtime ?? null,
      preference: carrier.preference ?? null,
      primary_runtime_ready: primaryRuntimeReady,
      proof_driver: proofDriver,
      agent_cli_ready: agentCliReady || primaryRuntimeReady,
      agent_cli_control_path: agentCliControlPath,
      preferred_runtime_selected: carrier.preference === 'interactive_agent_cli',
      carrier_session_id: carrier.carrierSessionId ?? null,
      active_turn_state: resident.active_turn_state ?? null,
      carrier_state: resident.carrier_state ?? null,
      availability: resident.availability_detail ?? null,
    },
    policy,
    db_health: dbHealth,
    backlog: {
      pending_directives: pendingCount,
      unresolved_directives: unresolved,
      open_attention: openAttention,
      stale_pending_directives: stalePending.length,
      stale_pending_threshold_ms: stalePendingThresholdMs,
      outcome_counts: outcomes.summary?.counts ?? {},
      resident_backlog: resident.resident_backlog ?? null,
    },
    latest_activity: {
      loop_run_id: loop.latest?.run_id ?? null,
      loop_status: loop.latest?.status ?? null,
      source_sync: latestSummary.source_sync ?? null,
      evaluated: latestSummary.evaluated ?? null,
      materialized: latestSummary.materialized ?? null,
      resident_directives_emitted: latestSummary.resident_directives_emitted ?? null,
      directives_dispatched: latestSummary.directives_dispatched ?? null,
      receipts_recorded: latestSummary.receipts_recorded ?? null,
      latest_receipt_at: receipts.receipts?.[0]?.received_at ?? null,
      latest_report_at: resident.latest_report?.submitted_at ?? null,
      latest_report_production_proof: latestProductionProof,
      latest_production_outcome_at: latestProductionOutcome?.event_at ?? null,
      production_proof_age_ms: productionProofAgeMs,
      production_proof_fresh: productionProofFresh,
      production_proof_freshness_window_ms: proofFreshnessWindowMs,
      mailbox_proof_fresh: mailboxProof.status === 'fresh',
      mailbox_proof_age_ms: mailboxProof.age_ms ?? null,
      mailbox_proof_at: mailboxProof.proof?.proved_at ?? null,
      mailbox_proof_freshness_window_ms: mailboxProofFreshnessWindowMs,
    },
    mailbox_proof: mailboxProof,
    alerts: alertSignals,
    surface_policy_noise: surfacePolicyNoise,
    commands: {
      run_once: 'pnpm cli -- loop run sonar.email-resident --once --ensure-resident',
      supervise: 'pnpm cli -- loop supervise sonar.email-resident --ensure-resident',
      agent_cli_resident: '.\\narada-sonar.ps1 agent-start -Agent sonar.resident -Runtime agent-cli -Exec',
      live_fixture_proof: 'pnpm cli -- resident e2e --ack-fixture --live --ensure-resident --expect-carrier-preference interactive_agent_cli --production-proof --json',
      mailbox_proof: 'pnpm cli -- resident e2e --mailbox-proof --controlled-mailbox-proof --controlled-mailbox-source <ref> --live --ensure-resident --expect-carrier-preference interactive_agent_cli --production-proof --json',
    },
    notes: [
      'This status is scoped to the Sonar email resident operating layer.',
      'transport_ready means loop plumbing is usable; production_ready additionally requires primary agent-cli runtime and non-proof-driver report evidence.',
      'Unrelated Sonar cloud or Sentry warnings are intentionally excluded.',
    ],
  };
}

export function sonarEmailResidentReadiness(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const operating = sonarEmailResidentOperatingLayerStatus(siteRoot, options);
  const requireProduction = options.requireProduction === true || options.require_production === true;
  const requireMailboxProof = options.requireMailboxProof === true || options.require_mailbox_proof === true;
  const projection = options.projectionDriftResult ?? runReadinessJsonCommand(siteRoot, [
    process.execPath,
    [join(siteRoot, 'tools', 'task-lifecycle', 'detect-projection-drift.js'), siteRoot],
  ]);
  const packageBoundary = options.packageBoundaryResult ?? checkTaskGovernancePackageBoundary(siteRoot);
  const pending = Number(operating.backlog?.pending_directives ?? 0);
  const stalePending = Number(operating.backlog?.stale_pending_directives ?? 0);
  const openAttention = Number(operating.backlog?.open_attention ?? 0);
  const residentUsable = ['available', 'busy'].includes(operating.resident?.status);
  const gates = [
    readinessGate('db_health', operating.db_health?.status === 'ok', {
      status: operating.db_health?.status ?? 'unknown',
      integrity: operating.db_health?.integrity_check ?? null,
      repair_command: operating.db_health?.repair_command ?? null,
    }),
    readinessGate('policy', operating.policy?.status === 'ok', {
      status: operating.policy?.status ?? 'unknown',
      errors: operating.policy?.validation?.errors ?? [],
    }),
    readinessGate('surface_policy_noise', operating.surface_policy_noise?.status === 'ok', {
      current_count: operating.surface_policy_noise?.current_count ?? null,
      historical_count: operating.surface_policy_noise?.historical_count ?? null,
      repaired_historical_count: operating.surface_policy_noise?.repaired_historical_count ?? null,
    }),
    readinessGate('projection_drift', projection.status === 'ok' && projection.packet?.status === 'ok', {
      command_status: projection.status,
      drift_count: projection.packet?.drift_count ?? null,
      missing_sql: projection.packet?.missing_sql ?? null,
      error: projection.error ?? null,
    }),
    readinessGate('package_boundary', packageBoundary.status === 'ok', packageBoundary),
    readinessGate('resident_carrier', residentUsable, {
      status: operating.resident?.status ?? 'unknown',
      runtime: operating.resident?.runtime ?? null,
      preference: operating.resident?.preference ?? null,
      carrier_session_id: operating.resident?.carrier_session_id ?? null,
    }),
    readinessGate('production_runtime', !requireProduction || operating.production_status === 'production_ready', {
      required: requireProduction,
      production_status: operating.production_status ?? 'unknown',
      primary_runtime_ready: operating.resident?.primary_runtime_ready === true,
      production_proof_fresh: operating.latest_activity?.production_proof_fresh === true,
      proof_driver: operating.resident?.proof_driver === true,
      block_code: productionRuntimeBlockCode(operating),
      remediation: productionRuntimeRemediation(operating),
    }),
    readinessGate('mailbox_proof', !requireMailboxProof || operating.mailbox_proof?.status === 'fresh', {
      required: requireMailboxProof,
      status_detail: operating.mailbox_proof?.status ?? 'missing',
      proof_id: operating.mailbox_proof?.proof?.proof_id ?? null,
      proved_at: operating.mailbox_proof?.proof?.proved_at ?? null,
      age_ms: operating.mailbox_proof?.age_ms ?? null,
      freshness_window_ms: operating.mailbox_proof?.freshness_window_ms ?? null,
      remediation: 'Run a controlled live mailbox proof: pnpm cli -- resident e2e --mailbox-proof --controlled-mailbox-proof --controlled-mailbox-source <ref> --live --ensure-resident --expect-carrier-preference interactive_agent_cli --production-proof --json',
    }),
    readinessGate('stale_pending_directives', stalePending === 0, {
      stale_pending_directives: stalePending,
      threshold_ms: operating.backlog?.stale_pending_threshold_ms ?? null,
    }),
    readinessGate('operator_attention', openAttention === 0, {
      open_attention: openAttention,
    }),
    readinessGate('pending_without_carrier', pending === 0 || residentUsable, {
      pending_directives: pending,
      resident_status: operating.resident?.status ?? 'unknown',
    }),
  ];
  const failed = gates.filter((gate) => gate.status !== 'ok');
  const ready = failed.length === 0;
  return {
    schema: 'narada.sonar.operating_layer_readiness.v1',
    status: ready ? 'ready' : 'not_ready',
    ready,
    loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
    gates,
    failed_gates: failed.map((gate) => gate.gate),
    invariants: [
      {
        invariant: 'one_task_projection_per_lifecycle_row',
        gate: 'projection_drift',
        status: gateStatus(gates, 'projection_drift'),
      },
      {
        invariant: 'site_runtime_uses_current_narada_contracts',
        gate: 'package_boundary',
        status: gateStatus(gates, 'package_boundary'),
      },
      {
        invariant: 'one_usable_resident_delivery_lane',
        gate: 'resident_carrier',
        status: gateStatus(gates, 'resident_carrier'),
      },
      {
        invariant: 'production_grade_readiness_when_requested',
        gate: 'production_runtime',
        status: gateStatus(gates, 'production_runtime'),
      },
      {
        invariant: 'mailbox_to_resident_proof_when_requested',
        gate: 'mailbox_proof',
        status: gateStatus(gates, 'mailbox_proof'),
      },
      {
        invariant: 'pending_directives_are_deliverable_or_visible',
        gate: 'pending_without_carrier',
        status: gateStatus(gates, 'pending_without_carrier'),
      },
    ],
    operating_layer: operating,
    commands: {
      status: 'pnpm cli -- ops loop',
      readiness: requireProduction || requireMailboxProof
        ? `pnpm cli -- ops readiness${requireProduction ? ' --require-production' : ''}${requireMailboxProof ? ' --require-mailbox-proof' : ''}`
        : 'pnpm cli -- ops readiness',
      projection_drift: 'pnpm cli -- task projection drift --json',
      run_once: operating.commands?.run_once ?? null,
      supervise: operating.commands?.supervise ?? null,
    },
  };
}

export function sonarEmailResidentCoherence(cwd, options: SiteLoopPayload = {}) {
  const requireProduction = options.requireProduction !== false && options.require_production !== false;
  const requireMailboxProof = options.requireMailboxProof !== false && options.require_mailbox_proof !== false;
  const readiness = sonarEmailResidentReadiness(cwd, {
    ...options,
    requireProduction,
    requireMailboxProof,
  });
  const blockers = readiness.gates
    .filter((gate) => gate.status !== 'ok')
    .map((gate) => coherenceBlocker(gate, readiness));
  return {
    schema: 'narada.sonar.operating_layer_coherence.v1',
    status: blockers.length === 0 ? 'coherent' : 'not_coherent',
    coherent: blockers.length === 0,
    loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
    required: {
      production_runtime: requireProduction,
      mailbox_proof: requireMailboxProof,
    },
    blockers,
    next_actions: blockers.length === 0
      ? []
      : blockers.map((blocker) => blocker.next_action).filter(Boolean),
    readiness,
    commands: {
      readiness: `pnpm cli -- ops readiness${requireProduction ? ' --require-production' : ''}${requireMailboxProof ? ' --require-mailbox-proof' : ''}`,
      status: 'pnpm cli -- ops loop',
      mailbox_proof: readiness.operating_layer?.commands?.mailbox_proof ?? null,
      background_agent_cli: 'pnpm cli -- resident summon --background --json',
    },
  };
}

function coherenceBlocker(gate, readiness) {
  const base = {
    gate: gate.gate,
    status: gate.status,
    code: gate.block_code ?? `blocked_by_${gate.gate}`,
    detail: gate,
    next_action: null,
  };
  if (gate.gate === 'mailbox_proof') {
    return {
      ...base,
      code: gate.status_detail === 'missing'
        ? 'blocked_by_missing_controlled_mailbox_proof'
        : gate.status_detail === 'stale'
          ? 'blocked_by_stale_controlled_mailbox_proof'
          : base.code,
      next_action: gate.remediation,
    };
  }
  if (gate.gate === 'production_runtime') {
    return {
      ...base,
      code: gate.block_code ?? 'blocked_by_unproven_production_runtime',
      next_action: gate.remediation,
    };
  }
  if (gate.gate === 'resident_carrier') {
    return {
      ...base,
      code: 'blocked_by_no_usable_resident_carrier',
      next_action: readiness.operating_layer?.commands?.agent_cli_resident
        ? `Start resident carrier: ${readiness.operating_layer.commands.agent_cli_resident}`
        : 'Start sonar.resident agent-cli carrier.',
    };
  }
  if (gate.gate === 'projection_drift') {
    return {
      ...base,
      code: 'blocked_by_task_projection_drift',
      next_action: 'Run pnpm cli -- task projection drift --json and repair reported drift.',
    };
  }
  if (gate.gate === 'package_boundary') {
    return {
      ...base,
      code: gate.block_codes?.[0] ?? 'blocked_by_package_boundary',
      next_action: gate.remediation ?? 'Run pnpm install and rerun the package boundary guard.',
    };
  }
  return base;
}

function productionRuntimeBlockCode(operating) {
  if (operating.production_status === 'production_ready') return null;
  if (operating.resident?.primary_runtime_ready !== true) return 'blocked_by_no_primary_agent_cli';
  if (operating.resident?.proof_driver === true) return 'blocked_by_proof_driver_runtime';
  if (operating.latest_activity?.production_proof_fresh !== true) return 'blocked_by_no_fresh_production_proof';
  return 'blocked_by_unproven_production_runtime';
}

function productionRuntimeRemediation(operating) {
  const command = operating.commands?.agent_cli_resident ?? '.\\narada-sonar.ps1 agent-start -Agent sonar.resident -Runtime agent-cli -Exec';
  if (operating.resident?.primary_runtime_ready !== true) return `Start and keep open the primary resident carrier: ${command}`;
  if (operating.resident?.proof_driver === true) return 'Run production proof through live agent-cli resident, not the agent-runtime-server proof driver.';
  if (operating.latest_activity?.production_proof_fresh !== true) return 'Run a fresh controlled resident proof through the primary agent-cli carrier.';
  return 'Inspect resident readiness evidence.';
}

function checkTaskGovernancePackageBoundary(siteRoot) {
  const taskLifecycleRoot = join(siteRoot, 'tools', 'task-lifecycle');
  const naradaProperRoot = resolve(siteRoot, '..', 'narada');
  const packages = [
    {
      name: '@narada2/charters',
      vendor: 'charters',
      expectedDependency: 'workspace:*',
      naradaPackageRoot: join(naradaProperRoot, 'packages', 'domains', 'charters'),
    },
    {
      name: '@narada2/control-plane',
      vendor: 'control-plane',
      expectedDependency: 'workspace:*',
      naradaPackageRoot: join(naradaProperRoot, 'packages', 'layers', 'control-plane'),
    },
    {
      name: '@narada2/intent-zones',
      vendor: 'intent-zones',
      expectedDependency: 'workspace:*',
      naradaPackageRoot: join(naradaProperRoot, 'packages', 'intent-zones'),
    },
    {
      name: '@narada2/task-lifecycle-kernel',
      vendor: 'task-lifecycle-kernel',
      expectedDependency: 'workspace:*',
      naradaPackageRoot: join(naradaProperRoot, 'packages', 'task-lifecycle-kernel'),
    },
    {
      name: '@narada2/task-governance-core',
      vendor: 'task-governance',
      expectedDependency: 'workspace:*',
      naradaPackageRoot: join(naradaProperRoot, 'packages', 'task-governance'),
    },
  ];
  const result: SiteLoopPayload = {
    status: 'ok',
    packages: [],
  };
  try {
    const packageJson = JSON.parse(readFileSync(join(taskLifecycleRoot, 'package.json'), 'utf8'));
    result.block_codes = [];
    for (const pkg of packages) {
      const installedPackage = join(taskLifecycleRoot, 'node_modules', ...pkg.name.split('/'));
      const localVendor = join(taskLifecycleRoot, 'vendor', pkg.vendor);
      const row = {
        package: pkg.name,
        expected_dependency: pkg.expectedDependency,
        configured_dependency: packageJson.dependencies?.[pkg.name] ?? null,
        narada_package_root: pkg.naradaPackageRoot,
        installed_package: installedPackage,
        local_vendor_present: existsSync(localVendor),
        installed_realpath: existsSync(installedPackage) ? realpathSync(installedPackage) : null,
        expected_realpath: existsSync(pkg.naradaPackageRoot) ? realpathSync(pkg.naradaPackageRoot) : null,
      };
      result.packages.push(row);
      if (row.configured_dependency !== pkg.expectedDependency) result.block_codes.push(`blocked_by_wrong_dependency:${pkg.name}`);
      if (!row.expected_realpath || row.installed_realpath !== row.expected_realpath) result.block_codes.push(`blocked_by_realpath_mismatch:${pkg.name}`);
      if (row.local_vendor_present) result.block_codes.push(`blocked_by_local_vendor:${pkg.vendor}`);
    }
    if (result.block_codes.length > 0) {
      result.status = 'blocked';
      result.remediation = 'Remove tools/task-lifecycle/vendor/*, keep task-lifecycle Narada dependencies on workspace:*, then run pnpm install.';
    }
  } catch (error) {
    result.status = 'blocked';
    result.block_codes = ['blocked_by_package_boundary_check_error'];
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function readinessGate(gate, ok, detail: SiteLoopPayload = {}) {
  return {
    gate,
    ...detail,
    status: ok ? 'ok' : 'blocked',
  };
}

function gateStatus(gates, gate) {
  return gates.find((item) => item.gate === gate)?.status ?? 'unknown';
}

function runReadinessJsonCommand(cwd, [command, args]) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'),
    },
  });
  const stdout = String(result.stdout ?? '').trim();
  let packet = null;
  try {
    packet = stdout ? JSON.parse(stdout) : null;
  } catch (error) {
    return {
      status: 'invalid_json',
      exit_code: result.status ?? 1,
      error: error instanceof Error ? error.message : String(error),
      stdout,
      stderr: String(result.stderr ?? '').trim(),
    };
  }
  return {
    status: result.status === 0 ? 'ok' : 'failed',
    exit_code: result.status ?? (result.error ? 1 : 0),
    packet,
    stdout,
    stderr: String(result.stderr ?? '').trim(),
    error: result.error ? result.error.message : null,
  };
}

function appendNodeOption(existing, option) {
  const current = String(existing ?? '').trim();
  if (current.split(/\s+/).includes(option)) return current;
  return [current, option].filter(Boolean).join(' ');
}

function recentSurfacePolicyNoise(siteRoot, options: SiteLoopPayload = {}) {
  const policyPath = join(siteRoot, '.narada', 'capabilities', 'mcp-surfaces.json');
  const actionDir = join(siteRoot, '.narada', 'crew', 'action-admission');
  const declaredTools = loadSurfaceDeclaredTools(policyPath);
  const includeEvidence = options.includeEvidence === true || options.include_evidence === true;
  const repairedAtMs = existsSync(policyPath) ? statSync(policyPath).mtimeMs : 0;
  const carrierStartedAtMs = Date.parse(options.carrierStartedAt ?? '');
  const currentBaselineMs = Math.max(
    repairedAtMs,
    Number.isFinite(carrierStartedAtMs) ? carrierStartedAtMs : 0,
  );
  const current: SurfacePolicyNoise[] = [];
  const historical: SurfacePolicyNoise[] = [];
  const repairedHistorical: SurfacePolicyNoise[] = [];
  if (!existsSync(actionDir)) {
    const result: SiteLoopPayload = {
      schema: 'narada.sonar.surface_policy_noise.v1',
      status: 'ok',
      policy_path: policyPath,
      current_count: 0,
      historical_count: 0,
      repaired_historical_count: 0,
      current: [],
    };
    if (includeEvidence) result.repaired_historical = [];
    return result;
  }
  for (const name of readdirSafe(actionDir).filter((entry) => entry.endsWith('.json'))) {
    const path = join(actionDir, name);
    const packet = readJson(path);
    if (packet?.reason !== 'surface_registry_tool_not_declared') continue;
    const serverName = packet?.request?.requested_action?.classifier_metadata?.server_name ?? null;
    const toolName = packet?.request?.requested_action?.tool ?? packet?.requested_action?.tool ?? packet?.tool ?? null;
    const item = {
      path,
      tool: toolName,
      server_name: serverName,
      reason: packet.reason,
      mtime_ms: statSync(path).mtimeMs,
    };
    if (toolName && declaredTools.has(`${serverName ?? ''}:${toolName}`)) {
      repairedHistorical.push(item);
      continue;
    }
    if (item.mtime_ms >= currentBaselineMs) current.push(item);
    else historical.push(item);
  }
  const result: SiteLoopPayload = {
    schema: 'narada.sonar.surface_policy_noise.v1',
    status: current.length === 0 ? 'ok' : 'attention_needed',
    policy_path: policyPath,
    policy_mtime_ms: repairedAtMs,
    current_baseline_ms: currentBaselineMs,
    carrier_started_at: options.carrierStartedAt ?? null,
    current_count: current.length,
    historical_count: historical.length,
    repaired_historical_count: repairedHistorical.length,
    current,
  };
  if (includeEvidence) result.repaired_historical = repairedHistorical.slice(0, 20);
  return result;
}

function residentMailboxProofDir(siteRoot) {
  return join(siteRoot, '.ai', 'runtime', 'resident-mailbox-proofs');
}

function recordResidentMailboxProof(siteRoot, proof) {
  const dir = residentMailboxProofDir(siteRoot);
  mkdirSync(dir, { recursive: true });
  const proofId = proof.proof_id ?? `mailbox_proof_${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${randomUUID().slice(0, 8)}`;
  const packet = {
    schema: 'narada.sonar.resident_mailbox_proof.v1',
    site_id: 'narada-sonar',
    loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
    proved_at: new Date().toISOString(),
    ...proof,
    proof_id: proofId,
  };
  const path = join(dir, `${proofId}.json`);
  writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  return { ...packet, path };
}

function latestResidentMailboxProof(siteRoot, options: SiteLoopPayload = {}) {
  const dir = residentMailboxProofDir(siteRoot);
  const nowMs = Number(options.nowMs ?? Date.now());
  const freshnessWindowMs = Number(options.freshnessMs ?? MAILBOX_PROOF_FRESHNESS_MS);
  if (!existsSync(dir)) {
    return {
      schema: 'narada.sonar.resident_mailbox_proof_status.v1',
      status: 'missing',
      directory: dir,
      freshness_window_ms: freshnessWindowMs,
      proof: null,
    };
  }
  const proofs = readdirSafe(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = join(dir, name);
      const packet = readJson(path);
      if (!packet) return null;
      return { ...packet, path };
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.proved_at ?? '') - Date.parse(a.proved_at ?? ''));
  const latest = proofs[0] ?? null;
  if (!latest) {
    return {
      schema: 'narada.sonar.resident_mailbox_proof_status.v1',
      status: 'missing',
      directory: dir,
      freshness_window_ms: freshnessWindowMs,
      proof: null,
    };
  }
  const ageMs = nowMs - Date.parse(latest.proved_at ?? '');
  const fresh = Number.isFinite(ageMs) && ageMs <= freshnessWindowMs;
  return {
    schema: 'narada.sonar.resident_mailbox_proof_status.v1',
    status: fresh ? 'fresh' : 'stale',
    directory: dir,
    freshness_window_ms: freshnessWindowMs,
    age_ms: Number.isFinite(ageMs) ? ageMs : null,
    proof: latest,
  };
}

function loadSurfaceDeclaredTools(policyPath) {
  const packet = readJson(policyPath);
  const declared = new Set();
  for (const surface of packet?.surfaces ?? []) {
    const serverName = surface?.server_name ?? '';
    const contract = surface?.tool_contract ?? {};
    for (const toolName of [
      ...(contract.read_only_tools ?? []),
      ...(contract.mutating_tools ?? []),
      ...(contract.refused_tools ?? []),
    ]) {
      declared.add(`${serverName}:${toolName}`);
    }
  }
  return declared;
}

export function setSonarEmailResidentLoopControl(cwd, control) {
  const store = openSiteLoopStore(resolve(cwd));
  try {
    return setLoopControl(store, { loopId: SONAR_EMAIL_RESIDENT_LOOP_ID, ...control });
  } finally {
    store.close();
  }
}

export function sonarResidentStatus(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const status = getResidentStatus(siteRoot, options);
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: false });
  ensureSiteLoopTables(lifecycleStore.db);
  try {
    const productionProofFreshnessWindowMs = Number(options.productionProofFreshnessMs ?? options.production_proof_freshness_ms ?? 24 * 60 * 60_000);
    const latestProductionOutcome = latestProductionReportedOutcome(listDirectiveOutcomes({ db: lifecycleStore.db }, {
      loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
      outcome: 'reported',
      limit: 500,
    }));
    const productionProofAgeMs = latestProductionOutcome?.event_at
      ? Date.now() - Date.parse(latestProductionOutcome.event_at)
      : null;
    const productionProofFresh = latestProductionOutcome
      && Number.isFinite(productionProofAgeMs)
      && productionProofAgeMs <= productionProofFreshnessWindowMs;
    const productionReady = status.active_runtime === 'agent-cli'
      && status.fallback_active !== true
      && status.proof_driver_active !== true
      && productionProofFresh;
    return {
      ...status,
      production_ready: productionReady,
      production_ready_basis: {
        latest_production_outcome: latestProductionOutcome ?? null,
        production_proof_age_ms: productionProofAgeMs,
        production_proof_freshness_window_ms: productionProofFreshnessWindowMs,
      },
      runtime_coherent: status.runtime_coherent === true && status.terminal_work_inflight?.status !== 'terminal_inflight',
      outcome_summary: getDirectiveOutcomeSummary({ db: lifecycleStore.db }, { loopId: SONAR_EMAIL_RESIDENT_LOOP_ID }),
      pending_summary: sonarResidentPendingFromDb(lifecycleStore.db, {
        agentId: options.agentId ?? RESIDENT_AGENT_ID,
        role: options.role ?? RESIDENT_ROLE,
        limit: 500,
      }),
      resident_backlog: residentBacklogSummaryFromDb(lifecycleStore.db, {
        siteRoot,
        nowIso: options.nowIso ?? options.now_iso ?? options.now,
        actionStaleMinutes: options.actionStaleMinutes,
      }),
    };
  } finally {
    lifecycleStore.db.close();
  }
}

export function sonarResidentPending(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: false });
  try {
    return sonarResidentPendingFromDb(lifecycleStore.db, options);
  } finally {
    lifecycleStore.db.close();
  }
}

function sonarResidentPendingFromDb(db, options: SiteLoopPayload = {}) {
  const directiveStore = new SqliteDirectiveRuntimeStore({ db });
  directiveStore.initSchema();
  const limit = Number(options.limit ?? 25);
  const pending = dedupeByDirectiveId([
    ...directiveStore.listPending({ target: { kind: 'agent', id: options.agentId ?? RESIDENT_AGENT_ID }, limit }),
    ...directiveStore.listPending({ target: { kind: 'role', id: options.role ?? RESIDENT_ROLE }, limit }),
  ]).slice(0, limit);
  return {
    schema: 'narada.sonar.resident_pending_directives.v1',
    status: 'ok',
    agent_id: options.agentId ?? RESIDENT_AGENT_ID,
    role: options.role ?? RESIDENT_ROLE,
    pending_count: pending.length,
    directives: pending.map(publicDirectiveSummary),
  };
}

export function sonarResidentReceipts(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: false });
  try {
    const limit = Number(options.limit ?? 25);
    const table = lifecycleStore.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'directive_receipts'
    `).get();
    if (!table) {
      return {
        schema: 'narada.sonar.resident_receipts.v1',
        status: 'ok',
        agent_id: options.agentId ?? RESIDENT_AGENT_ID,
        receipt_count: 0,
        receipts: [],
      };
    }
    const rows = lifecycleStore.db.prepare(`
      SELECT receipt_id, directive_id, received_at, carrier_session_id, agent_id, transport
      FROM directive_receipts
      WHERE agent_id = ?
      ORDER BY received_at DESC
      LIMIT ?
    `).all(options.agentId ?? RESIDENT_AGENT_ID, limit);
    return {
      schema: 'narada.sonar.resident_receipts.v1',
      status: 'ok',
      agent_id: options.agentId ?? RESIDENT_AGENT_ID,
      receipt_count: rows.length,
      receipts: rows.map((row) => ({
        receipt_id: String(row.receipt_id),
        directive_id: String(row.directive_id),
        received_at: String(row.received_at),
        carrier_session_id: String(row.carrier_session_id),
        agent_id: String(row.agent_id),
        transport: String(row.transport),
      })),
    };
  } finally {
    lifecycleStore.db.close();
  }
}

export function sonarResidentOutcomes(cwd, options: SiteLoopPayload = {}) {
  const store = openSiteLoopStore(resolve(cwd));
  try {
    const outcomes = listDirectiveOutcomes(store, {
      loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
      outcome: options.outcome ?? null,
      limit: options.limit ?? 50,
    });
    return {
      schema: 'narada.sonar.resident_outcomes.v1',
      status: 'ok',
      agent_id: options.agentId ?? RESIDENT_AGENT_ID,
      loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
      summary: {
        ...getDirectiveOutcomeSummary(store, { loopId: SONAR_EMAIL_RESIDENT_LOOP_ID }),
        proof_split: directiveOutcomeProofSplit(outcomes),
      },
      outcomes,
    };
  } finally {
    store.close();
  }
}

function directiveOutcomeProofSplit(outcomes) {
  const latestByDirective = new Map();
  for (const item of outcomes) {
    if (!latestByDirective.has(item.directive_id)) latestByDirective.set(item.directive_id, item);
  }
  const reported = [...latestByDirective.values()].filter((item) => item.outcome === 'reported');
  return {
    schema: 'narada.sonar.directive_outcome_proof_split.v1',
    reported_total_in_view: reported.length,
    reported_production_in_view: reported.filter((item) => item.evidence?.production_proof === true || item.evidence?.proof_mode === 'agent_reasoning').length,
    reported_proof_driver_in_view: reported.filter((item) => item.evidence?.proof_mode === 'proof_driver' || item.evidence?.production_proof === false || item.task_id?.includes('resident-e2e-fixture')).length,
    reported_unclassified_in_view: reported.filter((item) => item.evidence?.production_proof !== true && item.evidence?.production_proof !== false && !item.evidence?.proof_mode && !item.task_id?.includes('resident-e2e-fixture')).length,
  };
}

function residentBacklogSummaryFromDb(db, options: SiteLoopPayload = {}) {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const actionStaleMinutes = Number(options.actionStaleMinutes ?? 30);
  const candidates = residentBacklogCandidates(db, { limit: 500, siteRoot: options.siteRoot });
  const includeFixtureHistory = options.includeFixtureHistory === true;
  const counts = {};
  const tasks = [];
  let historicalFixtureCount = 0;
  for (const candidate of candidates) {
    if (!includeFixtureHistory && isResidentFixtureHistoryTask(candidate)) {
      historicalFixtureCount += 1;
      continue;
    }
    const decision = residentBacklogRecoveryDecision(db, candidate, { nowIso, actionStaleMinutes, recordAttention: false });
    const bucket = decision.status === 'emit'
      ? candidate.status === 'opened' ? 'recoverable_opened'
        : candidate.status === 'needs_continuation' ? 'recoverable_needs_continuation'
        : 'recoverable_stale_claimed'
      : decision.reason === 'active_directive_exists' ? 'active_directive_suppressed'
      : ['claimed_missing_active_assignment', 'claimed_by_other_agent'].includes(decision.reason) ? 'unrecoverable_claimed'
      : decision.reason;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    tasks.push({
      task_id: candidate.task_id,
      task_number: candidate.task_number,
      status: candidate.status,
      bucket,
      reason: decision.reason,
      directive_id: decision.directive_id ?? null,
      active_agent_id: candidate.active_agent_id,
    });
  }
  return {
    schema: 'narada.sonar.resident_backlog_summary.v1',
    status: 'ok',
    now: nowIso,
    action_stale_minutes: actionStaleMinutes,
    candidate_count: tasks.length,
    total_candidate_count: candidates.length,
    historical_fixture_count: historicalFixtureCount,
    counts,
    tasks,
  };
}

function isResidentFixtureHistoryTask(candidate) {
  const taskId = String(candidate?.task_id ?? '');
  return /\bfrom-inbox-resident-(e2e-fixture|recovery-drill)\b/.test(taskId)
    || /\bresident-e2e-fixture\b/.test(taskId)
    || /\bresident-recovery-drill\b/.test(taskId);
}

async function reconcileReportedResidentTaskLifecycleState(siteRoot, options: SiteLoopPayload = {}) {
  const limit = Number(options.limit ?? 100);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: true });
  try {
    const rows = lifecycleStore.db.prepare(`
      SELECT tl.task_id, tl.task_number, tl.status,
             ta.assignment_id, ta.agent_id AS active_agent_id,
             r.report_id, r.summary, r.verification_json, r.submitted_at
      FROM task_lifecycle tl
      JOIN task_reports r ON r.task_id = tl.task_id
      LEFT JOIN task_assignments ta
        ON ta.task_id = tl.task_id AND ta.released_at IS NULL
      WHERE tl.governed_by = 'resident'
        AND tl.status IN ('opened', 'claimed')
        AND r.agent_id = ?
      ORDER BY tl.task_number DESC, r.submitted_at DESC
      LIMIT ?
    `).all(RESIDENT_AGENT_ID, limit);
    const byTask = new Map();
    for (const row of rows) {
      if (!byTask.has(row.task_id)) byTask.set(row.task_id, row);
    }
    const repaired = [];
    const skipped = [];
    for (const row of byTask.values()) {
      if (!isResidentAutoworkReport(row)) {
        skipped.push({
          task_id: String(row.task_id),
          task_number: Number(row.task_number),
          status: String(row.status),
          report_id: String(row.report_id),
          reason: 'not_autowork_report',
        });
        continue;
      }
      const taskFile = await findTaskFile(siteRoot, String(row.task_number));
      if (!taskFile) {
        skipped.push({
          task_id: String(row.task_id),
          task_number: Number(row.task_number),
          status: String(row.status),
          report_id: String(row.report_id),
          reason: 'task_projection_missing',
        });
        continue;
      }
      const { frontMatter, body } = await readTaskFile(taskFile.path);
      const targetStatus = 'needs_continuation';
      const update = lifecycleStore.db.transaction(() => {
        if (row.assignment_id) {
          lifecycleStore.releaseAssignment(String(row.assignment_id), 'reported_resident_autowork_reconciled_to_needs_continuation');
        }
        lifecycleStore.updateStatus(String(row.task_id), targetStatus, 'sonar.email-resident.loop');
      });
      update();
      await writeTaskProjection(taskFile.path, { ...frontMatter, status: targetStatus }, body);
      repaired.push({
        task_id: String(row.task_id),
        task_number: Number(row.task_number),
        from_status: String(row.status),
        to_status: targetStatus,
        report_id: String(row.report_id),
        released_assignment_id: row.assignment_id ? String(row.assignment_id) : null,
        path: taskFile.path,
      });
    }
    return {
      schema: 'narada.sonar.reported_resident_task_state_reconciliation.v1',
      status: 'ok',
      now: nowIso,
      repaired_count: repaired.length,
      skipped_count: skipped.length,
      repaired,
      skipped,
    };
  } finally {
    lifecycleStore.db.close();
  }
}

function isResidentAutoworkReport(row) {
  const summary = String(row.summary ?? '');
  if (summary.includes('Resident autowork completed directive_id:')) return true;
  try {
    const verification = JSON.parse(String(row.verification_json ?? '[]'));
    return Array.isArray(verification)
      && verification.some((item) => item?.kind === 'resident_autowork_contract');
  } catch {
    return false;
  }
}

export async function cleanupResidentFixtureResidue(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const dryRun = options.dryRun === true || options.dry_run === true;
  const limit = Number(options.limit ?? 100);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: !dryRun });
  try {
    const rows = lifecycleStore.db.prepare(`
      SELECT tl.task_id, tl.task_number, tl.status,
             ta.assignment_id, r.report_id, r.submitted_at,
             m.envelope_id
      FROM task_lifecycle tl
      JOIN task_reports r ON r.task_id = tl.task_id
      LEFT JOIN task_assignments ta
        ON ta.task_id = tl.task_id AND ta.released_at IS NULL
      LEFT JOIN envelope_task_mappings m
        ON m.task_id = tl.task_id
      WHERE tl.governed_by = 'resident'
        AND tl.status IN ('needs_continuation', 'in_review', 'archived_test_fixture')
        AND r.agent_id = ?
      ORDER BY tl.task_number DESC, r.submitted_at DESC
      LIMIT ?
    `).all(RESIDENT_AGENT_ID, limit);
    const byTask = new Map();
    for (const row of rows) {
      if (!byTask.has(row.task_id)) byTask.set(row.task_id, row);
    }
    const archived = [];
    const refused = [];
    for (const row of byTask.values()) {
      const taskId = String(row.task_id);
      if (!isResidentFixtureTaskId(taskId)) {
        refused.push({ task_id: taskId, task_number: Number(row.task_number), reason: 'not_resident_fixture_task' });
        continue;
      }
      if (row.envelope_id && !isResidentFixtureEnvelopeId(row.envelope_id)) {
        refused.push({
          task_id: taskId,
          task_number: Number(row.task_number),
          envelope_id: String(row.envelope_id),
          reason: 'non_fixture_envelope_mapping',
        });
        continue;
      }
      const taskFile = await findTaskFile(siteRoot, String(row.task_number));
      if (!taskFile) {
        refused.push({ task_id: taskId, task_number: Number(row.task_number), reason: 'task_projection_missing' });
        continue;
      }
      const targetStatus = 'closed';
      if (!dryRun) {
        const { frontMatter, body } = await readTaskFile(taskFile.path);
        const update = lifecycleStore.db.transaction(() => {
          if (row.assignment_id) lifecycleStore.releaseAssignment(String(row.assignment_id), 'resident_fixture_residue_archived');
          lifecycleStore.updateStatus(taskId, targetStatus, 'sonar.email-resident.loop', {
            closed_at: nowIso,
            closed_by: 'sonar.email-resident.loop',
            closure_mode: 'test_fixture_archive',
          });
        });
        update();
        await writeTaskProjection(taskFile.path, {
          ...frontMatter,
          status: targetStatus,
          closed_at: nowIso,
          closed_by: 'sonar.email-resident.loop',
          closure_mode: 'test_fixture_archive',
        }, body);
      }
      archived.push({
        task_id: taskId,
        task_number: Number(row.task_number),
        from_status: String(row.status),
        to_status: targetStatus,
        closure_mode: 'test_fixture_archive',
        report_id: String(row.report_id),
        envelope_id: row.envelope_id ? String(row.envelope_id) : null,
        released_assignment_id: row.assignment_id ? String(row.assignment_id) : null,
        path: taskFile.path,
      });
    }
    const evidencePath = dryRun ? null : writeResidentFixtureResidueCleanupEvidence(siteRoot, {
      now: nowIso,
      archived,
      refused,
    });
    return {
      schema: 'narada.sonar.resident_fixture_residue_cleanup.v1',
      status: 'ok',
      dry_run: dryRun,
      now: nowIso,
      archived_count: archived.length,
      refused_count: refused.length,
      evidence_path: evidencePath,
      archived,
      refused,
    };
  } finally {
    lifecycleStore.db.close();
  }
}

function isResidentFixtureTaskId(taskId) {
  return /-from-inbox-resident-(e2e-fixture|recovery-drill)$/.test(String(taskId));
}

function isResidentFixtureEnvelopeId(envelopeId) {
  return /^env_resident-(e2e|recovery)/.test(String(envelopeId));
}

function writeResidentFixtureResidueCleanupEvidence(siteRoot, evidence) {
  const dir = join(siteRoot, '.ai', 'mutation-evidence', 'resident-fixture-cleanup');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `resident_fixture_cleanup_${new Date().toISOString().replace(/[:.]/g, '')}_${randomUUID().slice(0, 8)}.json`);
  writeFileSync(path, JSON.stringify({
    schema: 'narada.sonar.resident_fixture_residue_cleanup_evidence.v1',
    mutation_kind: 'resident_fixture_residue_archive',
    authority: {
      actor: 'sonar.email-resident.loop',
      basis: 'synthetic resident fixture/drill task with existing resident report; no customer-visible task is eligible',
    },
    ...evidence,
  }, null, 2), 'utf8');
  return path;
}

function latestProductionReportedOutcome(outcomes) {
  return outcomes.find((item) => item.outcome === 'reported'
    && (item.evidence?.production_proof === true || item.evidence?.proof_mode === 'agent_reasoning')) ?? null;
}

function stalePendingDirectives(directives, options: SiteLoopPayload = {}) {
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  const thresholdMs = Number(options.thresholdMs ?? options.threshold_ms ?? 10 * 60_000);
  return directives.filter((directive) => {
    const createdMs = Date.parse(directive.created_at ?? directive.createdAt ?? directive.admitted_at ?? '');
    return Number.isFinite(nowMs) && Number.isFinite(createdMs) && nowMs - createdMs > thresholdMs;
  });
}

function operatingLayerAlertSignals({ resident, dbHealth, health, pending, stalePending, requireFreshProductionProof = false, productionProofFresh = null }) {
  const alerts = [];
  if (!['available', 'busy'].includes(resident.status)) {
    alerts.push({
      kind: resident.carrier_state?.state === 'policy_stale' ? 'policy_stale_resident' : 'no_available_resident',
      severity: 'error',
      detail: resident.carrier_state?.dispatch_skip_reason ?? resident.status,
    });
  }
  if (resident.carrier_state?.state === 'stale_busy') {
    alerts.push({ kind: 'stale_busy_resident', severity: 'error', detail: resident.carrier_state?.dispatch_skip_reason ?? null });
  }
  if (dbHealth?.status !== 'ok') {
    alerts.push({ kind: 'db_integrity_bad', severity: 'critical', detail: dbHealth?.integrity_check ?? dbHealth?.error ?? dbHealth?.status });
  }
  if (Number(stalePending.length) > 0) {
    alerts.push({ kind: 'pending_directive_stale', severity: 'error', count: stalePending.length });
  }
  if (Number(health?.consecutive_failures ?? 0) > 0) {
    alerts.push({ kind: 'repeated_loop_failure', severity: Number(health?.consecutive_failures ?? 0) > 2 ? 'critical' : 'warning', count: Number(health?.consecutive_failures ?? 0), detail: health?.failing_step ?? null });
  }
  if (Number(pending?.pending_count ?? 0) > 0 && resident.status === 'blocked') {
    alerts.push({ kind: 'pending_directives_without_resident', severity: 'error', count: Number(pending.pending_count ?? 0) });
  }
  if (requireFreshProductionProof && productionProofFresh !== true) {
    alerts.push({ kind: 'production_proof_not_fresh', severity: 'error', detail: 'fresh_production_proof_required' });
  }
  return alerts;
}

function persistOperatingLayerAlerts(siteRoot, store, { runId, nowIso = new Date().toISOString(), requireFreshProductionProof = false }: SiteLoopPayload = {}) {
  const resident = sonarResidentStatus(siteRoot);
  const pending = sonarResidentPending(siteRoot, { limit: 500 });
  const dbHealth = taskLifecycleDbHealth(siteRoot);
  const health = getLoopHealth(store, SONAR_EMAIL_RESIDENT_LOOP_ID);
  const stalePending = stalePendingDirectives(pending.directives ?? [], { now: nowIso });
  const status = sonarEmailResidentOperatingLayerStatus(siteRoot, {
    nowIso,
    requireFreshProductionProof,
  });
  const alerts = operatingLayerAlertSignals({
    resident,
    dbHealth,
    health,
    pending,
    stalePending,
    requireFreshProductionProof,
    productionProofFresh: status.latest_activity?.production_proof_fresh,
  })
    .filter((item) => ['error', 'critical'].includes(item.severity));
  const activeKinds = new Set(alerts.map((alert) => alert.kind));
  const resolved = [];
  for (const item of listLoopAttention(store, { loopId: SONAR_EMAIL_RESIDENT_LOOP_ID, status: 'opened', limit: 500 })) {
    if (!String(item.directive_id ?? '').startsWith('operating-layer:')) continue;
    if (activeKinds.has(item.classification)) continue;
    const ack = acknowledgeLoopAttention(store, {
      attentionId: item.escalation_id,
      reason: 'operating_layer_alert_resolved',
      acknowledgedBy: 'sonar.site-loop',
      at: nowIso,
    });
    resolved.push({ classification: item.classification, attention_id: item.attention_id, status: ack.status });
  }
  const created = [];
  for (const alert of alerts) {
    const directiveId = `operating-layer:${alert.kind}`;
    const envelope = writeOperatorAttentionEnvelope(siteRoot, {
      directive_id: directiveId,
      status: alert.kind,
      task_id: null,
      reason: alert.detail ?? alert.kind,
      severity: alert.severity,
    }, { runId, nowIso });
    const escalation = recordLoopEscalation(store, {
      loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
      directiveId,
      classification: alert.kind,
      envelopeId: envelope.envelope_id,
      escalation: {
        schema: 'narada.sonar.operating_layer_alert.v1',
        ...alert,
        run_id: runId,
        envelope_path: envelope.path,
      },
      at: nowIso,
    });
    created.push({
      classification: alert.kind,
      envelope_id: envelope.envelope_id,
      escalation_id: escalation?.escalation_id ?? null,
      severity: alert.severity,
    });
  }
  return {
    schema: 'narada.sonar.operating_layer_alert_reconciliation.v1',
    status: 'ok',
    alert_count: alerts.length,
    created,
    resolved,
  };
}

export function refuseResidentDirective(cwd, options: SiteLoopPayload = {}) {
  const directiveId = options.directiveId ?? options.directive_id;
  const reason = options.reason;
  if (!directiveId) return { schema: 'narada.sonar.resident_refusal.v1', status: 'refused', reason: 'directive_required' };
  if (!reason || !String(reason).trim()) return { schema: 'narada.sonar.resident_refusal.v1', status: 'refused', reason: 'reason_required' };
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(resolve(cwd));
  ensureSiteLoopTables(lifecycleStore.db);
  try {
    const directiveStore = new SqliteDirectiveRuntimeStore({ db: lifecycleStore.db });
    directiveStore.initSchema();
    const directive = directiveStore.getDirective(directiveId);
    if (!directive) {
      return { schema: 'narada.sonar.resident_refusal.v1', status: 'refused', reason: 'directive_not_found', directive_id: directiveId };
    }
    if (!isResidentDirectiveTarget(directive, options)) {
      return {
        schema: 'narada.sonar.resident_refusal.v1',
        status: 'refused',
        reason: 'directive_not_targeted_to_resident',
        directive_id: directiveId,
        target: directive.target ?? null,
      };
    }
    const triage = directiveStore.recordTriage(directiveId, {
      triaged_at: options.at ?? new Date().toISOString(),
      agent_id: options.agentId ?? RESIDENT_AGENT_ID,
      status: 'refused',
      reason: String(reason),
      selected_work_ref: null,
    });
    const taskId = directiveTaskRef(directive);
    const outcome = recordDirectiveOutcome({ db: lifecycleStore.db }, {
      loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
      directiveId,
      outcome: 'refused',
      agentId: options.agentId ?? RESIDENT_AGENT_ID,
      taskId,
      reason: String(reason),
      observedAt: triage.triaged_at,
      eventAt: triage.triaged_at,
      evidence: {
        source: options.source ?? 'operator_recorded_resident_refusal',
        triage_id: triage.triage_id,
        directive_id: directiveId,
        reason: String(reason),
        target: directive.target ?? null,
      },
    });
    return {
      schema: 'narada.sonar.resident_refusal.v1',
      status: 'recorded',
      directive: publicDirectiveSummary(directive),
      triage,
      outcome,
      health: getLoopHealth({ db: lifecycleStore.db }, SONAR_EMAIL_RESIDENT_LOOP_ID),
    };
  } finally {
    lifecycleStore.db.close();
  }
}

export function sonarResidentCapabilities(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const agentId = options.agentId ?? RESIDENT_AGENT_ID;
  const identities = readJson(join(siteRoot, 'operator-surfaces', 'identities.json'));
  const identity = (identities?.identities ?? []).find((item) => item.identity_id === agentId) ?? null;
  const declaredRuntime = identity?.carrier_projections?.['agent-cli']?.runtime ?? null;
  const declaredFallbackRuntime = identity?.carrier_projections?.['agent-runtime-server']?.runtime ?? identity?.carrier_projections?.nars?.runtime ?? null;
  const mcpProbe = probeTaskLifecycleMcpTools(siteRoot);
  const availableTaskTools = new Set(mcpProbe.tools.length > 0 ? mcpProbe.tools : taskLifecycleTools().map((tool) => tool.name));
  const missingTools = REQUIRED_RESIDENT_TASK_TOOLS.filter((tool) => !availableTaskTools.has(tool));
  const surfacePolicy = readResidentTaskLifecycleSurfacePolicy(siteRoot);
  const missingMutatingAuthority = REQUIRED_RESIDENT_MUTATING_TASK_TOOLS.filter((tool) => !surfacePolicy.mutating_tools.includes(tool));
  const status = identity
    && declaredRuntime === 'agent-cli'
    && mcpProbe.status === 'ok'
    && missingTools.length === 0
    && missingMutatingAuthority.length === 0
    ? 'ready'
    : 'not_ready';
  return {
    schema: 'narada.sonar.resident_capabilities.v1',
    status,
    agent_id: agentId,
    role: RESIDENT_ROLE,
    preferred_runtime: 'agent-cli',
    fallback_runtime: 'agent-runtime-server',
    declared_runtime: declaredRuntime,
    declared_fallback_runtime: declaredFallbackRuntime,
    required_tools: REQUIRED_RESIDENT_TASK_TOOLS,
    required_mutating_authority_tools: REQUIRED_RESIDENT_MUTATING_TASK_TOOLS,
    missing_tools: missingTools,
    missing_mutating_authority_tools: missingMutatingAuthority,
    evidence: {
      identity_path: join(siteRoot, 'operator-surfaces', 'identities.json'),
      task_mcp_probe: mcpProbe,
      task_lifecycle_surface_policy: surfacePolicy,
      identity_found: Boolean(identity),
      runtime_agent_cli_preferred: declaredRuntime === 'agent-cli',
      runtime_agent_runtime_server_fallback: declaredFallbackRuntime === 'agent-runtime-server',
    },
  };
}

function readResidentTaskLifecycleSurfacePolicy(siteRoot) {
  const path = join(siteRoot, '.narada', 'capabilities', 'mcp-surfaces.json');
  const registry = readJson(path);
  const surface = (registry?.surfaces ?? []).find((item) => item.surface_id === 'task-lifecycle-mcp.local') ?? null;
  const contract = surface?.tool_contract ?? {};
  return {
    schema: 'narada.sonar.resident_task_lifecycle_surface_policy.v1',
    status: surface ? 'ok' : 'missing',
    path,
    surface_id: surface?.surface_id ?? null,
    read_only_tools: Array.isArray(contract.read_only_tools) ? contract.read_only_tools.map(String) : [],
    mutating_tools: Array.isArray(contract.mutating_tools) ? contract.mutating_tools.map(String) : [],
    refused_tools: Array.isArray(contract.refused_tools) ? contract.refused_tools.map(String) : [],
  };
}

export function ensureResidentCarrier(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const control = options.control ?? readLoopControlForSupervisor(siteRoot);
  if (control?.paused) {
    return {
      schema: 'narada.sonar.resident_supervisor.v1',
      status: 'blocked',
      reason: 'loop_paused',
      agent_id: RESIDENT_AGENT_ID,
      control,
      before: getResidentStatus(siteRoot, { agentId: RESIDENT_AGENT_ID, requireLiveCarrier: options.requireLiveCarrier !== false }),
      launch: null,
    };
  }
  const runtimeCleanup = cleanupResidentRuntime(siteRoot, { runtime: 'agent-cli' });
  const before = getResidentStatus(siteRoot, { agentId: RESIDENT_AGENT_ID, requireLiveCarrier: options.requireLiveCarrier !== false });
  const beforeCarrier: SiteLoopPayload = before.carrier ?? {};
  if (['available', 'busy'].includes(before.status) && residentCarrierAcceptableForSupervisor(before)) {
    const redundantFallbackCleanup = beforeCarrier.runtime === 'agent-cli'
      ? cleanupRedundantNarsFallbacks(siteRoot, before)
      : { status: 'skipped', reason: 'primary_agent_cli_not_selected' };
    return {
      schema: 'narada.sonar.resident_supervisor.v1',
      agent_id: RESIDENT_AGENT_ID,
      runtime_cleanup: runtimeCleanup,
      redundant_fallback_cleanup: redundantFallbackCleanup,
      before,
      launch: null,
    };
  }
  const policy = loadSonarEmailResidentOperatingPolicy(siteRoot).policy;
  const restartPolicy = evaluateResidentRestartPolicy(siteRoot, {
    maxRestarts: policy.rate_limits?.max_restarts_per_window,
    windowMs: policy.rate_limits?.restart_window_ms,
    ...(options.restartPolicy ?? {}),
  });
  if (restartPolicy.status === 'blocked') {
    return {
      schema: 'narada.sonar.resident_supervisor.v1',
      status: 'blocked',
      reason: restartPolicy.reason,
      agent_id: RESIDENT_AGENT_ID,
      runtime_cleanup: runtimeCleanup,
      before,
      restart_policy: restartPolicy,
      launch: null,
    };
  }
  const runner = options.runner ?? defaultResidentLaunchRunner;
  const launch = runner(siteRoot);
  const after = getResidentStatus(siteRoot, { agentId: RESIDENT_AGENT_ID, requireLiveCarrier: options.requireLiveCarrier !== false });
  return {
    schema: 'narada.sonar.resident_supervisor.v1',
    status: launch.status === 'launching' ? 'launch_requested' : launch.status === 'blocked' ? 'blocked' : 'launch_failed',
    agent_id: RESIDENT_AGENT_ID,
    runtime_cleanup: runtimeCleanup,
    before,
    launch,
    after,
  };
}

function residentCarrierAcceptableForSupervisor(status) {
  if (status?.carrier?.runtime !== 'agent-runtime-server' && status?.carrier?.legacy_runtime !== 'nars') return true;
  if (!residentCarrierPolicyGenerationCurrent(status)) return false;
  const proofDriver = status?.host?.started_event?.resident_proof_driver === true
    || status?.host?.started_event?.resident_autowork === true;
  if (!proofDriver) return false;
  return true;
}

function cleanupRedundantNarsFallbacks(siteRoot, primaryStatus) {
  const primaryCarrierId = primaryStatus?.carrier?.carrierSessionId ?? null;
  if (primaryStatus?.carrier?.runtime !== 'agent-cli' || !primaryCarrierId) {
    return { status: 'skipped', reason: 'primary_agent_cli_not_selected' };
  }
  const resultsDir = join(siteRoot, '.ai', 'runtime', 'agent-start-results');
  const retired = [];
  const stopped = [];
  const skipped = [];
  if (!existsSync(resultsDir)) {
    return { schema: 'narada.sonar.redundant_fallback_cleanup.v1', status: 'ok', retired, stopped, skipped };
  }
  for (const name of readdirSafe(resultsDir).filter((entry) => entry.endsWith('.result.json'))) {
    const path = join(resultsDir, name);
    const packet = readJson(path);
    if (packet?.identity !== RESIDENT_AGENT_ID || (packet?.runtime !== 'agent-runtime-server' && packet?.runtime !== 'nars')) continue;
    const carrierSessionId = packet.carrier_session?.carrier_session_id
      ?? packet.carrier_session_id
      ?? packet.required_environment?.NARADA_CARRIER_SESSION_ID
      ?? null;
    if (!carrierSessionId) {
      skipped.push({ path, reason: 'carrier_session_id_missing' });
      continue;
    }
    const retirement = readCarrierRetirement(siteRoot, carrierSessionId);
    if (retirement) {
      skipped.push({ path, carrier_session_id: carrierSessionId, reason: 'already_retired' });
      continue;
    }
    const live = isResidentCarrierLive(siteRoot, carrierSessionId, { staleAfterMs: 120000 });
    if (live.live) stopped.push(stopResidentCarrierProcesses(carrierSessionId));
    retired.push(retireResidentCarrier(siteRoot, carrierSessionId, {
      reason: `redundant_fallback_retired:primary=${primaryCarrierId}`,
    }));
  }
  return {
    schema: 'narada.sonar.redundant_fallback_cleanup.v1',
    status: 'ok',
    primary_carrier_session_id: primaryCarrierId,
    retired_count: retired.length,
    stopped_count: stopped.filter((item) => item.status === 'ok').reduce((sum, item) => sum + item.stopped_count, 0),
    retired,
    stopped,
    skipped,
  };
}

function stopResidentCarrierProcesses(carrierSessionId) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$needle=$env:NARADA_RESIDENT_CARRIER_PROBE_ID; $self=$PID; $p=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -and $_.CommandLine.Contains($needle) -and ($_.CommandLine -like '*agent-runtime-server-control-host.js*' -or $_.CommandLine -like '*nars-control-host.js*') }; $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NARADA_RESIDENT_CARRIER_PROBE_ID: String(carrierSessionId) },
  });
  const stopped = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    status: result.status === 0 ? 'ok' : 'error',
    carrier_session_id: carrierSessionId,
    stopped_count: stopped.length,
    stopped_pids: stopped,
    stderr: String(result.stderr ?? '').trim() || null,
  };
}

function residentCarrierPolicyGenerationCurrent(status) {
  const siteRoot = status?.host?.session_dir
    ? resolve(status.host.session_dir, '..', '..', '..', '..')
    : null;
  const policyPath = siteRoot ? join(siteRoot, '.narada', 'capabilities', 'mcp-surfaces.json') : null;
  if (!policyPath || !existsSync(policyPath)) return true;
  const policyMtime = statSync(policyPath).mtimeMs;
  const startedAt = Date.parse(status?.host?.started_event?.timestamp ?? status?.carrier?.startedAt ?? '');
  if (!Number.isFinite(startedAt)) return false;
  return startedAt >= policyMtime;
}

function readLoopControlForSupervisor(siteRoot) {
  const store = openSiteLoopStore(siteRoot);
  try {
    return getLoopControl(store, SONAR_EMAIL_RESIDENT_LOOP_ID);
  } finally {
    store.close();
  }
}

function evaluateResidentRestartPolicy(siteRoot, options: SiteLoopPayload = {}) {
  const maxRestarts = Number(options.maxRestarts ?? options.max_restarts ?? 3);
  const windowMs = Number(options.windowMs ?? options.window_ms ?? 10 * 60 * 1000);
  const sinceMs = Date.now() - windowMs;
  const resultsDir = join(siteRoot, '.ai', 'runtime', 'agent-start-results');
  const recent = [];
  if (existsSync(resultsDir)) {
    for (const name of readdirSafe(resultsDir).filter((entry) => entry.endsWith('.result.json'))) {
      const packet = readJson(join(resultsDir, name));
      if (packet?.identity !== RESIDENT_AGENT_ID || (packet?.runtime !== 'agent-runtime-server' && packet?.runtime !== 'nars')) continue;
      const launchSource = packet.launch_source ?? packet.carrier_session?.record?.launch_source ?? null;
      if (launchSource !== 'sonar.email-resident.loop.supervisor') continue;
      const ts = Date.parse(packet.started_at ?? packet.carrier_session?.record?.started_at ?? packet.agent_start_event ?? '');
      if (Number.isFinite(ts) && ts >= sinceMs) {
        recent.push({ path: join(resultsDir, name), started_at: packet.started_at ?? null, carrier_session_id: packet.carrier_session_id ?? packet.carrier_session?.carrier_session_id ?? null });
      }
    }
  }
  return {
    schema: 'narada.sonar.resident_restart_policy.v1',
    status: recent.length >= maxRestarts ? 'blocked' : 'ok',
    reason: recent.length >= maxRestarts ? 'restart_rate_limited' : null,
    max_restarts: maxRestarts,
    window_ms: windowMs,
    recent_count: recent.length,
    recent,
  };
}

function readdirSafe(path) {
  try {
    return existsSync(path) ? readdirSync(path) : [];
  } catch {
    return [];
  }
}

export async function runSonarResidentE2E(cwd, options: SiteLoopPayload = {}) {
  const mailboxProof = options.mailboxProof === true || options.mailbox_proof === true;
  const controlledMailboxProof = options.controlledMailboxProof === true || options.controlled_mailbox_proof === true;
  const controlledMailboxSource = options.controlledMailboxSource ?? options.controlled_mailbox_source ?? options.controlledSource ?? options.controlled_source ?? null;
  if (mailboxProof && controlledMailboxProof !== true) {
    return {
      schema: 'narada.sonar.resident_e2e.v1',
      status: 'refused',
      reason: 'controlled_mailbox_source_required',
      mode: 'mailbox_live_unattended',
      live_unattended_proven: false,
      production_proof: false,
      required_flag: '--controlled-mailbox-proof',
    };
  }
  if (mailboxProof && controlledMailboxProof === true && !controlledMailboxSource) {
    return {
      schema: 'narada.sonar.resident_e2e.v1',
      status: 'refused',
      reason: 'controlled_mailbox_source_required',
      mode: 'mailbox_live_unattended',
      live_unattended_proven: false,
      production_proof: false,
      required_option: '--controlled-mailbox-source <ref>',
    };
  }
  if (options.ackFixture !== true && !mailboxProof) {
    return {
      schema: 'narada.sonar.resident_e2e.v1',
      status: 'refused',
      reason: 'ack_fixture_required',
      required_flag: '--ack-fixture',
    };
  }
  const live = options.live === true;
  const simulate = options.simulateResident === true || options.simulate_resident === true;
  if (live && simulate) {
    return {
      schema: 'narada.sonar.resident_e2e.v1',
      status: 'refused',
      reason: 'live_e2e_cannot_use_store_simulation',
      mode: 'live_unattended',
      live_unattended_proven: false,
    };
  }
  const siteRoot = resolve(cwd);
  const fixtureId = options.id ?? `resident-e2e-${Date.now()}`;
  const expectedCarrierPreference = options.expectCarrierPreference ?? options.expect_carrier_preference ?? null;
  const requireProductionProof = options.requireProductionProof === true || options.require_production_proof === true;
  if (requireProductionProof) {
    cleanupResidentRuntime(siteRoot, { runtime: 'agent-cli' });
    const currentResident = sonarResidentStatus(siteRoot);
    const currentCarrier: SiteLoopPayload = currentResident?.carrier ?? {};
    const observedPreference = currentCarrier.preference ?? null;
    const observedPrimary = currentCarrier.runtime === 'agent-cli'
      && observedPreference === 'interactive_agent_cli'
      && currentResident?.host?.started_event?.resident_proof_driver !== true;
    if ((expectedCarrierPreference && observedPreference !== expectedCarrierPreference) || !observedPrimary) {
      return {
        schema: 'narada.sonar.resident_e2e.v1',
        status: 'refused',
        reason: 'production_carrier_not_available',
        mode: mailboxProof ? 'mailbox_live_unattended' : live ? 'live_unattended' : 'live_poll',
        live_unattended_proven: false,
        production_proof: false,
        production_proof_required: true,
        required_carrier: 'interactive_agent_cli',
        fallback_carrier: currentCarrier.preference === 'agent_runtime_server_fallback'
          ? {
              status: 'available_but_insufficient_for_production_proof',
              runtime: currentCarrier.runtime ?? null,
              carrier_session_id: currentCarrier.carrierSessionId ?? null,
            }
          : null,
        start_command: residentAgentCliStartCommand(siteRoot),
        remediation: 'Start a live sonar.resident agent-cli carrier, then rerun the strict production proof.',
        carrier_preference_assertion: {
          expected: expectedCarrierPreference,
          observed: observedPreference,
          matched: expectedCarrierPreference ? observedPreference === expectedCarrierPreference : observedPrimary,
        },
        resident: currentResident,
      };
    }
  }
  const seeded = mailboxProof
    ? null
    : seedResidentWorkFixture(siteRoot, {
        id: fixtureId,
        title: options.title ?? 'Resident E2E fixture',
        summary: options.summary,
        ackFixture: true,
      });
  const beforeDirectiveIds = mailboxProof ? allResidentDirectiveIds(siteRoot) : [];
  const deadline = Date.now() + Number(options.timeoutMs ?? options.timeout_ms ?? 120_000);
  const pollMs = Number(options.pollMs ?? options.poll_ms ?? 5_000);
  let firstRun: SiteLoopPayload = await runSonarEmailResidentLoop(siteRoot, {
    limit: options.limit ?? 25,
    sourceSync: options.sourceSync === true || mailboxProof,
    sourceSyncRunner: options.sourceSyncRunner,
    ensureResident: options.ensureResident === true,
    requireLiveCarrier: !simulate,
  });
  const initialRuns = [{ run_id: firstRun.run_id, status: firstRun.status, summary: firstRun.summary ?? null }];
  while (firstRun.status === 'locked' && Date.now() < deadline) {
    await sleep(pollMs);
    firstRun = await runSonarEmailResidentLoop(siteRoot, {
      limit: options.limit ?? 25,
      sourceSync: false,
      ensureResident: options.ensureResident === true,
      requireLiveCarrier: !simulate,
    });
    initialRuns.push({ run_id: firstRun.run_id, status: firstRun.status, summary: firstRun.summary ?? null });
  }
  const directiveIds = mailboxProof
    ? mailboxProofDirectiveIds(siteRoot, firstRun, beforeDirectiveIds, { controlledSource: controlledMailboxSource })
    : fixtureDirectiveIds(siteRoot, seeded.envelope_id);
  const effectiveDirectiveIds = mailboxProof
    ? directiveIds
    : directiveIds.length > 0 ? directiveIds : directiveIdsFromRun(firstRun);
  const controlledSourceStatus = mailboxProof
    ? controlledMailboxSourceStatus(siteRoot, controlledMailboxSource, {
        directiveIds: effectiveDirectiveIds,
        run: firstRun,
      })
    : null;
  const storeSimulation = simulate
    ? simulateResidentFixtureCompletion(siteRoot, effectiveDirectiveIds, {
        at: new Date().toISOString(),
      })
    : null;
  let finalOutcome = runAgentOutcomeReconciliation(siteRoot, {
    directiveIds: effectiveDirectiveIds,
    includeBacklog: false,
    resident: sonarResidentStatus(siteRoot),
  });
  const polls = [];
  while (!hasReportedOutcome(finalOutcome) && Date.now() < deadline) {
    await sleep(pollMs);
    const cycle = await runSonarEmailResidentLoop(siteRoot, {
      limit: options.limit ?? 25,
      ensureResident: options.ensureResident === true,
      requireLiveCarrier: !simulate,
    });
    finalOutcome = runAgentOutcomeReconciliation(siteRoot, {
      directiveIds: effectiveDirectiveIds,
      includeBacklog: false,
      resident: sonarResidentStatus(siteRoot),
    });
    polls.push({ run_id: cycle.run_id, status: cycle.status, counts: finalOutcome.counts });
  }
  const finalResident = sonarResidentStatus(siteRoot);
  const finalCarrier: SiteLoopPayload = finalResident?.carrier ?? {};
  const carrierPreferenceObserved = finalCarrier.preference ?? null;
  const carrierPreferenceMatch = expectedCarrierPreference
    ? carrierPreferenceObserved === expectedCarrierPreference
    : true;
  const reported = hasReportedOutcome(finalOutcome) || storeSimulation?.status === 'ok';
  const productionProof = hasProductionReportedOutcome(finalOutcome);
  const productionProofMatch = !requireProductionProof || productionProof;
  const status = reported && carrierPreferenceMatch && productionProofMatch ? 'passed' : 'incomplete';
  const mailboxProofRecord = mailboxProof && status === 'passed'
    ? recordResidentMailboxProof(siteRoot, {
        source_ref: controlledMailboxSource,
        directive_ids: effectiveDirectiveIds,
        carrier_session_id: finalCarrier.carrierSessionId ?? null,
        outcome_counts: finalOutcome?.counts ?? {},
        run_id: firstRun.run_id,
        production_proof: productionProof,
      })
    : null;
  return {
    schema: 'narada.sonar.resident_e2e.v1',
    status,
    incomplete_reason: status === 'passed'
      ? null
      : !carrierPreferenceMatch
        ? 'carrier_preference_mismatch'
        : mailboxProof && effectiveDirectiveIds.length === 0
          ? 'mailbox_proof_no_new_materialized_directive'
        : !productionProofMatch
          ? 'production_proof_required'
        : 'resident_report_not_observed_before_timeout',
    mode: storeSimulation ? 'store_simulation' : mailboxProof ? 'mailbox_live_unattended' : live ? 'live_unattended' : 'live_poll',
    live_unattended_proven: !storeSimulation && reported && carrierPreferenceMatch && productionProof,
    production_proof: productionProof,
    production_proof_required: requireProductionProof,
    proof: residentE2EProof({
      storeSimulation,
      finalOutcome,
      directiveIds: effectiveDirectiveIds,
      resident: finalResident,
    }),
    carrier_preference_assertion: {
      expected: expectedCarrierPreference,
      observed: carrierPreferenceObserved,
      matched: carrierPreferenceMatch,
    },
    fixture: seeded,
    mailbox_proof: mailboxProof,
    mailbox_proof_record: mailboxProofRecord,
    mailbox_materialization: mailboxProof
      ? {
          controlled_source: controlledMailboxSource,
          controlled_source_status: controlledSourceStatus,
          evaluated: firstRun.summary?.evaluated ?? 0,
          materialized: firstRun.summary?.materialized ?? 0,
          duplicates: firstRun.summary?.duplicates ?? 0,
          bridge_errors: firstRun.summary?.bridge_errors ?? 0,
          new_directive_count: directiveIds.length,
        }
      : null,
    first_run: {
      run_id: firstRun.run_id,
      status: firstRun.status,
      summary: firstRun.summary,
    },
    initial_runs: initialRuns,
    store_simulation: storeSimulation,
    simulated_resident: storeSimulation,
    directive_ids: effectiveDirectiveIds,
    fixture_scoped: !mailboxProof,
    polls,
    outcome: finalOutcome,
    resident: finalResident,
    cleanup_hint: mailboxProof ? null : `pnpm cli -- loop fixture cleanup-resident-work --id ${fixtureId}`,
  };
}

function residentE2EProof({ storeSimulation, finalOutcome, directiveIds, resident }) {
  const counts = finalOutcome?.counts ?? {};
  const productionProof = hasProductionReportedOutcome(finalOutcome);
  return {
    schema: 'narada.sonar.resident_e2e.proof.v1',
    required_observations: ['directive_emitted', 'carrier_receipt', 'task_report_with_directive_id'],
    directive_count: directiveIds.length,
    directive_emitted: directiveIds.length > 0,
    carrier_receipt_observed: Number(counts.received ?? 0) > 0 || Number(counts.reported ?? 0) > 0,
    task_report_observed: Number(counts.reported ?? 0) > 0,
    production_task_report_observed: productionProof,
    store_simulation_used: Boolean(storeSimulation),
    live_carrier_status: resident?.status ?? 'unknown',
  };
}

function simulateResidentFixtureCompletion(siteRoot, directiveIds, { at = new Date().toISOString() }: SiteLoopPayload = {}) {
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(siteRoot);
  ensureSiteLoopTables(lifecycleStore.db);
  const directiveStore = new SqliteDirectiveRuntimeStore({ db: lifecycleStore.db });
  directiveStore.initSchema();
  const completed = [];
  try {
    for (const directiveId of directiveIds) {
      const directive = directiveStore.getDirective(directiveId);
      if (!directive) {
        completed.push({ directive_id: directiveId, status: 'skipped', reason: 'directive_not_found' });
        continue;
      }
      const taskId = directiveTaskRef(directive);
      if (!taskId) {
        completed.push({ directive_id: directiveId, status: 'skipped', reason: 'task_ref_missing' });
        continue;
      }
      const receipt = directive.delivery?.receipt_id
        ? null
        : directiveStore.recordReceipt(directiveId, {
            received_at: at,
            carrier_session_id: 'fixture_simulated_resident',
            agent_id: RESIDENT_AGENT_ID,
            transport: 'fixture_simulation',
          });
      const reportAt = new Date(Date.parse(at) + 1).toISOString();
      const reportId = `report_fixture_${directiveId}`;
      lifecycleStore.insertReport({
        report_id: reportId,
        task_id: taskId,
        agent_id: RESIDENT_AGENT_ID,
        summary: `Fixture resident completed directive_id:${directiveId}`,
        changed_files_json: '[]',
        verification_json: JSON.stringify([{ kind: 'fixture_simulation', status: 'passed' }]),
        directive_id: directiveId,
        submitted_at: reportAt,
      });
      completed.push({ directive_id: directiveId, status: 'reported', task_id: taskId, report_id: reportId, receipt_id: receipt?.receipt_id ?? directive.delivery?.receipt_id ?? null });
    }
    return {
      schema: 'narada.sonar.resident_e2e.store_simulation.v1',
      status: completed.every((item) => item.status === 'reported') ? 'ok' : 'partial',
      mode: 'store_simulation',
      live_unattended_proven: false,
      completed,
    };
  } finally {
    lifecycleStore.db.close();
  }
}

export function listSonarLoopAttention(cwd, options: SiteLoopPayload = {}) {
  const store = openSiteLoopStore(resolve(cwd));
  try {
    return {
      schema: 'narada.sonar.loop_attention_list.v1',
      loop_id: options.loopId ?? SONAR_EMAIL_RESIDENT_LOOP_ID,
      summary: getLoopAttentionSummary(store, { loopId: options.loopId ?? SONAR_EMAIL_RESIDENT_LOOP_ID }),
      attention: listLoopAttention(store, {
        loopId: options.loopId ?? SONAR_EMAIL_RESIDENT_LOOP_ID,
        status: options.status ?? null,
        limit: options.limit ?? 50,
      }),
    };
  } finally {
    store.close();
  }
}

export function showSonarLoopAttention(cwd, attentionId) {
  const store = openSiteLoopStore(resolve(cwd));
  try {
    const attention = getLoopAttention(store, { attentionId });
    return {
      schema: 'narada.sonar.loop_attention_show.v1',
      status: attention ? 'ok' : 'not_found',
      attention,
    };
  } finally {
    store.close();
  }
}

export function ackSonarLoopAttention(cwd, attentionId, options: SiteLoopPayload = {}) {
  const store = openSiteLoopStore(resolve(cwd));
  try {
    return {
      schema: 'narada.sonar.loop_attention_ack.v1',
      ...acknowledgeLoopAttention(store, {
        attentionId,
        reason: options.reason,
        acknowledgedBy: options.acknowledgedBy ?? 'operator',
      }),
      health: getLoopHealth(store, options.loopId ?? SONAR_EMAIL_RESIDENT_LOOP_ID),
    };
  } finally {
    store.close();
  }
}

export function recoverStaleResidentCarrier(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const reason = String(options.reason ?? '').trim();
  if (!reason) return { schema: 'narada.sonar.resident_recover_stale.v1', status: 'refused', reason: 'reason_required' };
  const resident = sonarResidentStatus(siteRoot);
  const recoverableCarrierStates = new Set(['stale_busy', 'policy_stale']);
  if (!recoverableCarrierStates.has(resident.carrier_state?.state)) {
    return {
      schema: 'narada.sonar.resident_recover_stale.v1',
      status: 'skipped',
      reason: 'resident_carrier_not_recoverable',
      carrier_state: resident.carrier_state ?? null,
    };
  }
  const store = openSiteLoopStore(siteRoot);
  try {
    const at = new Date().toISOString();
    const pending = sonarResidentPendingFromDb(store.db, { limit: 500 });
    const recovered = [];
    const directiveStore = new SqliteDirectiveRuntimeStore({ db: store.db });
    directiveStore.initSchema();
    for (const directive of pending.directives ?? []) {
      const full = directiveStore.getDirective(directive.directive_id);
      if (!full || full.delivery?.status !== 'leased') continue;
      const previousDelivery = full.delivery ?? {};
      directiveStore.upsertDirective({
        ...full,
        delivery: {
          ...previousDelivery,
          status: 'failed',
          failure_reason: `${resident.carrier_state.state}_carrier_recovery`,
          failed_at: at,
          retryable: true,
          recovered_at: at,
          previous_status: previousDelivery.status ?? 'leased',
        } as any,
      });
      recovered.push({ directive_id: directive.directive_id, retryable: true, previous_status: previousDelivery.status ?? 'leased' });
    }
    const retired = retireResidentCarrier(siteRoot, resident.carrier_state?.carrier_session_id, { reason, at });
    const attentionKind = resident.carrier_state.state === 'policy_stale'
      ? 'policy_drift'
      : 'stale_busy_carrier';
    const severity = loopAttentionSeverity(siteRoot, attentionKind);
    const envelope = writeOperatorAttentionEnvelope(siteRoot, {
      directive_id: resident.carrier_state.carrier_session_id ?? 'resident_carrier',
      status: attentionKind,
      task_id: null,
      reason,
      severity,
    }, { runId: 'resident_recover_stale', nowIso: at });
    const escalation = recordLoopEscalation(store, {
      loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
      directiveId: resident.carrier_state.carrier_session_id ?? 'resident_carrier',
      classification: attentionKind,
      envelopeId: envelope.envelope_id,
      escalation: {
        schema: 'narada.sonar.resident_stale_carrier_recovery.v1',
        severity,
        reason,
        resident: resident.carrier_state,
        retired,
        recovered,
        envelope_path: envelope.path,
      },
      at,
    });
    return {
      schema: 'narada.sonar.resident_recover_stale.v1',
      status: 'recovered',
      carrier_state: resident.carrier_state,
      recovered_count: recovered.length,
      recovered,
      retired,
      attention: escalation,
    };
  } finally {
    store.close();
  }
}

export function cleanupResidentRuntime(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const runtime = options.runtime ?? 'all';
  const dryRun = options.dryRun === true;
  const nowIso = options.nowIso ?? new Date().toISOString();
  const resultsDir = join(siteRoot, '.ai', 'runtime', 'agent-start-results');
  const inspected = [];
  const retired = [];
  const skipped = [];
  if (!existsSync(resultsDir)) {
    return {
      schema: 'narada.sonar.resident_runtime_cleanup.v1',
      status: 'ok',
      dry_run: dryRun,
      inspected_count: 0,
      retired_count: 0,
      inspected,
      retired,
      skipped,
    };
  }
  const rows = readdirSync(resultsDir)
    .filter((name) => name.endsWith('.result.json'))
    .map((name) => {
      const path = join(resultsDir, name);
      const packet = readJson(path);
      if (!packet || packet.identity !== RESIDENT_AGENT_ID) return null;
      const carrierSessionId = packet.carrier_session?.carrier_session_id
        ?? packet.carrier_session_id
        ?? packet.required_environment?.NARADA_CARRIER_SESSION_ID
        ?? null;
      return {
        path,
        runtime: packet.runtime ?? packet.runtime_substrate_kind ?? null,
        carrier_session_id: carrierSessionId,
        started_at: packet.started_at ?? packet.agent_start_event ?? name,
      };
    })
    .filter(Boolean)
    .filter((row) => runtime === 'all' || row.runtime === runtime);
  for (const row of rows) {
    const retirement = readCarrierRetirement(siteRoot, row.carrier_session_id);
    const live = isResidentCarrierLive(siteRoot, row.carrier_session_id, { staleAfterMs: 120000 });
    const inspectedRow = { ...row, live, retired: retirement ?? null };
    inspected.push(inspectedRow);
    if (retirement) {
      skipped.push({ ...row, reason: 'already_retired', retirement });
      continue;
    }
    if (live.live || live.heartbeat?.fresh === true) {
      skipped.push({ ...row, reason: 'carrier_live', live });
      continue;
    }
    if (dryRun) {
      skipped.push({ ...row, reason: 'dry_run_would_retire', live });
      continue;
    }
    retired.push(retireResidentCarrier(siteRoot, row.carrier_session_id, {
      reason: `runtime_cleanup:${live.reason ?? 'not_live'}`,
      at: nowIso,
    }));
  }
  return {
    schema: 'narada.sonar.resident_runtime_cleanup.v1',
    status: 'ok',
    dry_run: dryRun,
    runtime,
    inspected_count: inspected.length,
    retired_count: retired.length,
    inspected,
    retired,
    skipped,
  };
}

export function sonarResidentProofPacket(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const resident = sonarResidentStatus(siteRoot);
  const receipts = sonarResidentReceipts(siteRoot, { limit: Number(options.limit ?? 5) });
  const outcomes = sonarResidentOutcomes(siteRoot, { limit: Number(options.limit ?? 5) });
  const pending = sonarResidentPending(siteRoot, { limit: Number(options.limit ?? 25) });
  const proofDriver = resident.host?.started_event?.resident_proof_driver === true;
  const reportedOutcomes = (outcomes.outcomes ?? []).filter((item) => item.outcome === 'reported');
  const proofDriverReports = reportedOutcomes.filter((item) => item.evidence?.proof_mode === 'proof_driver'
    || (proofDriver && item.evidence?.production_proof !== true)).length;
  const productionReports = reportedOutcomes.filter((item) => item.evidence?.production_proof === true
    || item.evidence?.proof_mode === 'agent_reasoning').length;
  const proofCarrier: SiteLoopPayload = resident.carrier ?? {};
  const primaryRuntimeReady = proofCarrier.runtime === 'agent-cli'
    && proofCarrier.preference === 'interactive_agent_cli'
    && proofDriver !== true;
  const latestProductionOutcome = latestProductionReportedOutcome(reportedOutcomes);
  const productionProofAgeMs = latestProductionOutcome?.event_at
    ? Date.now() - Date.parse(latestProductionOutcome.event_at)
    : null;
  const productionProofFreshnessWindowMs = Number(options.productionProofFreshnessMs ?? options.production_proof_freshness_ms ?? 24 * 60 * 60_000);
  const productionProofFresh = Boolean(latestProductionOutcome)
    && Number.isFinite(productionProofAgeMs)
    && productionProofAgeMs <= productionProofFreshnessWindowMs;
  return {
    schema: 'narada.sonar.resident_proof_packet.v1',
    status: resident.status === 'available' || resident.status === 'busy'
      ? primaryRuntimeReady && productionReports > 0 ? 'production_ready' : 'transport_ready'
      : 'attention_needed',
    mode: proofDriver ? 'proof_driver' : proofCarrier.runtime === 'agent-cli' ? 'agent_cli_reasoning' : proofCarrier.runtime === 'agent-runtime-server' ? 'agent_runtime_server_fallback_reasoning' : proofCarrier.legacy_runtime === 'nars' ? 'agent_runtime_server_fallback_reasoning' : 'no_live_carrier',
    primary_runtime_ready: primaryRuntimeReady,
    agent_cli_ready: proofCarrier.preferred_interactive?.status === 'available' || primaryRuntimeReady,
    agent_cli_control_path: proofCarrier.preferred_interactive?.controlPath ?? (primaryRuntimeReady ? proofCarrier.controlPath ?? null : null),
    preferred_runtime_selected: proofCarrier.preference === 'interactive_agent_cli',
    production_ready: primaryRuntimeReady && productionProofFresh,
    production_proof_age_ms: productionProofAgeMs,
    production_proof_fresh: productionProofFresh,
    production_proof_freshness_window_ms: productionProofFreshnessWindowMs,
    resident,
    pending,
    receipts,
    outcomes,
    proof: {
      reported_count: reportedOutcomes.length,
      proof_driver_report_count: proofDriverReports,
      production_report_count: productionReports,
    },
    mailbox_live: options.mailboxLive === true,
    required_chain: ['mailbox_materialized', 'task_created', 'directive_emitted', 'carrier_receipt', 'task_report_with_directive_id', 'outcome_reconciled'],
  };
}

function hasProductionReportedOutcome(outcome) {
  return (outcome?.classifications ?? []).some((item) => item.status === 'reported' && item.production_proof === true);
}

export async function runSonarResidentRecoveryDrill(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const fixtureId = options.id ?? `resident-recovery-drill-${Date.now()}`;
  const before = sonarResidentStatus(siteRoot);
  const beforeCarrier: SiteLoopPayload = before.carrier ?? {};
  const retired = beforeCarrier.carrierSessionId
    ? retireResidentCarrier(siteRoot, beforeCarrier.carrierSessionId, {
        reason: options.reason ?? 'resident_recovery_drill',
        at: new Date().toISOString(),
      })
    : { status: 'skipped', reason: 'no_current_carrier' };
  const replacement = ensureResidentCarrier(siteRoot, { requireLiveCarrier: true });
  const proof = await runSonarResidentE2E(siteRoot, {
    ackFixture: true,
    live: true,
    ensureResident: true,
    id: fixtureId,
    title: options.title ?? 'Resident recovery drill',
    summary: options.summary ?? 'Recovery drill directive after retiring prior carrier.',
    timeoutMs: options.timeoutMs ?? 120_000,
    pollMs: options.pollMs ?? 5_000,
  });
  const cleanup = cleanupResidentWorkFixture(siteRoot, { id: fixtureId });
  const after = sonarResidentStatus(siteRoot);
  const accepted = proof.proof?.carrier_receipt_observed === true;
  const productionProof = proof.production_proof === true;
  return {
    schema: 'narada.sonar.resident_recovery_drill.v1',
    status: retired.status === 'retired' && ['launch_requested', 'already_available'].includes(replacement.status) && accepted
      ? productionProof ? 'production_passed' : 'transport_passed'
      : 'incomplete',
    before,
    retired,
    replacement,
    after,
    accepted_work: accepted,
    production_proof: productionProof,
    proof,
    cleanup,
  };
}

export function inspectSonarEmailResidentLoopSchema(cwd) {
  const store = openSiteLoopStore(resolve(cwd));
  try {
    const columns = store.db.prepare('PRAGMA table_info(task_reports)').all().map((row) => String(row.name));
    const health = getLoopHealth(store, SONAR_EMAIL_RESIDENT_LOOP_ID);
    return {
      schema: 'narada.sonar.site_loop_schema_repair.v1',
      status: 'ok',
      db_path: join(resolve(cwd), '.ai', 'task-lifecycle.db'),
      task_reports_directive_id: columns.includes('directive_id') ? 'present' : 'missing',
      canonical_records: {
        health_schema: health.schema,
      },
      health,
    };
  } finally {
    store.close();
  }
}

export function resolveSonarResidentOutcome(cwd, options: SiteLoopPayload = {}) {
  const directiveId = options.directiveId ?? options.directive_id;
  const store = openSiteLoopStore(resolve(cwd));
  try {
    return {
      ...resolveDirectiveOutcome(store, {
        loopId: options.loopId ?? SONAR_EMAIL_RESIDENT_LOOP_ID,
        directiveId,
        reason: options.reason ?? 'operator_cleanup',
        resolvedBy: options.resolvedBy ?? 'operator',
      }),
      health: getLoopHealth(store, options.loopId ?? SONAR_EMAIL_RESIDENT_LOOP_ID),
    };
  } finally {
    store.close();
  }
}

export function seedResidentWorkFixture(cwd, options: SiteLoopPayload = {}) {
  if (options.ackFixture !== true) {
    return {
      schema: 'narada.sonar.loop_fixture_seed.v1',
      status: 'refused',
      reason: 'ack_fixture_required',
      required_flag: '--ack-fixture',
      outbound_mutation: false,
    };
  }
  const siteRoot = resolve(cwd);
  const id = options.id ?? 'resident_work_fixture';
  const nowIso = options.receivedAt ?? new Date().toISOString();
  const envelopeId = `env_${sanitizeId(id)}`;
  const dir = join(siteRoot, '.ai', 'inbox-envelopes');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `fixture-${envelopeId}.json`);
  const existed = existsSync(path);
  const envelope = {
    schema: 'narada.inbox_envelope.v1',
    envelope_id: envelopeId,
    received_at: nowIso,
    kind: 'incident',
    authority: { level: 'system_test', principal: 'sonar.site-loop.fixture' },
    source: { kind: 'synthetic_fixture', ref: id },
    payload: {
      title: options.title ?? 'Resident synthetic work fixture',
      summary: options.summary ?? 'Synthetic local fixture for resident loop E2E validation.',
      target_role: RESIDENT_ROLE,
      preferred_agent_id: RESIDENT_AGENT_ID,
      fixture: true,
      fixture_id: id,
    },
    status: 'received',
  };
  if (!existed) writeFileSync(path, JSON.stringify(envelope, null, 2), 'utf8');
  return {
    schema: 'narada.sonar.loop_fixture_seed.v1',
    status: existed ? 'exists' : 'created',
    envelope_id: envelopeId,
    path,
    outbound_mutation: false,
  };
}

export function cleanupResidentWorkFixture(cwd, options: SiteLoopPayload = {}) {
  const siteRoot = resolve(cwd);
  const id = options.id ?? 'resident_work_fixture';
  const envelopeId = `env_${sanitizeId(id)}`;
  const path = join(siteRoot, '.ai', 'inbox-envelopes', `fixture-${envelopeId}.json`);
  if (!existsSync(path)) {
    return { schema: 'narada.sonar.loop_fixture_cleanup.v1', status: 'not_found', envelope_id: envelopeId, path };
  }
  // Keep cleanup intentionally narrow: remove only deterministic files created by seedResidentWorkFixture.
  try {
    rmSync(path, { force: true });
  } catch (error) {
    return { schema: 'narada.sonar.loop_fixture_cleanup.v1', status: 'error', envelope_id: envelopeId, path, error: error instanceof Error ? error.message : String(error) };
  }
  return { schema: 'narada.sonar.loop_fixture_cleanup.v1', status: 'removed', envelope_id: envelopeId, path };
}

export async function superviseSonarEmailResidentLoop(cwd, options: SiteLoopPayload = {}) {
  const policy = loadSonarEmailResidentOperatingPolicy(cwd).policy;
  const cycles = options.cycles == null ? Infinity : Number(options.cycles);
  const intervalMs = Number(options.intervalMs ?? options.interval_ms ?? policy.cadence.supervise_interval_ms);
  const jitterMs = Number(options.jitterMs ?? options.jitter_ms ?? 10_000);
  const runs = [];
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (let index = 0; index < cycles && !stopped; index += 1) {
      const result = await runSonarEmailResidentLoop(cwd, {
        dryRun: options.dryRun,
        sourceSync: options.sourceSync,
        sourceSyncRunner: options.sourceSyncRunner,
        limit: options.limit,
        threshold: options.threshold,
        drain: options.drain,
        ensureResident: options.ensureResident,
        requireFreshProductionProof: options.requireFreshProductionProof,
      });
      const statusAfterRun = sonarEmailResidentOperatingLayerStatus(cwd, {
        productionProofFreshnessMs: options.productionProofFreshnessMs ?? options.production_proof_freshness_ms,
        requireFreshProductionProof: options.requireFreshProductionProof === true || options.require_fresh_production_proof === true,
      });
      runs.push({
        run_id: result.run_id,
        status: result.status,
        summary: result.summary ?? null,
        checks: {
          db_ok: statusAfterRun.db_health?.status === 'ok',
          stale_pending_directives: Number(statusAfterRun.backlog?.stale_pending_directives ?? 0),
          blocking_alerts: (statusAfterRun.alerts ?? []).filter((alert) => ['error', 'critical'].includes(alert.severity)).length,
          production_proof_fresh: statusAfterRun.latest_activity?.production_proof_fresh === true,
        },
      });
      if (index + 1 >= cycles || stopped) break;
      await sleep(intervalMs + Math.floor(Math.random() * Math.max(0, jitterMs)));
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return {
    schema: 'narada.sonar.site_loop_supervisor_run.v1',
    status: stopped ? 'stopped' : 'ok',
    loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
    cycles_requested: Number.isFinite(cycles) ? cycles : null,
    cycles_completed: runs.length,
    runs,
  };
}

export async function runSonarEmailResidentSoak(cwd, options: SiteLoopPayload = {}) {
  const cycles = Math.max(1, Number(options.cycles ?? 3));
  const result = await superviseSonarEmailResidentLoop(cwd, {
    ...options,
    cycles,
    intervalMs: options.intervalMs ?? options.interval_ms ?? 0,
    jitterMs: options.jitterMs ?? options.jitter_ms ?? 0,
  });
  const status = sonarEmailResidentOperatingLayerStatus(cwd, {
    productionProofFreshnessMs: options.productionProofFreshnessMs ?? options.production_proof_freshness_ms,
  });
  const failedRuns = result.runs.filter((run) => run.status !== 'ok');
  const requireFreshProductionProof = options.requireFreshProductionProof === true || options.require_fresh_production_proof === true;
  const perCycleFailures = result.runs.filter((run) => run.checks
    && (run.checks.db_ok !== true
      || Number(run.checks.stale_pending_directives ?? 0) > 0
      || Number(run.checks.blocking_alerts ?? 0) > 0
      || (requireFreshProductionProof && run.checks.production_proof_fresh !== true)));
  const blockingAlerts = (status.alerts ?? []).filter((alert) => ['error', 'critical'].includes(alert.severity));
  const productionFreshOk = !requireFreshProductionProof || status.latest_activity?.production_proof_fresh === true;
  const passed = failedRuns.length === 0
    && perCycleFailures.length === 0
    && status.db_health?.status === 'ok'
    && Number(status.backlog?.stale_pending_directives ?? 0) === 0
    && blockingAlerts.length === 0
    && productionFreshOk;
  return {
    schema: 'narada.sonar.site_loop_soak.v1',
    status: passed ? 'passed' : 'failed',
    loop_id: SONAR_EMAIL_RESIDENT_LOOP_ID,
    cycles_requested: cycles,
    cycles_completed: result.cycles_completed,
    require_fresh_production_proof: requireFreshProductionProof,
    checks: {
      failed_runs: failedRuns.length,
      per_cycle_failures: perCycleFailures.length,
      db_ok: status.db_health?.status === 'ok',
      stale_pending_directives: Number(status.backlog?.stale_pending_directives ?? 0),
      blocking_alerts: blockingAlerts.length,
      production_proof_fresh: status.latest_activity?.production_proof_fresh === true,
    },
    supervisor: result,
    operating_layer: status,
  };
}

async function runStep({ store, runId, stepId, inputRefs = [], execute, outputRefs, evidence, onFailedStep = null }) {
  const startedAt = new Date().toISOString();
  try {
    const result = await execute();
    const finishedAt = new Date().toISOString();
    const step = {
      step_run_id: `${runId}:${stepId}`,
      run_id: runId,
      step_id: stepId,
      status: result?.status === 'error' ? 'failed' : 'ok',
      started_at: startedAt,
      finished_at: finishedAt,
      input_refs: inputRefs,
      output_refs: outputRefs(result),
      evidence: evidence(result),
      result,
    };
    if (store) recordLoopStep(store, step);
    if (step.status === 'failed') throw new Error(result.error ?? `${stepId}_failed`);
    return step;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const step = {
      step_run_id: `${runId}:${stepId}`,
      run_id: runId,
      step_id: stepId,
      status: 'failed',
      started_at: startedAt,
      finished_at: finishedAt,
      input_refs: inputRefs,
      output_refs: [],
      evidence: null,
      error: errorToPayload(error),
      result: null,
    };
    if (store) recordLoopStep(store, step);
    if (typeof onFailedStep === 'function') onFailedStep(step);
    throw error;
  }
}

function recordSyntheticStep({ store, runId, stepId, status = 'ok', inputRefs = [], outputRefs = [], evidence = null }: SiteLoopPayload) {
  const now = new Date().toISOString();
  const step = {
    step_run_id: `${runId}:${stepId}`,
    run_id: runId,
    step_id: stepId,
    status,
    started_at: now,
    finished_at: now,
    input_refs: inputRefs,
    output_refs: outputRefs,
    evidence,
  };
  if (store) recordLoopStep(store, step);
  return step;
}

function summarizeBridgeResult(result) {
  return {
    schema: result?.schema ?? null,
    status: result?.status ?? null,
    evaluated: result?.evaluated ?? 0,
    materialized: result?.materialized ?? 0,
    skipped: result?.skipped ?? 0,
    duplicates: result?.duplicates ?? 0,
    errors: result?.errors ?? 0,
    dry_run: result?.dry_run ?? false,
  };
}

function summarizeSourceSync(result) {
  return {
    schema: result?.schema ?? 'narada.sonar.source_sync.v1',
    status: result?.status ?? result?.outcome ?? 'ok',
    dry_run: result?.dry_run ?? result?.dryRun ?? null,
    synced_count: result?.synced_count ?? result?.synced ?? result?.changed ?? null,
    skipped_count: result?.skipped_count ?? result?.skipped ?? null,
  };
}

function summarizeTaskMaterialization(result) {
  const materialized = result?.details?.materialized ?? [];
  return {
    materialized_count: result?.materialized ?? 0,
    duplicate_count: result?.duplicates ?? 0,
    skipped_count: result?.skipped ?? 0,
    error_count: result?.errors ?? 0,
    tasks: materialized.map((item) => ({
      envelope_id: item.envelopeId ?? null,
      task_id: item.taskId ?? null,
      task_number: item.taskNumber ?? null,
      mapping_written: item.mapping_written ?? null,
      target_role: item.targetRole ?? null,
      preferred_agent_id: item.preferredAgentId ?? null,
    })),
  };
}

function summarizeResidentDirectiveEmission(result) {
  const directives = residentDirectiveRefs(result);
  const errors = (result?.details?.materialized ?? [])
    .map((item) => item.resident_directive)
    .filter((directive) => directive?.status === 'error');
  return {
    emitted_count: directives.length,
    error_count: errors.length,
    directives,
    errors,
  };
}

function summarizeTicketTaskReconciliation(result) {
  return {
    schema: result?.schema ?? 'narada.sonar.ticket_task_reconciliation.v1',
    status: result?.status ?? 'unknown',
    dry_run: result?.dry_run ?? false,
    scanned: result?.scanned ?? 0,
    created: result?.created ?? 0,
    existing: result?.existing ?? 0,
    planned: result?.planned ?? 0,
    skipped: (result?.results ?? []).filter((entry) => entry?.status === 'skipped').length,
    tasks: (result?.results ?? [])
      .filter((entry) => entry?.task?.task_id || entry?.task?.task_number)
      .map((entry) => ({
        ticket_id: entry.ticket_id ?? null,
        status: entry.status ?? null,
        task_id: entry.task?.task_id ?? null,
        task_number: entry.task?.task_number ?? null,
        link_path: entry.link_path ?? null,
      })),
  };
}

function summarizeResidentBacklogRecovery(result) {
  return {
    schema: result?.schema ?? 'narada.sonar.resident_backlog_recovery.v1',
    status: result?.status ?? 'unknown',
    emitted_count: result?.emitted?.length ?? 0,
    created_count: (result?.emitted ?? []).filter((item) => item.emission_status === 'created').length,
    existing_count: (result?.emitted ?? []).filter((item) => item.emission_status === 'existing').length,
    skipped_count: result?.skipped?.length ?? 0,
    scanned_count: result?.scanned_count ?? 0,
    emitted: result?.emitted ?? [],
    skipped: result?.skipped ?? [],
  };
}

function emitResidentBacklogRecoveryDirectives(siteRoot, options: SiteLoopPayload = {}) {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const actionStaleMinutes = Number(options.actionStaleMinutes ?? 30);
  const limit = Math.max(0, Number(options.limit ?? 25));
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: true });
  const directiveStore = new SqliteDirectiveRuntimeStore({ db: lifecycleStore.db });
  directiveStore.initSchema();
  try {
    const candidates = residentBacklogCandidates(lifecycleStore.db, { limit: Math.max(limit * 4, limit), siteRoot });
    const emitted = [];
    const skipped = [];
    for (const candidate of candidates) {
      if (emitted.length >= limit) {
        skipped.push({ task_id: candidate.task_id, task_number: candidate.task_number, reason: 'cycle_limit_reached' });
        continue;
      }
      const decision = residentBacklogRecoveryDecision(lifecycleStore.db, candidate, { siteRoot, nowIso, actionStaleMinutes });
      if (decision.status !== 'emit') {
        skipped.push({
          task_id: candidate.task_id,
          task_number: candidate.task_number,
          reason: decision.reason,
          directive_id: decision.directive_id ?? null,
          outcome: decision.outcome ?? null,
        });
        continue;
      }
      const staleBucket = Math.floor(Date.parse(nowIso) / Math.max(1, actionStaleMinutes) / 60000);
      const result = directiveStore.emitResidentDirectiveForAdmittedWork({
        siteId: 'sonar',
        authorityLocus: 'client_service',
        systemEmitterId: 'sonar.system.directive_emitter',
        residentAgentId: RESIDENT_AGENT_ID,
        residentRole: RESIDENT_ROLE,
        taskId: candidate.task_id,
        taskNumber: candidate.task_number,
        sourceId: candidate.mailbox_ticket_id ?? undefined,
        transitionId: `resident_backlog_recovery:${decision.reason}:${decision.directive_id ?? 'none'}:${staleBucket}`,
        title: candidate.mailbox_ticket_id
          ? `Mailbox ticket draft recovery: ${candidate.mailbox_ticket_id}`
          : candidate.task_id,
        admittedAt: nowIso,
      });
      const priorDirectiveId = decision.directive_id ?? null;
      if (priorDirectiveId && result.directive?.directive_id) {
        supersedeRecoveredDirective(lifecycleStore.db, {
          priorDirectiveId,
          replacementDirectiveId: result.directive.directive_id,
          taskId: candidate.task_id,
          reason: decision.reason,
          at: nowIso,
        });
      }
      emitted.push({
        task_id: candidate.task_id,
        task_number: candidate.task_number,
        directive_id: result.directive?.directive_id ?? null,
        is_new: result.isNew ?? false,
        emission_status: result.isNew ? 'created' : 'existing',
        reason: decision.reason,
        prior_directive_id: decision.directive_id ?? null,
      });
    }
    return {
      schema: 'narada.sonar.resident_backlog_recovery.v1',
      status: 'ok',
      now: nowIso,
      action_stale_minutes: actionStaleMinutes,
      scanned_count: candidates.length,
      emitted,
      skipped,
    };
  } finally {
    lifecycleStore.db.close();
  }
}

function residentBacklogCandidates(db, { limit, siteRoot = null }) {
  return db.prepare(`
    SELECT tl.task_id, tl.task_number, tl.status, tl.governed_by,
           ta.assignment_id, ta.agent_id AS active_agent_id, ta.claimed_at,
           ts.title, ts.goal_markdown, ts.context_markdown, ts.required_work_markdown,
           ts.acceptance_criteria_json
    FROM task_lifecycle tl
    LEFT JOIN task_assignments ta
      ON ta.task_id = tl.task_id AND ta.released_at IS NULL
    LEFT JOIN task_specs ts
      ON ts.task_id = tl.task_id
    WHERE tl.governed_by = 'resident'
      AND tl.status IN ('opened', 'claimed', 'needs_continuation')
    ORDER BY tl.task_number DESC
    LIMIT ?
  `).all(limit).filter((row) => {
    if (String(row.status) !== 'needs_continuation') return true;
    return isNeedsContinuationTicketDraftRecoveryCandidate(row, { siteRoot });
  }).map((row) => ({
    task_id: String(row.task_id),
    task_number: Number(row.task_number),
    status: String(row.status),
    governed_by: row.governed_by ? String(row.governed_by) : null,
    assignment_id: row.assignment_id ? String(row.assignment_id) : null,
    active_agent_id: row.active_agent_id ? String(row.active_agent_id) : null,
    claimed_at: row.claimed_at ? String(row.claimed_at) : null,
    mailbox_ticket_id: mailboxTicketIdFromTaskRow(row),
  }));
}

function isNeedsContinuationTicketDraftRecoveryCandidate(row, { siteRoot }) {
  const ticketId = mailboxTicketIdFromTaskRow(row);
  if (!ticketId) return false;
  if (!siteRoot) return true;
  return !ticketHasLocalTerminalOrDraftReceipt(siteRoot, ticketId);
}

function mailboxTicketIdFromTaskRow(row) {
  const text = [
    row.title,
    row.goal_markdown,
    row.context_markdown,
    row.required_work_markdown,
    row.acceptance_criteria_json,
  ].filter(Boolean).join('\n');
  const match = text.match(/\bMailbox ticket:\s*(mail:[A-Za-z0-9._-]+)/i)
    ?? text.match(/\b(mail:[A-Za-z0-9._-]+)\b/);
  return match ? match[1] : null;
}

function ticketHasLocalTerminalOrDraftReceipt(siteRoot, ticketId) {
  const evidenceRoot = resolve(siteRoot, 'evidence', 'live', safeEvidenceName(ticketId));
  const closePath = resolve(siteRoot, '.ai', 'tickets', 'closed', `${safeEvidenceName(ticketId)}.json`);
  const latestDraft = latestJsonReceiptPath(resolve(evidenceRoot, 'outlook-draft-receipts'));
  const latestDelete = latestJsonReceiptPath(resolve(evidenceRoot, 'outlook-delete-receipts'));
  return existsSync(closePath)
    || latestJsonReceiptPath(resolve(evidenceRoot, 'outlook-send-receipts'))
    || (latestDraft && (!latestDelete || latestDraft.name > latestDelete.name));
}

function latestJsonReceiptPath(directory) {
  if (!existsSync(directory)) return null;
  const names = readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  return names.length > 0 ? { name: names.at(-1), path: resolve(directory, names.at(-1)) } : null;
}

function safeEvidenceName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function residentBacklogRecoveryDecision(db, candidate, { siteRoot = null, nowIso, actionStaleMinutes, recordAttention = true }) {
  if (candidate.status === 'claimed') {
    if (!candidate.assignment_id) {
      if (recordAttention) {
        recordTaskBacklogAttention(db, candidate, {
          siteRoot,
          classification: 'claimed_missing_active_assignment',
          reason: 'resident claimed task has no active assignment row',
          nowIso,
        });
      }
      return { status: 'skip', reason: 'claimed_missing_active_assignment' };
    }
    if (candidate.active_agent_id !== RESIDENT_AGENT_ID) {
      if (recordAttention) {
        recordTaskBacklogAttention(db, candidate, {
          siteRoot,
          classification: 'resident_task_claimed_by_other_agent',
          reason: `resident task is claimed by ${candidate.active_agent_id}`,
          nowIso,
        });
      }
      return { status: 'skip', reason: 'claimed_by_other_agent' };
    }
  }
  const directives = residentDirectivesForTask(db, candidate.task_id);
  if (directives.some((directive) => directive.outcome === 'reported')) {
    return { status: 'skip', reason: 'already_reported' };
  }
  const latest = directives[0] ?? null;
  if (!latest) {
    return { status: 'emit', reason: `${candidate.status}_missing_directive` };
  }
  if (isResidentDirectiveActive(latest, { nowIso, actionStaleMinutes })) {
    return {
      status: 'skip',
      reason: 'active_directive_exists',
      directive_id: latest.directive_id,
      outcome: latest.outcome ?? latest.delivery_status,
    };
  }
  return {
    status: 'emit',
    reason: `${candidate.status}_stale_directive`,
    directive_id: latest.directive_id,
    outcome: latest.outcome ?? latest.delivery_status,
  };
}

function residentDirectivesForTask(db, taskId) {
  return db.prepare(`
    SELECT dr.directive_id, dr.created_at, dr.delivery_status,
           dol.outcome, dol.observed_at, dol.recorded_at
    FROM directive_refs ref
    JOIN directive_records dr ON dr.directive_id = ref.directive_id
    LEFT JOIN directive_outcome_latest dol
      ON dol.loop_id = ? AND dol.directive_id = dr.directive_id
    WHERE ref.ref_kind = 'task'
      AND ref.ref_id = ?
      AND dr.admission_status = 'admitted'
      AND (
        (dr.target_kind = 'agent' AND dr.target_id = ?)
        OR (dr.target_kind = 'role' AND dr.target_id = ?)
      )
    ORDER BY dr.created_at DESC, dr.directive_id DESC
  `).all(SONAR_EMAIL_RESIDENT_LOOP_ID, taskId, RESIDENT_AGENT_ID, RESIDENT_ROLE).map((row) => ({
    directive_id: String(row.directive_id),
    created_at: String(row.created_at),
    delivery_status: String(row.delivery_status),
    outcome: row.outcome ? String(row.outcome) : null,
    observed_at: row.observed_at ? String(row.observed_at) : null,
    recorded_at: row.recorded_at ? String(row.recorded_at) : null,
  }));
}

function isResidentDirectiveActive(directive, { nowIso, actionStaleMinutes }) {
  const activeOutcomes = new Set(['pending', 'leased', 'received', 'carrier_accepted']);
  const outcome = directive.outcome ?? null;
  const status = outcome ?? directive.delivery_status;
  if (!activeOutcomes.has(status)) return false;
  const anchor = directive.observed_at ?? directive.recorded_at ?? directive.created_at;
  return minutesBetween(anchor, nowIso) < actionStaleMinutes;
}

function supersedeRecoveredDirective(db, { priorDirectiveId, replacementDirectiveId, taskId, reason, at }) {
  const existing = latestDirectiveOutcome(db, priorDirectiveId);
  if (existing?.outcome === 'superseded') return null;
  return recordDirectiveOutcome({ db }, {
    loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
    directiveId: priorDirectiveId,
    outcome: 'superseded',
    agentId: RESIDENT_AGENT_ID,
    taskId,
    reason: 'superseded_by_recovery_directive',
    eventAt: at,
    observedAt: at,
    recordedAt: at,
    evidence: {
      schema: 'narada.sonar.directive_recovery_supersession.v1',
      previous_outcome: existing,
      replacement_directive_id: replacementDirectiveId,
      task_id: taskId,
      recovery_reason: reason,
    },
  });
}

function recordTaskBacklogAttention(db, candidate, { siteRoot, classification, reason, nowIso }) {
  const directiveId = `task:${candidate.task_id}`;
  const envelopeId = `operator_attention_${safeFileToken(candidate.task_id)}_${safeFileToken(classification)}`;
  const existing = getLoopEscalation({ db }, {
    loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
    directiveId,
    classification,
  });
  if (existing?.status === 'opened') return { status: 'exists', escalation: existing };
  const envelope = writeTaskBacklogAttentionEnvelope(candidate, {
    siteRoot,
    envelopeId,
    classification,
    reason,
    nowIso,
  });
  const escalation = recordLoopEscalation({ db }, {
    loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
    directiveId,
    classification,
    envelopeId,
    escalation: {
      schema: 'narada.sonar.resident_task_backlog_attention.v1',
      subject_ref: directiveId,
      task_id: candidate.task_id,
      task_number: candidate.task_number,
      status: candidate.status,
      active_agent_id: candidate.active_agent_id,
      assignment_id: candidate.assignment_id,
      classification,
      reason,
      envelope_path: envelope.path,
    },
    at: nowIso,
  });
  return { status: 'created', escalation };
}

function writeTaskBacklogAttentionEnvelope(candidate, { siteRoot, envelopeId, classification, reason, nowIso }) {
  const dir = join(resolve(siteRoot), '.ai', 'operator-attention');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${envelopeId}.json`);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({
      schema: 'narada.inbox_envelope.v1',
      envelope_id: envelopeId,
      kind: 'operator_attention',
      received_at: nowIso,
      authority: { level: 'system_reported', principal: 'sonar.email-resident' },
      source: { kind: 'site_loop', ref: SONAR_EMAIL_RESIDENT_LOOP_ID },
      payload: {
        title: `Resident task needs operator attention: ${classification}`,
        summary: `Resident-governed task ${candidate.task_id} cannot be recovered automatically: ${reason}.`,
        subject_ref: `task:${candidate.task_id}`,
        task_id: candidate.task_id,
        task_number: candidate.task_number,
        classification,
        reason,
        status: candidate.status,
        active_agent_id: candidate.active_agent_id,
        assignment_id: candidate.assignment_id,
        severity: 'error',
      },
      status: 'received',
    }, null, 2), 'utf8');
  }
  return { envelope_id: envelopeId, path };
}

function summarizeDirectiveDispatch(result) {
  return {
    schema: result?.schema ?? null,
    status: result?.status ?? null,
    pending_count: result?.pending_count ?? 0,
    dispatched_count: result?.dispatched?.length ?? 0,
    skipped_count: result?.skipped?.length ?? 0,
    control_path: result?.control_path ?? null,
    carrier_status: result?.carrier?.status ?? null,
    carrier_reason: result?.carrier?.reason ?? null,
  };
}

function summarizeReceiptReconciliation(result) {
  return {
    status: result?.receipt_reconciliation?.status ?? 'unknown',
    scanned: result?.receipt_reconciliation?.scanned ?? 0,
    recorded_count: result?.receipt_reconciliation?.recorded?.length ?? 0,
    carrier_accepted_count: result?.receipt_reconciliation?.carrier_accepted?.length ?? 0,
    skipped_count: result?.receipt_reconciliation?.skipped?.length ?? 0,
    lease_recovered_count: result?.lease_recovery?.recovered?.length ?? 0,
    recorded: result?.receipt_reconciliation?.recorded ?? [],
    lease_recovery: result?.lease_recovery ?? null,
  };
}

function summarizeRun({ bridge, dispatch, steps }: SiteLoopPayload) {
  const directEmissionCount = steps.find((step) => step.step_id === 'resident_directive_emission')?.evidence?.emitted_count ?? residentDirectiveRefs(bridge).length;
  const backlogEmissionCount = steps.find((step) => step.step_id === 'resident_backlog_recovery_emission')?.evidence?.emitted_count ?? 0;
  const ticketTaskReconciliation = steps.find((step) => step.step_id === 'ticket_task_reconciliation')?.evidence ?? null;
  return {
    source_sync: steps.find((step) => step.step_id === 'source_sync')?.evidence ?? null,
    ticket_task_reconciliation: ticketTaskReconciliation,
    ticket_tasks_created: ticketTaskReconciliation?.created ?? 0,
    evaluated: bridge?.evaluated ?? 0,
    materialized: bridge?.materialized ?? 0,
    duplicates: bridge?.duplicates ?? 0,
    bridge_errors: bridge?.errors ?? 0,
    resident_directives_emitted: directEmissionCount + backlogEmissionCount,
    pending_directives: dispatch?.pending_count ?? 0,
    directives_dispatched: dispatch?.dispatched?.length ?? 0,
    directives_skipped: dispatch?.skipped?.length ?? 0,
    receipts_recorded: dispatch?.receipt_reconciliation?.recorded?.length ?? 0,
    resident_supervisor: steps.find((step) => step.step_id === 'resident_supervisor')?.evidence?.status ?? 'not_enabled',
    agent_outcomes: steps.find((step) => step.step_id === 'agent_outcome_reconciliation')?.evidence?.counts ?? {},
    escalations: steps.find((step) => step.step_id === 'stale_escalation_reconciliation')?.evidence?.created?.length ?? 0,
    step_count: steps.length,
  };
}

function sourceSyncRefs(result) {
  return [
    ...(result?.cursor_path ? [{ kind: 'sync_cursor', ref: result.cursor_path }] : []),
    ...(result?.health_path ? [{ kind: 'sync_health', ref: result.health_path }] : []),
  ];
}

export function runAgentOutcomeReconciliation(cwd, options: SiteLoopPayload = {}) {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const deliveryStaleMinutes = Number(options.deliveryStaleMinutes ?? 5);
  const actionStaleMinutes = Number(options.actionStaleMinutes ?? 30);
  const directiveIds = Array.isArray(options.directiveIds)
    ? options.directiveIds.map(String).filter(Boolean)
    : [];
  const includeBacklog = options.includeBacklog !== false;
  const resident = options.resident ?? null;
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(cwd);
  ensureSiteLoopTables(lifecycleStore.db);
  const directiveStore = new SqliteDirectiveRuntimeStore({ db: lifecycleStore.db });
  directiveStore.initSchema();
  try {
    const baseWhere = `
      admission_status = 'admitted'
      AND (
        (target_kind = 'agent' AND target_id = 'sonar.resident')
        OR (target_kind = 'role' AND target_id = 'resident')
      )
    `;
    const rows = directiveIds.length === 0 && !includeBacklog
      ? []
      : directiveIds.length > 0 && !includeBacklog
      ? lifecycleStore.db.prepare(`
          SELECT directive_id, directive_json, created_at, delivery_status
          FROM directive_records
          WHERE ${baseWhere}
            AND directive_id IN (${directiveIds.map(() => '?').join(', ')})
          ORDER BY created_at ASC, directive_id ASC
        `).all(...directiveIds)
      : directiveIds.length > 0
        ? lifecycleStore.db.prepare(`
          SELECT directive_id, directive_json, created_at, delivery_status
          FROM directive_records
          WHERE ${baseWhere}
            AND (
              directive_id IN (${directiveIds.map(() => '?').join(', ')})
              OR delivery_status IN ('pending', 'leased', 'failed', 'receipt_recorded')
            )
          ORDER BY created_at ASC, directive_id ASC
        `).all(...directiveIds)
        : lifecycleStore.db.prepare(`
          SELECT directive_id, directive_json, created_at, delivery_status
          FROM directive_records
          WHERE ${baseWhere}
            AND delivery_status IN ('pending', 'leased', 'failed', 'receipt_recorded')
          ORDER BY created_at ASC, directive_id ASC
        `).all();
    const classifications = rows.map((row) => classifyDirectiveOutcome(lifecycleStore.db, {
      directive_id: String(row.directive_id),
      created_at: String(row.created_at),
      delivery_status: String(row.delivery_status),
      directive: JSON.parse(String(row.directive_json)),
    }, {
      nowIso,
      nowMs,
      deliveryStaleMinutes,
      actionStaleMinutes,
      resident,
    }));
    const outcomeRecords = classifications
      .map((item) => recordOutcomeForClassification({ db: lifecycleStore.db }, item, { nowIso }))
      .filter(Boolean);
    const counts = {};
    for (const item of classifications) counts[item.status] = (counts[item.status] ?? 0) + 1;
    return {
      schema: 'narada.sonar.agent_outcome_reconciliation.v1',
      status: 'ok',
      now: nowIso,
      delivery_stale_minutes: deliveryStaleMinutes,
      action_stale_minutes: actionStaleMinutes,
      scoped_directive_ids: directiveIds,
      include_backlog: includeBacklog,
      resident_status: resident?.status ?? null,
      counts,
      classifications,
      outcome_records: outcomeRecords,
      output_refs: classifications.map((item) => ({
        kind: 'agent_outcome_classification',
        ref: item.directive_id,
        status: item.status,
        task_id: item.task_id,
      })),
    };
  } finally {
    lifecycleStore.db.close();
  }
}

function classifyDirectiveOutcome(db, row, options) {
  const directive = row.directive;
  const taskRef = (directive.content?.refs ?? []).find((ref) => ref.kind === 'task')?.id
    ?? directive.content?.data?.task_id
    ?? null;
  const createdAt = directive.created_at ?? row.created_at;
  const receipt = directive.delivery?.receipt_id
    ? getDirectiveReceipt(db, directive.directive_id, directive.delivery.receipt_id)
    : null;
  const receiptAt = directive.delivery?.received_at ?? receipt?.received_at ?? null;
  const leaseUntil = directive.delivery?.leased_until ?? null;
  const deliveryAgeMinutes = minutesBetween(createdAt, options.nowIso);

  if (!taskRef) {
    return baseOutcome(row, 'unknown', {
      reason: 'missing_task_ref',
      task_id: null,
      receipt_id: directive.delivery?.receipt_id ?? null,
      receipt_at: receiptAt,
    });
  }

  const previousOutcome = latestDirectiveOutcome(db, directive.directive_id);
  if (previousOutcome?.outcome === 'superseded') {
    return baseOutcome(row, 'superseded', {
      reason: previousOutcome.reason ?? 'previous_outcome_superseded',
      task_id: taskRef,
      receipt_id: directive.delivery?.receipt_id ?? null,
      receipt_at: receiptAt,
    });
  }

  if (!directive.delivery?.receipt_id) {
    if (['not_started', 'stale_launch', 'blocked', 'rate_limited'].includes(options.resident?.status) && row.delivery_status === 'pending') {
      return baseOutcome(row, 'blocked_no_carrier', {
        reason: `resident_carrier_${options.resident.status}`,
        task_id: taskRef,
        receipt_id: null,
        receipt_at: null,
        lease_until: leaseUntil,
      });
    }
    const leaseExpired = leaseUntil ? Date.parse(leaseUntil) <= options.nowMs : false;
    const oldEnough = deliveryAgeMinutes >= options.deliveryStaleMinutes;
    const waitingStatus = row.delivery_status === 'leased' ? 'leased' : 'pending';
    return baseOutcome(row, leaseExpired || oldEnough ? 'delivery_stale' : waitingStatus, {
      reason: leaseExpired ? 'lease_expired_without_receipt' : oldEnough ? 'delivery_without_receipt_past_threshold' : 'awaiting_receipt',
      task_id: taskRef,
      receipt_id: null,
      receipt_at: null,
      lease_until: leaseUntil,
    });
  }

  const triage = latestDirectiveTriage(db, directive.directive_id, 'sonar.resident');
  if (triage?.status === 'refused') {
    return baseOutcome(row, 'refused', {
      reason: triage.reason ?? 'resident_refused_directive',
      task_id: taskRef,
      receipt_id: directive.delivery.receipt_id,
      receipt_at: receiptAt,
      triage_id: triage.triage_id,
      triaged_at: triage.triaged_at,
    });
  }

  const report = latestDirectiveLinkedTaskReportAfter(db, taskRef, receiptAt ?? createdAt, 'sonar.resident', directive.directive_id);
  if (report) {
    return baseOutcome(row, 'reported', {
      reason: report.proof_mode === 'proof_driver'
        ? 'resident_proof_driver_task_report_after_receipt_with_directive_ref'
        : 'resident_task_report_after_receipt_with_directive_ref',
      task_id: taskRef,
      receipt_id: directive.delivery.receipt_id,
      receipt_at: receiptAt,
      report_id: report?.report_id ?? null,
      reported_at: report?.submitted_at ?? null,
      proof_mode: report.proof_mode,
      production_proof: report.proof_mode !== 'proof_driver',
    });
  }

  const acceptedAt = ['carrier_accepted', 'accepted'].includes(triage?.status) ? triage.triaged_at : null;
  const actionAgeMinutes = minutesBetween(acceptedAt ?? receiptAt ?? createdAt, options.nowIso);
  const waitingStatus = acceptedAt && actionAgeMinutes < options.actionStaleMinutes ? 'carrier_accepted' : 'received';
  const staleReason = acceptedAt
    ? 'carrier_accepted_without_directive_linked_task_outcome_past_threshold'
    : 'receipt_without_directive_linked_task_outcome_past_threshold';
  return baseOutcome(row, actionAgeMinutes >= options.actionStaleMinutes ? 'action_stale' : waitingStatus, {
    reason: actionAgeMinutes >= options.actionStaleMinutes ? staleReason : acceptedAt ? 'carrier_accepted_waiting_for_directive_linked_task_outcome' : 'receipt_waiting_for_directive_linked_task_outcome',
    task_id: taskRef,
    receipt_id: directive.delivery.receipt_id,
    receipt_at: receiptAt,
    triage_id: triage?.triage_id ?? null,
    triaged_at: triage?.triaged_at ?? null,
  });
}

function latestDirectiveOutcome(db, directiveId) {
  const row = db.prepare(`
    SELECT outcome, reason, receipt_id, report_id, observed_at, recorded_at
    FROM directive_outcome_latest
    WHERE loop_id = ? AND directive_id = ?
  `).get(SONAR_EMAIL_RESIDENT_LOOP_ID, directiveId);
  return row ? {
    outcome: String(row.outcome),
    reason: row.reason ? String(row.reason) : null,
    receipt_id: row.receipt_id ? String(row.receipt_id) : null,
    report_id: row.report_id ? String(row.report_id) : null,
    observed_at: row.observed_at ? String(row.observed_at) : null,
    recorded_at: row.recorded_at ? String(row.recorded_at) : null,
  } : null;
}

function recordOutcomeForClassification(store, classification, { nowIso = new Date().toISOString() }: SiteLoopPayload = {}) {
  if (!classification?.directive_id || classification.status === 'unknown') return null;
  if (classification.status === 'superseded') {
    const existing = latestDirectiveOutcome(store.db, classification.directive_id);
    if (existing?.outcome === 'superseded') return null;
  }
  return recordDirectiveOutcome(store, {
    loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
    directiveId: classification.directive_id,
    outcome: classification.status,
    agentId: RESIDENT_AGENT_ID,
    taskId: classification.task_id ?? null,
    reportId: classification.report_id ?? null,
    receiptId: classification.receipt_id ?? null,
    reason: classification.reason ?? null,
    evidence: classification,
    eventAt: classification.reported_at ?? classification.triaged_at ?? classification.receipt_at ?? classification.created_at ?? nowIso,
    observedAt: nowIso,
    recordedAt: new Date().toISOString(),
  });
}

function reconcileLoopEscalations(siteRoot, store, outcome, { runId, nowIso = new Date().toISOString() }: SiteLoopPayload = {}) {
  const created = [];
  const cleared = [];
  const observed = [];
  for (const item of outcome.classifications ?? []) {
    const observation = recordLoopClassificationObservation(store, {
      loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
      directiveId: item.directive_id,
      classification: item.status,
      observation: { ...item, run_id: runId },
      at: nowIso,
    });
    observed.push(observation);
    if (['reported', 'refused', 'superseded'].includes(item.status)) {
      for (const classification of ['delivery_stale', 'action_stale', 'blocked_no_carrier', 'stale_busy_carrier']) {
        const existing = getLoopEscalation(store, { loopId: SONAR_EMAIL_RESIDENT_LOOP_ID, directiveId: item.directive_id, classification });
        if (existing?.status === 'opened') {
          const attentionId = existing.envelope_id ?? existing.escalation_id;
          const ack = acknowledgeLoopAttention(store, {
            attentionId,
            reason: `cleared_by_directive_outcome:${item.status}`,
            acknowledgedBy: 'sonar.email-resident.loop',
            at: nowIso,
          });
          cleared.push({ directive_id: item.directive_id, classification, outcome: item.status, attention_id: attentionId, status: ack.status });
        }
      }
    }
    if (!['delivery_stale', 'action_stale', 'blocked_no_carrier'].includes(item.status)) continue;
    const count = countRecentConsecutiveLoopClassificationObservations(store, {
      loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
      directiveId: item.directive_id,
      classification: item.status,
      limit: 3,
    });
    if (count < 3) continue;
    const existing = getLoopEscalation(store, { loopId: SONAR_EMAIL_RESIDENT_LOOP_ID, directiveId: item.directive_id, classification: item.status });
    if (existing?.status === 'opened') continue;
    const severity = loopAttentionSeverity(siteRoot, item.status);
    const envelope = writeOperatorAttentionEnvelope(siteRoot, { ...item, severity }, { runId, nowIso });
    const escalation = recordLoopEscalation(store, {
      loopId: SONAR_EMAIL_RESIDENT_LOOP_ID,
      directiveId: item.directive_id,
      classification: item.status,
      envelopeId: envelope.envelope_id,
      escalation: { ...item, severity, run_id: runId, envelope_path: envelope.path },
      at: nowIso,
    });
    created.push({ ...escalation, envelope_id: envelope.envelope_id, path: envelope.path });
  }
  return {
    schema: 'narada.sonar.loop_escalation_reconciliation.v1',
    status: 'ok',
    observed_count: observed.length,
    created_count: created.length,
    cleared_count: cleared.length,
    observed,
    created,
    cleared,
  };
}

function loopAttentionSeverity(siteRoot, classification) {
  const policy = loadSonarEmailResidentOperatingPolicy(siteRoot).policy;
  return policy.attention?.[classification] ?? policy.attention?.[classification === 'blocked_no_carrier' ? 'no_carrier' : classification] ?? 'warning';
}

function probeTaskLifecycleMcpTools(siteRoot) {
  const configPath = join(siteRoot, '.ai', 'mcp', 'narada-sonar-task-lifecycle-mcp.json');
  const config = readJson(configPath);
  const server = config?.mcpServers?.['narada-sonar-task-lifecycle'] ?? null;
  const entrypoint = Array.isArray(server?.args)
    ? server.args.find((arg) => String(arg).replace(/\\/g, '/').includes('tools/task-lifecycle/task-mcp-server.js'))
    : null;
  if (!server || !entrypoint) {
    return { status: 'missing_config', config_path: configPath, tools: [] };
  }
  const resolvedEntrypoint = String(entrypoint).replace('{site_root}', siteRoot);
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-04-18', capabilities: {}, clientInfo: { name: 'resident-capability-probe', version: '1.0' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    '',
  ].join('\n');
  const result = spawnSync(process.execPath, [resolvedEntrypoint, '--site-root', siteRoot], {
    cwd: siteRoot,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error) {
    return { status: 'error', config_path: configPath, entrypoint: resolvedEntrypoint, tools: [], error: result.error.message };
  }
  if ((result.status ?? 1) !== 0) {
    return { status: 'error', config_path: configPath, entrypoint: resolvedEntrypoint, tools: [], exit_code: result.status, stderr: result.stderr };
  }
  try {
    const responses = String(result.stdout ?? '').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const list = responses.find((response) => response.id === 2);
    const tools = (list?.result?.tools ?? []).map((tool) => tool.name).filter(Boolean);
    return { status: 'ok', config_path: configPath, entrypoint: resolvedEntrypoint, tools };
  } catch (error) {
    return { status: 'error', config_path: configPath, entrypoint: resolvedEntrypoint, tools: [], error: error instanceof Error ? error.message : String(error), stdout: result.stdout };
  }
}

function defaultResidentLaunchRunner(siteRoot) {
  const launcher = join(siteRoot, 'tools', 'agent-start', 'start-agent.js');
  const host = join(siteRoot, 'tools', 'site-loop', 'agent-runtime-server-control-host.js');
  if (!existsSync(launcher)) {
    return { status: 'failed', reason: 'agent_start_launcher_missing', launcher };
  }
  if (!existsSync(host)) {
    return { status: 'failed', reason: 'agent_runtime_server_control_host_missing', host };
  }
  const materialized = spawnSync(process.execPath, [
    launcher,
    RESIDENT_AGENT_ID,
    '--runtime',
    'agent-runtime-server',
    '--json',
    '--launch-source',
    'sonar.email-resident.loop.supervisor',
    '--trigger-source',
    'loop_ensure_resident',
    '--trigger-reason',
    'no_acceptable_live_resident_carrier',
    '--requested-by',
    'sonar.email-resident.loop',
  ], {
    cwd: siteRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      NARADA_SITE_ROOT: siteRoot,
      NARADA_WORKSPACE_ROOT: siteRoot,
    },
  });
  if (materialized.error) {
    return { status: 'failed', reason: 'agent_start_materialization_error', launcher, error: materialized.error.message };
  }
  if ((materialized.status ?? 1) !== 0) {
    return { status: 'failed', reason: 'agent_start_materialization_failed', launcher, exit_code: materialized.status, stderr: materialized.stderr, stdout: materialized.stdout };
  }
  let launchResult;
  try {
    launchResult = JSON.parse(materialized.stdout);
  } catch (error) {
    return { status: 'failed', reason: 'agent_start_materialization_output_not_json', launcher, error: error instanceof Error ? error.message : String(error), stdout: materialized.stdout };
  }
  const carrierSessionId = launchResult.carrier_session?.carrier_session_id
    ?? launchResult.carrier_session_id
    ?? null;
  if (!carrierSessionId) {
    return { status: 'failed', reason: 'agent_start_materialization_missing_carrier_session', launcher, launch_result: launchResult };
  }
  const sessionDir = join(siteRoot, '.narada', 'crew', 'nars-sessions', carrierSessionId);
  const controlFlagIndex = Array.isArray(launchResult.runtime_args) ? launchResult.runtime_args.indexOf('--control-jsonl') : -1;
  const controlPath = (controlFlagIndex >= 0 ? launchResult.runtime_args[controlFlagIndex + 1] : null)
    ?? join(sessionDir, 'control.jsonl');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(controlPath, '', { flag: 'a' });
  const child = spawn(process.execPath, [
    host,
    '--site-root',
    siteRoot,
    '--identity',
    RESIDENT_AGENT_ID,
    '--session',
    carrierSessionId,
    '--control-jsonl',
    controlPath,
  ], {
    cwd: siteRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      NARADA_SITE_ROOT: siteRoot,
      NARADA_WORKSPACE_ROOT: siteRoot,
      NARADA_AGENT_ID: RESIDENT_AGENT_ID,
      NARADA_CARRIER_SESSION_ID: carrierSessionId,
      NARADA_RESIDENT_PROOF_DRIVER: '1',
      NARADA_RESIDENT_AUTOWORK: '1',
    },
  });
  child.unref();
  const resultPath = launchResult.launch_result_path ?? null;
  const enrichedLaunchResult = {
    ...launchResult,
    runtime: 'agent-runtime-server',
    status: 'launching',
    control_path: controlPath,
    agent_runtime_server_launch: {
      schema: 'narada.agent_start.agent_runtime_server.v0',
      status: 'launching',
      transport: 'jsonl_stdio_hosted_by_control_jsonl',
      carrier_relation: 'resident_agent_runtime_server_control_host',
      session_dir: sessionDir,
      session_path: join(sessionDir, 'session.jsonl'),
      control_path: controlPath,
      host_path: host,
      host_pid: child.pid ?? null,
    },
  };
  if (resultPath) {
    writeFileSync(resultPath, `${JSON.stringify(enrichedLaunchResult, null, 2)}\n`, 'utf8');
  }
  return {
    status: 'launching',
    pid: child.pid ?? null,
    launcher,
    host,
    event_path: resultPath,
    carrier_session_id: carrierSessionId,
    runtime: 'agent-runtime-server',
    preferred_runtime: 'agent-cli',
    selection_reason: 'no_live_interactive_agent_cli_control_path',
    trigger_reason: 'no_acceptable_live_resident_carrier',
    requested_by: 'sonar.email-resident.loop',
    control_path: controlPath,
  };
}

function writeOperatorAttentionEnvelope(siteRoot, classification, { runId, nowIso }) {
  const envelopeId = `operator_attention_${safeFileToken(classification.directive_id)}_${safeFileToken(classification.status)}`;
  const dir = join(siteRoot, '.ai', 'operator-attention');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${envelopeId}.json`);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({
      schema: 'narada.inbox_envelope.v1',
      envelope_id: envelopeId,
      kind: 'operator_attention',
      received_at: nowIso,
      authority: { level: 'system_reported', principal: 'sonar.email-resident' },
      source: { kind: 'site_loop', ref: runId },
      payload: {
        title: `Resident directive needs operator attention: ${classification.status}`,
        summary: `Directive ${classification.directive_id} for task ${classification.task_id ?? 'unknown'} repeated status ${classification.status}.`,
        directive_id: classification.directive_id,
        task_id: classification.task_id ?? null,
        classification: classification.status,
        reason: classification.reason ?? null,
        severity: classification.severity ?? loopAttentionSeverity(siteRoot, classification.status),
      },
      status: 'received',
    }, null, 2), 'utf8');
  }
  return { envelope_id: envelopeId, path };
}

function retireResidentCarrier(siteRoot, carrierSessionId, { reason, at }: SiteLoopPayload = {}) {
  if (!carrierSessionId) return { status: 'skipped', reason: 'carrier_session_id_missing' };
  const dir = join(siteRoot, '.narada', 'crew', 'nars-sessions', carrierSessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'retired.json');
  const record = {
    schema: 'narada.sonar.resident_carrier_retirement.v1',
    status: 'retired',
    carrier_session_id: carrierSessionId,
    retired_at: at ?? new Date().toISOString(),
    reason: reason ?? 'stale_busy_carrier_recovery',
  };
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf8');
  return { ...record, path };
}

function residentAgentCliStartCommand(siteRoot) {
  return `pwsh -NoExit -Command "Set-Location -LiteralPath '${siteRoot}'; .\\narada-sonar.ps1 agent-start -Agent sonar.resident -Runtime agent-cli -Exec"`;
}

function readCarrierRetirement(siteRoot, carrierSessionId) {
  if (!carrierSessionId) return null;
  const path = join(siteRoot, '.narada', 'crew', 'nars-sessions', carrierSessionId, 'retired.json');
  return readJson(path);
}

function isResidentCarrierLive(siteRoot, carrierSessionId, { staleAfterMs = 30000 }: SiteLoopPayload = {}) {
  if (!carrierSessionId) return { live: false, reason: 'carrier_session_id_missing' };
  const heartbeat = readCarrierHeartbeat(siteRoot, carrierSessionId, staleAfterMs);
  if (heartbeat.fresh) {
    return {
      live: true,
      reason: 'fresh_carrier_heartbeat',
      heartbeat,
    };
  }
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$needle=$env:NARADA_RESIDENT_CARRIER_PROBE_ID; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine -like '*agent-cli*' -or $_.CommandLine -like '*agent-runtime-server-control-host*' -or $_.CommandLine -like '*nars-control-host*') -and $_.CommandLine.Contains($needle) }).Count`,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NARADA_RESIDENT_CARRIER_PROBE_ID: String(carrierSessionId) },
  });
  if (result.status !== 0) {
    return {
      live: true,
      reason: 'process_probe_failed_conservative_live',
      exit_code: result.status,
      stderr: String(result.stderr ?? '').trim(),
      heartbeat,
    };
  }
  const count = Number(String(result.stdout ?? '').trim());
  return count > 0
    ? { live: true, reason: 'carrier_session_found_in_process_command_line', process_count: count, heartbeat }
    : { live: false, reason: 'carrier_session_not_found_in_process_command_line', heartbeat };
}

function readCarrierHeartbeat(siteRoot, carrierSessionId, staleAfterMs) {
  const path = join(siteRoot, '.narada', 'crew', 'nars-sessions', carrierSessionId, 'heartbeat.json');
  if (!existsSync(path)) return { status: 'missing', fresh: false, path };
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.status === 'stopped') {
      return { status: 'stopped', fresh: false, age_ms: null, stale_after_ms: staleAfterMs, path, record };
    }
    const heartbeatMs = Date.parse(record.heartbeat_at ?? '');
    const age_ms = Number.isFinite(heartbeatMs) ? Date.now() - heartbeatMs : null;
    const matches = record.carrier_session_id === carrierSessionId;
    const fresh = matches && record.status === 'alive' && age_ms !== null && age_ms <= staleAfterMs;
    return { status: fresh ? 'fresh' : 'stale', fresh, age_ms, stale_after_ms: staleAfterMs, path, record };
  } catch (error) {
    return { status: 'unreadable', fresh: false, path, error: error instanceof Error ? error.message : String(error) };
  }
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function sanitizeId(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'resident_work_fixture';
}

function safeFileToken(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)
    || 'unknown';
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function baseOutcome(row, status, fields) {
  return {
    directive_id: row.directive_id,
    status,
    created_at: row.directive.created_at ?? row.created_at,
    delivery_status: row.delivery_status,
    ...fields,
  };
}

function getDirectiveReceipt(db, directiveId, receiptId) {
  return db.prepare(`
    SELECT receipt_id, directive_id, received_at, carrier_session_id, agent_id, transport
    FROM directive_receipts
    WHERE directive_id = ? AND receipt_id = ?
  `).get(directiveId, receiptId) ?? null;
}

function latestDirectiveTriage(db, directiveId, agentId) {
  const row = db.prepare(`
    SELECT triage_id, directive_id, triaged_at, agent_id, status, reason, selected_work_ref_json
    FROM directive_triage_records
    WHERE directive_id = ? AND agent_id = ?
    ORDER BY triaged_at DESC, rowid DESC
    LIMIT 1
  `).get(directiveId, agentId);
  if (!row) return null;
  return {
    triage_id: String(row.triage_id),
    directive_id: String(row.directive_id),
    triaged_at: String(row.triaged_at),
    agent_id: String(row.agent_id),
    status: String(row.status),
    reason: row.reason ? String(row.reason) : null,
    selected_work_ref: row.selected_work_ref_json ? JSON.parse(String(row.selected_work_ref_json)) : null,
  };
}

function latestDirectiveLinkedTaskReportAfter(db, taskId, afterIso, agentId, directiveId) {
  const rows = db.prepare(`
    SELECT report_id, task_id, agent_id, summary, changed_files_json, verification_json, directive_id, submitted_at
    FROM task_reports
    WHERE task_id = ? AND submitted_at > ? AND agent_id = ?
      AND (directive_id = ? OR summary LIKE ?)
    ORDER BY submitted_at DESC
    LIMIT 20
  `).all(taskId, afterIso, agentId, directiveId, `%directive_id:${directiveId}%`);
  const row = rows.find((candidate) => reportMentionsDirective(candidate, directiveId));
  return row ? { ...row, proof_mode: classifyTaskReportProofMode(row) } : null;
}

function classifyTaskReportProofMode(report) {
  const haystack = [
    report?.summary,
    report?.changed_files_json,
    report?.verification_json,
  ].filter(Boolean).join('\n');
  if (/\b(resident[_ ]autowork|fixture_simulation|proof_driver|Fixture resident completed)\b/i.test(haystack)) {
    return 'proof_driver';
  }
  return 'agent_reasoning';
}

function reportMentionsDirective(report, directiveId) {
  if (report?.directive_id && String(report.directive_id) === String(directiveId)) return true;
  const token = `directive_id:${directiveId}`;
  const haystack = [
    report?.summary,
    report?.changed_files_json,
    report?.verification_json,
  ].filter(Boolean).join('\n');
  return new RegExp(`(^|[^A-Za-z0-9_.:-])${escapeRegExp(token)}([^A-Za-z0-9_.:-]|$)`).test(haystack);
}

function isResidentDirectiveTarget(directive, options: SiteLoopPayload = {}) {
  const target = directive?.target;
  if (!target) return false;
  if (target.kind === 'agent' && target.id === (options.agentId ?? RESIDENT_AGENT_ID)) return true;
  if (target.kind === 'role' && target.id === (options.role ?? RESIDENT_ROLE)) return true;
  return false;
}

function directiveTaskRef(directive) {
  return (directive?.content?.refs ?? []).find((ref) => ref.kind === 'task')?.id
    ?? directive?.content?.data?.task_id
    ?? null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function minutesBetween(fromIso, toIso) {
  const from = Date.parse(fromIso ?? '');
  const to = Date.parse(toIso ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, (to - from) / 60000);
}

function bridgeOutputRefs(result) {
  return [
    ...materializedTaskRefs(result),
    ...residentDirectiveRefs(result),
  ];
}

function materializedTaskRefs(result) {
  return (result?.details?.materialized ?? [])
    .filter((item) => item.taskId || item.taskNumber)
    .map((item) => ({
      kind: 'task',
      ref: item.taskId ?? `task_number:${item.taskNumber}`,
      task_number: item.taskNumber ?? null,
      envelope_id: item.envelopeId ?? null,
    }));
}

function ticketTaskRefs(result) {
  return (result?.results ?? [])
    .filter((entry) => entry?.task?.task_id || entry?.task?.task_number)
    .map((entry) => ({
      kind: 'task',
      ref: entry.task?.task_id ?? `task_number:${entry.task?.task_number}`,
      task_number: entry.task?.task_number ?? null,
      ticket_id: entry.ticket_id ?? null,
      status: entry.status ?? null,
    }));
}

function residentDirectiveRefs(result) {
  return (result?.details?.materialized ?? [])
    .map((item) => item.resident_directive)
    .filter((directive) => directive?.directive_id)
    .map((directive) => ({
      kind: 'directive',
      ref: directive.directive_id,
      is_new: directive.is_new ?? false,
    }));
}

function residentBacklogRecoveryDirectiveRefs(result) {
  return (result?.emitted ?? [])
    .filter((item) => item.directive_id)
    .map((item) => ({
      kind: 'directive',
      ref: item.directive_id,
      is_new: item.is_new ?? false,
      task_id: item.task_id ?? null,
      task_number: item.task_number ?? null,
      recovery_reason: item.reason ?? null,
    }));
}

function directiveIdsFromRun(run) {
  const refs = [];
  for (const step of run?.steps ?? []) {
    for (const ref of step.output_refs ?? []) {
      if (ref.kind === 'directive' && ref.ref) refs.push(String(ref.ref));
      if (ref.kind === 'directive_delivery_attempt' && ref.directive_id) refs.push(String(ref.directive_id));
      if (ref.kind === 'directive_delivery_skipped' && ref.directive_id) refs.push(String(ref.directive_id));
    }
  }
  return [...new Set(refs)];
}

function fixtureDirectiveIds(siteRoot, envelopeId) {
  if (!envelopeId) return [];
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(siteRoot);
  const directiveStore = new SqliteDirectiveRuntimeStore({ db: lifecycleStore.db });
  directiveStore.initSchema();
  try {
    const rows = lifecycleStore.db.prepare(`
      SELECT DISTINCT directive_id
      FROM directive_refs
      WHERE ref_kind = 'source' AND ref_id = ?
      ORDER BY directive_id ASC
    `).all(envelopeId);
    return rows.map((row) => String(row.directive_id));
  } finally {
    lifecycleStore.db.close();
  }
}

function mailboxProofDirectiveIds(siteRoot, run, beforeDirectiveIds: any[] = [], options: SiteLoopPayload = {}) {
  const before = new Set(beforeDirectiveIds.map(String));
  const ids = directiveIdsFromRun(run).filter((id) => !before.has(id));
  if (ids.length === 0) return [];
  const controlledSource = options.controlledSource == null ? null : String(options.controlledSource);
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(siteRoot);
  const directiveStore = new SqliteDirectiveRuntimeStore({ db: lifecycleStore.db });
  directiveStore.initSchema();
  try {
    return ids.filter((id) => {
      const directive = directiveStore.getDirective(id);
      if (!directive || directiveLooksSyntheticFixture(siteRoot, directive)) return false;
      if (!controlledSource) return true;
      return directiveMatchesControlledSource(lifecycleStore.db, directive, controlledSource);
    });
  } finally {
    lifecycleStore.db.close();
  }
}

function directiveMatchesControlledSource(db, directive, controlledSource) {
  const sources = new Set();
  const sourceId = directive?.content?.data?.source_id
    ?? (directive?.content?.refs ?? []).find((ref) => ref.kind === 'source')?.id
    ?? null;
  if (sourceId) sources.add(String(sourceId));
  for (const ref of directive?.content?.refs ?? []) {
    if (ref?.kind === 'source' && ref.id) sources.add(String(ref.id));
  }
  const rows = db.prepare(`
    SELECT ref_id
    FROM directive_refs
    WHERE directive_id = ? AND ref_kind = 'source'
  `).all(directive.directive_id);
  for (const row of rows) sources.add(String(row.ref_id));
  return sources.has(controlledSource);
}

function controlledMailboxSourceStatus(siteRoot, controlledSource, options: SiteLoopPayload = {}) {
  const sourceRef = controlledSource == null ? null : String(controlledSource);
  if (!sourceRef) {
    return {
      schema: 'narada.sonar.controlled_mailbox_source_status.v1',
      status: 'missing',
      source_ref: null,
      matched_directive_count: 0,
      known_envelope_count: 0,
    };
  }
  const matchingEnvelopes = [];
  const inboxDir = join(siteRoot, '.ai', 'inbox-envelopes');
  if (existsSync(inboxDir)) {
    for (const name of readdirSafe(inboxDir).filter((entry) => entry.endsWith('.json'))) {
      const path = join(inboxDir, name);
      const envelope = readJson(path);
      const refs = [
        envelope?.envelope_id,
        envelope?.id,
        envelope?.source?.ref,
        envelope?.source?.id,
        envelope?.payload?.source_id,
        envelope?.payload?.mailbox_ref,
        envelope?.payload?.mail_ref,
      ].filter(Boolean).map(String);
      if (refs.includes(sourceRef) || name.includes(sourceRef.replace(/^mail:/, ''))) {
        matchingEnvelopes.push({
          path,
          envelope_id: envelope?.envelope_id ?? envelope?.id ?? null,
          source_ref: envelope?.source?.ref ?? envelope?.source?.id ?? null,
          title: envelope?.payload?.title ?? envelope?.title ?? null,
        });
      }
    }
  }
  const matchedDirectiveIds = (options.directiveIds ?? []).map(String);
  const runSummary = options.run?.summary ?? {};
  return {
    schema: 'narada.sonar.controlled_mailbox_source_status.v1',
    status: matchedDirectiveIds.length > 0
      ? 'matched_new_directive'
      : matchingEnvelopes.length > 0
        ? 'known_source_no_new_directive'
        : Number(runSummary.duplicates ?? 0) > 0 && Number(runSummary.materialized ?? 0) === 0
          ? 'not_materialized_duplicate_or_filtered'
          : 'not_observed',
    source_ref: sourceRef,
    matched_directive_count: matchedDirectiveIds.length,
    matched_directive_ids: matchedDirectiveIds,
    known_envelope_count: matchingEnvelopes.length,
    matching_envelopes: matchingEnvelopes.slice(0, 5),
  };
}

function directiveLooksSyntheticFixture(siteRoot, directive) {
  const sourceId = directive?.content?.data?.source_id
    ?? (directive?.content?.refs ?? []).find((ref) => ref.kind === 'source')?.id
    ?? null;
  if (!sourceId) return false;
  if (String(sourceId).startsWith('env_codex-') || String(sourceId).startsWith('env_resident-e2e')) return true;
  const inboxDir = join(siteRoot, '.ai', 'inbox-envelopes');
  if (!existsSync(inboxDir)) return false;
  for (const name of readdirSafe(inboxDir).filter((entry) => entry.endsWith('.json') && entry.includes(String(sourceId)))) {
    const envelope = readJson(join(inboxDir, name));
    if (envelope?.source?.kind === 'synthetic_fixture' || envelope?.payload?.fixture === true) return true;
  }
  return false;
}

function allResidentDirectiveIds(siteRoot) {
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(siteRoot);
  const directiveStore = new SqliteDirectiveRuntimeStore({ db: lifecycleStore.db });
  directiveStore.initSchema();
  try {
    const rows = lifecycleStore.db.prepare(`
      SELECT directive_id
      FROM directive_records
      WHERE admission_status = 'admitted'
        AND (
          (target_kind = 'agent' AND target_id = ?)
          OR (target_kind = 'role' AND target_id = ?)
        )
      ORDER BY directive_id ASC
    `).all(RESIDENT_AGENT_ID, RESIDENT_ROLE);
    return rows.map((row) => String(row.directive_id));
  } finally {
    lifecycleStore.db.close();
  }
}

function hasReportedOutcome(outcome) {
  return Number(outcome?.counts?.reported ?? 0) > 0;
}

function dedupeByDirectiveId(directives) {
  const seen = new Set();
  const result = [];
  for (const directive of directives) {
    if (!directive?.directive_id || seen.has(directive.directive_id)) continue;
    seen.add(directive.directive_id);
    result.push(directive);
  }
  return result;
}

function publicDirectiveSummary(directive) {
  return {
    directive_id: directive.directive_id,
    kind: directive.kind,
    source: directive.source ?? null,
    authority: directive.authority ?? null,
    target: directive.target ?? null,
    content_kind: directive.content?.kind ?? null,
    text: directive.content?.text ?? null,
    refs: directive.content?.refs ?? [],
    delivery: directive.delivery ?? { status: 'pending' },
    created_at: directive.created_at ?? null,
  };
}

function dispatchedDirectiveRefs(result) {
  return [
    ...(result?.dispatched ?? []).map((item) => ({
      kind: 'directive_delivery_attempt',
      ref: item.attempt_id ?? item.directive_id,
      directive_id: item.directive_id,
      lease_id: item.lease_id ?? null,
    })),
    ...(result?.skipped ?? []).map((item) => ({
      kind: 'directive_delivery_skipped',
      ref: item.directive_id,
      directive_id: item.directive_id,
      reason: item.reason,
    })),
  ];
}

function receiptRefs(result) {
  return (result?.receipt_reconciliation?.recorded ?? []).map((item) => ({
    kind: 'directive_receipt',
    ref: item.receipt_id,
    directive_id: item.directive_id,
  }));
}

function publicStep(step) {
  const out: SiteLoopPayload = {
    step_id: step.step_id,
    status: step.status,
    started_at: step.started_at,
    finished_at: step.finished_at,
    input_refs: step.input_refs ?? [],
    output_refs: step.output_refs ?? [],
    evidence: step.evidence ?? null,
  };
  if (step.error) out.error = step.error;
  return out;
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `site_loop_run_${stamp}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function errorToPayload(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'Error',
  };
}

function parseJsonOutput(text, fallback) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}
function parseArgs(argv) {
  const parsed: SiteLoopPayload = { cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--source-sync') parsed.sourceSync = true;
    else if (arg === '--ensure-resident') parsed.ensureResident = true;
    else if (arg === '--limit') parsed.limit = Number(argv[++i]);
    else if (arg === '--threshold') parsed.threshold = Number(argv[++i]);
    else if (arg === '--cwd' || arg === '--site-root') parsed.cwd = argv[++i];
    else if (!arg.startsWith('--')) parsed.cwd = arg;
  }
  return parsed;
}
const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isEntrypoint) {
  const args = parseArgs(process.argv.slice(2));
  runSonarEmailResidentLoop(args.cwd, args)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'ok' ? 0 : 1);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
}
