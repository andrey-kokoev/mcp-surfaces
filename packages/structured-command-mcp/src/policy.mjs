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

export function createExecutionPolicy(options = {}) {
  const allowedRoots = normalizeList(options.allowedRoots).map((root) => resolve(root));
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
