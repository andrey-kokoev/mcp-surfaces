import { schemaName, type SiteLoopConfig } from './site-loop-config.js';
import { DEFAULT_SITE_LOOP_PHASE_PLAN, type SiteLoopPayload, type SiteLoopPhaseAdapter } from './site-loop-kernel.js';

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
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') as SiteLoopPayload[] : [];
}

function bridgeResult(context): unknown {
  return context.steps.find((step) => step.step_id === 'inbox_bridge')?.result ?? null;
}

function bridgeDirectiveIds(context, deps: SiteLoopPhaseDeps): string[] {
  return deps.residentDirectiveRefs(bridgeResult(context)).map((ref) => String(ref.ref)).filter(Boolean);
}

function skippedOutcome(context, reason: string) {
  return {
    schema: schemaName(context.siteLoopConfig, 'agent_outcome_reconciliation'),
    status: 'skipped',
    reason,
    output_refs: [],
    classifications: [],
    counts: {},
  };
}

function dispatchRunner(context, deps: SiteLoopPhaseDeps) {
  return typeof context.options.dispatchRunner === 'function'
    ? context.options.dispatchRunner
    : deps.dispatchPendingDirectives;
}

function testAuthorityMode(context): boolean {
  return context.options.testAuthority === true || context.options.test_authority === true;
}

function fixtureResident(context): SiteLoopPayload {
  return {
    status: 'fixture',
    authority_mode: 'test',
    agent_id: context.state.residentAgentId,
    carrier: { status: 'fixture', preference: 'fixture' },
  };
}

function fixtureDirectiveDispatch(context): SiteLoopPayload {
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
      shouldRun: (context) => context.state.sourceSyncRequested && !context.drain,
      inputRefs: (context) => [{ kind: 'site_root', ref: context.siteRoot }],
      execute: (context) => deps.runSourceSync(context.siteRoot, {
        dryRun: context.dryRun,
        runner: context.options.sourceSyncRunner,
        commandConfig: context.siteLoopConfig.commands.source_sync,
        schema: schemaName(context.siteLoopConfig, 'source_sync'),
      }),
      outputRefs: (result) => deps.sourceSyncRefs(result),
      evidence: (result, context) => deps.summarizeSourceSync(result, context.siteLoopConfig),
    },
    {
      id: 'scheduled_sop_triggers',
      shouldRun: (context) => !context.drain && context.siteLoopConfig.scheduled_sops.length > 0,
      inputRefs: (context) => context.siteLoopConfig.scheduled_sops.map((schedule) => ({ kind: 'sop_schedule', ref: schedule.id })),
      execute: (context) => deps.emitScheduledSopTriggers(context.siteRoot, context.siteLoopConfig, {
        dryRun: context.dryRun,
        now: context.options.now,
      }),
      outputRefs: (result) => items(record(result).results)
        .filter((item) => typeof item.envelope_id === 'string')
        .map((item) => ({ kind: 'inbox_envelope', ref: item.envelope_id })),
      evidence: (result) => result,
    },
    {
      id: 'inbox_bridge',
      shouldRun: (context) => !context.drain,
      inputRefs: (context) => [{ kind: 'site_root', ref: context.siteRoot }],
      execute: (context) => deps.runInboxBridge(context.siteRoot, {
        dryRun: context.dryRun,
        limit: context.limit,
        threshold: context.threshold,
      }),
      outputRefs: (result) => deps.bridgeOutputRefs(result),
      evidence: (result) => deps.summarizeBridgeResult(result),
    },
    {
      id: 'task_materialization',
      synthetic: true,
      shouldRun: (context) => context.steps.some((step) => step.step_id === 'inbox_bridge'),
      inputRefs: () => [{ kind: 'step', ref: 'inbox_bridge' }],
      execute: (context) => bridgeResult(context),
      outputRefs: (result) => deps.materializedTaskRefs(result),
      evidence: (result) => deps.summarizeTaskMaterialization(result),
    },
    {
      id: 'resident_directive_emission',
      synthetic: true,
      shouldRun: (context) => context.steps.some((step) => step.step_id === 'inbox_bridge'),
      inputRefs: (context) => deps.materializedTaskRefs(bridgeResult(context)),
      execute: (context) => bridgeResult(context),
      outputRefs: (result) => deps.residentDirectiveRefs(result),
      evidence: (result) => deps.summarizeResidentDirectiveEmission(result),
    },
    {
      id: 'ticket_task_reconciliation',
      shouldRun: (context) => !context.dryRun && !context.drain && context.state.sourceSyncRequested,
      skipStep: (context) => {
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
      inputRefs: (context) => [
        ...deps.outputRefsForStep(context.steps, 'source_sync'),
        context.state.ticketProjectionRef,
      ],
      execute: (context) => deps.runTicketTaskReconcile(context.siteRoot, {
        dryRun: context.dryRun,
        limit: context.limit,
        preferredRole: context.state.residentRole,
        runner: context.options.ticketTaskReconcileRunner,
        commandConfig: context.siteLoopConfig.commands.ticket_task_reconciliation,
        schema: schemaName(context.siteLoopConfig, 'ticket_task_reconciliation'),
      }),
      outputRefs: (result) => deps.ticketTaskRefs(result),
      evidence: (result, context) => deps.summarizeTicketTaskReconciliation(result, context.siteLoopConfig),
    },
    {
      id: 'pre_backlog_outcome_reconciliation',
      synthetic: true,
      inputRefs: (context) => bridgeDirectiveIds(context, deps).map((ref) => ({ kind: 'directive', ref })),
      execute: (context) => {
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
      outputRefs: (result) => items(record(result).output_refs),
      evidence: (result) => result,
    },
    {
      id: 'reported_resident_task_state_reconciliation',
      synthetic: true,
      inputRefs: (context) => [{ kind: 'resident_backlog', ref: context.state.residentAgentId }],
      execute: (context) => context.dryRun
        ? { schema: schemaName(context.siteLoopConfig, 'reported_resident_task_state_reconciliation'), status: 'skipped', reason: 'dry_run', repaired: [] }
        : deps.reconcileReportedResidentTaskLifecycleState(context.siteRoot, { limit: 100 }),
      outputRefs: (result) => items(record(result).repaired).map((item) => ({ kind: 'task', ref: item.task_id })),
      evidence: (result) => result,
    },
    {
      id: 'resident_backlog_recovery_emission',
      synthetic: true,
      inputRefs: (context) => [{ kind: 'resident_backlog', ref: context.state.residentAgentId }],
      execute: (context) => {
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
      outputRefs: (result) => deps.residentBacklogRecoveryDirectiveRefs(result),
      evidence: (result, context) => deps.summarizeResidentBacklogRecovery(result, context.siteLoopConfig),
    },
    {
      id: 'resident_supervisor',
      shouldRun: (context) => !context.dryRun && context.options.ensureResident === true,
      inputRefs: (context) => [{ kind: 'agent', ref: context.state.residentAgentId }],
      execute: (context) => deps.ensureResidentCarrier(context.siteRoot, {
        runner: context.options.residentSupervisorRunner,
        requireLiveCarrier: context.options.requireLiveCarrier !== false,
      }),
      outputRefs: (result) => {
        const launch = record(record(result).launch);
        return launch.event_path ? [{ kind: 'agent_start_event', ref: launch.event_path }] : [];
      },
      evidence: (result) => result,
    },
    {
      id: 'resident_directive_dispatch',
      shouldRun: (context) => !context.dryRun,
      skipStep: (context) => {
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
      inputRefs: (context) => context.drain
        ? []
        : [
            ...deps.residentDirectiveRefs(bridgeResult(context)),
            ...deps.residentBacklogRecoveryDirectiveRefs(context.state.backlogRecovery),
          ],
      execute: async (context) => {
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
      outputRefs: (result, context) => context.drain ? [] : deps.dispatchedDirectiveRefs(result),
      evidence: (result, context) => context.drain
        ? { ...deps.summarizeDirectiveDispatch(result), drain: true }
        : deps.summarizeDirectiveDispatch(result),
    },
    {
      id: 'receipt_reconciliation',
      synthetic: true,
      inputRefs: (context) => deps.dispatchedDirectiveRefs(context.state.dispatch),
      execute: (context) => context.state.dispatch ?? null,
      outputRefs: (result) => deps.receiptRefs(result),
      evidence: (result) => deps.summarizeReceiptReconciliation(result),
    },
    {
      id: 'agent_outcome_reconciliation',
      synthetic: true,
      inputRefs: (context) => bridgeDirectiveIds(context, deps).map((ref) => ({ kind: 'directive', ref })),
      execute: (context) => {
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
      outputRefs: (result) => items(record(result).output_refs),
      evidence: (result) => result,
    },
    {
      id: 'stale_escalation_reconciliation',
      synthetic: true,
      inputRefs: (context) => items(record(context.state.outcome).output_refs),
      execute: (context) => context.store && !context.dryRun
        ? deps.reconcileLoopEscalations(context.siteRoot, context.store, context.state.outcome, { runId: context.runId, nowIso: context.options.nowIso })
        : { status: 'skipped', reason: context.dryRun ? 'dry_run' : 'store_unavailable', created: [] },
      outputRefs: (result) => items(record(result).created).map((item) => ({
        kind: 'operator_attention_envelope',
        ref: item.envelope_id,
        directive_id: item.directive_id,
      })),
      evidence: (result) => result,
    },
    {
      id: 'operating_alert_reconciliation',
      synthetic: true,
      inputRefs: () => [],
      execute: (context) => testAuthorityMode(context)
        ? { status: 'skipped', reason: 'test_authority_fixture', created: [] }
        : context.store && !context.dryRun
        ? deps.persistOperatingLayerAlerts(context.siteRoot, context.store, {
            runId: context.runId,
            nowIso: context.options.nowIso,
            requireFreshProductionProof: context.options.requireFreshProductionProof === true || context.options.require_fresh_production_proof === true,
          })
        : { status: 'skipped', reason: context.dryRun ? 'dry_run' : 'store_unavailable', created: [] },
      outputRefs: (result) => items(record(result).created).map((item) => ({
        kind: 'operator_attention_envelope',
        ref: item.envelope_id,
        classification: item.classification,
      })),
      evidence: (result) => result,
    },
  ];
}
