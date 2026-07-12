import type { PrimitiveConfigValue, SandboxMode, WorkerAuthority, WorkerCognition } from './policy.js';

export type WorkerIntent = {
  instruction: string;
  mode?: WorkerDelegationMode;
};

export type WorkerDelegationMode = 'audit_only' | 'plan_only' | 'implement' | 'implement_and_verify';

export type WorkerPreflightCheck = {
  name: string;
  status: 'ok' | 'warning' | 'blocked';
  message: string;
};

export type WorkerPreflightPath = {
  path: string;
  access: 'read' | 'write' | 'create';
  label?: string;
};

export type WorkerVerificationBudget = {
  focus?: 'focused' | 'broad';
  max_commands?: number;
  max_minutes?: number;
  stop_on_first_failure?: boolean;
  broad_commands_allowed?: boolean;
  notes?: string;
};

export type WorkerRunMetadata = {
  requested_mode: WorkerDelegationMode;
  edits_performed: boolean | null;
  target_state_changed: boolean | null;
  confidence: 'complete' | 'partial' | 'pending';
  blocked_paths: string[];
  verification: string[];
  preflight: WorkerPreflightCheck[];
  final_checklist: string[];
};

export type WorkerProgressPreview = {
  event_count: number;
  latest_event_type: string | null;
  latest_event_preview: string | null;
  latest_event_at?: string | null;
  readable: boolean;
  tail_truncated: boolean;
  error_preview?: string;
};

export type WorkerConstraintRequest = {
  cwd: string;
  site_root?: string;
  provider?: string;
  authority?: string;
  cognition?: string;
  resumable?: boolean;
  wait_for_completion?: boolean;
  exit_interview?: boolean;
  verification_budget?: WorkerVerificationBudget;
  test_budget?: WorkerVerificationBudget;
  preflight_paths?: WorkerPreflightPath[];
  required_mcp_tools?: string[];
  overrides?: WorkerConstraintOverrides;
};

export type WorkerConstraintOverrides = {
  runtime?: string;
  sandbox?: string;
  model?: string;
  reasoning_effort?: string;
  config?: Record<string, PrimitiveConfigValue>;
  skip_git_repo_check?: boolean;
};

export type WorkerRunToolInput = {
  intent: WorkerIntent;
  constraints: WorkerConstraintRequest;
};

export type WorkerEditToolInput = {
  cwd: string;
  site_root?: string;
  provider?: string;
  instruction: string;
  required_mcp_tools?: string[];
  resumable?: boolean;
  wait_for_completion?: boolean;
  exit_interview?: boolean;
  overrides?: WorkerConstraintOverrides;
};

export type SupportedRuntime = 'codex' | 'narada-agent-runtime-server';

export type WorkerResolvedExecutionPolicy = {
  runtime: SupportedRuntime;
  authority: WorkerAuthority;
  cognition: WorkerCognition;
  command: string;
  command_args: string[];
  argv: string[];
  cwd: string;
  site_root?: string;
  site_bound?: boolean;
  site_marker?: string | null;
  site_root_source?: 'explicit' | 'bound_environment' | 'nearest_marker';
  site_binding?: Record<string, unknown>;
  workspace_root?: string;
  provider?: string | null;
  provider_source?: string;
  provider_env_key?: string;
  provider_runtime_binding?: Record<string, unknown>;
  required_mcp_tools?: string[];
  worker_mcp_projection?: Record<string, unknown>;
  sandbox: SandboxMode;
  model: string | null;
  reasoning_effort: string | null;
  config: Record<string, PrimitiveConfigValue>;
  skip_git_repo_check: boolean;
  resumable: boolean;
  ephemeral: boolean;
  json_events: boolean;
  implementation_identity?: Record<string, unknown>;
  prompt_byte_length: number;
  max_output_bytes: number;
  max_run_ms: number;
  max_tool_rounds: number;
  environment_keys: string[];
};

export type WorkerExecutorRequest = {
  schema: 'narada.worker.executor_request.v1';
  run_id: string;
  resume_worker_session_id: string | null;
  intent: WorkerIntent;
  requested_mode: WorkerDelegationMode;
  preflight: WorkerPreflightCheck[];
  requested_mcp_tools: string[];
  mcp_tool_verification: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  resolved_execution_policy: WorkerResolvedExecutionPolicy;
};
