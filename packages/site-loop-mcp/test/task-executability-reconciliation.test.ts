import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runTaskExecutabilityReconciliation,
  TASK_EXECUTABILITY_SITE_LOOP_SCHEMA,
} from '../src/site-loop/task-executability-reconciliation.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-task-executability-'));

const unbound = await runTaskExecutabilityReconciliation(siteRoot);
assert.equal(unbound.schema, TASK_EXECUTABILITY_SITE_LOOP_SCHEMA);
assert.equal(unbound.status, 'deferred');
assert.equal(unbound.reason, 'task_lifecycle_store_not_bound');
assert.deepEqual(unbound.attention, {
  code: 'task_executability_reconciliation_not_bound',
  severity: 'warning',
});

let observedLimit = 0;
const attentionOrchestrator = {
  async reconcileAll(limit: number) {
    observedLimit = limit;
    return {
      schema: 'narada.task.executability.orchestrator.v1',
      stopped: 'limit' as const,
      results: [
        {
          schema: 'narada.task.executability.orchestrator.v1',
          outcome: 'failed_retryable' as const,
          request_id: 'request-retryable',
          reason: 'worker_not_available',
        },
      ],
    };
  },
};
const attention = await runTaskExecutabilityReconciliation(siteRoot, {
  orchestrator: attentionOrchestrator,
  limit: 100,
});
assert.equal(observedLimit, 10);
assert.equal(attention.schema, TASK_EXECUTABILITY_SITE_LOOP_SCHEMA);
assert.equal(attention.status, 'attention');
const attentionCounts = attention.counts as { failures: number };
const attentionDetails = attention.attention as { code: string; severity: string };
assert.equal(attentionCounts.failures, 1);
assert.equal(attentionDetails.code, 'task_executability_reconciliation_failure');
assert.equal(attentionDetails.severity, 'warning');

const healthyOrchestrator = {
  async reconcileAll(limit: number) {
    assert.equal(limit, 2);
    return {
      schema: 'narada.task.executability.orchestrator.v1',
      stopped: 'idle' as const,
      results: [
        { schema: 'narada.task.executability.orchestrator.v1', outcome: 'completed' as const, request_id: 'request-done' },
        { schema: 'narada.task.executability.orchestrator.v1', outcome: 'idle' as const },
      ],
    };
  },
};
const healthy = await runTaskExecutabilityReconciliation(siteRoot, {
  orchestrator: healthyOrchestrator,
  limit: 2,
});
assert.equal(healthy.status, 'ok');
assert.deepEqual(healthy.counts, {
  completed: 1,
  dispatched: 0,
  idle: 1,
  failures: 0,
});
assert.equal(healthy.attention, null);

console.log('site-loop task executability reconciliation contract ok');
