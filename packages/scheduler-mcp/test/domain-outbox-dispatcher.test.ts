import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runSchedulerDomainOutboxDispatcher,
  type SchedulerDomainFabricCaller,
} from '../src/domain-outbox-dispatcher.js';
import type { JsonRecord } from '@narada-core/mcp-runtime-client';

const mailboxEvent: JsonRecord = {
  schema: 'narada.mailbox.outbox_event.v1',
  event_id: 'mailbox-event-1',
  topic: 'mailbox.message.first_observed',
  partition_key: 'support\u0000message-1',
  aggregate_id: 'observation-1',
  aggregate_revision: 1,
  schema_version: 1,
  causation_id: 'generation-1',
  idempotency_key: 'mailbox-event-1',
  occurred_at: '2026-07-31T12:00:00.000Z',
  payload: { mailbox_id: 'support', message_id: 'message-1', fact_id: 'fact-1' },
};

test('domain outbox replay admits one scheduler event across a lost source acknowledgement', async () => {
  const fabric = new FixtureFabric(mailboxEvent);
  fabric.failNextMailboxAck = true;

  const first = await runSchedulerDomainOutboxDispatcher({
    siteRoot: 'D:/fixture',
    profile: 'mailbox',
    consumerId: 'scheduler-mailbox',
    outboxStartAt: '2026-07-31T00:00:00.000Z',
  }, fabric);

  assert.equal(first.status, 'completed_with_errors');
  assert.equal(first.events_admitted, 1);
  assert.equal(first.events_acknowledged, 0);
  assert.equal(fabric.schedulerEvents.size, 1);

  const recovered = await runSchedulerDomainOutboxDispatcher({
    siteRoot: 'D:/fixture',
    profile: 'mailbox',
    consumerId: 'scheduler-mailbox',
    outboxStartAt: '2026-07-31T00:00:00.000Z',
  }, fabric);

  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.events_admitted, 1);
  assert.equal(recovered.events_acknowledged, 1);
  assert.equal(fabric.schedulerEvents.size, 1);
  assert.equal(fabric.mailboxAcknowledged, true);
});

test('work-lifecycle profile registers every topic and normalizes created_at', async () => {
  const event: JsonRecord = {
    event_id: 'work-event-1',
    topic: 'work.ticket-work-due.v1',
    partition_key: 'ticket-1',
    aggregate_id: 'ticket-1',
    aggregate_revision: 2,
    schema_version: 1,
    causation_id: 'source-1',
    idempotency_key: 'work-event-1',
    created_at: '2026-07-31T13:00:00.000Z',
    payload: { ticket_id: 'ticket-1' },
  };
  const fabric = new FixtureFabric(null, event);

  const report = await runSchedulerDomainOutboxDispatcher({
    siteRoot: 'D:/fixture',
    profile: 'work-lifecycle',
    consumerId: 'scheduler-work',
    topics: ['work.ticket-work-due.v1', 'work.task-terminal.v1'],
  }, fabric);

  assert.equal(report.status, 'completed');
  assert.deepEqual([...fabric.workTopics].sort(), ['work.task-terminal.v1', 'work.ticket-work-due.v1']);
  assert.equal(fabric.schedulerEvents.get('work-event-1')?.occurred_at, '2026-07-31T13:00:00.000Z');
  assert.equal(fabric.workAcknowledged, true);
});

class FixtureFabric implements SchedulerDomainFabricCaller {
  readonly schedulerEvents = new Map<string, JsonRecord>();
  readonly workTopics = new Set<string>();
  mailboxAcknowledged = false;
  workAcknowledged = false;
  failNextMailboxAck = false;

  constructor(
    private readonly mailboxEvent: JsonRecord | null,
    private readonly workEvent: JsonRecord | null = null,
  ) {}

  async call(surfaceId: string, toolName: string, args: JsonRecord = {}): Promise<JsonRecord> {
    if (surfaceId === 'scheduler' && toolName === 'scheduler_runtime_status') {
      return { status: 'fresh', implementation_id: 'scheduler-runtime-fixture' };
    }
    if (surfaceId === 'scheduler' && toolName === 'scheduler_event_admit') {
      const eventId = String(args.event_id);
      const existing = this.schedulerEvents.get(eventId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(args)) {
        throw new Error(`scheduler_event_idempotency_conflict:${eventId}`);
      }
      this.schedulerEvents.set(eventId, args);
      return { admission: existing ? 'existing' : 'created' };
    }
    if (surfaceId === 'mailbox' && toolName === 'mailbox_outbox_consumer_register') {
      return { status: 'registered' };
    }
    if (surfaceId === 'mailbox' && toolName === 'mailbox_outbox_list') {
      return { items: this.mailboxEvent && !this.mailboxAcknowledged ? [this.mailboxEvent] : [] };
    }
    if (surfaceId === 'mailbox' && toolName === 'mailbox_outbox_ack') {
      if (this.failNextMailboxAck) {
        this.failNextMailboxAck = false;
        throw new Error('fixture_response_lost_before_mailbox_ack');
      }
      this.mailboxAcknowledged = true;
      return { status: 'acknowledged' };
    }
    if (surfaceId === 'work-lifecycle' && toolName === 'work_outbox_consumer_register') {
      this.workTopics.add(String(args.topic));
      return { status: 'registered' };
    }
    if (surfaceId === 'work-lifecycle' && toolName === 'work_outbox_list') {
      return { events: this.workEvent && !this.workAcknowledged ? [this.workEvent] : [] };
    }
    if (surfaceId === 'work-lifecycle' && toolName === 'work_outbox_ack') {
      this.workAcknowledged = true;
      return { status: 'acknowledged' };
    }
    throw new Error(`unexpected_call:${surfaceId}:${toolName}`);
  }
}
