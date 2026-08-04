import type {
  SurfaceExecutionDeclaration,
  SurfaceInvocationContext,
  SurfaceReplacementAssessment,
  SurfaceReplacementCandidate,
  SurfaceRuntimeHealth,
  SurfaceRuntimeInit,
  SurfaceRuntimeJson,
  SurfaceRuntimeRequest,
  ToolContractV2,
} from '@narada-core/mcp-fabric-contracts';

export type FactoryAdapterSpec = {
  kind: 'surface_factory';
  module_path: string;
};

export type StdioAdapterSpec = {
  kind: 'stdio';
  executable: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type SurfaceAdapterSpec = FactoryAdapterSpec | StdioAdapterSpec;

export type AdmittedSurfaceBinding = {
  binding_id: string;
  site_id: string;
  authority_ref: string;
  surface_id: string;
  projection_id: string;
  tool_contract_digest: string;
  tools: ToolContractV2[];
  execution?: SurfaceExecutionDeclaration;
  site_root?: string;
  configuration?: SurfaceRuntimeJson;
};

export type RuntimeSessionBinding = {
  carrier_session_id: string;
  carrier_id: string;
  agent_id: string;
};

export type AcquireSurfaceInput = {
  binding: AdmittedSurfaceBinding;
  session: RuntimeSessionBinding;
  adapter: SurfaceAdapterSpec;
};

export type SurfaceRuntimeHandle = {
  handle_id: string;
  instance_id: string;
  generation_id: string;
  reused: boolean;
  execution: SurfaceExecutionDeclaration;
};

export type InvokeSurfaceInput = {
  handle_id: string;
  request: SurfaceRuntimeRequest;
  context: SurfaceInvocationContext;
};

export type SurfaceInvocationOutcome = {
  schema: 'narada.mcp_surface_runtime.invocation.v1';
  request_id: string;
  instance_id: string;
  generation_id: string;
  surface_id: string;
  tool_name: string;
  status: 'ok' | 'refused' | 'failed';
  admission: SurfaceInvocationContext['admission'];
  result?: SurfaceRuntimeJson;
  error?: { code: string; message: string };
};

export type ReplaceSurfaceInput = {
  handle_id: string;
  expected_generation_id: string;
  adapter: FactoryAdapterSpec;
  candidate_tool_contract_digest: string;
  drain_timeout_ms?: number;
};

export type SurfaceReplacementOutcome = {
  schema: 'narada.mcp_surface_runtime.replacement.v1';
  instance_id: string;
  previous_generation_id: string;
  candidate_generation_id: string;
  status: 'replaced' | 'refused' | 'failed';
  assessment: SurfaceReplacementAssessment;
};

export type SurfaceRuntimeInstanceStatus = {
  instance_id: string;
  binding_id: string;
  site_id: string;
  authority_ref: string;
  surface_id: string;
  projection_id: string;
  generation_id: string;
  state: 'loading' | 'ready' | 'degraded' | 'restarting' | 'unavailable';
  tenancy: SurfaceExecutionDeclaration['tenancy'];
  adapter: SurfaceAdapterSpec['kind'];
  session_count: number;
  inflight: number;
  runtime: {
    executable: string;
    version: string;
    pid: number;
    worker_thread_id?: number;
  };
};

export type RuntimeWorkerResourceSnapshot = {
  sampled_at: string;
  heap_total_bytes: number;
  heap_used_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
  heap_limit_bytes: number;
  active_resource_counts: Record<string, number>;
  invocation_count: number;
  inflight: number;
};

export type SurfaceRuntimeResourceSnapshot = {
  schema: 'narada.mcp_surface_runtime.resources.v1';
  sampled_at: string;
  parent: RuntimeWorkerResourceSnapshot & { pid: number };
  instances: Array<SurfaceRuntimeInstanceStatus & {
    resource_status: 'complete' | 'unavailable';
    resources: RuntimeWorkerResourceSnapshot | null;
    unavailable_reason: string | null;
  }>;
};

export interface RuntimeGenerationAdapter {
  readonly kind: SurfaceAdapterSpec['kind'];
  readonly toolNames: readonly string[];
  readonly runtime: SurfaceRuntimeInstanceStatus['runtime'];
  call(request: SurfaceRuntimeRequest, context: SurfaceInvocationContext): Promise<SurfaceRuntimeJson>;
  health(): Promise<SurfaceRuntimeHealth>;
  assessReplacement(candidate: SurfaceReplacementCandidate): Promise<SurfaceReplacementAssessment | null>;
  resourceSnapshot(inflight: number, invocationCount: number): Promise<RuntimeWorkerResourceSnapshot | null>;
  writeHeapSnapshot(path: string, maxBytes: number): Promise<number>;
  close(): Promise<void>;
}

export type AdapterStartInput = {
  adapter: SurfaceAdapterSpec;
  init: SurfaceRuntimeInit;
};
