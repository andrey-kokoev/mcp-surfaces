import { spawnSync as nodeSpawnSync } from 'node:child_process';
import type { JsonRecord } from './protocol.js';
import type { SpeechState } from './state.js';
import { firstString } from './values.js';

export function resolveProviderApiKey(state: SpeechState, providerId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const provider = state.providerRegistry.providers[providerId];
  if (!provider || provider.credential_requirement.kind === 'none') return null;
  const envNames = provider.credential_requirement.env_names ?? [];
  for (const envName of envNames) {
    const envKey = String(env[envName] ?? '').trim();
    if (envKey) return envKey;
  }
  return lookupPowerShellSecret(provider.credential_requirement.secret_ref, env, state.options);
}

export function resolveOpenAiApiKey(state: SpeechState, providerId = 'openai-api', env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveProviderApiKey(state, providerId, env);
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
