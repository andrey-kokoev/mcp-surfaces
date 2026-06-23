import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const DEFAULT_MAX_TIMEOUT_MS = 300_000;

const DEFAULT_BLOCKED_COMMANDS = new Set([
  'cmd',
  'cmd.exe',

  'powershell',
  'powershell.exe',
  'wsl',
  'wsl.exe',
]);

const DEFAULT_ALLOWED_COMMANDS = new Set([
  'railway',
  'wrangler',
]);

const DEFAULT_ALLOWED_PREFIXES = [
  ['pnpm', 'test'],
  ['pnpm', 'build'],
  ['pnpm', 'typecheck'],
  ['pnpm', '--filter'],
  ['pwsh', '-file'],
  ['pwsh', '-noprofile', '-file'],
  ['pwsh', '-noprofile', '-executionpolicy', 'bypass', '-file'],
];

export function createExecutionPolicy(options: unknown = {}) {
  const optionsRecord = asRecord(options);
  const allowedRoots = normalizeAllowedRoots(optionsRecord.allowedRoots);
  const allowedCommands = new Set([...DEFAULT_ALLOWED_COMMANDS, ...normalizeList(optionsRecord.allowedCommands).map((item) => item.toLowerCase())]);
  const allowedPrefixes = [...DEFAULT_ALLOWED_PREFIXES, ...normalizeList(optionsRecord.allowedPrefixes).map((prefix) => normalizePrefix(prefix))];
  const blockedCommands = new Set([...DEFAULT_BLOCKED_COMMANDS, ...normalizeList(optionsRecord.blockedCommands).map((item) => item.toLowerCase())]);
  return {
    allowedRoots,
    allowedCommands,
    defaultAllowedCommands: DEFAULT_ALLOWED_COMMANDS,
    allowedPrefixes,
    defaultAllowedPrefixes: DEFAULT_ALLOWED_PREFIXES,
    blockedCommands,
    maxTimeoutMs: clampInteger(optionsRecord.maxTimeoutMs, 1, DEFAULT_MAX_TIMEOUT_MS, DEFAULT_MAX_TIMEOUT_MS),
    maxOutputBytes: clampInteger(optionsRecord.maxOutputBytes, 1, 20 * 1024 * 1024, 1024 * 1024),
  };

}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
    remediation_hints: reasons.length === 0 ? [] : buildRemediationHints(argv, reasons),
    mcp_fallbacks: reasons.length === 0 ? [] : buildMcpFallbacks(argv, reasons, cwd),
    command: normalizedCommand,
    args: argv.slice(1),
    working_directory: cwd,
    shell_interpolation: false,
  };
}

function buildRemediationHints(argv, reasons) {
  const command = argv[0]?.toLowerCase();
  const subcommand = argv[1]?.toLowerCase();
  const hints = [];

  if (command === 'git') {
    const toolBySubcommand = {
      add: 'git_add',
      commit: 'git_commit',
      diff: 'git_diff',
      log: 'git_log',
      push: 'git_push',
      show: 'git_show',
      status: 'git_status',
    };
    const tool = toolBySubcommand[subcommand] ?? 'git_status';
    hints.push(`Use the governed Git MCP tool ${tool} instead of shelling out to git.`);
  }

  if (command === 'rg' || command === 'grep' || command === 'findstr') {
    hints.push('Use local-filesystem fs_grep_search for content search or fs_glob_search for file pattern search.');
  }

  if (command === 'ls' || command === 'dir' || command === 'find') {
    hints.push('Use local-filesystem fs_glob_search or fs_read_file for governed filesystem inspection.');
  }

  if (reasons.some((reason) => String(reason).startsWith('working_directory_outside_allowed_roots:'))) {
    hints.push('Run from an allowed root or request a policy update through the surface configuration instead of bypassing the root guard.');
  }

  if (reasons.some((reason) => String(reason).startsWith('blocked_command:'))) {
    hints.push('Use an explicit argv-based allowed command or a narrower MCP surface; blocked shell interpreters remain disallowed.');
  }

  return [...new Set(hints)];
}

function buildMcpFallbacks(argv, reasons, cwd) {
  const command = argv[0]?.toLowerCase();
  const args = argv.slice(1);
  const fallbacks = [];
  const refusedByCommandPolicy = reasons.some((reason) => String(reason).startsWith('command_not_allowed:'));
  if (!refusedByCommandPolicy) return fallbacks;

  if (command === 'rg' || command === 'grep' || command === 'findstr') {
    const searchPattern = firstSearchPatternArg(args);
    const filesMode = command === 'rg' && args.some((arg) => String(arg).toLowerCase() === '--files');
    if (!filesMode) {
      fallbacks.push({
        surface_id: 'local-filesystem',
        tool_name: 'fs_grep_search',
        canonical_name: 'fs_grep_search',
        purpose: 'content_search',
        arguments: {
          pattern: searchPattern ?? '<search pattern>',
          path: cwd,
          output_mode: 'content',
        },
      });
    }
    fallbacks.push({
      surface_id: 'local-filesystem',
      tool_name: 'fs_glob_search',
      canonical_name: 'fs_glob_search',
      purpose: filesMode ? 'file_listing' : 'file_pattern_search',
      arguments: {
        pattern: firstGlobArg(args) ?? '*',
        directory: cwd,
      },
    });
  }

  if (command === 'ls' || command === 'dir' || command === 'find') {
    fallbacks.push({
      surface_id: 'local-filesystem',
      tool_name: 'fs_glob_search',
      canonical_name: 'fs_glob_search',
      purpose: 'filesystem_listing',
      arguments: {
        pattern: '*',
        directory: cwd,
      },
    });
  }

  return fallbacks;
}

function firstSearchPatternArg(args) {
  const optionsWithValues = new Set(['-g', '--glob', '-t', '--type', '-T', '--type-not', '-e', '--regexp']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? '');
    if (!arg) continue;
    if (optionsWithValues.has(arg)) {
      if (arg === '-e' || arg === '--regexp') return args[index + 1] ? String(args[index + 1]) : null;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

function firstGlobArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? '');
    if (arg === '-g' || arg === '--glob') return args[index + 1] ? String(args[index + 1]) : null;
  }
  return null;
}

export function publicExecutionPolicy(policy) {
  return {
    schema: 'narada.structured_command.execution_policy.v0',
    allowed_roots: policy.allowedRoots,
    allowed_commands: [...policy.allowedCommands].sort(),
    default_allowed_commands: [...(policy.defaultAllowedCommands ?? [])].sort(),
    allowed_prefixes: policy.allowedPrefixes.map((prefix) => prefix.join(' ')),
    default_allowed_prefixes: (policy.defaultAllowedPrefixes ?? []).map((prefix) => prefix.join(' ')),
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
  return policy.allowedPrefixes.some((prefix) => prefix.every((part, index) => commandPartMatches(argv[index], part, index)) && prefixAllowedByAdditionalGuards(prefix, argv));
}

function prefixAllowedByAdditionalGuards(prefix, argv) {
  if (prefix[0] === 'pnpm' && prefix[1] === '--filter') {
    const script = argv[3]?.toLowerCase();
    return script === 'test' || script === 'build' || script === 'typecheck' || String(script ?? '').startsWith('test:');
  }
  return true;
}

function commandPartMatches(actual, expected, index) {
  const normalizedActual = String(actual ?? '').toLowerCase();
  const normalizedExpected = String(expected ?? '').toLowerCase();
  if (normalizedActual === normalizedExpected) return true;
  if (index !== 0) return false;
  return normalizeExecutableAlias(normalizedActual) === normalizeExecutableAlias(normalizedExpected);
}

function normalizeExecutableAlias(value) {
  if (value === 'pwsh.exe') return 'pwsh';
  return value;
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
