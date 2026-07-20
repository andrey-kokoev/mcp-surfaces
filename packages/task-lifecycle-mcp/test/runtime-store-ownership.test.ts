import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeStoreOwnership } from '../src/kernel/runtime-store-ownership.js';

type TestStore = { id: string };

test('transfers the request lease across a replacement without leaking it', async () => {
  const closed: string[] = [];
  const ownership = new RuntimeStoreOwnership<TestStore>((store) => closed.push(store.id));
  ownership.initialize({ id: 'old' });

  const lease = ownership.acquire('request-1');
  const next = await ownership.replace({
    requestId: 'request-1',
    open: () => ({ id: 'new' }),
  });

  assert.equal(next.id, 'new');
  assert.equal(lease.store.id, 'new');
  assert.equal(ownership.activeRequestCount, 1);
  assert.deepEqual(closed, ['old']);

  lease.release();
  lease.release();
  assert.equal(ownership.activeRequestCount, 0);
});

test('waits for unrelated requests before replacing the old store', async () => {
  const ownership = new RuntimeStoreOwnership<TestStore>(() => undefined);
  ownership.initialize({ id: 'old' });

  const replacingLease = ownership.acquire('request-1');
  const blockingLease = ownership.acquire('request-2');
  let opened = false;
  const replacement = ownership.replace({
    requestId: 'request-1',
    open: () => {
      opened = true;
      return { id: 'new' };
    },
  });

  await Promise.resolve();
  assert.equal(opened, false);
  blockingLease.release();
  await replacement;

  assert.equal(opened, true);
  assert.equal(replacingLease.store.id, 'new');
  replacingLease.release();
  assert.equal(ownership.activeRequestCount, 0);
});

test('rejects new requests while replacement is transitioning', async () => {
  const ownership = new RuntimeStoreOwnership<TestStore>(() => undefined);
  ownership.initialize({ id: 'old' });
  const activeLease = ownership.acquire('active-request');

  const replacement = ownership.replace({ open: () => ({ id: 'new' }) });
  assert.throws(() => ownership.acquire('new-request'), /task_lifecycle_store_transition_in_progress/);

  activeLease.release();
  await replacement;
  assert.equal(ownership.currentStore()?.id, 'new');
  const recoveredLease = ownership.acquire('recovered-request');
  recoveredLease.release();
});

test('restores a transferred lease when opening the replacement fails', async () => {
  const ownership = new RuntimeStoreOwnership<TestStore>(() => undefined);
  ownership.initialize({ id: 'old' });
  const lease = ownership.acquire('request-1');
  const failure = new Error('open failed');

  await assert.rejects(
    ownership.replace({
      requestId: 'request-1',
      open: () => {
        throw failure;
      },
    }),
    failure,
  );

  assert.equal(lease.store.id, 'old');
  assert.equal(ownership.activeRequestCount, 1);
  lease.release();
  assert.equal(ownership.activeRequestCount, 0);
});

test('restores a transferred lease when closing the old store fails', async () => {
  const closed: string[] = [];
  const failure = new Error('close failed');
  const ownership = new RuntimeStoreOwnership<TestStore>((store) => {
    closed.push(store.id);
    if (store.id === 'old') throw failure;
  });
  ownership.initialize({ id: 'old' });
  const lease = ownership.acquire('request-1');

  await assert.rejects(
    ownership.replace({
      requestId: 'request-1',
      open: () => ({ id: 'new' }),
    }),
    failure,
  );

  assert.equal(lease.store.id, 'old');
  assert.equal(ownership.currentStore()?.id, 'old');
  assert.equal(ownership.activeRequestCount, 1);
  assert.deepEqual(closed, ['old', 'new']);
  lease.release();
});
