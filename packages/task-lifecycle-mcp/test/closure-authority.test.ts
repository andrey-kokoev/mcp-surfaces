import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimLifecycleTask } from '../src/task-lifecycle/task-lifecycle-mutation-services.js';
import { deriveClosureAuthority, terminalTaskMutationGuard } from '../src/task-lifecycle/closure-authority.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-closure-authority-'));

function storeFor(lifecycle: Record<string, unknown>) {
  const assignments: Record<string, unknown>[] = [];
  return {
    db: { exec() {} },
    getLifecycleByNumber: () => lifecycle,
    getActiveAssignment: () => null,
    insertAssignment: (assignment: Record<string, unknown>) => assignments.push(assignment),
    updateStatus: (_taskId: string, status: string) => { lifecycle.status = status; },
    assignments,
  };
}

function lifecycle(status: string, overrides: Record<string, unknown> = {}) {
  return {
    task_id: `task-${status}`,
    task_number: 2400,
    status,
    closed_at: null,
    closed_by: null,
    reopened_at: null,
    reopened_by: null,
    continuation_packet_json: null,
    ...overrides,
  };
}

try {
  const closed = lifecycle('closed', { closed_at: '2026-07-19T10:00:00.000Z', closed_by: 'prior-agent' });
  const closedAuthority = deriveClosureAuthority(closed);
  assert.equal(closedAuthority.closure_dominates, true);
  assert.equal(closedAuthority.terminal_state_requires_reopen, true);
  assert.equal(terminalTaskMutationGuard(closed, 'outcome_admission')?.error, 'terminal_task_mutation_requires_reopen');
  const closedStore = storeFor(closed);
  const closedClaim = await claimLifecycleTask({ siteRoot, store: closedStore, taskNumber: 2400, agentId: 'new-agent' });
  assert.equal(closedClaim.status, 'closure_authority_blocks_claim');
  assert.equal(closedStore.assignments.length, 0);

  const confirmed = lifecycle('confirmed');
  assert.equal(deriveClosureAuthority(confirmed).closure_dominates, true);
  const confirmedClaim = await claimLifecycleTask({ siteRoot, store: storeFor(confirmed), taskNumber: 2400, agentId: 'new-agent' });
  assert.equal(confirmedClaim.status, 'closure_authority_blocks_claim');

  const reopened = lifecycle('opened', {
    closed_at: '2026-07-19T10:00:00.000Z',
    closed_by: 'prior-agent',
    reopened_at: '2026-07-19T11:00:00.000Z',
    reopened_by: 'operator',
  });
  assert.equal(deriveClosureAuthority(reopened).closure_dominates, false);
  const reopenedStore = storeFor(reopened);
  const reopenedClaim = await claimLifecycleTask({ siteRoot, store: reopenedStore, taskNumber: 2400, agentId: 'new-agent' });
  assert.equal(reopenedClaim.status, 'claimed');
  assert.equal(reopenedStore.assignments.length, 1);

  const ordinary = lifecycle('opened');
  assert.equal(terminalTaskMutationGuard(ordinary, 'outcome_admission'), null);
  const ordinaryStore = storeFor(ordinary);
  const ordinaryClaim = await claimLifecycleTask({ siteRoot, store: ordinaryStore, taskNumber: 2400, agentId: 'new-agent' });
  assert.equal(ordinaryClaim.status, 'claimed');

  console.log('closure authority tests passed');
} finally {
  rmSync(siteRoot, { recursive: true, force: true });
}
