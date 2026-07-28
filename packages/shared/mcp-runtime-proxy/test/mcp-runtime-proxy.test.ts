import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SURFACE_DESCRIBE_TOOL_NAME,
  defineSurface,
} from '@narada2/mcp-fabric-contracts';
import {
  clientVisibleToolDefinitions,
  effectiveRequestTimeoutMs,
} from '../src/main.js';
import {
  RUNTIME_INSTANCE_SCHEMA,
  captureRuntimeFreshness,
  classifyRuntimeInstance,
  evaluateRuntimeFreshness,
  listRuntimeInstances,
  runtimeInstancePath,
  writeRuntimeInstance,
  type RuntimeInstanceRecord,
} from '../src/runtime-lifecycle.js';

const root = mkdtempSync(join(tmpdir(), 'mcp-runtime-proxy-v3-'));

assert.equal(effectiveRequestTimeoutMs(100, null, 60_000), 100);
assert.equal(effectiveRequestTimeoutMs(100, 300, 1_000), 1_300);
assert.equal(effectiveRequestTimeoutMs(100, 900_000, 60_000), 960_000);

const nativeTool = {
  name: 'proxy_test_guidance',
  description: 'Describe the proxy test surface.',
  inputSchema: { type: 'object', additionalProperties: false },
};
const proxyTestSurface = defineSurface({
  surface_id: 'proxy-test',
  surface_version: '1.0.0',
  package: '@narada-test/proxy-test',
  tools: [{
    definition: nativeTool,
    effect: { class: 'read', idempotency: 'replayable', confirmation: 'never' },
  }],
  projections: [{
    id: 'default',
    transport: { kind: 'stdio', command: 'node', args: ['dist/main.js'], env: [] },
    injection_scope: 'local_site',
    default_injection: 'enabled',
    runtime_requirements: [],
    authority_requirements: ['scope.local_site'],
    lifecycle: { mode: 'replayable' },
  }],
});
const exposedSubset = clientVisibleToolDefinitions({
  descriptor: proxyTestSurface.descriptor,
  surface_id: proxyTestSurface.descriptor.surface_id,
  client_tool_names: ['proxy_test_guidance', SURFACE_DESCRIBE_TOOL_NAME],
}, [nativeTool]);
assert.deepEqual(
  exposedSubset.map((tool) => tool.name),
  ['proxy_test_guidance', SURFACE_DESCRIBE_TOOL_NAME],
);
assert.equal(exposedSubset[1]?.annotations?.readOnlyHint, true);

const runtimeRoot = join(root, 'sealed');
mkdirSync(runtimeRoot, { recursive: true });
const proxyRuntime = join(runtimeRoot, 'proxy.js');
const childRuntime = join(runtimeRoot, 'child.js');
const generationPath = join(root, 'generation.json');
writeFileSync(proxyRuntime, 'export {};\n', 'utf8');
writeFileSync(childRuntime, 'export {};\n', 'utf8');
writeFileSync(generationPath, '{"generation":"v3"}\n', 'utf8');

const tracker = captureRuntimeFreshness({
  proxyRuntimePath: proxyRuntime,
  childEntrypoint: childRuntime,
  carrierGenerationPath: generationPath,
  carrierGenerationDigest: `sha256:${'a'.repeat(64)}`,
});
const pinned = evaluateRuntimeFreshness({
  tracker,
  surfaceId: 'freshness-test',
});
assert.equal(pinned.status, 'pinned');
assert.equal(pinned.source_policy, 'validated_at_process_start');
assert.equal(pinned.update_policy, 'restart_to_select_latest_compatible');

writeFileSync(childRuntime, 'export const changed = true;\n', 'utf8');
const corrupt = evaluateRuntimeFreshness({
  tracker,
  surfaceId: 'freshness-test',
});
assert.equal(corrupt.status, 'corrupt');
assert.ok(
  (corrupt.reasons as Array<Record<string, unknown>>)
    .some((reason) => reason.code === 'sealed_runtime_file_changed'),
);

const instanceRoot = join(root, 'instances');
const now = new Date();
const liveInstance: RuntimeInstanceRecord = {
  schema: RUNTIME_INSTANCE_SCHEMA,
  surface_id: 'live-surface',
  server_key: 'live-server',
  proxy_pid: process.pid,
  parent_pid: process.ppid,
  child_pid: null,
  supervisor_pid: null,
  managed_child_pid: null,
  server_pid: null,
  entrypoint: childRuntime,
  started_at: now.toISOString(),
  heartbeat_at: now.toISOString(),
  lease_expires_at: new Date(now.getTime() + 10_000).toISOString(),
  state: 'live',
  liveness_evidence: { parent_pid_alive: true },
  runtime_freshness: { status: 'pinned' },
  carrier_generation_path: generationPath,
  carrier_generation_digest: `sha256:${'a'.repeat(64)}`,
  closure_digest: `sha256:${'b'.repeat(64)}`,
  receipt_digest: `sha256:${'c'.repeat(64)}`,
  generation_id: 'generation-test',
  closed_at: null,
};
writeRuntimeInstance(runtimeInstancePath(instanceRoot, process.pid), liveInstance);
assert.equal(
  classifyRuntimeInstance(liveInstance, { isPidAlive: () => true }).observed_state,
  'live',
);
const deadChild = { ...liveInstance, child_pid: 424_242 };
assert.ok(
  classifyRuntimeInstance(deadChild, { isPidAlive: (pid) => pid !== 424_242 })
    .stale_reasons.includes('child_pid_not_alive'),
);
const listing = listRuntimeInstances(instanceRoot, { isPidAlive: () => true });
assert.equal((listing.counts as Record<string, unknown>).live, 1);
