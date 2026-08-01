import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  CanonicalInvocationPlanError,
  readCanonicalInvocationPlan,
} from '../src/canonical-invocation-plan.js';
import { writeCanonicalPlanRegistry } from './canonical-plan-fixture.js';

function fixture(options: { validUntil?: string } = {}) {
  const root = mkdtempSync(join(testTempRoot(), 'worker-canonical-plan-'));
  mkdirSync(join(root, '.ai'), { recursive: true });
  const databasePath = join(root, '.ai', 'intelligence-registry.db');
  writeCanonicalPlanRegistry({
    databasePath,
    planRef: 'plan:canonical-worker-test',
    targetSite: 'site:worker-target',
    principal: 'principal:worker-test',
    provider: 'kimi-code-api',
    model: 'k3',
    ...options,
  });
  return { root, databasePath };
}

test('canonical worker plan is dereferenced from durable authority with target and purpose binding', () => {
  const { root, databasePath } = fixture();
  try {
    const binding = readCanonicalInvocationPlan({
      databasePath,
      planRef: 'plan:canonical-worker-test',
      expectedPurpose: 'local-agent-runtime',
      expectedTargetSite: 'site:worker-target',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    assert.equal(binding.provider, 'kimi-code-api');
    assert.equal(binding.model_ref, 'model:k3');
    assert.equal(binding.invocation_model_key, 'k3');
    assert.equal(binding.intent_ref, 'intent:canonical-worker-test');
    assert.equal(binding.purpose, 'local-agent-runtime');
    assert.equal(binding.snapshot_digest, `sha256:${'1'.repeat(64)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical worker plan refuses foreign Site, purpose, expiry, and missing plan refs', () => {
  const { root, databasePath } = fixture({ validUntil: '2026-08-02T00:00:00.000Z' });
  try {
    const base = {
      databasePath,
      planRef: 'plan:canonical-worker-test',
      expectedPurpose: 'local-agent-runtime',
      expectedTargetSite: 'site:worker-target',
      now: new Date('2026-08-01T00:00:00.000Z'),
    };
    assertCode(() => readCanonicalInvocationPlan({ ...base, expectedTargetSite: 'site:foreign' }), 'worker_canonical_invocation_plan_target_mismatch');
    assertCode(() => readCanonicalInvocationPlan({ ...base, expectedPurpose: 'operator-chat' }), 'worker_canonical_invocation_plan_purpose_mismatch');
    assertCode(() => readCanonicalInvocationPlan({ ...base, now: new Date('2026-08-03T00:00:00.000Z') }), 'worker_canonical_invocation_plan_expired');
    assertCode(() => readCanonicalInvocationPlan({ ...base, planRef: 'plan:missing' }), 'worker_canonical_invocation_plan_not_found');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function assertCode(action: () => unknown, codeName: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CanonicalInvocationPlanError);
    assert.equal(error.codeName, codeName);
    return true;
  });
}

function testTempRoot(): string {
  return process.env.TEMP ?? process.env.TMP ?? 'D:\\tmp';
}
