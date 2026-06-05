import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { diagnosticError } from './errors.js';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type PrimitiveConfigValue = string | number | boolean;
export type WorkerProfile = 'default' | 'delegating-agent-read' | 'delegating-agent-write' | 'delegating-agent-command';

export type WorkerPolicy = {
  defaultRuntime: 'codex';
  defaultProfile: 'default';
  allowedProfiles: WorkerProfile[];
  runRoot: string;
  auditLogDir: string | null;
  allowedRoots: string[];
  rootsFromTrustConfig: string | null;
  allowedRuntimes: ['codex'];
  allowedSandboxes: SandboxMode[];
  allowedConfigKeys: string[];
  allowRawConfigOverrides: boolean;
  allowDangerFullAccess: boolean;
  maxParallelRuns: number;
  maxPromptBytes: number;
  maxOutputBytes: number;
  maxRunMs: number;
  editDefaults: {
    model: string | null;
    reasoningEffort: string | null;
  };
  runtimes: {
    codex: {
      command: string;
      commandArgs: string[];
      defaultSandbox: SandboxMode;
      defaultReasoningEffort: string;
      ephemeral: boolean;
      jsonEvents: boolean;
    };
  };
};

const DEFAULT_MAX_PROMPT_BYTES = 1_048_576;
const DEFAULT_MAX_OUTPUT_BYTES = 2_097_152;
const DEFAULT_MAX_RUN_MS = 1_800_000;
const ENV_KEYS = ['PATH', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'OPENAI_API_KEY'];
const WORKER_PROFILES: WorkerProfile[] = ['default', 'delegating-agent-read', 'delegating-agent-write', 'delegating-agent-command'];

export function createWorkerPolicy(options: Record<string, unknown> = {}): WorkerPolicy {
  const fileConfig = typeof options.config === 'string' && options.config.trim() ? parseConfigFile(options.config) : {};
  const merged = mergeConfig(fileConfig, options);
  const worker = asRecord(merged.worker);
  const roots = asRecord(worker.roots);
  const policy = asRecord(worker.policy);
  const editDefaults = asRecord(worker.edit_defaults);
  const runtimes = asRecord(worker.runtimes);
  const codex = asRecord(runtimes.codex);

  const defaultRuntime = stringValue(merged.defaultRuntime ?? worker.default_runtime ?? 'codex');
  if (defaultRuntime !== 'codex') throw diagnosticError('worker_invalid_runtime', 'worker_invalid_runtime', { runtime: defaultRuntime });

  const allowedRuntimes = stringList(merged.allowedRuntime ?? merged.allowedRuntimes ?? policy.allowed_runtimes ?? ['codex']);
  if (allowedRuntimes.length !== 1 || allowedRuntimes[0] !== 'codex') throw diagnosticError('worker_runtime_not_allowed', 'worker_runtime_not_allowed', { allowed_runtimes: allowedRuntimes });

  const allowedSandboxes = stringList(merged.allowedSandbox ?? merged.allowedSandboxes ?? policy.allowed_sandboxes ?? ['read-only', 'workspace-write']).map(validateSandbox);
  const allowDangerFullAccess = booleanValue(merged.allowDangerFullAccess ?? policy.allow_danger_full_access, false);
  if (allowedSandboxes.includes('danger-full-access') && !allowDangerFullAccess) throw diagnosticError('worker_danger_full_access_not_allowed');

  const rootsFromTrustConfig = stringOrNull(merged.rootsFromTrustConfig ?? roots.roots_from_trust_config);
  const explicitRoots = [...stringList(merged.allowedRoot), ...stringList(merged.allowedRoots), ...stringList(roots.allowed_roots)];
  const allowedRoots = normalizeAllowedRoots([...explicitRoots, ...(rootsFromTrustConfig ? parseTrustedProjectRootsFromTrustConfig(rootsFromTrustConfig) : [])]);
  if (allowedRoots.length === 0) throw diagnosticError('worker_cwd_outside_allowed_roots', 'worker_cwd_outside_allowed_roots', { reason: 'allowed_root_set_empty' });

  const codexCommand = stringValue(merged.codexCommand ?? codex.command ?? 'codex');
  const codexCommandArgs = stringList(merged.codexCommandArg ?? merged.codexCommandArgs ?? codex.command_args);
  const codexDefaultSandbox = validateSandbox(merged.defaultSandbox ?? codex.default_sandbox ?? 'read-only');
  if (!allowedSandboxes.includes(codexDefaultSandbox)) throw diagnosticError('worker_invalid_sandbox', 'worker_invalid_sandbox', { sandbox: codexDefaultSandbox });

  return {
    defaultRuntime: 'codex',
    defaultProfile: 'default',
    allowedProfiles: WORKER_PROFILES,
    runRoot: resolve(stringValue(merged.runRoot ?? worker.run_root ?? defaultRunRoot())),
    auditLogDir: stringOrNull(merged.auditLogDir ?? worker.audit_log_dir) ? resolve(stringValue(merged.auditLogDir ?? worker.audit_log_dir)) : null,
    allowedRoots,
    rootsFromTrustConfig,
    allowedRuntimes: ['codex'],
    allowedSandboxes,
    allowedConfigKeys: stringList(merged.allowedConfigKey ?? merged.allowedConfigKeys ?? policy.allowed_config_keys ?? ['model', 'model_reasoning_effort']),
    allowRawConfigOverrides: booleanValue(merged.allowRawConfigOverrides ?? policy.allow_raw_config_overrides, false),
    allowDangerFullAccess,
    maxParallelRuns: strictInteger(merged.maxParallelRuns ?? policy.max_parallel_runs, 1, 32, 1, 'max_parallel_runs'),
    maxPromptBytes: strictInteger(merged.maxPromptBytes ?? policy.max_prompt_bytes, 1, 50 * 1024 * 1024, DEFAULT_MAX_PROMPT_BYTES, 'max_prompt_bytes'),
    maxOutputBytes: strictInteger(merged.maxOutputBytes ?? policy.max_output_bytes, 1, 50 * 1024 * 1024, DEFAULT_MAX_OUTPUT_BYTES, 'max_output_bytes'),
    maxRunMs: strictInteger(merged.maxRunMs ?? policy.max_run_ms, 1, 24 * 60 * 60 * 1000, DEFAULT_MAX_RUN_MS, 'max_run_ms'),
    editDefaults: {
      model: stringOrNull(merged.editDefaultModel ?? editDefaults.model ?? 'gpt-5.4-mini'),
      reasoningEffort: stringOrNull(merged.editDefaultReasoningEffort ?? editDefaults.reasoning_effort ?? 'low'),
    },
    runtimes: {
      codex: {
        command: codexCommand,
        commandArgs: codexCommandArgs,
        defaultSandbox: codexDefaultSandbox,
        defaultReasoningEffort: stringValue(merged.defaultReasoningEffort ?? codex.default_reasoning_effort ?? 'medium'),
        ephemeral: booleanValue(merged.ephemeral ?? codex.ephemeral, true),
        jsonEvents: booleanValue(merged.jsonEvents ?? codex.json_events, true),
      },
    },
  };
}

export function resolveProfile(value: unknown, policy: WorkerPolicy): WorkerProfile {
  const profile = stringValue(value ?? policy.defaultProfile);
  if (!isWorkerProfile(profile) || !policy.allowedProfiles.includes(profile)) throw diagnosticError('worker_invalid_profile', 'worker_invalid_profile', { profile, allowed_profiles: policy.allowedProfiles });
  return profile;
}

export function defaultSandboxForProfile(profile: WorkerProfile): SandboxMode {
  if (profile === 'delegating-agent-write' || profile === 'delegating-agent-command') return 'workspace-write';
  return 'read-only';
}

export function publicWorkerPolicy(policy: WorkerPolicy): Record<string, unknown> {
  return {
    schema: 'narada.worker.policy.v1',
    status: 'ok',
    default_runtime: policy.defaultRuntime,
    default_profile: policy.defaultProfile,
    allowed_profiles: policy.allowedProfiles,
    run_root: policy.runRoot,
    audit_log_dir: policy.auditLogDir,
    allowed_roots: policy.allowedRoots,
    roots_from_trust_config: policy.rootsFromTrustConfig,
    allowed_runtimes: policy.allowedRuntimes,
    allowed_sandboxes: policy.allowedSandboxes,
    allowed_config_keys: policy.allowedConfigKeys,
    allow_raw_config_overrides: policy.allowRawConfigOverrides,
    allow_danger_full_access: policy.allowDangerFullAccess,
    max_parallel_runs: policy.maxParallelRuns,
    max_prompt_bytes: policy.maxPromptBytes,
    max_output_bytes: policy.maxOutputBytes,
    max_run_ms: policy.maxRunMs,
    edit_defaults: {
      model: policy.editDefaults.model,
      reasoning_effort: policy.editDefaults.reasoningEffort,
    },
    runtimes: {
      codex: {
        command: policy.runtimes.codex.command,
        command_args: policy.runtimes.codex.commandArgs,
        default_sandbox: policy.runtimes.codex.defaultSandbox,
        default_reasoning_effort: policy.runtimes.codex.defaultReasoningEffort,
        ephemeral: policy.runtimes.codex.ephemeral,
        json_events: policy.runtimes.codex.jsonEvents,
      },
    },
  };
}

export function resolveWorkingDirectory(input: unknown, policy: WorkerPolicy): string {
  const cwd = resolve(requiredString(input, 'worker_cwd_required'));
  if (!policy.allowedRoots.some((root) => cwd === root || isPathInside(cwd, root))) {
    throw diagnosticError('worker_cwd_outside_allowed_roots', 'worker_cwd_outside_allowed_roots', { cwd, allowed_roots: policy.allowedRoots });
  }
  return cwd;
}

export function validateRuntime(value: unknown, policy: WorkerPolicy): 'codex' {
  const runtime = stringValue(value ?? policy.defaultRuntime);
  if (runtime !== 'codex') throw diagnosticError('worker_invalid_runtime', 'worker_invalid_runtime', { runtime });
  if (!policy.allowedRuntimes.includes(runtime)) throw diagnosticError('worker_runtime_not_allowed', 'worker_runtime_not_allowed', { runtime });
  return 'codex';
}

export function validateSandbox(value: unknown): SandboxMode {
  const sandbox = stringValue(value);
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write' && sandbox !== 'danger-full-access') {
    throw diagnosticError('worker_invalid_sandbox', 'worker_invalid_sandbox', { sandbox });
  }
  return sandbox;
}

export function resolveSandbox(value: unknown, policy: WorkerPolicy): SandboxMode {
  const sandbox = validateSandbox(value ?? policy.runtimes.codex.defaultSandbox);
  if (sandbox === 'danger-full-access' && (!policy.allowDangerFullAccess || !policy.allowedSandboxes.includes('danger-full-access'))) throw diagnosticError('worker_danger_full_access_not_allowed');
  if (!policy.allowedSandboxes.includes(sandbox)) throw diagnosticError('worker_invalid_sandbox', 'worker_invalid_sandbox', { sandbox, allowed_sandboxes: policy.allowedSandboxes });
  return sandbox;
}

export function resolveConfig(input: Record<string, unknown>, policy: WorkerPolicy): { config: Record<string, PrimitiveConfigValue>; model: string | null; reasoning_effort: string | null } {
  const config: Record<string, PrimitiveConfigValue> = {};
  const userConfig = asRecord(input.config);
  for (const [key, value] of Object.entries(userConfig)) addConfigValue(config, key, value, policy);
  if (input.model !== undefined && input.model !== null && String(input.model).trim()) addConfigValue(config, 'model', String(input.model).trim(), policy);
  if (input.reasoning_effort !== undefined && input.reasoning_effort !== null && String(input.reasoning_effort).trim()) addConfigValue(config, 'model_reasoning_effort', String(input.reasoning_effort).trim(), policy);
  return {
    config,
    model: typeof config.model === 'string' ? config.model : null,
    reasoning_effort: typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : null,
  };
}

export function environmentForWorker(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ENV_KEYS) if (typeof env[key] === 'string') result[key] = env[key]!;
  return result;
}

function addConfigValue(target: Record<string, PrimitiveConfigValue>, key: string, value: unknown, policy: WorkerPolicy): void {
  if (!policy.allowRawConfigOverrides && !policy.allowedConfigKeys.includes(key)) throw diagnosticError('worker_config_key_not_allowed', 'worker_config_key_not_allowed', { key, allowed_config_keys: policy.allowedConfigKeys });
  if (!isPrimitiveConfigValue(value)) throw diagnosticError('worker_config_key_not_allowed', 'worker_config_value_must_be_primitive', { key });
  target[key] = value;
}

function parseConfigFile(path: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = root;
      for (const part of section[1].split('.')) current = ensureRecord(current, part);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) throw diagnosticError('worker_invalid_config_file', 'worker_invalid_config_file', { line });
    current[kv[1]] = parseTomlValue(kv[2].trim());
  }
  return root;
}

function parseTomlValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((part) => parseTomlValue(part.trim()));
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) return numberValue;
  throw diagnosticError('worker_invalid_config_file', 'worker_invalid_config_value', { value });
}

export function parseTrustedProjectRootsFromTrustConfig(configPath: string): string[] {
  const roots = [];
  let currentProject: string | null = null;
  for (const rawLine of readFileSync(configPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[projects\.'([^']+)'\]$/i) ?? line.match(/^\[projects\.\"([^\"]+)\"\]$/i);
    if (header) {
      currentProject = header[1];
      continue;
    }
    if (line.startsWith('[')) {
      currentProject = null;
      continue;
    }
    if (!currentProject) continue;
    const trust = line.match(/^trust_level\s*=\s*\"([^\"]+)\"$/i);
    if (trust && trust[1].toLowerCase() === 'trusted') roots.push(currentProject);
  }
  return normalizeAllowedRoots(roots);
}

function normalizeAllowedRoots(roots: unknown[]): string[] {
  const seen = new Set<string>();
  const normalized = [];
  for (const item of roots) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    const resolved = resolve(text);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(resolved);
  }
  return normalized;
}

function mergeConfig(fileConfig: Record<string, unknown>, options: Record<string, unknown>): Record<string, unknown> {
  return { ...fileConfig, ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'config')) };
}

function defaultRunRoot(): string {
  const home = process.env.CODEX_HOME || process.env.USERPROFILE || process.env.HOME || process.cwd();
  return resolve(home, 'worker-delegation', 'runs');
}

function requiredString(value: unknown, code: string): string {
  const text = stringValue(value);
  if (!text) throw diagnosticError(code);
  return text;
}

function stringValue(value: unknown): string {
  return String(value ?? '').trim();
}

function stringOrNull(value: unknown): string | null {
  const text = stringValue(value);
  return text ? text : null;
}

function stringList(value: unknown): string[] {
  if (value === undefined || value === null || value === true) return [];
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [String(value)].filter(Boolean);
}

function booleanValue(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw diagnosticError('worker_invalid_config_value', 'worker_invalid_boolean', { value });
}

function strictInteger(value: unknown, min: number, max: number, defaultValue: number, field: string): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) throw diagnosticError('worker_invalid_config_value', 'worker_invalid_integer', { field, value });
  if (parsed < min || parsed > max) throw diagnosticError('worker_invalid_config_value', 'worker_integer_out_of_range', { field, value, min, max });
  return parsed;
}

function isPrimitiveConfigValue(value: unknown): value is PrimitiveConfigValue {
  return typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean';
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isWorkerProfile(value: string): value is WorkerProfile {
  return WORKER_PROFILES.includes(value as WorkerProfile);
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}
