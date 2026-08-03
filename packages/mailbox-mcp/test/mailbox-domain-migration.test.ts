import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MailboxDomainStore } from '../src/mailbox-domain-store.js';

const root = mkdtempSync(join(tmpdir(), 'mailbox-domain-migration-'));

try {
  const compatiblePath = join(root, 'compatible.db');
  seedLegacyDatabase(compatiblePath, false);
  const migrated = new MailboxDomainStore(compatiblePath);
  assert.equal(Number((migrated.db.prepare('pragma user_version').get() as { user_version: number }).user_version), 2);
  assert.equal(
    (migrated.db.prepare('select scope_id from mailbox_outbox where event_id = ?').get('event-1') as { scope_id: string }).scope_id,
    'support',
  );
  assert.equal(
    Number((migrated.db.prepare('select count(*) as count from mailbox_admission_receipts').get() as { count: number }).count),
    1,
  );
  migrated.registerOutboxConsumer(
    'legacy-consumer',
    'support',
    ['mailbox.message.first_observed'],
    '2026-07-31T00:00:00.000Z',
    '2026-08-03T00:00:00.000Z',
  );
  assert.equal(migrated.listOutbox('legacy-consumer', 1).items.length, 1);
  migrated.close();

  const divergentPath = join(root, 'divergent.db');
  seedLegacyDatabase(divergentPath, true);
  assert.throws(
    () => new MailboxDomainStore(divergentPath),
    /mailbox_admission_migration_divergent_duplicate:support:fact-1/,
  );

  console.log('mailbox domain migration ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}

function seedLegacyDatabase(path: string, divergent: boolean): void {
  const db = new DatabaseSync(path);
  db.exec(`
    create table mailbox_outbox(
      event_id text primary key,
      topic text not null,
      aggregate_id text not null,
      aggregate_revision integer not null,
      schema_version integer not null,
      causation_id text not null,
      idempotency_key text not null unique,
      partition_key text not null,
      occurred_at text not null,
      payload_json text not null
    );
    create table mailbox_outbox_consumers(
      consumer_id text primary key,
      start_at text not null,
      created_at text not null
    );
    create table mailbox_admission_receipts(
      admission_id text primary key,
      idempotency_key text not null unique,
      request_fingerprint text not null,
      scope_id text not null,
      fact_id text not null,
      policy_version text not null,
      decision_json text not null,
      created_at text not null
    );
  `);
  db.prepare(`
    insert into mailbox_outbox values (?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
  `).run(
    'event-1',
    'mailbox.message.first_observed',
    'observation-1',
    'generation-1',
    'event-1',
    'observation-1',
    '2026-07-31T12:00:00.000Z',
    JSON.stringify({ mailbox_id: 'support', fact_id: 'fact-1' }),
  );
  db.prepare('insert into mailbox_outbox_consumers values (?, ?, ?)').run(
    'legacy-consumer',
    '2026-07-31T00:00:00.000Z',
    '2026-07-31T00:00:00.000Z',
  );
  const first = JSON.stringify({ schema: 'narada.mailbox.message_admission_receipt.v1', decision: 'admitted' });
  const second = divergent
    ? JSON.stringify({ schema: 'narada.mailbox.message_admission_receipt.v1', decision: 'rejected' })
    : first;
  const insert = db.prepare('insert into mailbox_admission_receipts values (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('admission-1', 'operation-1', 'fingerprint-1', 'support', 'fact-1', 'policy-1', first, '2026-07-31T12:00:00.000Z');
  insert.run('admission-2', 'operation-2', 'fingerprint-2', 'support', 'fact-1', 'policy-1', second, '2026-07-31T12:01:00.000Z');
  db.close();
}
