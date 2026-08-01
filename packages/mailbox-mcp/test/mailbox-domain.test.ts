import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  loadControlPlaneRuntime,
  type ControlPlaneRuntime,
  type Source,
  type SourceBatch,
  type SourceRecord,
  type SyncResult,
} from '../src/control-plane-runtime.js';
import { MailboxDomainService } from '../src/mailbox-domain.js';

type RecordValue = Record<string, unknown>;

const root = mkdtempSync(join(tmpdir(), 'mailbox-domain-'));
const projectionRoot = join(root, '.narada', 'runtime', 'mailboxes', 'support');
const configDir = join(root, 'config');
mkdirSync(configDir, { recursive: true });
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mailbox-domain-fixture', private: true }));
writeFileSync(join(configDir, 'config.json'), JSON.stringify({
  root_dir: projectionRoot,
  scopes: [{
    scope_id: 'support',
    root_dir: projectionRoot,
    sources: [{ type: 'graph' }],
    graph: { user_id: 'support@example.test', prefer_immutable_ids: true },
    scope: { included_container_refs: ['inbox'], included_item_kinds: ['message'] },
    normalize: {
      attachment_policy: 'metadata_only',
      body_policy: 'text_only',
      include_headers: false,
      tombstones_enabled: true,
    },
    runtime: {
      polling_interval_ms: 60_000,
      acquire_lock_timeout_ms: 1_000,
      cleanup_tmp_on_startup: true,
      rebuild_views_after_sync: false,
      rebuild_search_after_sync: false,
    },
    admission: {
      mail: {
        included_folder_refs: ['inbox'],
        allowed_sender_domains: ['allowed.test'],
        unknown_sender_behavior: 'ignore',
      },
    },
    policy: {
      primary_charter: 'fixture',
      allowed_actions: ['no_action'],
      require_human_approval: true,
    },
  }],
}));

let sourceCalls = 0;
const source: Source = {
  sourceId: 'support',
  async pull(checkpoint?: string | null): Promise<SourceBatch> {
    sourceCalls += 1;
    return {
      records: [
        messageRecord('event-allowed', 'message-allowed', 'sender@allowed.test'),
        messageRecord('event-rejected', 'message-rejected', 'sender@outside.test'),
      ],
      priorCheckpoint: checkpoint ?? null,
      nextCheckpoint: checkpoint === 'cursor-1' ? 'cursor-2' : 'cursor-1',
      hasMore: false,
      fetchedAt: '2026-07-31T12:00:00.000Z',
    };
  },
};

try {
  const naradaSonarRoot = resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'narada.sonar');
  const runtime = await loadControlPlaneRuntime(naradaSonarRoot);
  const service = new MailboxDomainService(root, { runtime, sourceFactory: () => source });

  const first = await service.syncGeneration({ idempotency_key: 'sync-action-1', scope_id: 'support' });
  assert.equal(first.schema, 'narada.domain_operation.v1');
  assert.equal(first.outcome, 'completed');
  assert.equal(record(first.result).status, 'synced');
  assert.equal(record(first.result).first_observation_count, 2);
  assert.equal(first.result_ref, undefined, 'SOP result_ref is reserved for immutable value refs');
  assert.equal(sourceCalls, 1);

  const replay = await service.syncGeneration({ idempotency_key: 'sync-action-1', scope_id: 'support' });
  assert.equal(record(replay.result).idempotency_replayed, true);
  assert.equal(sourceCalls, 1);

  service.outboxConsumerRegister({ consumer_id: 'scheduler', start_at: '2026-07-31T00:00:00.000Z' });
  const listed = service.outboxList({ consumer_id: 'scheduler' });
  const events = arrayOfRecords(listed.items);
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((event) => String(event.partition_key))).size, 2);
  for (const event of events) {
    assert.equal(event.partition_key, record(event.payload).observation_id);
  }

  const allowedEvent = events.find((event) => record(event.payload).message_id === 'message-allowed');
  const rejectedEvent = events.find((event) => record(event.payload).message_id === 'message-rejected');
  assert.ok(allowedEvent);
  assert.ok(rejectedEvent);

  const admitted = await service.admitMessage({
    idempotency_key: 'admission-action-allowed',
    scope_id: 'support',
    fact_id: String(record(allowedEvent.payload).fact_id),
  });
  assert.equal(record(admitted.result).decision, 'admitted');
  assert.equal(record(record(admitted.result).ticket_admit_source_arguments).immutable_source_id, 'message-allowed');
  const admittedSourceRef = record(record(record(admitted.result).ticket_admit_source_arguments).source_ref);
  assert.equal(admittedSourceRef.fact_id, record(allowedEvent.payload).fact_id);
  assert.equal(admittedSourceRef.source_version, 'v1');
  assert.equal(admittedSourceRef.scope_id, 'support');
  assert.equal(admittedSourceRef.mailbox_id, 'support@example.test');
  assert.equal(JSON.stringify(admitted).includes('Allowed body must not cross admission receipt'), false);

  const immutableFact = await service.factShow({
    fact_id: String(record(allowedEvent.payload).fact_id),
    scope_id: 'support',
  });
  assert.equal(immutableFact.status, 'ok');
  assert.equal(record(immutableFact.fact).fact_id, record(allowedEvent.payload).fact_id);
  assert.equal(typeof record(immutableFact.fact).payload_sha256, 'string');
  assert.equal(JSON.stringify(record(immutableFact.fact).payload).includes('Allowed body must not cross admission receipt'), true);

  const rejected = await service.admitMessage({
    idempotency_key: 'admission-action-rejected',
    scope_id: 'support',
    fact_id: String(record(rejectedEvent.payload).fact_id),
  });
  assert.equal(record(rejected.result).decision, 'rejected');
  assert.equal(record(rejected.result).reason, 'sender_not_allowed');
  assert.equal(record(rejected.result).ticket_admit_source_arguments, undefined);

  for (const event of events) {
    const eventId = String(event.event_id);
    const acknowledgement = { schema: 'fixture.scheduler_receipt.v1', scheduler_event_id: `scheduler:${eventId}` };
    const ack = service.outboxAck({ consumer_id: 'scheduler', event_id: eventId, receipt: acknowledgement });
    assert.equal(ack.replayed, false);
    const ackReplay = service.outboxAck({ consumer_id: 'scheduler', event_id: eventId, receipt: acknowledgement });
    assert.equal(ackReplay.replayed, true);
  }
  assert.equal(service.outboxList({ consumer_id: 'scheduler' }).count, 0);

  const overlap = await service.syncGeneration({ idempotency_key: 'sync-action-2', scope_id: 'support' });
  assert.equal(record(overlap.result).status, 'no_change');
  assert.equal(record(overlap.result).first_observation_count, 0);
  assert.equal(sourceCalls, 2);

  let injectCrash = true;
  const crashService = new MailboxDomainService(root, {
    runtime,
    sourceFactory: () => source,
    faultInjector: (point) => {
      if (point === 'after_runner' && injectCrash) {
        injectCrash = false;
        throw new Error('fixture_crash_after_cursor_commit');
      }
    },
  });
  await assert.rejects(
    crashService.syncGeneration({ idempotency_key: 'sync-action-crash', scope_id: 'support' }),
    /fixture_crash_after_cursor_commit/,
  );
  assert.equal(sourceCalls, 3);
  const recovered = await service.syncGeneration({ idempotency_key: 'sync-action-crash', scope_id: 'support' });
  assert.equal(recovered.outcome, 'completed');
  assert.equal(record(recovered.result).idempotency_replayed, true);
  assert.equal(sourceCalls, 3);

  const fatalRuntime: ControlPlaneRuntime = {
    ...runtime,
    DefaultSyncRunner: class {
      constructor(_options: Record<string, unknown>) {}

      async syncOnce(): Promise<SyncResult> {
        return {
          status: 'fatal_failure',
          error: 'fixture_fatal_sync_failure',
          event_count: 0,
          applied_count: 0,
          skipped_count: 0,
          duration_ms: 1,
        };
      }
    },
  };
  const fatalService = new MailboxDomainService(root, { runtime: fatalRuntime, sourceFactory: () => source });
  const blocked = await fatalService.syncGeneration({ idempotency_key: 'sync-action-fatal', scope_id: 'support' });
  assert.equal(blocked.outcome, 'completed');
  assert.equal(record(blocked.result).schema, 'narada.mailbox.sync_generation_failure.v1');
  assert.equal(record(blocked.result).status, 'blocked');
  assert.equal(record(blocked.result).error_message, 'fixture_fatal_sync_failure');
  assert.equal(record(blocked.result).idempotency_replayed, false);
  assert.equal(blocked.result_ref, undefined, 'blocked receipts remain bounded inline results');

  const blockedReplay = await fatalService.syncGeneration({ idempotency_key: 'sync-action-fatal', scope_id: 'support' });
  assert.equal(blockedReplay.outcome, 'completed');
  assert.equal(record(blockedReplay.result).status, 'blocked');
  assert.equal(record(blockedReplay.result).idempotency_replayed, true);

  console.log('mailbox domain behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}

function messageRecord(eventId: string, messageId: string, sender: string): SourceRecord {
  return {
    recordId: eventId,
    ordinal: '2026-07-31T12:00:00.000Z',
    provenance: {
      sourceId: 'support',
      observedAt: '2026-07-31T12:00:00.000Z',
      sourceVersion: 'v1',
    },
    payload: {
      schema_version: 1,
      event_id: eventId,
      mailbox_id: 'support',
      message_id: messageId,
      source_item_id: messageId,
      source_version: 'v1',
      event_kind: 'upsert',
      observed_at: '2026-07-31T12:00:00.000Z',
      payload: {
        schema_version: 1,
        mailbox_id: 'support',
        message_id: messageId,
        conversation_id: 'conversation-1',
        internet_message_id: `<${messageId}@example.test>`,
        subject: `Subject ${messageId}`,
        from: { email: sender },
        sender: { email: sender },
        reply_to: [],
        to: [],
        cc: [],
        bcc: [],
        folder_refs: ['inbox'],
        category_refs: [],
        flags: {
          is_read: false,
          is_draft: false,
          is_flagged: false,
          has_attachments: false,
        },
        body: {
          body_kind: 'text',
          text: messageId === 'message-allowed'
            ? 'Allowed body must not cross admission receipt'
            : 'Rejected body must not cross admission receipt',
        },
        attachments: [],
      },
    },
  };
}

function record(value: unknown): RecordValue {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as RecordValue;
}

function arrayOfRecords(value: unknown): RecordValue[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
