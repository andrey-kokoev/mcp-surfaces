import { randomUUID } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { writeHeapSnapshot } from 'node:v8';
import { rename, rm, stat } from 'node:fs/promises';
import { Ajv, type ValidateFunction } from 'ajv';
import {
  stableDigest,
  surfaceExecutionDeclaration,
  type SurfaceExecutionDeclaration,
  type SurfaceReplacementCandidate,
  type SurfaceRuntimeInit,
} from '@narada-core/mcp-fabric-contracts';
import type { RuntimeLifecycleEventV1, RuntimeResourceOwnerV1 } from '@narada-core/mcp-fabric-contracts';
import type { RuntimeObservationSink } from '@narada-core/mcp-runtime-observation';
import { StdioSurfaceAdapter } from './stdio-adapter.js';
import type {
  AcquireSurfaceInput,
  AdapterStartInput,
  AdmittedSurfaceBinding,
  InvokeSurfaceInput,
  ReplaceSurfaceInput,
  RuntimeGenerationAdapter,
  RuntimeSessionBinding,
  SurfaceAdapterSpec,
  SurfaceInvocationOutcome,
  SurfaceReplacementOutcome,
  SurfaceRuntimeHandle,
  SurfaceRuntimeInstanceStatus,
  SurfaceRuntimeResourceSnapshot,
} from './types.js';
import { WorkerSurfaceAdapter } from './worker-adapter.js';

type Generation = {
  id: string;
  adapter: RuntimeGenerationAdapter;
  toolContractDigest: string;
  inflight: number;
  invocationCount: number;
};

type Instance = {
  id: string;
  binding: AdmittedSurfaceBinding;
  bindingFingerprint: string;
  adapterFingerprint: string;
  execution: SurfaceExecutionDeclaration;
  state: SurfaceRuntimeInstanceStatus['state'];
  generation: Generation;
  handles: Set<string>;
  replacementBarrier: Promise<void> | null;
  replacementCompletion: Promise<void> | null;
  replacementInProgress: boolean;
  inputValidators: Map<string, ValidateFunction>;
  outputValidators: Map<string, ValidateFunction>;
};

type HandleRecord = {
  instance: Instance;
  session: RuntimeSessionBinding;
};

export class McpSurfaceRuntimeEngine {
  #instances = new Map<string, Instance>();
  #handles = new Map<string, HandleRecord>();
  #starting = new Map<string, Promise<Instance>>();
  #closed = false;
  readonly #observationSink: RuntimeObservationSink | null;
  readonly #observationParentOwnerId: string | null;

  constructor(options: { observation_sink?: RuntimeObservationSink; observation_parent_owner_id?: string } = {}) {
    this.#observationSink = options.observation_sink ?? null;
    this.#observationParentOwnerId = options.observation_parent_owner_id ?? null;
  }

  async acquire(input: AcquireSurfaceInput): Promise<SurfaceRuntimeHandle> {
    this.#assertOpen();
    const execution = surfaceExecutionDeclaration(input.binding.execution);
    assertAdapterMatches(execution, input.adapter);
    const instanceId = runtimeInstanceId(input.binding, input.session, execution);
    const existing = this.#instances.get(instanceId);
    const reused = existing !== undefined || this.#starting.has(instanceId);
    const instance = existing ?? await this.#acquireStarted(instanceId, input, execution);
    this.#assertOpen();
    assertInstanceCompatible(instance, input);
    const handleId = `surface-handle-${randomUUID()}`;
    instance.handles.add(handleId);
    this.#handles.set(handleId, { instance, session: input.session });
    this.#emitLifecycle(instance, reused ? 'instance_reused' : 'instance_acquired', null, 'ok');
    return {
      handle_id: handleId,
      instance_id: instance.id,
      generation_id: instance.generation.id,
      reused,
      execution,
    };
  }

  async invoke(input: InvokeSurfaceInput): Promise<SurfaceInvocationOutcome> {
    this.#assertOpen();
    const record = this.#requireHandle(input.handle_id);
    if (record.instance.replacementBarrier) await record.instance.replacementBarrier;
    this.#assertOpen();
    const { instance, session } = record;
    const declaration = instance.binding.tools.find((tool) => tool.name === input.request.tool_name);
    if (!declaration) throw new Error(`mcp_surface_runtime_tool_not_admitted:${input.request.tool_name}`);
    const inputValidator = instance.inputValidators.get(declaration.name);
    if (!inputValidator?.(input.request.arguments)) {
      throw new Error(`mcp_surface_runtime_arguments_invalid:${declaration.name}:${formatValidationErrors(inputValidator?.errors)}`);
    }
    assertInvocationContext(instance.binding, session, input);
    const admission = input.context.admission;
    this.#emitLifecycle(instance, 'invocation_started', input.context.request_id, null);
    if (admission.decision !== 'admitted') {
      this.#emitLifecycle(instance, 'invocation_terminal', input.context.request_id, 'refused');
      return {
        schema: 'narada.mcp_surface_runtime.invocation.v1',
        request_id: input.context.request_id,
        instance_id: instance.id,
        generation_id: instance.generation.id,
        surface_id: instance.binding.surface_id,
        tool_name: input.request.tool_name,
        status: 'refused',
        admission,
        error: { code: 'tool_effect_not_admitted', message: admission.reason },
      };
    }

    const generation = instance.generation;
    generation.inflight += 1;
    generation.invocationCount += 1;
    try {
      const result = await generation.adapter.call(input.request, input.context);
      const outputValidator = instance.outputValidators.get(declaration.name);
      if (outputValidator && !outputValidator(result)) {
        throw new Error(`mcp_surface_runtime_result_invalid:${declaration.name}:${formatValidationErrors(outputValidator.errors)}`);
      }
      const outcome: SurfaceInvocationOutcome = {
        schema: 'narada.mcp_surface_runtime.invocation.v1',
        request_id: input.context.request_id,
        instance_id: instance.id,
        generation_id: generation.id,
        surface_id: instance.binding.surface_id,
        tool_name: input.request.tool_name,
        status: 'ok',
        admission,
        result,
      };
      this.#emitLifecycle(instance, 'invocation_terminal', input.context.request_id, 'ok');
      return outcome;
    } catch (error) {
      const health = await generation.adapter.health().catch(() => ({ status: 'unavailable' as const }));
      if (health.status !== 'healthy') instance.state = health.status === 'unavailable' ? 'unavailable' : 'degraded';
      const outcome: SurfaceInvocationOutcome = {
        schema: 'narada.mcp_surface_runtime.invocation.v1',
        request_id: input.context.request_id,
        instance_id: instance.id,
        generation_id: generation.id,
        surface_id: instance.binding.surface_id,
        tool_name: input.request.tool_name,
        status: 'failed',
        admission,
        error: {
          code: String((error as { code?: unknown })?.code ?? 'surface_runtime_call_failed'),
          message: error instanceof Error ? error.message : String(error),
        },
      };
      this.#emitLifecycle(instance, 'invocation_terminal', input.context.request_id, 'failed');
      return outcome;
    } finally {
      generation.inflight -= 1;
    }
  }

  async replace(input: ReplaceSurfaceInput): Promise<SurfaceReplacementOutcome> {
    this.#assertOpen();
    const { instance } = this.#requireHandle(input.handle_id);
    const previous = instance.generation;
    const candidateId = generationId(instance.binding.surface_id);
    if (input.expected_generation_id !== previous.id) {
      return replacementRefusal(instance.id, previous.id, candidateId, 'expected_generation_mismatch');
    }
    if (instance.replacementInProgress) {
      return replacementRefusal(instance.id, previous.id, candidateId, 'replacement_already_in_progress');
    }
    if (instance.execution.replacement !== 'generation_swap') {
      return replacementRefusal(instance.id, previous.id, candidateId, 'replacement_policy_manual');
    }
    if (instance.execution.adapter !== 'surface_factory') {
      return replacementRefusal(instance.id, previous.id, candidateId, 'generation_swap_requires_surface_factory');
    }
    if (input.candidate_tool_contract_digest !== instance.binding.tool_contract_digest) {
      return replacementRefusal(instance.id, previous.id, candidateId, 'candidate_contract_not_admitted');
    }

    instance.replacementInProgress = true;
    this.#emitLifecycle(instance, 'replacement_started', null, null);
    let completeReplacement: () => void = () => undefined;
    instance.replacementCompletion = new Promise<void>((resolve) => { completeReplacement = resolve; });
    const init = runtimeInit(instance.binding, candidateId, input.candidate_tool_contract_digest);
    let candidate: RuntimeGenerationAdapter | null = null;
    let releaseBarrier: () => void = () => undefined;
    let barrierInstalled = false;
    try {
      candidate = await startAdapter({ adapter: input.adapter, init });
      assertToolInventory(instance.binding, candidate.toolNames);
      const health = await candidate.health();
      if (health.status !== 'healthy') {
        await candidate.close();
        return replacementRefusal(instance.id, previous.id, candidateId, `candidate_${health.status}`);
      }
      const assessmentInput: SurfaceReplacementCandidate = {
        previous_generation_id: previous.id,
        previous_tool_contract_digest: previous.toolContractDigest,
        candidate_generation_id: candidateId,
        candidate_tool_contract_digest: input.candidate_tool_contract_digest,
      };
      const assessment = await candidate.assessReplacement(assessmentInput);
      if (!assessment || !assessment.compatible || assessment.state_migration_required === true) {
        await candidate.close();
        return {
          schema: 'narada.mcp_surface_runtime.replacement.v1',
          instance_id: instance.id,
          previous_generation_id: previous.id,
          candidate_generation_id: candidateId,
          status: 'refused',
          assessment: assessment ?? { compatible: false, reason: 'replacement_assessment_missing' },
        };
      }

      instance.state = 'restarting';
      instance.replacementBarrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
      barrierInstalled = true;
      await waitForDrain(previous, input.drain_timeout_ms ?? 10_000);
      instance.generation = {
        id: candidateId,
        adapter: candidate,
        toolContractDigest: input.candidate_tool_contract_digest,
        inflight: 0,
        invocationCount: 0,
      };
      candidate = null;
      instance.state = 'ready';
      releaseBarrier();
      instance.replacementBarrier = null;
      await previous.adapter.close();
      this.#emitLifecycle(instance, 'replacement_terminal', null, 'ok');
      return {
        schema: 'narada.mcp_surface_runtime.replacement.v1',
        instance_id: instance.id,
        previous_generation_id: previous.id,
        candidate_generation_id: candidateId,
        status: 'replaced',
        assessment,
      };
    } catch (error) {
      if (candidate) await candidate.close().catch(() => undefined);
      if (barrierInstalled) releaseBarrier();
      instance.replacementBarrier = null;
      instance.state = 'ready';
      this.#emitLifecycle(instance, 'replacement_terminal', null, 'failed');
      return {
        schema: 'narada.mcp_surface_runtime.replacement.v1',
        instance_id: instance.id,
        previous_generation_id: previous.id,
        candidate_generation_id: candidateId,
        status: 'failed',
        assessment: { compatible: false, reason: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      instance.replacementInProgress = false;
      completeReplacement();
      instance.replacementCompletion = null;
    }
  }

  status(): { schema: 'narada.mcp_surface_runtime.status.v1'; instances: SurfaceRuntimeInstanceStatus[] } {
    return {
      schema: 'narada.mcp_surface_runtime.status.v1',
      instances: [...this.#instances.values()].map((instance) => ({
        instance_id: instance.id,
        binding_id: instance.binding.binding_id,
        site_id: instance.binding.site_id,
        authority_ref: instance.binding.authority_ref,
        surface_id: instance.binding.surface_id,
        projection_id: instance.binding.projection_id,
        generation_id: instance.generation.id,
        state: instance.state,
        tenancy: instance.execution.tenancy,
        adapter: instance.generation.adapter.kind,
        session_count: instance.handles.size,
        inflight: instance.generation.inflight,
        runtime: instance.generation.adapter.runtime,
      })),
    };
  }

  async resourceSnapshot(): Promise<SurfaceRuntimeResourceSnapshot> {
    const sampledAt = new Date().toISOString();
    const memory = process.memoryUsage();
    const heap = getHeapStatistics();
    const statuses = this.status().instances;
    const instances = await Promise.all(statuses.map(async (status) => {
      const instance = this.#instances.get(status.instance_id);
      if (!instance) return { ...status, resource_status: 'unavailable' as const, resources: null, unavailable_reason: 'instance_retired_during_sample' };
      try {
        const resources = await instance.generation.adapter.resourceSnapshot(
          instance.generation.inflight,
          instance.generation.invocationCount,
        );
        return resources
          ? { ...status, resource_status: 'complete' as const, resources, unavailable_reason: null }
          : { ...status, resource_status: 'unavailable' as const, resources: null, unavailable_reason: 'adapter_resource_probe_unavailable' };
      } catch (error) {
        return { ...status, resource_status: 'unavailable' as const, resources: null, unavailable_reason: sanitizeProbeError(error) };
      }
    }));
    return {
      schema: 'narada.mcp_surface_runtime.resources.v1',
      sampled_at: sampledAt,
      parent: {
        pid: process.pid,
        sampled_at: sampledAt,
        heap_total_bytes: memory.heapTotal,
        heap_used_bytes: memory.heapUsed,
        external_bytes: memory.external,
        array_buffers_bytes: memory.arrayBuffers,
        heap_limit_bytes: heap.heap_size_limit,
        active_resource_counts: countActiveResourceClasses(),
        invocation_count: [...this.#instances.values()].reduce((sum, value) => sum + value.generation.invocationCount, 0),
        inflight: [...this.#instances.values()].reduce((sum, value) => sum + value.generation.inflight, 0),
      },
      instances,
    };
  }

  async writeHeapSnapshot(input: {
    target: 'service_parent' | 'surface_generation';
    path: string;
    max_bytes: number;
    instance_id?: string;
    expected_generation_id?: string;
  }): Promise<{ path: string; bytes: number; generation_id: string | null }> {
    if (!Number.isSafeInteger(input.max_bytes) || input.max_bytes < 1024 * 1024 || input.max_bytes > 512 * 1024 * 1024) {
      throw new Error('mcp_surface_runtime_heap_snapshot_size_limit_invalid');
    }
    const temporary = `${input.path}.${process.pid}.tmp`;
    await rm(temporary, { force: true });
    if (input.target === 'service_parent') {
      try {
        writeHeapSnapshot(temporary);
        const bytes = (await stat(temporary)).size;
        if (bytes > input.max_bytes) throw new Error('mcp_surface_runtime_heap_snapshot_size_limit');
        await rename(temporary, input.path);
        return { path: input.path, bytes, generation_id: null };
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    const instance = this.#instances.get(String(input.instance_id ?? ''));
    if (!instance) throw new Error('mcp_surface_runtime_heap_snapshot_instance_unknown');
    if (instance.generation.id !== input.expected_generation_id) throw new Error('mcp_surface_runtime_heap_snapshot_generation_mismatch');
    const bytes = await instance.generation.adapter.writeHeapSnapshot(temporary, input.max_bytes);
    await rename(temporary, input.path);
    return { path: input.path, bytes, generation_id: instance.generation.id };
  }

  async release(handleId: string): Promise<void> {
    const record = this.#handles.get(handleId);
    if (!record) return;
    this.#handles.delete(handleId);
    record.instance.handles.delete(handleId);
    this.#emitLifecycle(record.instance, 'instance_released', null, 'ok');
    if (record.instance.handles.size === 0) {
      if (record.instance.replacementCompletion) await record.instance.replacementCompletion;
      await waitForDrain(record.instance.generation, 10_000);
      if (record.instance.handles.size === 0) {
        this.#instances.delete(record.instance.id);
        await record.instance.generation.adapter.close();
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#handles.clear();
    await Promise.allSettled([...this.#starting.values()]);
    await Promise.allSettled(
      [...this.#instances.values()]
        .map((instance) => instance.replacementCompletion)
        .filter((completion): completion is Promise<void> => completion !== null),
    );
    const instances = [...this.#instances.values()];
    this.#instances.clear();
    await Promise.allSettled(instances.map((instance) => waitForDrain(instance.generation, 10_000)));
    await Promise.allSettled(instances.map((instance) => instance.generation.adapter.close()));
  }

  async #acquireStarted(
    instanceId: string,
    input: AcquireSurfaceInput,
    execution: SurfaceExecutionDeclaration,
  ): Promise<Instance> {
    const pending = this.#starting.get(instanceId);
    if (pending) return pending;
    const starting = this.#startInstance(instanceId, input, execution);
    this.#starting.set(instanceId, starting);
    try {
      return await starting;
    } finally {
      this.#starting.delete(instanceId);
    }
  }

  async #startInstance(
    instanceId: string,
    input: AcquireSurfaceInput,
    execution: SurfaceExecutionDeclaration,
  ): Promise<Instance> {
    const id = generationId(input.binding.surface_id);
    const adapter = await startAdapter({
      adapter: input.adapter,
      init: runtimeInit(input.binding, id, input.binding.tool_contract_digest),
    });
    try {
      assertToolInventory(input.binding, adapter.toolNames);
      const health = await adapter.health();
      if (health.status !== 'healthy') throw new Error(`mcp_surface_runtime_initial_health_${health.status}`);
      const instance: Instance = {
        id: instanceId,
        binding: input.binding,
        bindingFingerprint: stableDigest(input.binding),
        adapterFingerprint: adapterFingerprint(input.adapter),
        execution,
        state: 'ready',
        generation: { id, adapter, toolContractDigest: input.binding.tool_contract_digest, inflight: 0, invocationCount: 0 },
        handles: new Set(),
        replacementBarrier: null,
        replacementCompletion: null,
        replacementInProgress: false,
        ...compileToolValidators(input.binding),
      };
      this.#assertOpen();
      this.#instances.set(instanceId, instance);
      this.#emitOwner(instance);
      this.#emitLifecycle(instance, 'generation_started', null, 'ok');
      this.#emitLifecycle(instance, 'generation_activated', null, 'ok');
      return instance;
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }

  #requireHandle(handleId: string): HandleRecord {
    const record = this.#handles.get(handleId);
    if (!record) throw new Error(`mcp_surface_runtime_handle_unknown:${handleId}`);
    return record;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('mcp_surface_runtime_engine_closed');
  }

  #emitOwner(instance: Instance): void {
    if (!this.#observationSink) return;
    const now = new Date().toISOString();
    const owner: RuntimeResourceOwnerV1 = {
      schema: 'narada.mcp_runtime.resource_owner.v1',
      owner_id: instance.id,
      site_id: instance.binding.site_id,
      authority_ref: instance.binding.authority_ref,
      owner_kind: instance.generation.adapter.kind === 'surface_factory' ? 'surface_worker' : 'nars_stdio_child',
      pid: instance.generation.adapter.runtime.pid > 0 ? instance.generation.adapter.runtime.pid : null,
      process_started_at: null,
      parent_owner_id: this.#observationParentOwnerId,
      surface_id: instance.binding.surface_id,
      instance_id: instance.id,
      generation_id: instance.generation.id,
      carrier_session_id: null,
      executable_name: instance.generation.adapter.runtime.executable || null,
      observed_at: now,
    };
    void this.#observationSink.emit(owner);
  }

  #emitLifecycle(
    instance: Instance,
    eventType: RuntimeLifecycleEventV1['event_type'],
    requestId: string | null,
    status: RuntimeLifecycleEventV1['status'],
  ): void {
    if (!this.#observationSink) return;
    void this.#observationSink.emit({
      schema: 'narada.mcp_runtime.lifecycle_event.v1',
      event_id: `event-${randomUUID()}`,
      occurred_at: new Date().toISOString(),
      site_id: instance.binding.site_id,
      authority_ref: instance.binding.authority_ref,
      owner_id: instance.id,
      event_type: eventType,
      surface_id: instance.binding.surface_id,
      instance_id: instance.id,
      generation_id: instance.generation.id,
      request_id: requestId,
      status,
      inflight: instance.generation.inflight,
    });
  }
}

async function startAdapter(input: AdapterStartInput): Promise<RuntimeGenerationAdapter> {
  return input.adapter.kind === 'surface_factory'
    ? WorkerSurfaceAdapter.start(input)
    : StdioSurfaceAdapter.start(input);
}

function runtimeInstanceId(
  binding: AdmittedSurfaceBinding,
  session: RuntimeSessionBinding,
  execution: SurfaceExecutionDeclaration,
): string {
  return `surface-instance-${stableDigest({
    site_id: binding.site_id,
    authority_ref: binding.authority_ref,
    binding_id: binding.binding_id,
    projection_id: binding.projection_id,
    tenancy: execution.tenancy,
    session: execution.tenancy === 'session_isolated' ? session.carrier_session_id : null,
  }).slice(0, 24)}`;
}

function generationId(surfaceId: string): string {
  return `${surfaceId}-generation-${randomUUID()}`;
}

function runtimeInit(binding: AdmittedSurfaceBinding, id: string, toolContractDigest: string): SurfaceRuntimeInit {
  return {
    binding_id: binding.binding_id,
    site_id: binding.site_id,
    authority_ref: binding.authority_ref,
    surface_id: binding.surface_id,
    projection_id: binding.projection_id,
    generation_id: id,
    tool_contract_digest: toolContractDigest,
    ...(binding.site_root ? { site_root: binding.site_root } : {}),
    ...(binding.configuration ? { configuration: binding.configuration } : {}),
  };
}

function assertAdapterMatches(execution: SurfaceExecutionDeclaration, adapter: SurfaceAdapterSpec): void {
  if (execution.adapter !== adapter.kind) {
    throw new Error(`mcp_surface_runtime_adapter_mismatch:${execution.adapter}:${adapter.kind}`);
  }
}

function assertInstanceCompatible(instance: Instance, input: AcquireSurfaceInput): void {
  if (instance.bindingFingerprint !== stableDigest(input.binding)) {
    throw new Error(`mcp_surface_runtime_reuse_binding_mismatch:${instance.id}`);
  }
  if (instance.adapterFingerprint !== adapterFingerprint(input.adapter)) {
    throw new Error(`mcp_surface_runtime_reuse_adapter_mismatch:${instance.id}`);
  }
}

function adapterFingerprint(adapter: SurfaceAdapterSpec): string {
  return stableDigest(adapter.kind === 'surface_factory'
    ? { kind: adapter.kind, module_path: adapter.module_path }
    : {
        kind: adapter.kind,
        executable: adapter.executable,
        args: adapter.args ?? [],
        cwd: adapter.cwd ?? null,
        env: Object.fromEntries(Object.entries(adapter.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      });
}

function assertToolInventory(binding: AdmittedSurfaceBinding, liveNames: readonly string[]): void {
  const expected = binding.tools.map((tool) => tool.name).sort();
  const observed = [...liveNames].sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error(`mcp_surface_runtime_tool_contract_mismatch:expected=${expected.join(',')}:observed=${observed.join(',')}`);
  }
}

function assertInvocationContext(
  binding: AdmittedSurfaceBinding,
  session: RuntimeSessionBinding,
  input: InvokeSurfaceInput,
): void {
  const context = input.context;
  const admission = context.admission;
  const requiredValues: Array<[unknown, string]> = [
    [context.request_id, 'request_id'],
    [context.carrier_session_id, 'carrier_session_id'],
    [context.carrier_id, 'carrier_id'],
    [context.agent_id, 'agent_id'],
    [context.site_id, 'site_id'],
    [context.authority_ref, 'authority_ref'],
    [admission.decision_ref, 'admission_decision_ref'],
    [admission.reason, 'admission_reason'],
  ];
  const missing = requiredValues.find(([value]) => typeof value !== 'string' || !value.trim());
  if (missing) throw new Error(`mcp_surface_runtime_context_invalid:${missing[1]}`);
  if (!['admitted', 'refused', 'deferred', 'routed'].includes(admission.decision)) {
    throw new Error('mcp_surface_runtime_context_invalid:admission_decision');
  }
  const checks: Array<[boolean, string]> = [
    [context.site_id === binding.site_id, 'site_id'],
    [context.authority_ref === binding.authority_ref, 'authority_ref'],
    [context.carrier_session_id === session.carrier_session_id, 'carrier_session_id'],
    [context.carrier_id === session.carrier_id, 'carrier_id'],
    [context.agent_id === session.agent_id, 'agent_id'],
    [admission.authority_ref === binding.authority_ref, 'admission_authority_ref'],
    [admission.surface_id === binding.surface_id, 'admission_surface_id'],
    [admission.tool_name === input.request.tool_name, 'admission_tool_name'],
  ];
  const mismatch = checks.find(([matches]) => !matches);
  if (mismatch) throw new Error(`mcp_surface_runtime_context_mismatch:${mismatch[1]}`);
}

function replacementRefusal(
  instanceId: string,
  previousGenerationId: string,
  candidateGenerationId: string,
  reason: string,
): SurfaceReplacementOutcome {
  return {
    schema: 'narada.mcp_surface_runtime.replacement.v1',
    instance_id: instanceId,
    previous_generation_id: previousGenerationId,
    candidate_generation_id: candidateGenerationId,
    status: 'refused',
    assessment: { compatible: false, reason },
  };
}

async function waitForDrain(generation: Generation, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (generation.inflight > 0) {
    if (Date.now() >= deadline) throw new Error('mcp_surface_runtime_drain_timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function compileToolValidators(binding: AdmittedSurfaceBinding): {
  inputValidators: Map<string, ValidateFunction>;
  outputValidators: Map<string, ValidateFunction>;
} {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const inputValidators = new Map<string, ValidateFunction>();
  const outputValidators = new Map<string, ValidateFunction>();
  for (const tool of binding.tools) {
    inputValidators.set(tool.name, ajv.compile(tool.input_schema));
    if (tool.output_schema) outputValidators.set(tool.name, ajv.compile(tool.output_schema));
  }
  return { inputValidators, outputValidators };
}

function formatValidationErrors(errors: ValidateFunction['errors']): string {
  if (!errors?.length) return 'unknown';
  return errors.slice(0, 3).map((error) => `${error.instancePath || '/'}:${error.keyword}`).join(',');
}

function countActiveResourceClasses(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) {
    const safe = String(name).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'unknown';
    counts[safe] = (counts[safe] ?? 0) + 1;
  }
  return counts;
}

function sanitizeProbeError(error: unknown): string {
  const code = String((error as { code?: unknown })?.code ?? 'resource_probe_failed');
  return code.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160);
}
