import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JsonRecord } from './protocol.js';
import { firstString, optionalString } from './values.js';

export function resolveOpenAiApiKey(args: JsonRecord, state: { options: JsonRecord }, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = optionalString(args.api_key);
  if (explicit) return explicit;
  const envKey = optionalString(env.OPENAI_API_KEY);
  if (envKey) return envKey;
  const secretRef = openAiSecretRef(state, env) ?? 'narada/provider/openai-api/api-key';
  return lookupPowerShellSecret(secretRef, env, state.options);
}

function openAiSecretRef(state: { options: JsonRecord }, env: NodeJS.ProcessEnv): string | null {
  const registryPath = providerRegistryPath(state, env);
  if (!registryPath || !existsSync(registryPath)) return null;
  try {
    const registry = asRecord(JSON.parse(readFileSync(registryPath, 'utf8')));
    const provider = asRecord(asRecord(registry.providers)['openai-api']);
    const requirement = asRecord(provider.credential_requirement);
    const secretRef = optionalString(requirement.secret_ref) ?? optionalString(provider.credential_secret_ref);
    const envNames = Array.isArray(requirement.env_names) ? requirement.env_names.filter((name): name is string => typeof name === 'string' && name.trim().length > 0) : [];
    if (envNames.length > 0 && !envNames.includes('OPENAI_API_KEY')) return null;
    return secretRef;
  } catch {
    return null;
  }
}

function providerRegistryPath(state: { options: JsonRecord }, env: NodeJS.ProcessEnv): string | null {
  const explicit = firstString(state.options.providerRegistryPath, env.NARADA_INTELLIGENCE_PROVIDER_METADATA_PATH);
  if (explicit) return resolve(explicit);
  const candidates = [
    'D:\\code\\narada\\packages\\carrier-provider-contract\\contracts\\provider-registry.json',
  ];
  return candidates.map((candidate) => resolve(candidate)).find((candidate) => existsSync(candidate)) ?? null;
}

function lookupPowerShellSecret(secretRef: string, env: NodeJS.ProcessEnv, options: JsonRecord): string | null {
  const mode = String(env.NARADA_PROVIDER_SECRET_STORE ?? options.providerSecretStore ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'disabled', 'none'].includes(mode)) return null;
  const command = firstString(options.secretLookupCommand, env.NARADA_SECRET_LOOKUP_COMMAND) ?? 'pwsh';
  const args = Array.isArray(options.secretLookupCommandArgs)
    ? options.secretLookupCommandArgs.map(String)
    : ['-NoProfile', '-NonInteractive', '-Command', SECRET_MANAGEMENT_LOOKUP_SCRIPT];
  const result = nodeSpawnSync(command, args, {
    env: { ...env, NARADA_SECRET_LOOKUP_NAME: secretRef },
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout ?? '').trim();
  return value || null;
}

const SECRET_MANAGEMENT_LOOKUP_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$name = [Environment]::GetEnvironmentVariable('NARADA_SECRET_LOOKUP_NAME', 'Process')
if ([string]::IsNullOrWhiteSpace($name)) { exit 3 }
if (-not (Get-Module -ListAvailable -Name Microsoft.PowerShell.SecretManagement)) { exit 10 }
Import-Module Microsoft.PowerShell.SecretManagement -ErrorAction Stop
$secret = Get-Secret -Name $name -AsPlainText -ErrorAction SilentlyContinue
if ($null -eq $secret -or [string]::IsNullOrWhiteSpace([string]$secret)) { exit 2 }
[Console]::Out.Write([string]$secret)
`;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
