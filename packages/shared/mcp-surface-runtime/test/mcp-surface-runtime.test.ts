import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type {
  SurfaceAdmissionDecision,
  SurfaceInvocationContext,
  ToolContractV2,
} from '@narada-core/mcp-fabric-contracts';
import {
  McpSurfaceRuntimeEngine,
  type AdmittedSurfaceBinding,
  type RuntimeSessionBinding,
  type SurfaceRuntimeHandle,
} from '../src/index.js';

const root = mkdtempSync(join(tmpdir(), 'mcp-surface-runtime-'));
const digestA = 'a'.repeat(64);
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.js`, import.meta.url));

test.after(() => rmSync(root, { recursive: true, force: true }));

function tool(name: string, effect: ToolContractV2['effect']['class'] = 'read'): ToolContractV2 {
  return {
    name,
    description: `${name} fixture`,
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    effect: effect === 'read'
      ? { class: 'read', idempotency: 'replayable', confirmation: 'never' }
      : { class: effect, idempotency: 'non_idempotent', confirmation: 'policy' },
  };
}

function binding(input: Partial<AdmittedSurfaceBinding> = {}): AdmittedSurfaceBinding {
  return {
    binding_id: 'fixture-binding',
    site_id: 'fixture-site',
    authority_ref: 'authority:fixture-site',
    surface_id: 'fixture-surface',
    projection_id: 'default',
    tool_contract_digest: digestA,
    tools: [tool('fixture_crash'), tool('fixture_read')],
    execution: { adapter: 'surface_factory', tenancy: 'authority_shared', replacement: 'manual' },
    site_root: root,
    ...input,
  };
}

function session(id: string): RuntimeSessionBinding {
  return { carrier_session_id: id, carrier_id: `carrier-${id}`, agent_id: `agent-${id}` };
}

function context(
  admittedBinding: AdmittedSurfaceBinding,
  boundSession: RuntimeSessionBinding,
  toolName: string,
  decision: SurfaceAdmissionDecision['decision'] = 'admitted',
): SurfaceInvocationContext {
  return {
    request_id: `request-${Math.random()}`,
    carrier_session_id: boundSession.carrier_session_id,
    carrier_id: boundSession.carrier_id,
    agent_id: boundSession.agent_id,
    site_id: admittedBinding.site_id,
    authority_ref: admittedBinding.authority_ref,
    admission: {
      decision,
      decision_ref: `decision-${Math.random()}`,
      authority_ref: admittedBinding.authority_ref,
      surface_id: admittedBinding.surface_id,
      tool_name: toolName,
      reason: decision === 'admitted' ? 'fixture_admitted' : 'fixture_not_admitted',
    },
  };
}

async function invoke(
  engine: McpSurfaceRuntimeEngine,
  handle: SurfaceRuntimeHandle,
  admittedBinding: AdmittedSurfaceBinding,
  boundSession: RuntimeSessionBinding,
  toolName: string,
  decision: SurfaceAdmissionDecision['decision'] = 'admitted',
) {
  return engine.invoke({
    handle_id: handle.handle_id,
    request: { tool_name: toolName, arguments: {} },
    context: context(admittedBinding, boundSession, toolName, decision),
  });
}

test('authority-shared workers are reused across carrier sessions but never across authority bindings', async () => {
  const engine = new McpSurfaceRuntimeEngine();
  const sharedBinding = binding();
  const leftSession = session('left');
  const rightSession = session('right');
  const [left, right] = await Promise.all([
    engine.acquire({ binding: sharedBinding, session: leftSession, adapter: { kind: 'surface_factory', module_path: fixture('shared-surface') } }),
    engine.acquire({ binding: sharedBinding, session: rightSession, adapter: { kind: 'surface_factory', module_path: fixture('shared-surface') } }),
  ]);
  assert.equal(left.instance_id, right.instance_id);
  assert.equal(right.reused, true);
  const leftResult = await invoke(engine, left, sharedBinding, leftSession, 'fixture_read');
  const rightResult = await invoke(engine, right, sharedBinding, rightSession, 'fixture_read');
  assert.equal(leftResult.status, 'ok');
  assert.equal(leftResult.result?.marker, rightResult.result?.marker);
  assert.equal(rightResult.result?.calls, 2);

  await assert.rejects(
    () => engine.acquire({
      binding: binding({ configuration: { variant: 'different' } }),
      session: session('third'),
      adapter: { kind: 'surface_factory', module_path: fixture('shared-surface') },
    }),
    /mcp_surface_runtime_reuse_binding_mismatch/,
  );
  await assert.rejects(
    () => engine.acquire({
      binding: sharedBinding,
      session: session('fourth'),
      adapter: { kind: 'surface_factory', module_path: fixture('sqlite-surface') },
    }),
    /mcp_surface_runtime_reuse_adapter_mismatch/,
  );

  const otherBinding = binding({ binding_id: 'other-binding', authority_ref: 'authority:other-site' });
  const other = await engine.acquire({ binding: otherBinding, session: leftSession, adapter: { kind: 'surface_factory', module_path: fixture('shared-surface') } });
  assert.notEqual(other.instance_id, left.instance_id);
  const otherResult = await invoke(engine, other, otherBinding, leftSession, 'fixture_read');
  assert.notEqual(otherResult.result?.marker, leftResult.result?.marker);
  await engine.release(left.handle_id);
  assert.equal(engine.status().instances.find((instance) => instance.instance_id === right.instance_id)?.session_count, 1);
  await engine.release(right.handle_id);
  assert.equal(engine.status().instances.some((instance) => instance.instance_id === right.instance_id), false);
  assert.equal(engine.status().instances.some((instance) => instance.instance_id === other.instance_id), true);
  await engine.close();
});

test('SQLite state is authority-shared and a non-admitted mutation never enters the surface', async () => {
  const engine = new McpSurfaceRuntimeEngine();
  const sqliteBinding = binding({
    binding_id: 'sqlite-binding',
    surface_id: 'sqlite-fixture',
    tools: [tool('fixture_increment', 'local_write'), tool('fixture_read_count')],
  });
  const firstSession = session('sqlite-one');
  const secondSession = session('sqlite-two');
  const first = await engine.acquire({ binding: sqliteBinding, session: firstSession, adapter: { kind: 'surface_factory', module_path: fixture('sqlite-surface') } });
  const second = await engine.acquire({ binding: sqliteBinding, session: secondSession, adapter: { kind: 'surface_factory', module_path: fixture('sqlite-surface') } });
  const refused = await invoke(engine, first, sqliteBinding, firstSession, 'fixture_increment', 'routed');
  assert.equal(refused.status, 'refused');
  const before = await invoke(engine, second, sqliteBinding, secondSession, 'fixture_read_count');
  assert.equal(before.result?.value, 0);
  const admitted = await invoke(engine, first, sqliteBinding, firstSession, 'fixture_increment');
  assert.equal(admitted.result?.value, 1);
  const after = await invoke(engine, second, sqliteBinding, secondSession, 'fixture_read_count');
  assert.equal(after.result?.value, 1);
  await engine.close();
});

test('session-isolated posture creates distinct instances', async () => {
  const engine = new McpSurfaceRuntimeEngine();
  const isolated = binding({ execution: { adapter: 'surface_factory', tenancy: 'session_isolated', replacement: 'manual' } });
  const left = await engine.acquire({ binding: isolated, session: session('isolated-left'), adapter: { kind: 'surface_factory', module_path: fixture('shared-surface') } });
  const right = await engine.acquire({ binding: isolated, session: session('isolated-right'), adapter: { kind: 'surface_factory', module_path: fixture('shared-surface') } });
  assert.notEqual(left.instance_id, right.instance_id);
  await engine.close();
});

test('generation replacement is explicit, assessed, and preserves logical instance identity', async () => {
  const engine = new McpSurfaceRuntimeEngine();
  const replaceable = binding({
    binding_id: 'replaceable',
    surface_id: 'generation-fixture',
    tools: [tool('fixture_version')],
    execution: { adapter: 'surface_factory', tenancy: 'authority_shared', replacement: 'generation_swap' },
  });
  const boundSession = session('generation');
  const handle = await engine.acquire({ binding: replaceable, session: boundSession, adapter: { kind: 'surface_factory', module_path: fixture('generation-v1') } });
  assert.equal((await invoke(engine, handle, replaceable, boundSession, 'fixture_version')).result?.version, 1);
  const replaced = await engine.replace({
    handle_id: handle.handle_id,
    expected_generation_id: handle.generation_id,
    adapter: { kind: 'surface_factory', module_path: fixture('generation-v2') },
    candidate_tool_contract_digest: digestA,
  });
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.instance_id, handle.instance_id);
  assert.notEqual(replaced.candidate_generation_id, replaced.previous_generation_id);
  assert.equal((await invoke(engine, handle, replaceable, boundSession, 'fixture_version')).result?.version, 2);

  const stale = await engine.replace({
    handle_id: handle.handle_id,
    expected_generation_id: handle.generation_id,
    adapter: { kind: 'surface_factory', module_path: fixture('generation-v2') },
    candidate_tool_contract_digest: digestA,
  });
  assert.equal(stale.status, 'refused');
  assert.equal(stale.assessment.reason, 'expected_generation_mismatch');

  const refused = await engine.replace({
    handle_id: handle.handle_id,
    expected_generation_id: replaced.candidate_generation_id,
    adapter: { kind: 'surface_factory', module_path: fixture('generation-incompatible') },
    candidate_tool_contract_digest: digestA,
  });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.assessment.state_migration_required, true);
  assert.equal((await invoke(engine, handle, replaceable, boundSession, 'fixture_version')).result?.version, 2);
  await engine.close();
});

test('generation replacement is serialized per logical instance', async () => {
  const engine = new McpSurfaceRuntimeEngine();
  const replaceable = binding({
    binding_id: 'serialized-replacement',
    surface_id: 'serialized-generation-fixture',
    tools: [tool('fixture_version')],
    execution: { adapter: 'surface_factory', tenancy: 'authority_shared', replacement: 'generation_swap' },
  });
  const boundSession = session('serialized-generation');
  const handle = await engine.acquire({
    binding: replaceable,
    session: boundSession,
    adapter: { kind: 'surface_factory', module_path: fixture('generation-v1') },
  });
  const first = engine.replace({
    handle_id: handle.handle_id,
    expected_generation_id: handle.generation_id,
    adapter: { kind: 'surface_factory', module_path: fixture('generation-v3-slow') },
    candidate_tool_contract_digest: digestA,
  });
  const concurrent = await engine.replace({
    handle_id: handle.handle_id,
    expected_generation_id: handle.generation_id,
    adapter: { kind: 'surface_factory', module_path: fixture('generation-v2') },
    candidate_tool_contract_digest: digestA,
  });

  assert.equal(concurrent.status, 'refused');
  assert.equal(concurrent.assessment.reason, 'replacement_already_in_progress');
  assert.equal((await first).status, 'replaced');
  assert.equal((await invoke(engine, handle, replaceable, boundSession, 'fixture_version')).result?.version, 3);
  await engine.close();
});

test('last-session release waits for an in-progress replacement before disposing the instance', async () => {
  const engine = new McpSurfaceRuntimeEngine();
  const replaceable = binding({
    binding_id: 'release-during-replacement',
    surface_id: 'release-during-replacement-fixture',
    tools: [tool('fixture_version')],
    execution: { adapter: 'surface_factory', tenancy: 'authority_shared', replacement: 'generation_swap' },
  });
  const boundSession = session('release-during-replacement');
  const handle = await engine.acquire({
    binding: replaceable,
    session: boundSession,
    adapter: { kind: 'surface_factory', module_path: fixture('generation-v1') },
  });
  let replacementCompleted = false;
  const replacement = engine.replace({
    handle_id: handle.handle_id,
    expected_generation_id: handle.generation_id,
    adapter: { kind: 'surface_factory', module_path: fixture('generation-v3-slow') },
    candidate_tool_contract_digest: digestA,
  }).finally(() => { replacementCompleted = true; });

  await new Promise((resolve) => setTimeout(resolve, 10));
  await engine.release(handle.handle_id);
  assert.equal(replacementCompleted, true);
  assert.equal((await replacement).status, 'replaced');
  assert.deepEqual(engine.status().instances, []);
  await engine.close();
});

test('engine shutdown waits for starting workers and prevents a late acquire from escaping', async () => {
  const engine = new McpSurfaceRuntimeEngine();
  const starting = engine.acquire({
    binding: binding({
      binding_id: 'close-during-start',
      surface_id: 'close-during-start-fixture',
      tools: [tool('fixture_version')],
      execution: { adapter: 'surface_factory', tenancy: 'authority_shared', replacement: 'generation_swap' },
    }),
    session: session('close-during-start'),
    adapter: { kind: 'surface_factory', module_path: fixture('generation-v3-slow') },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  await engine.close();
  await assert.rejects(starting, /mcp_surface_runtime_engine_closed/);
  assert.deepEqual(engine.status().instances, []);
});

test('engine shutdown drains an admitted in-flight call before disposing its worker', async () => {
  const engine = new McpSurfaceRuntimeEngine();
  const admittedBinding = binding({
    binding_id: 'close-during-call',
    surface_id: 'close-during-call-fixture',
    tools: [tool('fixture_version')],
    execution: { adapter: 'surface_factory', tenancy: 'authority_shared', replacement: 'generation_swap' },
  });
  const boundSession = session('close-during-call');
  const handle = await engine.acquire({
    binding: admittedBinding,
    session: boundSession,
    adapter: { kind: 'surface_factory', module_path: fixture('generation-v3-slow') },
  });
  const call = invoke(engine, handle, admittedBinding, boundSession, 'fixture_version');
  await new Promise((resolve) => setTimeout(resolve, 10));

  await engine.close();
  assert.equal((await call).result?.version, 3);
  assert.deepEqual(engine.status().instances, []);
});

test('one worker crash does not terminate unrelated surface instances', async () => {
  const engine = new McpSurfaceRuntimeEngine();
  const crashingBinding = binding({ binding_id: 'crashing' });
  const healthyBinding = binding({ binding_id: 'healthy', authority_ref: 'authority:healthy' });
  const crashingSession = session('crashing');
  const healthySession = session('healthy');
  const crashing = await engine.acquire({ binding: crashingBinding, session: crashingSession, adapter: { kind: 'surface_factory', module_path: fixture('shared-surface') } });
  const healthy = await engine.acquire({ binding: healthyBinding, session: healthySession, adapter: { kind: 'surface_factory', module_path: fixture('shared-surface') } });
  const crash = await invoke(engine, crashing, crashingBinding, crashingSession, 'fixture_crash');
  assert.equal(crash.status, 'failed');
  const surviving = await invoke(engine, healthy, healthyBinding, healthySession, 'fixture_read');
  assert.equal(surviving.status, 'ok');
  assert.equal(engine.status().instances.find((entry) => entry.instance_id === crashing.instance_id)?.state, 'unavailable');
  assert.equal(engine.status().instances.find((entry) => entry.instance_id === healthy.instance_id)?.state, 'ready');
  await engine.close();
});

test('stdio compatibility adapter remains available and reports its actual process', async () => {
  const engine = new McpSurfaceRuntimeEngine();
  const stdioBinding = binding({
    binding_id: 'stdio-binding',
    surface_id: 'stdio-fixture',
    tools: [tool('fixture_stdio_read')],
    execution: { adapter: 'stdio', tenancy: 'session_isolated', replacement: 'manual' },
  });
  const boundSession = session('stdio');
  const handle = await engine.acquire({
    binding: stdioBinding,
    session: boundSession,
    adapter: { kind: 'stdio', executable: process.execPath, args: [fixture('stdio-surface')] },
  });
  const result = await invoke(engine, handle, stdioBinding, boundSession, 'fixture_stdio_read');
  assert.equal(result.status, 'ok');
  assert.equal(typeof (result.result?.structuredContent as Record<string, unknown>)?.pid, 'number');
  const status = engine.status().instances[0]!;
  assert.equal(status.adapter, 'stdio');
  assert.equal(status.runtime.executable, process.execPath);
  assert.equal(status.runtime.pid > 0, true);
  await engine.close();
});
