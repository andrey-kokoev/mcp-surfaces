import type { McpToolDefinition } from '@narada-core/mcp-fabric-contracts';
import {
  inspectSchedulerActivationStore,
  openPreparedSchedulerActivationStore,
  prepareSchedulerActivationStore,
  type SchedulerActivationStatus,
  type SchedulerActivationStore,
  type SchedulerBindingStatus,
  type SchedulerConcurrencyKind,
  type SchedulerTriggerKind,
} from './activation-store.js';

type JsonRecord = Record<string, unknown>;

export interface SchedulerActivationRuntimeState {
  siteRoot: string | null;
  activationStore: SchedulerActivationStore | null;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  };
}

const stringSchema = (description: string): Record<string, unknown> => ({
  type: 'string',
  description,
});
const integerSchema = (description: string): Record<string, unknown> => ({
  type: 'integer',
  description,
});
const implementationId = stringSchema(
  'Current implementation_id returned by scheduler_runtime_status.',
);

const READ_ONLY_ACTIVATION_TOOLS = new Set([
  'scheduler_activation_doctor',
  'scheduler_binding_list',
  'scheduler_binding_show',
  'scheduler_event_show',
  'scheduler_activation_list',
]);

export function isSchedulerActivationTool(name: string): boolean {
  return name.startsWith('scheduler_activation_') || name.startsWith('scheduler_binding_')
    || name.startsWith('scheduler_event_');
}

export function isSchedulerActivationMutation(name: string): boolean {
  return isSchedulerActivationTool(name) && !READ_ONLY_ACTIVATION_TOOLS.has(name);
}

export function listSchedulerActivationTools(): McpToolDefinition[] {
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const write = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  return [
    {
      name: 'scheduler_activation_doctor',
      description: 'Inspect the durable Scheduler binding/event/activation ledger without preparing or repairing it.',
      inputSchema: objectSchema({}),
      annotations: { title: 'scheduler_activation_doctor', ...read },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_activation_prepare',
      description: 'Explicitly prepare the one Site-scoped Scheduler database. Runtime startup never migrates it.',
      inputSchema: objectSchema({ implementation_id: implementationId }, ['implementation_id']),
      annotations: { title: 'scheduler_activation_prepare', ...write },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_binding_list',
      description: 'List durable completion-relative and domain-event activation bindings.',
      inputSchema: objectSchema({
        status: { type: 'string', enum: ['active', 'paused', 'retired'] },
      }),
      annotations: { title: 'scheduler_binding_list', ...read },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_binding_show',
      description: 'Show one durable activation binding and its revision.',
      inputSchema: objectSchema({
        binding_id: stringSchema('Stable binding id.'),
      }, ['binding_id']),
      annotations: { title: 'scheduler_binding_show', ...read },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_binding_upsert',
      description: 'Create or revision-guardedly update a durable activation binding.',
      inputSchema: objectSchema({
        binding_id: stringSchema('Stable binding id.'),
        trigger_kind: {
          type: 'string',
          enum: ['bootstrap', 'completion', 'domain_event'],
        },
        source_topic: stringSchema('Durable source event topic.'),
        source_sop_id: stringSchema('Optional predecessor SOP id filter.'),
        terminal_outcomes: { type: 'array', items: { type: 'string' } },
        target_sop_id: stringSchema('Target SOP template id.'),
        target_template_version: stringSchema('Pinned target template version.'),
        concurrency: { type: 'string', enum: ['singleton', 'partitioned'] },
        delay_by_outcome_ms: {
          type: 'object',
          additionalProperties: { type: 'integer', minimum: 0 },
        },
        default_delay_ms: integerSchema('Default completion/event delay in milliseconds.'),
        retry_base_ms: integerSchema('Retry backoff base in milliseconds.'),
        retry_max_ms: integerSchema('Retry backoff cap in milliseconds.'),
        max_attempts: integerSchema('Maximum dispatch attempts before blocking.'),
        blocked_policy: { type: 'string', enum: ['manual_unblock'] },
        expected_revision: integerSchema('Required only when changing an existing binding.'),
        implementation_id: implementationId,
      }, [
        'binding_id',
        'trigger_kind',
        'source_topic',
        'target_sop_id',
        'target_template_version',
        'concurrency',
        'implementation_id',
      ]),
      annotations: { title: 'scheduler_binding_upsert', ...write },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    ...(['pause', 'resume', 'retire'] as const).map((operation) => ({
      name: `scheduler_binding_${operation}`,
      description: operation === 'pause'
        ? 'Pause one binding, stop future event materialization, and terminally cancel pending or expired-leased activations.'
        : `${operation[0]!.toUpperCase() + operation.slice(1)} one binding without rewriting admitted SOP occurrences.`,
      inputSchema: objectSchema({
        binding_id: stringSchema('Stable binding id.'),
        expected_revision: integerSchema('Current binding revision.'),
        implementation_id: implementationId,
      }, ['binding_id', 'expected_revision', 'implementation_id']),
      annotations: { title: `scheduler_binding_${operation}`, ...write },
      outputSchema: { type: 'object', additionalProperties: true },
    })) as McpToolDefinition[],
    {
      name: 'scheduler_event_show',
      description: 'Show one immutable durable source event used to create Scheduler activations.',
      inputSchema: objectSchema({
        event_id: stringSchema('Stable source event id.'),
      }, ['event_id']),
      annotations: { title: 'scheduler_event_show', ...read },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_event_admit',
      description: 'Idempotently consume one durable completion or domain event and materialize matching activations.',
      inputSchema: objectSchema({
        event_id: stringSchema('Stable source event id.'),
        topic: stringSchema('Durable event topic.'),
        partition_key: stringSchema('Stable concurrency partition key.'),
        aggregate_id: stringSchema('Source aggregate id.'),
        aggregate_revision: integerSchema('Source aggregate revision.'),
        schema_version: integerSchema('Source event schema version.'),
        causation_id: stringSchema('Upstream causation id.'),
        idempotency_key: stringSchema('Upstream idempotency key.'),
        payload: { type: 'object', additionalProperties: true },
        occurred_at: stringSchema('Source event occurrence timestamp.'),
        implementation_id: implementationId,
      }, [
        'event_id',
        'topic',
        'partition_key',
        'aggregate_id',
        'aggregate_revision',
        'schema_version',
        'causation_id',
        'idempotency_key',
        'payload',
        'occurred_at',
        'implementation_id',
      ]),
      annotations: { title: 'scheduler_event_admit', ...write },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_activation_list',
      description: 'List durable activations and their due/lease/SOP receipt state.',
      inputSchema: objectSchema({
        status: {
          type: 'string',
          enum: ['pending', 'leased', 'admitted', 'terminal', 'blocked'],
        },
        binding_id: stringSchema('Optional binding id.'),
        source_event_id: stringSchema('Optional source event id.'),
        sop_run_id: stringSchema('Optional admitted SOP run id.'),
        limit: integerSchema('Maximum rows, default 100 and maximum 500.'),
      }),
      annotations: { title: 'scheduler_activation_list', ...read },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_activation_claim',
      description: 'Lease one due activation while enforcing singleton or partitioned concurrency.',
      inputSchema: objectSchema({
        consumer_id: stringSchema('Stable activation dispatcher identity.'),
        lease_ms: integerSchema('Lease duration from 1000 to 300000 ms.'),
        implementation_id: implementationId,
      }, ['consumer_id', 'implementation_id']),
      annotations: { title: 'scheduler_activation_claim', ...write },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_activation_admit_sop',
      description: 'Record the idempotent SOP occurrence admission receipt and retain the concurrency partition until terminal.',
      inputSchema: objectSchema({
        activation_id: stringSchema('Claimed activation id.'),
        consumer_id: stringSchema('Lease owner.'),
        lease_token: stringSchema('Opaque active lease token returned by scheduler_activation_claim.'),
        sop_run_id: stringSchema('Canonical admitted SOP run id.'),
        receipt_id: stringSchema('Stable SOP admission receipt id.'),
        receipt: { type: 'object', additionalProperties: true },
        implementation_id: implementationId,
      }, [
        'activation_id',
        'consumer_id',
        'lease_token',
        'sop_run_id',
        'receipt_id',
        'receipt',
        'implementation_id',
      ]),
      annotations: { title: 'scheduler_activation_admit_sop', ...write },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_activation_fail',
      description: 'Fail a leased dispatch attempt with bounded backoff or terminally block it.',
      inputSchema: objectSchema({
        activation_id: stringSchema('Claimed activation id.'),
        consumer_id: stringSchema('Lease owner.'),
        lease_token: stringSchema('Opaque active lease token returned by scheduler_activation_claim.'),
        retryable: { type: 'boolean' },
        error: stringSchema('Bounded failure code/summary.'),
        implementation_id: implementationId,
      }, ['activation_id', 'consumer_id', 'lease_token', 'retryable', 'error', 'implementation_id']),
      annotations: { title: 'scheduler_activation_fail', ...write },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_activation_resolve',
      description: 'Record a verified terminal SOP receipt and release the binding partition.',
      inputSchema: objectSchema({
        activation_id: stringSchema('Activation id; use this or sop_run_id.'),
        sop_run_id: stringSchema('Canonical SOP run id; use this or activation_id.'),
        outcome: stringSchema('Typed terminal SOP outcome.'),
        receipt_id: stringSchema('Stable terminal receipt id.'),
        receipt: { type: 'object', additionalProperties: true },
        implementation_id: implementationId,
      }, ['outcome', 'receipt_id', 'receipt', 'implementation_id']),
      annotations: { title: 'scheduler_activation_resolve', ...write },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'scheduler_activation_unblock',
      description: 'Explicitly unblock one activation and make it due now or at a declared timestamp.',
      inputSchema: objectSchema({
        activation_id: stringSchema('Blocked activation id.'),
        due_at: stringSchema('Optional new due timestamp.'),
        implementation_id: implementationId,
      }, ['activation_id', 'implementation_id']),
      annotations: { title: 'scheduler_activation_unblock', ...write },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

export function closeSchedulerActivationRuntime(state: SchedulerActivationRuntimeState): void {
  state.activationStore?.close();
  state.activationStore = null;
}

export function callSchedulerActivationTool(
  name: string,
  args: JsonRecord,
  state: SchedulerActivationRuntimeState,
): JsonRecord {
  const siteRoot = state.siteRoot;
  if (!siteRoot) throw new Error('scheduler_site_root_required');
  if (name === 'scheduler_activation_doctor') {
    return {
      schema: 'narada.scheduler.activation_doctor.v1',
      site_root: siteRoot,
      preparation: inspectSchedulerActivationStore(siteRoot),
      runtime_open: Boolean(state.activationStore),
    };
  }
  if (name === 'scheduler_activation_prepare') {
    closeSchedulerActivationRuntime(state);
    const result = prepareSchedulerActivationStore(siteRoot);
    state.activationStore = openPreparedSchedulerActivationStore(siteRoot);
    return { schema: 'narada.scheduler.activation_prepare.v1', ...result };
  }
  const store = state.activationStore ??= openPreparedSchedulerActivationStore(siteRoot);
  switch (name) {
    case 'scheduler_binding_list': {
      const status = optionalString(args.status) as SchedulerBindingStatus | undefined;
      const bindings = store.listBindings(status);
      return {
        schema: 'narada.scheduler.binding_list.v1',
        count: bindings.length,
        bindings,
      };
    }
    case 'scheduler_binding_show':
      return {
        schema: 'narada.scheduler.binding.v1',
        binding: store.requireBinding(requiredString(args.binding_id, 'binding_id_required')),
      };
    case 'scheduler_binding_upsert':
      return {
        schema: 'narada.scheduler.binding.v1',
        binding: store.upsertBinding({
          binding_id: requiredString(args.binding_id, 'binding_id_required'),
          trigger_kind: requiredString(args.trigger_kind, 'trigger_kind_required') as SchedulerTriggerKind,
          source_topic: requiredString(args.source_topic, 'source_topic_required'),
          source_sop_id: optionalString(args.source_sop_id),
          terminal_outcomes: stringArray(args.terminal_outcomes),
          target_sop_id: requiredString(args.target_sop_id, 'target_sop_id_required'),
          target_template_version: requiredString(
            args.target_template_version,
            'target_template_version_required',
          ),
          concurrency: requiredString(args.concurrency, 'concurrency_required') as SchedulerConcurrencyKind,
          delay_by_outcome_ms: numberRecord(args.delay_by_outcome_ms),
          default_delay_ms: optionalInteger(args.default_delay_ms),
          retry_base_ms: optionalInteger(args.retry_base_ms),
          retry_max_ms: optionalInteger(args.retry_max_ms),
          max_attempts: optionalInteger(args.max_attempts),
          blocked_policy: 'manual_unblock',
          expected_revision: optionalInteger(args.expected_revision),
        }),
      };
    case 'scheduler_binding_pause':
    case 'scheduler_binding_resume':
    case 'scheduler_binding_retire': {
      const status = name.endsWith('_pause')
        ? 'paused'
        : name.endsWith('_resume') ? 'active' : 'retired';
      return {
        schema: 'narada.scheduler.binding.v1',
        binding: store.setBindingStatus(
          requiredString(args.binding_id, 'binding_id_required'),
          status,
          requiredInteger(args.expected_revision, 'expected_revision_required'),
        ),
      };
    }
    case 'scheduler_event_show':
      return {
        schema: 'narada.scheduler.source_event.v1',
        event: store.requireSourceEvent(requiredString(args.event_id, 'event_id_required')),
      };
    case 'scheduler_event_admit':
      return {
        schema: 'narada.scheduler.event_admission.v1',
        ...store.admitEvent({
          event_id: requiredString(args.event_id, 'event_id_required'),
          topic: requiredString(args.topic, 'topic_required'),
          partition_key: requiredString(args.partition_key, 'partition_key_required'),
          aggregate_id: requiredString(args.aggregate_id, 'aggregate_id_required'),
          aggregate_revision: requiredInteger(
            args.aggregate_revision,
            'aggregate_revision_required',
          ),
          schema_version: requiredInteger(args.schema_version, 'schema_version_required'),
          causation_id: requiredString(args.causation_id, 'causation_id_required'),
          idempotency_key: requiredString(args.idempotency_key, 'idempotency_key_required'),
          payload: asRecord(args.payload),
          occurred_at: requiredString(args.occurred_at, 'occurred_at_required'),
        }),
      };
    case 'scheduler_activation_list': {
      const activations = store.listActivations({
        status: optionalString(args.status) as SchedulerActivationStatus | undefined,
        bindingId: optionalString(args.binding_id),
        sourceEventId: optionalString(args.source_event_id),
        sopRunId: optionalString(args.sop_run_id),
        limit: optionalInteger(args.limit),
      });
      return {
        schema: 'narada.scheduler.activation_list.v1',
        count: activations.length,
        activations,
      };
    }
    case 'scheduler_activation_claim':
      return {
        schema: 'narada.scheduler.activation_claim.v1',
        activation: store.claimDue(
          requiredString(args.consumer_id, 'consumer_id_required'),
          optionalInteger(args.lease_ms),
        ) ?? null,
      };
    case 'scheduler_activation_admit_sop':
      return {
        schema: 'narada.scheduler.activation.v1',
        activation: store.markAdmitted({
          activationId: requiredString(args.activation_id, 'activation_id_required'),
          consumerId: requiredString(args.consumer_id, 'consumer_id_required'),
          leaseToken: requiredString(args.lease_token, 'lease_token_required'),
          sopRunId: requiredString(args.sop_run_id, 'sop_run_id_required'),
          receiptId: requiredString(args.receipt_id, 'receipt_id_required'),
          receipt: asRecord(args.receipt),
        }),
      };
    case 'scheduler_activation_fail':
      return {
        schema: 'narada.scheduler.activation.v1',
        activation: store.failClaim({
          activationId: requiredString(args.activation_id, 'activation_id_required'),
          consumerId: requiredString(args.consumer_id, 'consumer_id_required'),
          leaseToken: requiredString(args.lease_token, 'lease_token_required'),
          retryable: args.retryable === true,
          error: requiredString(args.error, 'error_required'),
        }),
      };
    case 'scheduler_activation_resolve':
      return {
        schema: 'narada.scheduler.activation.v1',
        activation: store.resolveActivation({
          activationId: optionalString(args.activation_id),
          sopRunId: optionalString(args.sop_run_id),
          outcome: requiredString(args.outcome, 'outcome_required'),
          receiptId: requiredString(args.receipt_id, 'receipt_id_required'),
          receipt: asRecord(args.receipt),
        }),
      };
    case 'scheduler_activation_unblock':
      return {
        schema: 'narada.scheduler.activation.v1',
        activation: store.unblockActivation(
          requiredString(args.activation_id, 'activation_id_required'),
          optionalString(args.due_at),
        ),
      };
    default:
      throw new Error(`unknown_scheduler_activation_tool:${name}`);
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredInteger(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(code);
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
      .map((entry) => entry.trim())
    : [];
}

function numberRecord(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, nested] of Object.entries(asRecord(value))) {
    if (typeof nested !== 'number' || !Number.isInteger(nested)) {
      throw new Error('delay_by_outcome_ms_invalid');
    }
    result[key] = nested;
  }
  return result;
}
