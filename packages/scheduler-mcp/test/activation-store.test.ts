import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  inspectSchedulerActivationStore,
  openPreparedSchedulerActivationStore,
  prepareSchedulerActivationStore,
  type SchedulerActivationStore,
  type SchedulerSourceEvent,
} from '../src/activation-store.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-activation-'));
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(inspectSchedulerActivationStore(root).status, 'missing');
  assert.equal(prepareSchedulerActivationStore(root).status, 'prepared');
  const store = openPreparedSchedulerActivationStore(root, {
    now: () => new Date(nowMs),
  });
  return {
    root,
    store,
    now: () => new Date(nowMs),
    advance(ms: number) {
      nowMs += ms;
    },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function completionEvent(
  id: string,
  occurredAt: string,
  outcome = 'synced',
): SchedulerSourceEvent {
  return {
    event_id: id,
    topic: 'sop.run.terminal.v1',
    partition_key: 'sonar.mailbox-sync',
    aggregate_id: id.replace('event-', 'run-'),
    aggregate_revision: 1,
    schema_version: 1,
    causation_id: id,
    idempotency_key: id,
    payload: { sop_id: 'sonar.mailbox-sync', outcome },
    occurred_at: occurredAt,
  };
}

function installSyncBinding(store: SchedulerActivationStore) {
  return store.upsertBinding({
    binding_id: 'mailbox-sync-continuation',
    trigger_kind: 'completion',
    source_topic: 'sop.run.terminal.v1',
    source_sop_id: 'sonar.mailbox-sync',
    terminal_outcomes: ['synced', 'no_change', 'retryable_failure', 'blocked'],
    target_sop_id: 'sonar.mailbox-sync',
    target_template_version: 'v1',
    concurrency: 'singleton',
    delay_by_outcome_ms: { synced: 1_000, no_change: 2_000 },
    default_delay_ms: 0,
    retry_base_ms: 500,
    retry_max_ms: 4_000,
    max_attempts: 3,
    blocked_policy: 'manual_unblock',
  });
}

test('completion events are replay-safe, completion-relative, and pause-safe', () => {
  const f = fixture();
  try {
    const binding = installSyncBinding(f.store);
    const paused = f.store.setBindingStatus(binding.binding_id, 'paused', binding.revision);
    const event = completionEvent('event-1', f.now().toISOString());
    const admitted = f.store.admitEvent(event);
    assert.equal(admitted.status, 'admitted');
    assert.equal(admitted.activation_count, 1);
    assert.equal(admitted.activations[0]?.due_at, '2026-01-01T00:00:01.000Z');
    assert.equal(f.store.claimDue('dispatcher'), undefined);

    const replay = f.store.admitEvent(event);
    assert.equal(replay.status, 'replayed');
    assert.equal(replay.activations[0]?.activation_id, admitted.activations[0]?.activation_id);
    assert.throws(
      () => f.store.admitEvent({ ...event, payload: { ...event.payload, outcome: 'no_change' } }),
      /scheduler_event_idempotency_conflict/,
    );

    f.store.setBindingStatus(binding.binding_id, 'active', paused.revision);
    f.advance(1_000);
    const claim = f.store.claimDue('dispatcher');
    assert.ok(claim);
    assert.equal(claim.occurrence_key, 'mailbox-sync-continuation:event-1');
  } finally {
    f.close();
  }
});

test('retiring a binding stops future activations without cancelling an admitted occurrence', () => {
  const f = fixture();
  try {
    const binding = installSyncBinding(f.store);
    const firstEvent = completionEvent('event-before-retirement', f.now().toISOString());
    const admitted = f.store.admitEvent(firstEvent);
    assert.equal(admitted.activation_count, 1);

    f.store.setBindingStatus(binding.binding_id, 'retired', binding.revision);
    const afterRetirement = f.store.admitEvent(
      completionEvent('event-after-retirement', f.now().toISOString()),
    );
    assert.equal(afterRetirement.activation_count, 0);

    f.advance(1_000);
    const claim = f.store.claimDue('dispatcher');
    assert.ok(claim);
    assert.equal(claim.source_event_id, firstEvent.event_id);
    assert.equal(f.store.claimDue('dispatcher'), undefined);
  } finally {
    f.close();
  }
});

test('singleton concurrency remains held through SOP terminal receipt', () => {
  const f = fixture();
  try {
    installSyncBinding(f.store);
    f.store.admitEvent(completionEvent('event-1', f.now().toISOString(), 'retryable_failure'));
    f.store.admitEvent(completionEvent('event-2', f.now().toISOString(), 'retryable_failure'));
    f.advance(500);
    const first = f.store.claimDue('dispatcher');
    assert.ok(first);
    assert.ok(first.lease_token);
    const admitted = f.store.markAdmitted({
      activationId: first.activation_id,
      consumerId: 'dispatcher',
      leaseToken: first.lease_token,
      sopRunId: 'sop-run-1',
      receiptId: 'sop-admit-1',
      receipt: { occurrence_key: first.occurrence_key },
    });
    assert.equal(admitted.status, 'admitted');
    assert.equal(f.store.claimDue('dispatcher'), undefined);

    f.store.resolveActivation({
      sopRunId: 'sop-run-1',
      outcome: 'synced',
      receiptId: 'sop-terminal-1',
      receipt: { outcome: 'synced' },
    });
    const second = f.store.claimDue('dispatcher');
    assert.ok(second);
    assert.notEqual(second.activation_id, first.activation_id);
  } finally {
    f.close();
  }
});

test('partitioned concurrency permits unrelated tickets and blocks overlap', () => {
  const f = fixture();
  try {
    f.store.upsertBinding({
      binding_id: 'ticket-work-processing',
      trigger_kind: 'domain_event',
      source_topic: 'work.ticket-work-due.v1',
      target_sop_id: 'sonar.ticket-process',
      target_template_version: 'v1',
      concurrency: 'partitioned',
    });
    for (const ticket of ['ticket-1', 'ticket-2']) {
      f.store.admitEvent({
        event_id: `work-${ticket}`,
        topic: 'work.ticket-work-due.v1',
        partition_key: ticket,
        aggregate_id: ticket,
        aggregate_revision: 1,
        schema_version: 1,
        causation_id: `source-${ticket}`,
        idempotency_key: `work-${ticket}`,
        payload: { ticket_id: ticket },
        occurred_at: f.now().toISOString(),
      });
    }
    const first = f.store.claimDue('dispatcher');
    assert.ok(first);
    assert.ok(first.lease_token);
    f.store.markAdmitted({
      activationId: first.activation_id,
      consumerId: 'dispatcher',
      leaseToken: first.lease_token,
      sopRunId: 'ticket-run-1',
      receiptId: 'ticket-admit-1',
      receipt: {},
    });
    const second = f.store.claimDue('dispatcher');
    assert.ok(second);
    assert.notEqual(second.partition_key, first.partition_key);
  } finally {
    f.close();
  }
});

test('retry backoff, lease expiry recovery, and blocked outcome are durable', () => {
  const f = fixture();
  try {
    installSyncBinding(f.store);
    f.store.admitEvent(completionEvent('event-retry', f.now().toISOString(), 'retryable_failure'));
    f.advance(500);
    const first = f.store.claimDue('dispatcher', 1_000);
    assert.ok(first);
    assert.ok(first.lease_token);
    const retried = f.store.failClaim({
      activationId: first.activation_id,
      consumerId: 'dispatcher',
      leaseToken: first.lease_token,
      retryable: true,
      error: 'transport_timeout',
    });
    assert.equal(retried.status, 'pending');
    assert.equal(retried.attempt_count, 1);
    assert.equal(f.store.claimDue('dispatcher'), undefined);
    f.advance(500);
    const second = f.store.claimDue('dispatcher', 1_000);
    assert.ok(second);
    f.advance(1_001);
    const recovered = f.store.claimDue('recovery-dispatcher');
    assert.ok(recovered);
    assert.equal(recovered.activation_id, second.activation_id);
    assert.equal(recovered.attempt_count, 2);
    assert.notEqual(recovered.lease_token, second.lease_token);
    assert.throws(() => f.store.markAdmitted({
      activationId: recovered.activation_id,
      consumerId: 'recovery-dispatcher',
      leaseToken: second.lease_token!,
      sopRunId: 'stale-run',
      receiptId: 'stale-receipt',
      receipt: {},
    }), /scheduler_activation_lease_token_mismatch/);

    const blocked = f.store.admitEvent(
      completionEvent('event-blocked', f.now().toISOString(), 'blocked'),
    ).activations[0]!;
    assert.equal(blocked.status, 'blocked');
    assert.equal(f.store.unblockActivation(blocked.activation_id).status, 'pending');
  } finally {
    f.close();
  }
});
