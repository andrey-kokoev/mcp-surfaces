import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const DEFAULT_BLOCKED_COMMANDS = new Set([
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'wsl',
  'wsl.exe',
]);

export function createExecutionPolicy(options: any = {}): any {
  const allowedRoots = normalizeAllowedRoots(options.allowedRoots);
  const allowedCommands = new Set(normalizeList(options.allowedCommands).map((item) => item.toLowerCase()));
  const allowedPrefixes = normalizeList(options.allowedPrefixes).map((prefix) => normalizePrefix(prefix));
  const blockedCommands = new Set([...DEFAULT_BLOCKED_COMMANDS, ...normalizeList(options.blockedCommands).map((item) => item.toLowerCase())]);
  return {
    allowedRoots,
    allowedCommands,
    allowedPrefixes,
    blockedCommands,
    maxTimeoutMs: clampInteger(options.maxTimeoutMs, 1, 300_000, 60_000),
    maxOutputBytes: clampInteger(options.maxOutputBytes, 1, 20 * 1024 * 1024, 1024 * 1024),
  };
}

export function parseTrustedProjectRootsFromTrustConfig(configPath) {
  const source = readFileSync(configPath, 'utf8');
  const roots = [];
  let currentProject = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[projects\.'([^']+)'\]$/i) ?? line.match(/^\[projects\."([^"]+)"\]$/i);
    if (header) {
      currentProject = header[1];
      continue;
    }
    if (line.startsWith('[')) {
      currentProject = null;
      continue;
    }
    if (!currentProject) continue;
    const trust = line.match(/^trust_level\s*=\s*"([^"]+)"$/i);
    if (trust && trust[1].toLowerCase() === 'trusted') roots.push(currentProject);
  }
  return normalizeAllowedRoots(roots);
}

export function buildAllowedRoots({ trustConfigPaths = [], explicitRoots = [] } = {}) {
  const roots = [];
  for (const configPath of normalizeList(trustConfigPaths)) {
    roots.push(...parseTrustedProjectRootsFromTrustConfig(configPath));
  }
  roots.push(...normalizeList(explicitRoots));
  return normalizeAllowedRoots(roots);
}

export function normalizeAllowedRoots(roots) {
  const seen = new Set();
  const normalized = [];
  for (const root of normalizeList(roots)) {
    const resolved = resolve(root.trim());
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(resolved);
  }
  return normalized;
}

export function decideStructuredCommandExecution({ command, args = [], workingDirectory }, policy) {
  const normalizedCommand = normalizeCommand(command);
  const argv = [normalizedCommand, ...normalizeArgs(args)];
  const cwd = resolve(workingDirectory ?? '.');
  const reasons = [];

  if (!normalizedCommand) reasons.push('command_required');
  if (policy.blockedCommands.has(normalizedCommand.toLowerCase())) reasons.push(`blocked_command:${normalizedCommand}`);
  if (!isInsideAnyRoot(cwd, policy.allowedRoots)) reasons.push(`working_directory_outside_allowed_roots:${cwd}`);
  if (!isCommandAllowed(argv, policy)) reasons.push(`command_not_allowed:${argv.join(' ')}`);

  return {
    schema: 'narada.structured_command.execution_decision.v0',
    status: reasons.length === 0 ? 'allowed' : 'refused',
    reasons,
    command: normalizedCommand,
    args: argv.slice(1),
    working_directory: cwd,
    shell_interpolation: false,
  };
}

export function publicExecutionPolicy(policy) {
  return {
    schema: 'narada.structured_command.execution_policy.v0',
    allowed_roots: policy.allowedRoots,
    allowed_commands: [...policy.allowedCommands].sort(),
    allowed_prefixes: policy.allowedPrefixes.map((prefix) => prefix.join(' ')),
    blocked_commands: [...policy.blockedCommands].sort(),
    max_timeout_ms: policy.maxTimeoutMs,
    max_output_bytes: policy.maxOutputBytes,
    shell_interpolation: false,
  };
}

function isCommandAllowed(argv, policy) {
  const command = argv[0]?.toLowerCase();
  if (!command) return false;
  if (policy.allowedCommands.has(command)) return true;
  return policy.allowedPrefixes.some((prefix) => prefix.every((part, index) => argv[index]?.toLowerCase() === part));
}

function isInsideAnyRoot(path, roots) {
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel));
  });
}

function normalizeCommand(command) {
  const value = typeof command === 'string' ? command.trim() : '';
  if (!value || /[\r\n;&|<>]/.test(value)) return '';
  return value;
}

function normalizeArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.map((arg) => String(arg));
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return [String(value)].filter(Boolean);
}

function normalizePrefix(prefix) {
  return String(prefix).trim().split(/\s+/).filter(Boolean).map((item) => item.toLowerCase());
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
