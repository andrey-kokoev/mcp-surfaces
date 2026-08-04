#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { McpToolDefinition } from '@narada-core/mcp-fabric-contracts';
import {
  configureTaskLifecycleMcpRuntime,
  handleTaskLifecycleMcpRequest,
  taskLifecycleTools,
} from '@narada-core/task-lifecycle-mcp/task-lifecycle-mcp-server';
import { runJsonRpcStdioServer } from '@narada-core/task-lifecycle-mcp/stdio-json-rpc';
import {
  inspectPreparedWorkLifecycleStore,
  openPreparedWorkLifecycleStore,
  prepareWorkLifecycleStore,
  type TicketStatus,
  type WorkLifecycleStore,
} from '@narada-core/work-lifecycle-core';

const SERVER_NAME = 'work-lifecycle-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

type JsonRecord = Record<string, unknown>;

export interface WorkLifecycleRuntime {
  siteRoot: string;
  store: WorkLifecycleStore;
  ownsStore: boolean;
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
const numberSchema = (description: string): Record<string, unknown> => ({
  type: 'integer',
  description,
});

const TICKET_TOOLS: McpToolDefinition[] = [
  {
    name: 'work_lifecycle_doctor',
    description: 'Inspect the prepared unified Work Lifecycle database without mutating or repairing it.',
    inputSchema: objectSchema({}),
    annotations: {
      title: 'work_lifecycle_doctor',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'ticket_list',
    description: 'List canonical first-class ticket aggregates from Work Lifecycle.',
    inputSchema: objectSchema({
      status: stringSchema('Optional ticket lifecycle status.'),
      limit: numberSchema('Maximum rows, default 100 and maximum 500.'),
      offset: numberSchema('Pagination offset.'),
    }),
    annotations: {
      title: 'ticket_list',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'ticket_show',
    description: 'Show one canonical ticket aggregate and its bounded task, draft, and source references.',
    inputSchema: objectSchema({
      ticket_id: stringSchema('Canonical ticket id.'),
      ticket_number: numberSchema('Canonical ticket number; use either id or number.'),
    }),
    annotations: {
      title: 'ticket_show',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'ticket_sources_list',
    description: 'List bounded immutable source references admitted to one ticket.',
    inputSchema: objectSchema({
      ticket_id: stringSchema('Canonical ticket id.'),
    }, ['ticket_id']),
    annotations: {
      title: 'ticket_sources_list',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'ticket_processing_context_load',
    description: 'Freeze one bounded, revision-pinned ticket-processing context for a durable work-due event and return a typed SOP domain-operation receipt.',
    inputSchema: objectSchema({
      ticket_id: stringSchema('Canonical ticket id.'),
      triggering_event_id: stringSchema('Work Lifecycle ticket-work-due event that admitted this processing occurrence.'),
      idempotency_key: stringSchema('Stable SOP action occurrence key; exact retries return the same frozen context.'),
    }, ['ticket_id', 'triggering_event_id', 'idempotency_key']),
    annotations: {
      title: 'ticket_processing_context_load',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'ticket_admit_source',
    description: 'Mechanically create/find one canonical ticket and associate one immutable source in a single transaction. Ambiguous trusted correlation blocks.',
    inputSchema: objectSchema({
      source_kind: stringSchema('Typed source kind, for example mailbox_message.'),
      source_scope: stringSchema('Stable source authority scope, for example mailbox identity.'),
      immutable_source_id: stringSchema('Immutable source identity within the scope.'),
      idempotency_key: stringSchema('Stable admission operation key.'),
      causation_id: stringSchema('Upstream event or SOP action id.'),
      policy_version: stringSchema('Version of the mechanical admission/correlation policy.'),
      summary: stringSchema('Bounded lifecycle summary; message bodies are refused.'),
      source_ref: {
        type: 'object',
        additionalProperties: true,
        description: 'Bounded immutable refs and hashes only; no message body or copied evidence.',
      },
      correlation_keys: {
        type: 'array',
        items: objectSchema({
          kind: stringSchema('Trusted identifier kind.'),
          scope: stringSchema('Identifier authority scope.'),
          value: stringSchema('Stable identifier value.'),
        }, ['kind', 'scope', 'value']),
      },
    }, [
      'source_kind',
      'source_scope',
      'immutable_source_id',
      'idempotency_key',
      'causation_id',
      'policy_version',
      'summary',
      'source_ref',
      'correlation_keys',
    ]),
    annotations: {
      title: 'ticket_admit_source',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'ticket_admit_proposal',
    description: 'Mechanically admit a revision-bound agent proposal for one draft, task, resolution, or operator blocker route.',
    inputSchema: objectSchema({
      ticket_id: stringSchema('Canonical ticket id.'),
      expected_revision: numberSchema('Ticket revision loaded by the proposing agent.'),
      route: {
        type: 'string',
        enum: ['response_draft', 'followup_task', 'resolved', 'blocked_operator'],
      },
      idempotency_key: stringSchema('Stable proposal operation key.'),
      causation_id: stringSchema('SOP run/action or triggering event id.'),
      actor_id: stringSchema('Agent or operator identity contributing the proposal.'),
      summary: stringSchema('Bounded proposal summary.'),
      task: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: stringSchema('Follow-up task title.'),
          goal: stringSchema('Follow-up task goal.'),
          context: stringSchema('Optional bounded task context.'),
          required_work: stringSchema('Required work.'),
          non_goals: stringSchema('Optional non-goals.'),
          acceptance_criteria: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'goal', 'required_work', 'acceptance_criteria'],
      },
      draft: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source_id: stringSchema('Mailbox ticket source selected from the frozen processing context.'),
          reply_mode: { type: 'string', enum: ['reply', 'reply_all'] },
          body_text: stringSchema('Plain-text unsent response body.'),
          body_html: stringSchema('HTML unsent response body.'),
        },
        required: ['source_id', 'reply_mode'],
      },
      resolution_code: stringSchema('Typed terminal resolution code.'),
      blocker_code: stringSchema('Typed operator blocker code.'),
    }, [
      'ticket_id',
      'expected_revision',
      'route',
      'idempotency_key',
      'causation_id',
      'actor_id',
      'summary',
    ]),
    annotations: {
      title: 'ticket_admit_proposal',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'ticket_draft_receipt_record',
    description: 'Record a verified Graph Mail draft receipt under its prior revision-bound effect claim.',
    inputSchema: objectSchema({
      ticket_id: stringSchema('Canonical ticket id.'),
      effect_claim_id: stringSchema('Effect claim returned by ticket_admit_proposal.'),
      draft_operation_key: stringSchema('Stable Graph Mail operation key.'),
      draft_request_digest: stringSchema('SHA-256 digest of the exact Work Lifecycle-admitted draft request.'),
      receipt_id: stringSchema('Verified Graph Mail operation receipt id.'),
      draft_id: stringSchema('Stable draft identity.'),
      draft_ref: {
        type: 'object',
        additionalProperties: true,
        description: 'Bounded draft refs and hashes only; draft bodies are refused.',
      },
      idempotency_key: stringSchema('Stable SOP action occurrence key for recording this receipt.'),
      causation_id: stringSchema('Graph receipt or SOP action id.'),
    }, [
      'ticket_id',
      'effect_claim_id',
      'draft_operation_key',
      'draft_request_digest',
      'receipt_id',
      'draft_id',
      'draft_ref',
      'idempotency_key',
      'causation_id',
    ]),
    annotations: {
      title: 'ticket_draft_receipt_record',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'ticket_draft_disposition_reconcile',
    description: 'Reconcile a digest-verified, operation-linked Graph disposition observation and reactivate the ticket exactly once.',
    inputSchema: objectSchema({
      ticket_id: stringSchema('Canonical ticket id.'),
      draft_id: stringSchema('Stable draft identity.'),
      evidence: {
        type: 'object',
        additionalProperties: true,
        description: 'Complete narada.graph_mail.ticket_draft_disposition_receipt.v1 emitted and persisted by Graph Mail.',
      },
      idempotency_key: stringSchema('Stable disposition event operation key.'),
      causation_id: stringSchema('Graph event or synchronization event id.'),
    }, [
      'ticket_id',
      'draft_id',
      'evidence',
      'idempotency_key',
      'causation_id',
    ]),
    annotations: {
      title: 'ticket_draft_disposition_reconcile',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'work_outbox_list',
    description: 'List unacknowledged Work Lifecycle outbox events for one durable consumer.',
    inputSchema: objectSchema({
      consumer_id: stringSchema('Stable durable consumer identity.'),
      topics: { type: 'array', items: { type: 'string' } },
      limit: numberSchema('Maximum events, default 100 and maximum 500.'),
    }, ['consumer_id']),
    annotations: {
      title: 'work_outbox_list',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'work_outbox_consumer_register',
    description: 'Register a required durable consumer for one outbox topic before delivery and compaction.',
    inputSchema: objectSchema({
      topic: stringSchema('Outbox topic.'),
      consumer_id: stringSchema('Stable durable consumer identity.'),
    }, ['topic', 'consumer_id']),
    annotations: {
      title: 'work_outbox_consumer_register',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'work_outbox_ack',
    description: 'Durably acknowledge one outbox event with a bounded consumer receipt.',
    inputSchema: objectSchema({
      event_id: stringSchema('Stable Work Lifecycle event id.'),
      consumer_id: stringSchema('Stable durable consumer identity.'),
      receipt: { type: 'object', additionalProperties: true },
    }, ['event_id', 'consumer_id', 'receipt']),
    annotations: {
      title: 'work_outbox_ack',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'work_outbox_compact',
    description: 'Compact acknowledged outbox payloads older than a cutoff while preserving replay tombstones and event identities.',
    inputSchema: objectSchema({
      before: stringSchema('Exclusive ISO timestamp cutoff.'),
    }, ['before']),
    annotations: {
      title: 'work_outbox_compact',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'work_lifecycle_storage_inspect',
    description: 'Verify bounded Work Lifecycle storage and report any oversized lifecycle payload.',
    inputSchema: objectSchema({}),
    annotations: {
      title: 'work_lifecycle_storage_inspect',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
];

const OMITTED_TASK_TOOLS = new Set([
  'task_lifecycle_doctor',
  'task_lifecycle_restart',
  'task_lifecycle_compatibility_reconcile',
]);

function augmentTaskTool(definition: McpToolDefinition): McpToolDefinition {
  if (definition.annotations?.readOnlyHint) return definition;
  const inputSchema = definition.inputSchema as JsonRecord;
  const properties = asRecord(inputSchema.properties);
  const revisionFields: Record<string, unknown> = {};
  const required = new Set(Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((value): value is string => typeof value === 'string')
    : []);
  if ('task_number' in properties) {
    revisionFields.expected_revision = numberSchema(
      'Current task aggregate revision; stale state-dependent mutations are refused.',
    );
    required.add('expected_revision');
  }
  if ('parent_task_number' in properties) {
    revisionFields.expected_parent_revision = numberSchema(
      'Current parent task aggregate revision.',
    );
    required.add('expected_parent_revision');
  }
  if ('required_task_number' in properties) {
    revisionFields.expected_required_revision = numberSchema(
      'Current required task aggregate revision.',
    );
    required.add('expected_required_revision');
  }
  if (Object.keys(revisionFields).length === 0) return definition;
  return {
    ...definition,
    description: `${definition.description} Work Lifecycle requires the declared current task revision for state-dependent mutation.`,
    inputSchema: {
      ...inputSchema,
      properties: { ...properties, ...revisionFields },
      required: [...required],
    },
  };
}

const TASK_TOOLS = (taskLifecycleTools() as McpToolDefinition[])
  .filter((tool) => !OMITTED_TASK_TOOLS.has(tool.name))
  .map(augmentTaskTool);
const TASK_TOOL_BY_NAME = new Map(TASK_TOOLS.map((tool) => [tool.name, tool]));

export function listTools(): McpToolDefinition[] {
  return [...TICKET_TOOLS, ...TASK_TOOLS];
}

export function createWorkLifecycleRuntime(options: {
  siteRoot: string;
  store?: WorkLifecycleStore;
  env?: NodeJS.ProcessEnv;
  stderr?: NodeJS.WritableStream;
}): WorkLifecycleRuntime {
  const ownsStore = options.store === undefined;
  const store = options.store ?? openPreparedWorkLifecycleStore(options.siteRoot);
  try {
    configureTaskLifecycleMcpRuntime({
      argv: ['--site-root', options.siteRoot],
      cwd: options.siteRoot,
      env: options.env ?? process.env,
      stderr: options.stderr ?? process.stderr,
      storeOverride: store.taskStore,
    });
    return { siteRoot: options.siteRoot, store, ownsStore };
  } catch (error) {
    if (ownsStore) store.close();
    throw error;
  }
}

export async function handleWorkLifecycleMcpRequest(
  request: JsonRecord,
  runtime: WorkLifecycleRuntime,
): Promise<JsonRecord | null> {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) {
    return null;
  }
  try {
    const result = await dispatchMethod(
      String(request.method),
      asRecord(request.params),
      runtime,
    );
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: {
        code: -32000,
        message,
        data: {
          schema: 'narada.work_lifecycle.error.v1',
          code: message.split(':', 1)[0],
          site_root: runtime.siteRoot,
        },
      },
    };
  }
}

async function dispatchMethod(
  method: string,
  params: JsonRecord,
  runtime: WorkLifecycleRuntime,
): Promise<unknown> {
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  }
  if (method === 'tools/list') return { tools: listTools() };
  if (method !== 'tools/call') throw new Error(`unsupported_mcp_method:${method}`);
  const name = requiredString(params.name, 'tool_name_required');
  const args = asRecord(params.arguments);
  if (TASK_TOOL_BY_NAME.has(name)) return callTaskTool(name, args, runtime);
  return callTicketTool(name, args, runtime);
}

async function callTaskTool(
  name: string,
  args: JsonRecord,
  runtime: WorkLifecycleRuntime,
): Promise<unknown> {
  const definition = TASK_TOOL_BY_NAME.get(name);
  if (!definition) throw new Error(`unknown_tool:${name}`);
  const delegatedArgs = { ...args };
  if (!definition.annotations?.readOnlyHint) {
    assertTaskRevision(runtime.store, args, 'task_number', 'expected_revision');
    assertTaskRevision(runtime.store, args, 'parent_task_number', 'expected_parent_revision');
    assertTaskRevision(runtime.store, args, 'required_task_number', 'expected_required_revision');
    delete delegatedArgs.expected_revision;
    delete delegatedArgs.expected_parent_revision;
    delete delegatedArgs.expected_required_revision;
  }
  const response = await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id: `work-task-${randomUUID()}`,
    method: 'tools/call',
    params: { name, arguments: delegatedArgs },
  }) as JsonRecord;
  if (response.error) {
    const error = asRecord(response.error);
    throw new Error(String(error.message ?? 'task_lifecycle_error'));
  }
  return response.result;
}

function assertTaskRevision(
  store: WorkLifecycleStore,
  args: JsonRecord,
  numberField: string,
  revisionField: string,
): void {
  if (!(numberField in args)) return;
  const taskNumber = requiredInteger(args[numberField], `${numberField}_required`);
  const expected = requiredInteger(args[revisionField], `${revisionField}_required`);
  const lifecycle = store.taskStore.getLifecycleByNumber(taskNumber);
  if (!lifecycle) throw new Error(`task_not_found:${taskNumber}`);
  const actual = lifecycle.revision;
  if (!Number.isInteger(actual)) throw new Error('task_revision_unavailable');
  if (actual !== expected) {
    throw new Error(`task_revision_conflict:expected_${expected}:actual_${actual}`);
  }
}

function callTicketTool(
  name: string,
  args: JsonRecord,
  runtime: WorkLifecycleRuntime,
): unknown {
  const store = runtime.store;
  switch (name) {
    case 'work_lifecycle_doctor':
      const preparation = inspectPreparedWorkLifecycleStore(runtime.siteRoot, {
        databasePath: store.databasePath,
      });
      return toolResult({
        schema: 'narada.work_lifecycle.doctor.v1',
        status: preparation.status === 'prepared' ? 'ok' : 'not_ready',
        site_root: runtime.siteRoot,
        preparation,
        concurrency: {
          database_path: store.databasePath,
          posture: 'sqlite_wal_transactional_multi_process',
          conflict_guards: ['sqlite_write_serialization', 'idempotency_keys', 'revision_checks'],
        },
      });
    case 'ticket_list': {
      const status = optionalString(args.status) as TicketStatus | undefined;
      const allowed = new Set([
        'actionable',
        'effect_claimed',
        'waiting_on_draft',
        'waiting_on_task',
        'blocked',
        'resolved',
      ]);
      if (status && !allowed.has(status)) throw new Error('ticket_status_invalid');
      const tickets = store.listTickets({
        status,
        limit: optionalInteger(args.limit),
        offset: optionalInteger(args.offset),
      });
      return toolResult({
        schema: 'narada.work_lifecycle.ticket_list.v1',
        count: tickets.length,
        tickets,
      });
    }
    case 'ticket_show': {
      const ticketId = optionalString(args.ticket_id);
      const ticketNumber = optionalInteger(args.ticket_number);
      if (!ticketId && ticketNumber === undefined) throw new Error('ticket_identity_required');
      const ticket = ticketId
        ? store.getTicket(ticketId)
        : store.getTicketByNumber(ticketNumber!);
      if (!ticket) throw new Error('ticket_not_found');
      const taskLinks = store.db.prepare(`
        select link.*, task.task_number, task.status as task_status, task.revision as task_revision
          from ticket_task_links link
          join task_lifecycle task on task.task_id = link.task_id
         where link.ticket_id = ?
         order by link.linked_at, link.task_id
      `).all(ticket.ticket_id);
      const draftRefs = store.db.prepare(`
        select ticket_id, draft_id, effect_claim_id, receipt_id, disposition,
               disposition_evidence_kind, disposition_evidence_id, created_at, disposed_at
          from ticket_draft_refs where ticket_id = ?
         order by created_at, draft_id
      `).all(ticket.ticket_id);
      return toolResult({
        schema: 'narada.work_lifecycle.ticket.v1',
        ticket,
        sources: store.listTicketSources(ticket.ticket_id),
        task_links: taskLinks,
        draft_refs: draftRefs,
      });
    }
    case 'ticket_sources_list': {
      const ticketId = requiredString(args.ticket_id, 'ticket_id_required');
      return toolResult({
        schema: 'narada.work_lifecycle.ticket_sources.v1',
        ticket_id: ticketId,
        sources: store.listTicketSources(ticketId),
      });
    }
    case 'ticket_processing_context_load': {
      const idempotencyKey = requiredString(args.idempotency_key, 'idempotency_key_required');
      return toolResult(domainOperation(
        idempotencyKey,
        store.loadTicketProcessingContext({
          ticket_id: requiredString(args.ticket_id, 'ticket_id_required'),
          triggering_event_id: requiredString(args.triggering_event_id, 'triggering_event_id_required'),
          idempotency_key: idempotencyKey,
        }),
      ));
    }
    case 'ticket_admit_source': {
      const idempotencyKey = requiredString(args.idempotency_key, 'idempotency_key_required');
      return toolResult(domainOperation(idempotencyKey, store.admitSource({
        source_kind: requiredString(args.source_kind, 'source_kind_required'),
        source_scope: requiredString(args.source_scope, 'source_scope_required'),
        immutable_source_id: requiredString(args.immutable_source_id, 'immutable_source_id_required'),
        idempotency_key: idempotencyKey,
        causation_id: requiredString(args.causation_id, 'causation_id_required'),
        policy_version: requiredString(args.policy_version, 'policy_version_required'),
        summary: requiredString(args.summary, 'summary_required'),
        source_ref: asRecord(args.source_ref),
        correlation_keys: asArray(args.correlation_keys).map((value) => {
          const key = asRecord(value);
          return {
            kind: requiredString(key.kind, 'correlation_kind_required'),
            scope: requiredString(key.scope, 'correlation_scope_required'),
            value: requiredString(key.value, 'correlation_value_required'),
          };
        }),
      })));
    }
    case 'ticket_admit_proposal': {
      const idempotencyKey = requiredString(args.idempotency_key, 'idempotency_key_required');
      return toolResult(domainOperation(idempotencyKey, store.admitProposal({
        ticket_id: requiredString(args.ticket_id, 'ticket_id_required'),
        expected_revision: requiredInteger(args.expected_revision, 'expected_revision_required'),
        route: requiredString(args.route, 'route_required') as 'response_draft' | 'followup_task' | 'resolved' | 'blocked_operator',
        idempotency_key: idempotencyKey,
        causation_id: requiredString(args.causation_id, 'causation_id_required'),
        actor_id: requiredString(args.actor_id, 'actor_id_required'),
        summary: requiredString(args.summary, 'summary_required'),
        task: args.task ? {
          title: requiredString(asRecord(args.task).title, 'task_title_required'),
          goal: requiredString(asRecord(args.task).goal, 'task_goal_required'),
          context: optionalString(asRecord(args.task).context),
          required_work: requiredString(asRecord(args.task).required_work, 'task_required_work_required'),
          non_goals: optionalString(asRecord(args.task).non_goals),
          acceptance_criteria: asArray(asRecord(args.task).acceptance_criteria).map(String),
          tags: asArray(asRecord(args.task).tags).map(String),
        } : undefined,
        draft: args.draft ? {
          source_id: requiredString(asRecord(args.draft).source_id, 'draft_source_id_required'),
          reply_mode: requiredString(asRecord(args.draft).reply_mode, 'draft_reply_mode_required') as 'reply' | 'reply_all',
          body_text: optionalString(asRecord(args.draft).body_text) ?? undefined,
          body_html: optionalString(asRecord(args.draft).body_html) ?? undefined,
        } : undefined,
        resolution_code: optionalString(args.resolution_code),
        blocker_code: optionalString(args.blocker_code),
      })));
    }
    case 'ticket_draft_receipt_record': {
      const idempotencyKey = requiredString(args.idempotency_key, 'idempotency_key_required');
      return toolResult(domainOperation(idempotencyKey, store.recordDraftReceipt({
        ticket_id: requiredString(args.ticket_id, 'ticket_id_required'),
        effect_claim_id: requiredString(args.effect_claim_id, 'effect_claim_id_required'),
        draft_operation_key: requiredString(args.draft_operation_key, 'draft_operation_key_required'),
        draft_request_digest: requiredString(args.draft_request_digest, 'draft_request_digest_required'),
        receipt_id: requiredString(args.receipt_id, 'receipt_id_required'),
        draft_id: requiredString(args.draft_id, 'draft_id_required'),
        draft_ref: asRecord(args.draft_ref),
        idempotency_key: idempotencyKey,
        causation_id: requiredString(args.causation_id, 'causation_id_required'),
      })));
    }
    case 'ticket_draft_disposition_reconcile': {
      const idempotencyKey = requiredString(args.idempotency_key, 'idempotency_key_required');
      return toolResult(domainOperation(idempotencyKey, store.reconcileDraftDisposition({
        ticket_id: requiredString(args.ticket_id, 'ticket_id_required'),
        draft_id: requiredString(args.draft_id, 'draft_id_required'),
        evidence: asRecord(args.evidence) as Parameters<typeof store.reconcileDraftDisposition>[0]['evidence'],
        idempotency_key: idempotencyKey,
        causation_id: requiredString(args.causation_id, 'causation_id_required'),
      })));
    }
    case 'work_outbox_list': {
      const events = store.listOutbox(
        requiredString(args.consumer_id, 'consumer_id_required'),
        {
          topics: asArray(args.topics).map(String),
          limit: optionalInteger(args.limit),
        },
      );
      return toolResult({
        schema: 'narada.work_lifecycle.outbox.v1',
        count: events.length,
        events,
      });
    }
    case 'work_outbox_consumer_register':
      store.registerOutboxConsumer(
        requiredString(args.topic, 'topic_required'),
        requiredString(args.consumer_id, 'consumer_id_required'),
      );
      return toolResult({ status: 'registered' });
    case 'work_outbox_ack':
      store.acknowledgeOutbox(
        requiredString(args.event_id, 'event_id_required'),
        requiredString(args.consumer_id, 'consumer_id_required'),
        asRecord(args.receipt),
      );
      return toolResult({ status: 'acknowledged' });
    case 'work_outbox_compact':
      return toolResult(store.compactAcknowledgedOutbox(
        requiredString(args.before, 'before_required'),
      ));
    case 'work_lifecycle_storage_inspect':
      return toolResult(store.inspectStorageBounds());
    default:
      throw new Error(`unknown_tool:${name}`);
  }
}

function toolResult(payload: unknown): JsonRecord {
  const structured = payload && typeof payload === 'object'
    ? payload as JsonRecord
    : { value: payload };
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function domainOperation(operationKey: string, result: object): JsonRecord {
  return {
    schema: 'narada.domain_operation.v1',
    operation_ref: `work-lifecycle:${operationKey}`,
    outcome: 'completed',
    result,
  };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function parseArgs(argv: string[]): { siteRoot?: string; prepare: boolean; help: boolean } {
  const parsed: { siteRoot?: string; prepare: boolean; help: boolean } = {
    prepare: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--site-root' && argv[index + 1]) {
      parsed.siteRoot = argv[index + 1];
      index += 1;
    } else if (arg === '--prepare') {
      parsed.prepare = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }
  return parsed;
}

function parseJsonRpcInput(input: string): JsonRecord[] {
  return input.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line) as JsonRecord;
    } catch {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      };
    }
  });
}

export async function runWorkLifecycleMcpServer(options: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
} = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const parsed = parseArgs(argv);
  if (parsed.help) {
    stdout.write('Usage: work-lifecycle-mcp [--prepare] --site-root <path>\n');
    return;
  }
  const siteRoot = parsed.siteRoot ?? env.NARADA_SITE_ROOT ?? process.cwd();
  if (parsed.prepare) {
    stdout.write(`${JSON.stringify(prepareWorkLifecycleStore(siteRoot))}\n`);
    return;
  }
  const runtime = createWorkLifecycleRuntime({ siteRoot, env, stderr });
  try {
    await runJsonRpcStdioServer({
      stdin: options.stdin ?? process.stdin,
      stdout,
      parseJsonRpcInput,
      handleRequest: (request: JsonRecord) => handleWorkLifecycleMcpRequest(request, runtime),
    });
  } finally {
    if (runtime.ownsStore) runtime.store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorkLifecycleMcpServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
