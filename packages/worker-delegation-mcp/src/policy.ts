import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { diagnosticError } from './errors.js';

export const NARADA_SITE_ROOT_MARKERS = ['.narada/', '.ai/mcp/'] as const;
export const NARADA_AGENT_RUNTIME_SITE_REMEDIATION = 'Run narada-agent-runtime-server workers from inside a Narada Site root containing .narada/ or .ai/mcp/, add one of those markers, or pass constraints.site_root pointing at that Site root.';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type PrimitiveConfigValue = string | number | boolean;
export type WorkerAuthority = 'read' | 'write' | 'command';
export type WorkerCognition = 'low' | 'medium' | 'high';

export type WorkerCognitionDefaults = {
  model: string | null;
  reasoningEffort: string | null;
};

export type WorkerPolicy = {
  defaultRuntime: WorkerRuntimeId;
  defaultAuthority: WorkerAuthority;
  defaultCognition: WorkerCognition;
  allowedAuthorities: WorkerAuthority[];
  allowedCognition: WorkerCognition[];
  runRoot: string;
  auditLogDir: string | null;
  allowedRoots: string[];
  rootsFromTrustConfig: string | null;
  allowedRuntimes: WorkerRuntimeId[];
  allowedNaradaAgentRuntimeProviders: string[];
  allowedSandboxes: SandboxMode[];
  allowedConfigKeys: string[];
  allowRawConfigOverrides: boolean;
  allowDangerFullAccess: boolean;
  maxParallelRuns: number;
  maxPromptBytes: number;
  maxOutputBytes: number;
  maxRunMs: number;
  cognitionDefaults: Record<WorkerCognition, WorkerCognitionDefaults>;
  runtimes: {
    codex: WorkerRuntimeConfig;
    deepseek: WorkerDeepseekRuntimeConfig;
    naradaAgentRuntimeServer: WorkerRuntimeConfig;
  };
};

export type WorkerRuntimeId = 'codex' | 'deepseek-api' | 'narada-agent-runtime-server';

type WorkerRuntimeConfig = {
  command: string;
  commandArgs: string[];
  defaultSandbox: SandboxMode;
  defaultReasoningEffort: string;
  ephemeral: boolean;
  jsonEvents: boolean;
};

type WorkerDeepseekRuntimeConfig = {
  command: string;
  commandArgs: string[];
  defaultSandbox: SandboxMode;
  defaultReasoningEffort: string;
  ephemeral: boolean;
  jsonEvents: boolean;
};

const DEFAULT_MAX_PROMPT_BYTES = 1_048_576;
const DEFAULT_MAX_OUTPUT_BYTES = 2_097_152;
const DEFAULT_MAX_RUN_MS = 1_800_000;
const DEFAULT_WORKER_RUNTIME: WorkerRuntimeId = 'narada-agent-runtime-server';
const DEFAULT_WORKER_RUNTIME_ENV = 'NARADA_WORKER_DEFAULT_RUNTIME';
const DEFAULT_NARADA_AGENT_RUNTIME_PROVIDERS = ['kimi-code-api', 'kimi-api', 'openai-api', 'anthropic-api', 'codex-subscription'] as const;
const ENV_KEYS = [
  'PATH',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_API_BASE_URL',
  'KIMI_API_KEY',
  'KIMI_CODE_API_KEY',
  'MOONSHOT_API_KEY',
  'NARADA_WORKER_MCP_CONFIG',
];
const WORKER_AUTHORITIES: WorkerAuthority[] = ['read', 'write', 'command'];
const WORKER_COGNITION: WorkerCognition[] = ['low', 'medium', 'high'];

export function createWorkerPolicy(options: Record<string, unknown> = {}): WorkerPolicy {
  const fileConfig = typeof options.config === 'string' && options.config.trim() ? parseConfigFile(options.config) : {};
  const merged = mergeConfig(fileConfig, options);
  const worker = asRecord(merged.worker);
  const roots = asRecord(worker.roots);
  const policy = asRecord(worker.policy);
  const cognition = asRecord(worker.cognition);
  const runtimes = asRecord(worker.runtimes);
  const codex = asRecord(runtimes.codex);
  const deepseekCfg = asRecord(runtimes.deepseek);
  const naradaAgentRuntimeServerCfg = asRecord(runtimes.narada_agent_runtime_server ?? runtimes.naradaAgentRuntimeServer);

  const defaultRuntime = stringValue(merged.defaultRuntime ?? worker.default_runtime ?? process.env[DEFAULT_WORKER_RUNTIME_ENV] ?? DEFAULT_WORKER_RUNTIME);
  if (!isWorkerRuntime(defaultRuntime)) throw diagnosticError('worker_invalid_runtime', 'worker_invalid_runtime', { runtime: defaultRuntime });

  const allowedRuntimes = runtimeList(merged.allowedRuntime ?? merged.allowedRuntimes ?? policy.allowed_runtimes ?? ['codex', 'deepseek-api', 'narada-agent-runtime-server']);
  const allowedNaradaAgentRuntimeProviders = providerList(merged.allowedNaradaAgentRuntimeProvider ?? merged.allowedNaradaAgentRuntimeProviders ?? policy.allowed_narada_agent_runtime_providers ?? DEFAULT_NARADA_AGENT_RUNTIME_PROVIDERS);

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

  const deepseekCommand = stringValue(merged.deepseekCommand ?? deepseekCfg.command ?? 'node');
  const deepseekCommandArgs = stringList(merged.deepseekCommandArg ?? merged.deepseekCommandArgs ?? deepseekCfg.command_args);
  const deepseekDefaultSandbox = validateSandbox(merged.deepseekDefaultSandbox ?? deepseekCfg.default_sandbox ?? 'read-only');
  if (!allowedSandboxes.includes(deepseekDefaultSandbox)) throw diagnosticError('worker_invalid_sandbox', 'worker_invalid_sandbox', { sandbox: deepseekDefaultSandbox });

  const naradaAgentRuntimeServerCommand = stringValue(merged.naradaAgentRuntimeServerCommand ?? merged.agentRuntimeServerCommand ?? naradaAgentRuntimeServerCfg.command ?? 'narada-agent-runtime-server');
  const naradaAgentRuntimeServerCommandArgs = stringList(merged.naradaAgentRuntimeServerCommandArg ?? merged.naradaAgentRuntimeServerCommandArgs ?? merged.agentRuntimeServerCommandArg ?? merged.agentRuntimeServerCommandArgs ?? naradaAgentRuntimeServerCfg.command_args);
  const naradaAgentRuntimeServerDefaultSandbox = validateSandbox(merged.naradaAgentRuntimeServerDefaultSandbox ?? naradaAgentRuntimeServerCfg.default_sandbox ?? 'workspace-write');
  if (!allowedSandboxes.includes(naradaAgentRuntimeServerDefaultSandbox)) throw diagnosticError('worker_invalid_sandbox', 'worker_invalid_sandbox', { sandbox: naradaAgentRuntimeServerDefaultSandbox });

  const deepseekModelOverride = stringOrNull(merged.deepseekModel);
  const finalCognitionDefaults = cognitionDefaults(cognition, merged);
  if (deepseekModelOverride) {
    for (const level of ['low', 'medium', 'high'] as WorkerCognition[]) {
      finalCognitionDefaults[level] = { ...finalCognitionDefaults[level], model: deepseekModelOverride };
    }
  }

  return {
    defaultRuntime,
    defaultAuthority: validateAuthority(merged.defaultAuthority ?? worker.default_authority ?? 'read'),
    defaultCognition: validateCognition(merged.defaultCognition ?? worker.default_cognition ?? 'low'),
    allowedAuthorities: authorityList(merged.allowedAuthority ?? merged.allowedAuthorities ?? policy.allowed_authorities ?? WORKER_AUTHORITIES),
    allowedCognition: cognitionList(merged.allowedCognition ?? merged.allowedCognitionLevels ?? policy.allowed_cognition ?? WORKER_COGNITION),
    runRoot: resolve(stringValue(merged.runRoot ?? worker.run_root ?? defaultRunRoot())),
    auditLogDir: stringOrNull(merged.auditLogDir ?? worker.audit_log_dir) ? resolve(stringValue(merged.auditLogDir ?? worker.audit_log_dir)) : null,
    allowedRoots,
    rootsFromTrustConfig,
    allowedRuntimes,
    allowedNaradaAgentRuntimeProviders,
    allowedSandboxes,
    allowedConfigKeys: stringList(merged.allowedConfigKey ?? merged.allowedConfigKeys ?? policy.allowed_config_keys ?? ['model', 'model_reasoning_effort']),
    allowRawConfigOverrides: booleanValue(merged.allowRawConfigOverrides ?? policy.allow_raw_config_overrides, false),
    allowDangerFullAccess,
    maxParallelRuns: strictInteger(merged.maxParallelRuns ?? policy.max_parallel_runs, 1, 32, 10, 'max_parallel_runs'),
    maxPromptBytes: strictInteger(merged.maxPromptBytes ?? policy.max_prompt_bytes, 1, 50 * 1024 * 1024, DEFAULT_MAX_PROMPT_BYTES, 'max_prompt_bytes'),
    maxOutputBytes: strictInteger(merged.maxOutputBytes ?? policy.max_output_bytes, 1, 50 * 1024 * 1024, DEFAULT_MAX_OUTPUT_BYTES, 'max_output_bytes'),
    maxRunMs: strictInteger(merged.maxRunMs ?? policy.max_run_ms, 1, 24 * 60 * 60 * 1000, DEFAULT_MAX_RUN_MS, 'max_run_ms'),
    cognitionDefaults: finalCognitionDefaults,
    runtimes: {
      codex: {
        command: codexCommand,
        commandArgs: codexCommandArgs,
        defaultSandbox: codexDefaultSandbox,
        defaultReasoningEffort: stringValue(merged.defaultReasoningEffort ?? codex.default_reasoning_effort ?? 'medium'),
        ephemeral: booleanValue(merged.ephemeral ?? codex.ephemeral, true),
        jsonEvents: booleanValue(merged.jsonEvents ?? codex.json_events, true),
      },
      deepseek: {
        command: deepseekCommand,
        commandArgs: deepseekCommandArgs,
        defaultSandbox: deepseekDefaultSandbox,
        defaultReasoningEffort: stringValue(merged.deepseekDefaultReasoningEffort ?? deepseekCfg.default_reasoning_effort ?? 'high'),
        ephemeral: booleanValue(merged.deepseekEphemeral ?? deepseekCfg.ephemeral, true),
        jsonEvents: booleanValue(merged.deepseekJsonEvents ?? deepseekCfg.json_events, false),
      },
      naradaAgentRuntimeServer: {
        command: naradaAgentRuntimeServerCommand,
        commandArgs: naradaAgentRuntimeServerCommandArgs,
        defaultSandbox: naradaAgentRuntimeServerDefaultSandbox,
        defaultReasoningEffort: stringValue(merged.naradaAgentRuntimeServerDefaultReasoningEffort ?? naradaAgentRuntimeServerCfg.default_reasoning_effort ?? 'medium'),
        ephemeral: booleanValue(merged.naradaAgentRuntimeServerEphemeral ?? naradaAgentRuntimeServerCfg.ephemeral, true),
        jsonEvents: booleanValue(merged.naradaAgentRuntimeServerJsonEvents ?? naradaAgentRuntimeServerCfg.json_events, true),
      },
    },
  };
}

function naradaSiteRootMarker(path: string): string | null {
  if (isDirectory(join(path, '.narada'))) return '.narada/';
  if (isDirectory(join(path, '.ai', 'mcp'))) return '.ai/mcp/';
  return null;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function runtimeList(value: unknown): WorkerRuntimeId[] {
  const list = stringList(value).map((runtime) => {
    if (!isWorkerRuntime(runtime)) throw diagnosticError('worker_runtime_not_allowed', 'worker_runtime_not_allowed', { runtime });
    return runtime;
  });
  return list.length > 0 ? [...new Set(list)] : ['codex', 'deepseek-api', 'narada-agent-runtime-server'];
}

function providerList(value: unknown): string[] {
  const list = stringList(value).map((provider) => provider.trim()).filter(Boolean);
  return list.length > 0 ? [...new Set(list)] : [...DEFAULT_NARADA_AGENT_RUNTIME_PROVIDERS];
}

function isWorkerRuntime(value: unknown): value is WorkerRuntimeId {
  return value === 'codex' || value === 'deepseek-api' || value === 'narada-agent-runtime-server';
}

export function defaultConfigForCognition(cognition: WorkerCognition, policy: WorkerPolicy): WorkerCognitionDefaults {
  return policy.cognitionDefaults[cognition] ?? policy.cognitionDefaults.low;
}

export function resolveAuthority(value: unknown, policy: WorkerPolicy): WorkerAuthority {
  const authority = validateAuthority(value ?? policy.defaultAuthority);
  if (!policy.allowedAuthorities.includes(authority)) throw diagnosticError('worker_invalid_authority', 'worker_invalid_authority', { authority, allowed_authorities: policy.allowedAuthorities });
  return authority;
}

export function resolveCognition(value: unknown, policy: WorkerPolicy): WorkerCognition {
  const cognition = validateCognition(value ?? policy.defaultCognition);
  if (!policy.allowedCognition.includes(cognition)) throw diagnosticError('worker_invalid_cognition', 'worker_invalid_cognition', { cognition, allowed_cognition: policy.allowedCognition });
  return cognition;
}

export function defaultSandboxForAuthority(authority: WorkerAuthority): SandboxMode {
  if (authority === 'write' || authority === 'command') return 'workspace-write';
  return 'read-only';
}

export function publicWorkerPolicy(policy: WorkerPolicy): Record<string, unknown> {
  return {
    schema: 'narada.worker.policy.v1',
    status: 'ok',
    default_runtime: policy.defaultRuntime,
    default_authority: policy.defaultAuthority,
    default_cognition: policy.defaultCognition,
    allowed_authorities: policy.allowedAuthorities,
    allowed_cognition: policy.allowedCognition,
    run_root: policy.runRoot,
    audit_log_dir: policy.auditLogDir,
    allowed_roots: policy.allowedRoots,
    roots_from_trust_config: policy.rootsFromTrustConfig,
    allowed_runtimes: policy.allowedRuntimes,
    allowed_narada_agent_runtime_providers: policy.allowedNaradaAgentRuntimeProviders,
    allowed_sandboxes: policy.allowedSandboxes,
    allowed_config_keys: policy.allowedConfigKeys,
    allow_raw_config_overrides: policy.allowRawConfigOverrides,
    allow_danger_full_access: policy.allowDangerFullAccess,
    nars_site_semantics: {
      runtime: 'narada-agent-runtime-server',
      site_bound: true,
      required_markers: [...NARADA_SITE_ROOT_MARKERS],
      site_root_resolution: 'constraints.site_root when provided; otherwise nearest parent containing a Narada Site marker above cwd',
      workspace_root: 'worker cwd inside the resolved Site root',
      environment_keys: ['NARADA_SITE_ROOT', 'NARADA_WORKSPACE_ROOT', 'NARADA_AGENT_ID', 'NARADA_CARRIER_SESSION_ID'],
      provider_env_key: 'NARADA_INTELLIGENCE_PROVIDER',
      allowed_providers: policy.allowedNaradaAgentRuntimeProviders,
      remediation: NARADA_AGENT_RUNTIME_SITE_REMEDIATION,
    },
    max_parallel_runs: policy.maxParallelRuns,
    max_prompt_bytes: policy.maxPromptBytes,
    max_output_bytes: policy.maxOutputBytes,
    max_run_ms: policy.maxRunMs,
    cognition_defaults: Object.fromEntries(Object.entries(policy.cognitionDefaults).map(([cognition, defaults]) => [cognition, {
      model: defaults.model,
      reasoning_effort: defaults.reasoningEffort,
    }])),
    runtimes: {
      codex: {
        id: 'codex',
        command: policy.runtimes.codex.command,
        command_args: policy.runtimes.codex.commandArgs,
        default_sandbox: policy.runtimes.codex.defaultSandbox,
        default_reasoning_effort: policy.runtimes.codex.defaultReasoningEffort,
        ephemeral: policy.runtimes.codex.ephemeral,
        json_events: policy.runtimes.codex.jsonEvents,
      },
      deepseek: {
        id: 'deepseek-api',
        command: policy.runtimes.deepseek.command,
        command_args: policy.runtimes.deepseek.commandArgs,
        default_sandbox: policy.runtimes.deepseek.defaultSandbox,
        default_reasoning_effort: policy.runtimes.deepseek.defaultReasoningEffort,
        ephemeral: policy.runtimes.deepseek.ephemeral,
        json_events: policy.runtimes.deepseek.jsonEvents,
      },
      'deepseek-api': {
        id: 'deepseek-api',
        command: policy.runtimes.deepseek.command,
        command_args: policy.runtimes.deepseek.commandArgs,
        default_sandbox: policy.runtimes.deepseek.defaultSandbox,
        default_reasoning_effort: policy.runtimes.deepseek.defaultReasoningEffort,
        ephemeral: policy.runtimes.deepseek.ephemeral,
        json_events: policy.runtimes.deepseek.jsonEvents,
      },
      'narada-agent-runtime-server': {
        id: 'narada-agent-runtime-server',
        command: policy.runtimes.naradaAgentRuntimeServer.command,
        command_args: policy.runtimes.naradaAgentRuntimeServer.commandArgs,
        default_sandbox: policy.runtimes.naradaAgentRuntimeServer.defaultSandbox,
        default_reasoning_effort: policy.runtimes.naradaAgentRuntimeServer.defaultReasoningEffort,
        ephemeral: policy.runtimes.naradaAgentRuntimeServer.ephemeral,
        json_events: policy.runtimes.naradaAgentRuntimeServer.jsonEvents,
        carrier_kind: 'agent-cli',
        carrier_transport: 'jsonl-stdio',
        site_bound: true,
        site_root_markers: [...NARADA_SITE_ROOT_MARKERS],
        site_root_resolution: 'constraints.site_root when provided; otherwise nearest parent containing a Narada Site marker above cwd',
        site_environment_keys: ['NARADA_SITE_ROOT', 'NARADA_WORKSPACE_ROOT', 'NARADA_AGENT_ID', 'NARADA_CARRIER_SESSION_ID'],
        provider_env_key: 'NARADA_INTELLIGENCE_PROVIDER',
        allowed_providers: policy.allowedNaradaAgentRuntimeProviders,
        site_root_required_remediation: NARADA_AGENT_RUNTIME_SITE_REMEDIATION,
      },
    },
  };
}

export function resolveWorkingDirectory(input: unknown, policy: WorkerPolicy): string {
  const cwd = resolve(requiredString(input, 'worker_cwd_required'));
  if (!policy.allowedRoots.some((root) => areSamePath(cwd, root) || isPathInside(cwd, root))) {
    throw diagnosticError('worker_cwd_outside_allowed_roots', 'worker_cwd_outside_allowed_roots', { cwd, allowed_roots: policy.allowedRoots });
  }
  return cwd;
}

export type NaradaSiteBinding = {
  siteRoot: string;
  marker: string;
  source: 'explicit' | 'nearest_marker';
};

export function resolveNaradaSiteBinding(cwd: string, policy: WorkerPolicy, explicitSiteRoot?: unknown): NaradaSiteBinding {
  if (explicitSiteRoot !== undefined && explicitSiteRoot !== null && String(explicitSiteRoot).trim()) {
    const siteRoot = resolveWorkingDirectory(explicitSiteRoot, policy);
    const marker = naradaSiteRootMarker(siteRoot);
    if (!marker) {
      throw diagnosticError('worker_narada_site_root_not_found', 'worker_narada_site_root_not_found', siteRootNotFoundDetails({ cwd, site_root: siteRoot, explicit: true }));
    }
    return { siteRoot, marker, source: 'explicit' };
  }

  let current = resolve(cwd);
  while (true) {
    const marker = naradaSiteRootMarker(current);
    if (marker) return { siteRoot: current, marker, source: 'nearest_marker' };
    const parent = dirname(current);
    if (parent === current) break;
    if (!policy.allowedRoots.some((root) => areSamePath(parent, root) || isPathInside(parent, root))) break;
    current = parent;
  }
  throw diagnosticError('worker_narada_site_root_not_found', 'worker_narada_site_root_not_found', siteRootNotFoundDetails({ cwd, explicit: false }));
}

function siteRootNotFoundDetails(base: Record<string, unknown>): Record<string, unknown> {
  const details = {
    ...base,
    required_markers: [...NARADA_SITE_ROOT_MARKERS],
    remediation: NARADA_AGENT_RUNTIME_SITE_REMEDIATION,
  };
  return { ...details, details };
}

export function resolveNaradaSiteRoot(cwd: string, policy: WorkerPolicy, explicitSiteRoot?: unknown): string {
  return resolveNaradaSiteBinding(cwd, policy, explicitSiteRoot).siteRoot;
}

export function validateRuntime(value: unknown, policy: WorkerPolicy): WorkerRuntimeId {
  const runtime = stringValue(value ?? policy.defaultRuntime);
  if (!isWorkerRuntime(runtime)) throw diagnosticError('worker_invalid_runtime', 'worker_invalid_runtime', { runtime });
  if (!policy.allowedRuntimes.includes(runtime)) throw diagnosticError('worker_runtime_not_allowed', 'worker_runtime_not_allowed', { runtime });
  return runtime;
}

export function resolveNaradaAgentRuntimeProvider(value: unknown, policy: WorkerPolicy): { provider: string | null; source: string } {
  const provider = stringOrNull(value);
  if (!provider) return { provider: null, source: 'runtime_default' };
  if (!policy.allowedNaradaAgentRuntimeProviders.includes(provider)) {
    throw diagnosticError('worker_narada_provider_not_allowed', 'worker_narada_provider_not_allowed', { provider, allowed_providers: policy.allowedNaradaAgentRuntimeProviders });
  }
  return { provider, source: 'explicit_constraint' };
}

export function rejectNaradaAgentRuntimeProviderForRuntime(provider: unknown, runtime: WorkerRuntimeId): void {
  if (provider === undefined || provider === null || String(provider).trim() === '') return;
  if (runtime !== 'narada-agent-runtime-server') throw diagnosticError('worker_narada_provider_runtime_mismatch', 'worker_narada_provider_runtime_mismatch', { runtime, provider });
}

export function validateSandbox(value: unknown): SandboxMode {
  const sandbox = stringValue(value);
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write' && sandbox !== 'danger-full-access') {
    throw diagnosticError('worker_invalid_sandbox', 'worker_invalid_sandbox', { sandbox });
  }
  return sandbox;
}

export function resolveSandbox(value: unknown, policy: WorkerPolicy, runtime?: WorkerRuntimeId): SandboxMode {
  const defaultSandbox = runtime === 'deepseek-api'
    ? policy.runtimes.deepseek.defaultSandbox
    : runtime === 'narada-agent-runtime-server'
      ? policy.runtimes.naradaAgentRuntimeServer.defaultSandbox
      : policy.runtimes.codex.defaultSandbox;
  const sandbox = validateSandbox(value ?? defaultSandbox);
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
  const envByLowerKey = process.platform === 'win32'
    ? new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]))
    : null;
  for (const key of ENV_KEYS) {
    const value = typeof env[key] === 'string' ? env[key] : envByLowerKey?.get(key.toLowerCase());
    if (typeof value === 'string') result[key] = value;
  }
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
    const key = normalizePathComparisonKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(resolved);
  }
  return normalized;
}

function mergeConfig(fileConfig: Record<string, unknown>, options: Record<string, unknown>): Record<string, unknown> {
  return { ...fileConfig, ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'config')) };
}

function cognitionDefaults(cognition: Record<string, unknown>, options: Record<string, unknown>): Record<WorkerCognition, WorkerCognitionDefaults> {
  return {
    low: cognitionDefault('low', cognition, options, null, null),
    medium: cognitionDefault('medium', cognition, options, null, null),
    high: cognitionDefault('high', cognition, options, null, null),
  };
}

function cognitionDefault(level: WorkerCognition, cognition: Record<string, unknown>, options: Record<string, unknown>, defaultModel: string | null, defaultReasoningEffort: string | null): WorkerCognitionDefaults {
  const config = asRecord(cognition[level]);
  const pascal = `${level[0].toUpperCase()}${level.slice(1)}`;
  return {
    model: stringOrNull(options[`cognition${pascal}Model`] ?? config.model ?? defaultModel),
    reasoningEffort: stringOrNull(options[`cognition${pascal}ReasoningEffort`] ?? config.reasoning_effort ?? defaultReasoningEffort),
  };
}

function authorityList(value: unknown): WorkerAuthority[] {
  const list = stringList(value).map(validateAuthority);
  return list.length > 0 ? list : [...WORKER_AUTHORITIES];
}

function cognitionList(value: unknown): WorkerCognition[] {
  const list = stringList(value).map(validateCognition);
  return list.length > 0 ? list : [...WORKER_COGNITION];
}

function defaultRunRoot(): string {
  const siteRoot = process.env.NARADA_SITE_ROOT;
  if (siteRoot) return resolve(siteRoot, '.narada', 'runtime', 'worker-delegation');
  const userHome = process.env.USERPROFILE || process.env.HOME;
  if (userHome && existsSync(resolve(userHome, 'Narada'))) {
    return resolve(userHome, 'Narada', '.narada', 'runtime', 'worker-delegation');
  }
  const home = process.env.CODEX_HOME || userHome || process.cwd();
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
  const rel = relative(normalizePathComparisonKey(root), normalizePathComparisonKey(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function areSamePath(left: string, right: string): boolean {
  return normalizePathComparisonKey(left) === normalizePathComparisonKey(right);
}

function normalizePathComparisonKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validateAuthority(value: unknown): WorkerAuthority {
  const authority = stringValue(value);
  if (authority !== 'read' && authority !== 'write' && authority !== 'command') throw diagnosticError('worker_invalid_authority', 'worker_invalid_authority', { authority });
  return authority;
}

function validateCognition(value: unknown): WorkerCognition {
  const cognition = stringValue(value);
  if (cognition !== 'low' && cognition !== 'medium' && cognition !== 'high') throw diagnosticError('worker_invalid_cognition', 'worker_invalid_cognition', { cognition });
  return cognition;
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}
