import { schemaName, type SiteLoopConfig } from './site-loop-config.js';
import { DEFAULT_SITE_LOOP_PHASE_PLAN, type SiteLoopPayload, type SiteLoopPhaseAdapter, type SiteLoopPhaseContext, type SiteLoopStep } from './site-loop-kernel.js';

export type SiteLoopPhaseState = SiteLoopPayload & {
  sourceSyncRequested: boolean;
  residentAgentId: string;
  residentRole: string;
  ticketProjectionRef: { kind: string; ref: string };
  operatingPolicy: SiteLoopPayload;
  preBacklogOutcome?: unknown;
  backlogRecovery?: unknown;
  dispatch?: unknown;
  outcome?: unknown;
};

type SiteLoopPhaseDeps = {
  runSourceSync: (siteRoot: string, options: SiteLoopPayload) => Promise<unknown> | unknown;
  emitScheduledSopTriggers: (siteRoot: string, config: SiteLoopConfig, options: SiteLoopPayload) => unknown;
  runInboxBridge: (siteRoot: string, options: SiteLoopPayload) => Promise<unknown> | unknown;
  runTicketTaskReconcile: (siteRoot: string, options: SiteLoopPayload) => Promise<unknown> | unknown;
  runTaskExecutabilityReconciliation: (siteRoot: string, options: SiteLoopPayload) => Promise<unknown> | unknown;
  getResidentStatus: (siteRoot: string) => unknown;
  runAgentOutcomeReconciliation: (siteRoot: string, options: SiteLoopPayload) => unknown;
  reconcileReportedResidentTaskLifecycleState: (siteRoot: string, options: SiteLoopPayload) => Promise<unknown> | unknown;
  emitResidentBacklogRecoveryDirectives: (siteRoot: string, options: SiteLoopPayload) => unknown;
  ensureResidentCarrier: (siteRoot: string, options: SiteLoopPayload) => Promise<unknown> | unknown;
  dispatchPendingDirectives: (options: unknown) => Promise<unknown> | unknown;
  reconcileLoopEscalations: (siteRoot: string, store: unknown, outcome: unknown, options: SiteLoopPayload) => unknown;
  persistOperatingLayerAlerts: (siteRoot: string, store: unknown, options: SiteLoopPayload) => unknown;
  sourceSyncRefs: (result: unknown) => unknown[];
  bridgeOutputRefs: (result: unknown) => unknown[];
  ticketTaskRefs: (result: unknown) => unknown[];
  materializedTaskRefs: (result: unknown) => unknown[];
  residentDirectiveRefs: (result: unknown) => SiteLoopPayload[];
  residentBacklogRecoveryDirectiveRefs: (result: unknown) => unknown[];
  dispatchedDirectiveRefs: (result: unknown) => unknown[];
  receiptRefs: (result: unknown) => unknown[];
  summarizeSourceSync: (result: unknown, siteLoopConfig: SiteLoopConfig) => unknown;
  summarizeBridgeResult: (result: unknown) => unknown;
  summarizeTaskMaterialization: (result: unknown) => unknown;
  summarizeResidentDirectiveEmission: (result: unknown) => unknown;
  summarizeTicketTaskReconciliation: (result: unknown, siteLoopConfig: SiteLoopConfig) => unknown;
  summarizeResidentBacklogRecovery: (result: unknown, siteLoopConfig: SiteLoopConfig) => unknown;
  summarizeDirectiveDispatch: (result: unknown) => SiteLoopPayload;
  summarizeReceiptReconciliation: (result: unknown) => unknown;
  outputRefsForStep: (steps: SiteLoopPayload[], stepId: string) => unknown[];
};

export const SITE_LOOP_ADAPTER_PHASE_PLAN = DEFAULT_SITE_LOOP_PHASE_PLAN;

function record(value: unknown): SiteLoopPayload {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SiteLoopPayload : {};
}

function items(value: unknown): SiteLoopPayload[] {
  return Array.isArray(value) ? value.filter((item: SiteLoopPayload) => item && typeof item === 'object') as SiteLoopPayload[] : [];
}

function bridgeResult(context: SiteLoopPhaseContext<SiteLoopPhaseState>): unknown {
  return context.steps.find((step: SiteLoopStep) => step.step_id === 'inbox_bridge')?.result ?? null;
}

function bridgeDirectiveIds(context: SiteLoopPhaseContext<SiteLoopPhaseState>, deps: SiteLoopPhaseDeps): string[] {
  return deps.residentDirectiveRefs(bridgeResult(context)).map((ref: SiteLoopPayload) => String(ref.ref)).filter(Boolean);
}

function skippedOutcome(context: SiteLoopPhaseContext<SiteLoopPhaseState>, reason: string) {
  return {
    schema: schemaName(context.siteLoopConfig, 'agent_outcome_reconciliation'),
    status: 'skipped',
    reason,
    output_refs: [],
    classifications: [],
    counts: {},
  };
}

function dispatchRunner(context: SiteLoopPhaseContext<SiteLoopPhaseState>, deps: SiteLoopPhaseDeps) {
  return typeof context.options.dispatchRunner === 'function'
    ? context.options.dispatchRunner
    : deps.dispatchPendingDirectives;
}

function testAuthorityMode(context: SiteLoopPhaseContext<SiteLoopPhaseState>): boolean {
  return context.options.testAuthority === true || context.options.test_authority === true;
}

function fixtureResident(context: SiteLoopPhaseContext<SiteLoopPhaseState>): SiteLoopPayload {
  return {
    status: 'fixture',
    authority_mode: 'test',
    agent_id: context.state.residentAgentId,
    carrier: { status: 'fixture', preference: 'fixture' },
  };
}

function fixtureDirectiveDispatch(context: SiteLoopPhaseContext<SiteLoopPhaseState>): SiteLoopPayload {
  return {
    schema: schemaName(context.siteLoopConfig, 'directive_dispatch'),
    status: 'ok',
    authority_mode: 'test',
    dispatched: [],
    skipped: [],
    receipt_reconciliation: { status: 'skipped', reason: 'test_authority_fixture' },
    lease_recovery: { status: 'skipped', reason: 'test_authority_fixture' },
  };
}

export function createSiteLoopPhaseAdapters(deps: SiteLoopPhaseDeps): SiteLoopPhaseAdapter<SiteLoopPhaseState>[] {
  return [
    {
      id: 'source_sync',
      shouldRun: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => context.state.sourceSyncRequested
        && context.siteLoopConfig.commands.source_sync.enabled !== false
        && !context.drain,
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => [{ kind: 'site_root', ref: context.siteRoot }],
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => deps.runSourceSync(context.siteRoot, {
        dryRun: context.dryRun,
        runner: context.options.sourceSyncRunner,
        commandConfig: context.siteLoopConfig.commands.source_sync,
        schema: schemaName(context.siteLoopConfig, 'source_sync'),
        timeoutMs: context.options.sourceSyncTimeoutMs ?? context.options.source_sync_timeout_ms,
      }),
      outputRefs: (result: unknown) => deps.sourceSyncRefs(result),
      evidence: (result: unknown, context: SiteLoopPhaseContext<SiteLoopPhaseState>) => deps.summarizeSourceSync(result, context.siteLoopConfig),
    },
    {
      id: 'scheduled_sop_triggers',
      shouldRun: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => !context.drain && context.siteLoopConfig.scheduled_sops.length > 0,
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => context.siteLoopConfig.scheduled_sops.map((schedule: SiteLoopConfig['scheduled_sops'][number]) => ({ kind: 'sop_schedule', ref: schedule.id })),
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => deps.emitScheduledSopTriggers(context.siteRoot, context.siteLoopConfig, {
        dryRun: context.dryRun,
        now: context.options.now,
      }),
      outputRefs: (result: unknown) => items(record(result).results)
        .filter((item: SiteLoopPayload) => typeof item.envelope_id === 'string')
        .map((item: SiteLoopPayload) => ({ kind: 'inbox_envelope', ref: item.envelope_id })),
      evidence: (result: unknown) => result,
    },
    {
      id: 'inbox_bridge',
      shouldRun: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => !context.drain,
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => [{ kind: 'site_root', ref: context.siteRoot }],
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => deps.runInboxBridge(context.siteRoot, {
        dryRun: context.dryRun,
        limit: context.limit,
        threshold: context.threshold,
      }),
      outputRefs: (result: unknown) => deps.bridgeOutputRefs(result),
      evidence: (result: unknown) => deps.summarizeBridgeResult(result),
    },
    {
      id: 'task_materialization',
      synthetic: true,
      shouldRun: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => context.steps.some((step: SiteLoopStep) => step.step_id === 'inbox_bridge'),
      inputRefs: () => [{ kind: 'step', ref: 'inbox_bridge' }],
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => bridgeResult(context),
      outputRefs: (result: unknown) => deps.materializedTaskRefs(result),
      evidence: (result: unknown) => deps.summarizeTaskMaterialization(result),
    },
    {
      id: 'task_executability_reconciliation',
      shouldRun: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => !context.dryRun && !context.drain,
      skipStep: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => ({
        stepId: 'task_executability_reconciliation',
        status: 'skipped',
        inputRefs: [{ kind: 'task_lifecycle', ref: 'executability_requests' }],
        outputRefs: [],
        evidence: {
          schema: schemaName(context.siteLoopConfig, 'task_executability_reconciliation'),
          status: 'skipped',
          reason: context.dryRun ? 'dry_run' : 'drain',
        },
      }),
      inputRefs: () => [{ kind: 'task_lifecycle', ref: 'executability_requests' }],
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => deps.runTaskExecutabilityReconciliation(context.siteRoot, {
        store: context.store,
        limit: context.limit,
        orchestrator: context.options.taskExecutabilityOrchestrator,
        max_attempts: context.options.taskExecutabilityMaxAttempts,
        max_run_ms: context.options.taskExecutabilityMaxRunMs,
      }),
      outputRefs: (result: unknown) => items(record(result).results).map((item: SiteLoopPayload) => ({
        kind: 'task_executability_request',
        ref: item.request_id,
        outcome: item.outcome,
      })),
      evidence: (result: unknown) => result,
    },
    {
      id: 'resident_directive_emission',
      synthetic: true,
      shouldRun: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => context.steps.some((step: SiteLoopStep) => step.step_id === 'inbox_bridge'),
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => deps.materializedTaskRefs(bridgeResult(context)),
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => bridgeResult(context),
      outputRefs: (result: unknown) => deps.residentDirectiveRefs(result),
      evidence: (result: unknown) => deps.summarizeResidentDirectiveEmission(result),
    },
    {
      id: 'ticket_task_reconciliation',
      shouldRun: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => !context.dryRun
        && !context.drain
        && context.state.sourceSyncRequested
        && context.siteLoopConfig.commands.ticket_task_reconciliation.enabled !== false,
      skipStep: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => {
        const result = {
          schema: schemaName(context.siteLoopConfig, 'ticket_task_reconciliation'),
          status: 'skipped',
          reason: context.dryRun ? 'dry_run' : context.drain ? 'drain' : 'source_sync_not_run',
          created: 0,
          existing: 0,
          planned: 0,
          results: [],
        };
        return {
          stepId: 'ticket_task_reconciliation',
          status: 'skipped',
          inputRefs: [context.state.ticketProjectionRef],
          outputRefs: deps.ticketTaskRefs(result),
          evidence: deps.summarizeTicketTaskReconciliation(result, context.siteLoopConfig),
        };
      },
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => [
        ...deps.outputRefsForStep(context.steps, 'source_sync'),
        context.state.ticketProjectionRef,
      ],
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => deps.runTicketTaskReconcile(context.siteRoot, {
        dryRun: context.dryRun,
        limit: context.limit,
        preferredRole: context.state.residentRole,
        runner: context.options.ticketTaskReconcileRunner,
        commandConfig: context.siteLoopConfig.commands.ticket_task_reconciliation,
        schema: schemaName(context.siteLoopConfig, 'ticket_task_reconciliation'),
        timeoutMs: context.options.ticketTaskReconciliationTimeoutMs ?? context.options.ticket_task_reconciliation_timeout_ms,
      }),
      outputRefs: (result: unknown) => deps.ticketTaskRefs(result),
      evidence: (result: unknown, context: SiteLoopPhaseContext<SiteLoopPhaseState>) => deps.summarizeTicketTaskReconciliation(result, context.siteLoopConfig),
    },
    {
      id: 'pre_backlog_outcome_reconciliation',
      synthetic: true,
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => bridgeDirectiveIds(context, deps).map((ref: string) => ({ kind: 'directive', ref })),
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => {
        const directiveIds = bridgeDirectiveIds(context, deps);
        const resident = context.dryRun
          ? { status: 'skipped', reason: 'dry_run' }
          : testAuthorityMode(context) ? fixtureResident(context) : deps.getResidentStatus(context.siteRoot);
        const outcome = context.dryRun
          ? skippedOutcome(context, 'dry_run')
          : testAuthorityMode(context) ? skippedOutcome(context, 'test_authority_fixture')
          : deps.runAgentOutcomeReconciliation(context.siteRoot, {
              nowIso: context.options.nowIso,
              actionStaleMinutes: context.options.actionStaleMinutes,
              deliveryStaleMinutes: context.options.deliveryStaleMinutes,
              directiveIds,
              includeBacklog: true,
              resident,
            });
        context.state.preBacklogOutcome = outcome;
        return outcome;
      },
      outputRefs: (result: unknown) => items(record(result).output_refs),
      evidence: (result: unknown) => result,
    },
    {
      id: 'reported_resident_task_state_reconciliation',
      synthetic: true,
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => [{ kind: 'resident_backlog', ref: context.state.residentAgentId }],
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => context.dryRun
        ? { schema: schemaName(context.siteLoopConfig, 'reported_resident_task_state_reconciliation'), status: 'skipped', reason: 'dry_run', repaired: [] }
        : deps.reconcileReportedResidentTaskLifecycleState(context.siteRoot, { limit: 100 }),
      outputRefs: (result: unknown) => items(record(result).repaired).map((item: SiteLoopPayload) => ({ kind: 'task', ref: item.task_id })),
      evidence: (result: unknown) => result,
    },
    {
      id: 'resident_backlog_recovery_emission',
      synthetic: true,
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => [{ kind: 'resident_backlog', ref: context.state.residentAgentId }],
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => {
        const rateLimits = record(context.state.operatingPolicy.rate_limits);
        const result = context.dryRun
          ? {
              schema: schemaName(context.siteLoopConfig, 'resident_backlog_recovery'),
              status: 'skipped',
              reason: 'dry_run',
              emitted: [],
              skipped: [],
            }
          : deps.emitResidentBacklogRecoveryDirectives(context.siteRoot, {
              nowIso: context.options.nowIso,
              actionStaleMinutes: context.options.actionStaleMinutes,
              limit: Math.min(context.limit, Number(rateLimits.max_directives_per_cycle ?? context.limit)),
            });
        context.state.backlogRecovery = result;
        return result;
      },
      outputRefs: (result: unknown) => deps.residentBacklogRecoveryDirectiveRefs(result),
      evidence: (result: unknown, context: SiteLoopPhaseContext<SiteLoopPhaseState>) => deps.summarizeResidentBacklogRecovery(result, context.siteLoopConfig),
    },
    {
      id: 'resident_supervisor',
      shouldRun: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => !context.dryRun && context.options.ensureResident === true,
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => [{ kind: 'agent', ref: context.state.residentAgentId }],
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => deps.ensureResidentCarrier(context.siteRoot, {
        runner: context.options.residentSupervisorRunner,
        requireLiveCarrier: context.options.requireLiveCarrier !== false,
      }),
      outputRefs: (result: unknown) => {
        const launch = record(record(result).launch);
        return launch.event_path ? [{ kind: 'agent_start_event', ref: launch.event_path }] : [];
      },
      evidence: (result: unknown) => result,
    },
    {
      id: 'resident_directive_dispatch',
      shouldRun: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => !context.dryRun,
      skipStep: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => {
        const dispatch = {
          schema: schemaName(context.siteLoopConfig, 'directive_dispatch'),
          status: 'skipped',
          dry_run: true,
          reason: 'dry_run',
          dispatched: [],
          skipped: [],
          receipt_reconciliation: { status: 'skipped', reason: 'dry_run' },
          lease_recovery: { status: 'skipped', reason: 'dry_run' },
        };
        context.state.dispatch = dispatch;
        return {
          stepId: 'resident_directive_dispatch',
          status: 'skipped',
          inputRefs: deps.residentDirectiveRefs(bridgeResult(context)),
          outputRefs: [],
          evidence: dispatch,
        };
      },
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => context.drain
        ? []
        : [
            ...deps.residentDirectiveRefs(bridgeResult(context)),
            ...deps.residentBacklogRecoveryDirectiveRefs(context.state.backlogRecovery),
          ],
      execute: async (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => {
        if (testAuthorityMode(context)) {
          const result = fixtureDirectiveDispatch(context);
          context.state.dispatch = result;
          return result;
        }
        const runner = dispatchRunner(context, deps);
        const result = await runner({
          cwd: context.siteRoot,
          agentId: context.state.residentAgentId,
          role: context.state.residentRole,
          limit: context.drain ? 0 : context.limit,
          dryRun: false,
          ...(context.drain ? {} : { requireLiveCarrier: context.options.requireLiveCarrier !== false }),
        });
        context.state.dispatch = result;
        return result;
      },
      outputRefs: (result: unknown, context: SiteLoopPhaseContext<SiteLoopPhaseState>) => context.drain ? [] : deps.dispatchedDirectiveRefs(result),
      evidence: (result: unknown, context: SiteLoopPhaseContext<SiteLoopPhaseState>) => context.drain
        ? { ...deps.summarizeDirectiveDispatch(result), drain: true }
        : deps.summarizeDirectiveDispatch(result),
    },
    {
      id: 'receipt_reconciliation',
      synthetic: true,
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => deps.dispatchedDirectiveRefs(context.state.dispatch),
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => context.state.dispatch ?? null,
      outputRefs: (result: unknown) => deps.receiptRefs(result),
      evidence: (result: unknown) => deps.summarizeReceiptReconciliation(result),
    },
    {
      id: 'agent_outcome_reconciliation',
      synthetic: true,
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => bridgeDirectiveIds(context, deps).map((ref: string) => ({ kind: 'directive', ref })),
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => {
        const directiveIds = bridgeDirectiveIds(context, deps);
        const resident = context.dryRun
          ? { status: 'skipped', reason: 'dry_run' }
          : testAuthorityMode(context) ? fixtureResident(context) : deps.getResidentStatus(context.siteRoot);
        const outcome = context.dryRun
          ? skippedOutcome(context, 'dry_run')
          : testAuthorityMode(context) ? skippedOutcome(context, 'test_authority_fixture')
          : deps.runAgentOutcomeReconciliation(context.siteRoot, {
              nowIso: context.options.nowIso,
              actionStaleMinutes: context.options.actionStaleMinutes,
              deliveryStaleMinutes: context.options.deliveryStaleMinutes,
              directiveIds,
              includeBacklog: true,
              resident,
            });
        context.state.outcome = outcome;
        return outcome;
      },
      outputRefs: (result: unknown) => items(record(result).output_refs),
      evidence: (result: unknown) => result,
    },
    {
      id: 'stale_escalation_reconciliation',
      synthetic: true,
      inputRefs: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => items(record(context.state.outcome).output_refs),
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => context.store && !context.dryRun
        ? deps.reconcileLoopEscalations(context.siteRoot, context.store, context.state.outcome, { runId: context.runId, nowIso: context.options.nowIso })
        : { status: 'skipped', reason: context.dryRun ? 'dry_run' : 'store_unavailable', created: [] },
      outputRefs: (result: unknown) => items(record(result).created).map((item: SiteLoopPayload) => ({
        kind: 'operator_attention_envelope',
        ref: item.envelope_id,
        directive_id: item.directive_id,
      })),
      evidence: (result: unknown) => result,
    },
    {
      id: 'operating_alert_reconciliation',
      synthetic: true,
      inputRefs: () => [],
      execute: (context: SiteLoopPhaseContext<SiteLoopPhaseState>) => testAuthorityMode(context)
        ? { status: 'skipped', reason: 'test_authority_fixture', created: [] }
        : context.store && !context.dryRun
        ? deps.persistOperatingLayerAlerts(context.siteRoot, context.store, {
            runId: context.runId,
            nowIso: context.options.nowIso,
            requireFreshProductionProof: context.options.requireFreshProductionProof === true || context.options.require_fresh_production_proof === true,
          })
        : { status: 'skipped', reason: context.dryRun ? 'dry_run' : 'store_unavailable', created: [] },
      outputRefs: (result: unknown) => items(record(result).created).map((item: SiteLoopPayload) => ({
        kind: 'operator_attention_envelope',
        ref: item.envelope_id,
        classification: item.classification,
      })),
      evidence: (result: unknown) => result,
    },
  ];
}
