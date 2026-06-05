import type { PrimitiveConfigValue, SandboxMode, WorkerProfile } from './policy.js';

export type WorkerIntent = {
  instruction: string;
};

export type WorkerConstraintRequest = {
  cwd: string;
  profile?: string;
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

export type WorkerResolvedExecutionPolicy = {
  runtime: 'codex';
  profile: WorkerProfile;
  command: string;
  command_args: string[];
  argv: string[];
  cwd: string;
  sandbox: SandboxMode;
  model: string | null;
  reasoning_effort: string | null;
  config: Record<string, PrimitiveConfigValue>;
  skip_git_repo_check: boolean;
  ephemeral: boolean;
  json_events: boolean;
  prompt_byte_length: number;
  max_output_bytes: number;
  max_run_ms: number;
  environment_keys: string[];
};

export type WorkerExecutorRequest = {
  schema: 'narada.worker.executor_request.v1';
  run_id: string;
  resume_worker_session_id: string | null;
  intent: WorkerIntent;
  resolved_execution_policy: WorkerResolvedExecutionPolicy;
};
