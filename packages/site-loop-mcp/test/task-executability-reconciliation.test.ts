import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessmentForRequest,
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

const translated = assessmentForRequest({
  schema: 'narada.task.executability.assessment.v1',
  version: 1,
  dimensions: [{ id: 'scope', status: 'clear' }],
  first_actions: [{ action: 'inspect' }],
  reference_resolutions: [],
  acceptance_mappings: [{ criterion: 'one', mapped: true }],
  required_decisions: [],
  findings: [],
  evaluator_provenance: {
    runtime: 'narada-agent-runtime-server',
    provider: 'kimi-code-api',
    model: 'k3',
    cognition: 'low',
    profile_version: '1.0.0',
  },
}, {
  request_id: 'request-translation',
  task_id: 'task-translation',
  task_number: 42,
  task_spec_digest: 'sha256:task',
  environment_digest: 'sha256:environment',
  evaluator_profile: 'profile',
  evaluator_profile_version: '1.0.0',
} as any, {
  task_id: 'delegated-translation',
  worker_refs: [{ run_id: 'worker-translation' }],
});
assert.equal(translated.schema, 'narada.task_executability_assessment.v1');
assert.equal(translated.evaluator.schema, 'narada.task_executability_evaluator_provenance.v1');
assert.equal(translated.evaluator.provider, 'kimi-code-api');
assert.equal(translated.evaluator.model, 'k3');
assert.equal(translated.evaluator.delegated_task_id, 'delegated-translation');
assert.equal(translated.evaluator.worker_run_id, 'worker-translation');

const translatedRunRef = assessmentForRequest({
  schema: 'narada.task.executability.assessment.v1',
  version: 1,
  dimensions: [],
  first_actions: [],
  reference_resolutions: [],
  acceptance_mappings: [],
  required_decisions: [],
  findings: [],
  evaluator_provenance: { provider: 'kimi-code-api', model: 'k3', cognition: 'low', profile_version: '1.0.0' },
}, {
  request_id: 'request-run-ref',
  task_id: 'task-run-ref',
  task_number: 43,
  task_spec_digest: 'sha256:task-run-ref',
  environment_digest: 'sha256:environment-run-ref',
  evaluator_profile: 'profile',
  evaluator_profile_version: '1.0.0',
} as any, {
  task_id: 'delegated-run-ref',
  run_refs: [{ run_id: 'run-run-ref' }],
});
assert.equal(translatedRunRef.evaluator.delegated_task_id, 'delegated-run-ref');
assert.equal(translatedRunRef.evaluator.worker_run_id, 'run-run-ref');

console.log('site-loop task executability reconciliation contract ok');
