import { diagnosticError } from '../errors.js';
import type { PrimitiveConfigValue } from '../policy.js';
import type { WorkerEditToolInput } from '../worker-types.js';

export function workerEditRunArgs(args: Record<string, unknown>): Record<string, unknown> {
  const editInput = normalizeWorkerEditToolInput(args);
  return {
    intent: { instruction: editInput.instruction, mode: 'implement' },
    constraints: {
      cwd: editInput.cwd,
      ...(editInput.site_root !== undefined ? { site_root: editInput.site_root } : {}),
      ...(editInput.provider !== undefined ? { provider: editInput.provider } : {}),
      authority: 'write',
      cognition: 'low',
      ...(editInput.required_mcp_tools !== undefined ? { required_mcp_tools: editInput.required_mcp_tools } : {}),
      ...(editInput.resumable !== undefined ? { resumable: editInput.resumable } : {}),
      ...(editInput.wait_for_completion !== undefined ? { wait_for_completion: editInput.wait_for_completion } : {}),
      ...(editInput.wait_timeout_ms !== undefined ? { wait_timeout_ms: editInput.wait_timeout_ms } : {}),
      ...(editInput.exit_interview !== undefined ? { exit_interview: editInput.exit_interview } : {}),
      ...(editInput.overrides && Object.keys(editInput.overrides).length > 0 ? { overrides: editInput.overrides } : {}),
    },
  };
}

function normalizeWorkerEditToolInput(args: Record<string, unknown>): WorkerEditToolInput {
  const overridesInput = asRecord(args.overrides);
  const editInput: WorkerEditToolInput = {
    cwd: requiredNonEmptyString(args.cwd, 'worker_cwd_required'),
    instruction: requiredNonEmptyString(args.instruction, 'worker_prompt_too_large'),
  };
  if (args.site_root !== undefined && args.site_root !== null && String(args.site_root).trim()) editInput.site_root = String(args.site_root).trim();
  if (args.provider !== undefined && args.provider !== null && String(args.provider).trim()) editInput.provider = String(args.provider).trim();
  if (args.required_mcp_tools !== undefined) editInput.required_mcp_tools = normalizeStringList(args.required_mcp_tools);
  if (args.resumable !== undefined) editInput.resumable = Boolean(args.resumable);
  if (args.wait_for_completion !== undefined) editInput.wait_for_completion = Boolean(args.wait_for_completion);
  if (args.wait_timeout_ms !== undefined) editInput.wait_timeout_ms = Number(args.wait_timeout_ms);
  if (args.exit_interview !== undefined) editInput.exit_interview = Boolean(args.exit_interview);
  const overrides: NonNullable<WorkerEditToolInput['overrides']> = {};
  copyString(overrides, 'runtime', overridesInput.runtime);
  copyString(overrides, 'sandbox', overridesInput.sandbox);
  copyString(overrides, 'model', overridesInput.model);
  copyString(overrides, 'reasoning_effort', overridesInput.reasoning_effort);
  const config = primitiveConfigRecord(overridesInput.config);
  if (Object.keys(config).length > 0) overrides.config = config;
  if (overridesInput.skip_git_repo_check !== undefined) overrides.skip_git_repo_check = optionalBoolean(overridesInput.skip_git_repo_check, 'skip_git_repo_check');
  if (Object.keys(overrides).length > 0) editInput.overrides = overrides;
  return editInput;
}

function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  throw diagnosticError('worker_invalid_tool_input', 'worker_boolean_required', { field, value_type: Array.isArray(value) ? 'array' : typeof value });
}

function copyString(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  target[key] = String(value).trim();
}

function primitiveConfigRecord(value: unknown): Record<string, PrimitiveConfigValue> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw diagnosticError('worker_invalid_config_input', 'config must be an object', { value_type: Array.isArray(value) ? 'array' : typeof value });
  }
  const record = asRecord(value);
  const result: Record<string, PrimitiveConfigValue> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) {
      result[key] = item;
      continue;
    }
    throw diagnosticError('worker_config_key_not_allowed', 'worker_config_value_must_be_primitive', { key });
  }
  return result;
}

function requiredNonEmptyString(value: unknown, code: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code);
  return text;
}

function normalizeStringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw diagnosticError('worker_invalid_required_mcp_tools', 'worker_invalid_required_mcp_tools');
  return value.map((item) => requiredNonEmptyString(item, 'worker_invalid_required_mcp_tools'));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
