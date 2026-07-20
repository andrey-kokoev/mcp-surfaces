import assert from 'node:assert/strict';
import test from 'node:test';

import { continuationProjectionState } from '../src/continuation-projection.js';

test('a checkpoint with fresh continuation marks the prior portable projection stale', () => {
  const priorRef = {
    schema: 'narada.continuation.handoff.v1',
    path: '.ai/continuations/current.md',
    sha256: 'a'.repeat(64),
    created_at: '2026-07-19T00:00:00.000Z',
  };
  const state = continuationProjectionState({
    agentId: 'fixture.resident',
    continuation: { schema: 'narada.continuation.v1' },
    continuationRef: null,
    previousCheckpoint: {
      checkpoint_id: 'chk_previous',
      continuation_ref: priorRef,
    },
  });

  assert.equal(state?.status, 'stale');
  assert.equal(state?.reason, 'checkpoint_supersedes_linked_projection');
  assert.deepEqual(state?.continuation_ref, priorRef);
  assert.deepEqual(state?.next_action, {
    tool: 'agent_context_continuation_export',
    arguments: {
      agent_id: 'fixture.resident',
      path: '.ai/continuations/current.md',
      overwrite: true,
    },
  });
});

test('a linked projection is current and needs no re-export action', () => {
  const ref = { path: '.ai/continuations/current.md' };
  const state = continuationProjectionState({
    agentId: 'fixture.resident',
    continuation: { schema: 'narada.continuation.v1' },
    continuationRef: ref,
  });

  assert.equal(state?.status, 'linked');
  assert.equal(state?.next_action, null);
});
