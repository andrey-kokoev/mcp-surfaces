import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export type GitMcpMode = 'read' | 'write';

export type GitMcpPolicy = {
  mode: GitMcpMode;
  allowedRoots: string[];
  maxTimeoutMs: number;
  maxOutputBytes: number;
  mutationAudit: 'mutations';
  pushPolicy: 'current_upstream_or_explicit_remote_branch';
  branchPolicy: 'merged_only_no_force';
};

export class GitPolicyError extends Error {
  codeName: string;
  details: Record<string, unknown>;

  constructor(codeName: string, details: Record<string, unknown> = {}) {
    super(codeName);
    this.name = 'GitPolicyError';
    this.codeName = codeName;
    this.details = details;
  }
}

const DEFAULT_MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function createGitPolicy(options: Record<string, unknown> = {}): GitMcpPolicy {
  const mode = String(options.mode ?? 'read');
  if (mode !== 'read' && mode !== 'write') throw new GitPolicyError('git_mode_must_be_read_or_write', { mode });
  const siteRoot = resolve(String(options.siteRoot ?? options.outputRoot ?? firstOption(options.allowedRoot) ?? firstOption(options.allowedRoots) ?? process.cwd()));
  const siteExtraRoots = loadSiteExtraAllowedRoots(siteRoot);
  const explicitRoots = [...siteExtraRoots, ...optionList(options.allowedRoot), ...optionList(options.allowedRoots)];
  const allowedRoots = buildAllowedRoots({
    codexConfigPath: stringOrNull(options.rootsFromCodexConfig),
    explicitRoots,
    rootsConfigPath: stringOrNull(options.rootsConfig),
  });
  return {
    mode,
    allowedRoots,
    maxTimeoutMs: clampInteger(options.maxTimeoutMs, 1, 300_000, DEFAULT_MAX_TIMEOUT_MS),
    maxOutputBytes: clampInteger(options.maxOutputBytes, 1, 20 * 1024 * 1024, DEFAULT_MAX_OUTPUT_BYTES),
    mutationAudit: 'mutations',
    pushPolicy: 'current_upstream_or_explicit_remote_branch',
    branchPolicy: 'merged_only_no_force',
  };
}

export function publicGitPolicy(policy: GitMcpPolicy) {
  return {
    schema: 'narada.git.policy.v1',
    mode: policy.mode,
    allowed_roots: policy.allowedRoots,
    max_timeout_ms: policy.maxTimeoutMs,
    max_output_bytes: policy.maxOutputBytes,
    mutation_audit: policy.mutationAudit,
    push_policy: policy.pushPolicy,
    branch_policy: policy.branchPolicy,
  };
}

export function parseTrustedProjectRootsFromTrustConfig(configPath: string) {
  const source = readFileSync(configPath, 'utf8');
  const roots = [];
  let currentProject = null;
  for (const rawLine of source.split(/\r?\n/)) {
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

export function buildAllowedRoots({ codexConfigPath = null, explicitRoots = [], rootsConfigPath = null } = {}) {
  let roots = [];
  if (codexConfigPath) roots.push(...parseTrustedProjectRootsFromTrustConfig(codexConfigPath));
  if (rootsConfigPath) {
    const parsed = JSON.parse(readFileSync(rootsConfigPath, 'utf8'));
    if (!Array.isArray(parsed.allowed_roots)) throw new GitPolicyError('roots_config_requires_allowed_roots_array');
    roots.push(...parsed.allowed_roots);
  }
  roots.push(...explicitRoots);
  roots = normalizeAllowedRoots(roots);
  if (roots.length === 0) throw new GitPolicyError('git_mcp_requires_allowed_root');
  return roots;
}

export function normalizeAllowedRoots(roots: unknown) {
  const seen = new Set();
  const normalized = [];
  for (const root of optionList(roots)) {
    const resolved = resolve(root.trim());
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(resolved);
  }
  return normalized;
}

export function resolveWorkingDirectory(input: unknown, policy: GitMcpPolicy): string {
  const cwd = resolve(String(input ?? policy.allowedRoots[0]));
  if (!policy.allowedRoots.some((root) => cwd === root || isPathInside(cwd, root))) {
    throw new GitPolicyError('git_working_directory_outside_allowed_roots', { working_directory: cwd, allowed_roots: policy.allowedRoots });
  }
  return cwd;
}

export function requireWriteMode(policy: GitMcpPolicy, toolName: string): void {
  if (policy.mode !== 'write') throw new GitPolicyError('git_write_mode_required', { requested_tool: toolName, required_mode: 'write' });
}

export function validateGitPath(value: unknown): string {
  const path = String(value ?? '').trim();
  if (!path) throw new GitPolicyError('git_empty_path');
  if (path.startsWith('-')) throw new GitPolicyError('git_leading_dash_path_not_allowed', { path });
  if (isAbsolute(path)) throw new GitPolicyError('git_absolute_path_not_allowed', { path });
  if (path.split(/[\\/]+/).includes('..')) throw new GitPolicyError('git_parent_path_not_allowed', { path });
  return path;
}

export function validateGitPathspec(value: unknown): string {
  const pathspec = validateGitPath(value);
  if (pathspec.startsWith(':(')) throw new GitPolicyError('git_magic_pathspec_not_allowed', { pathspec });
  return pathspec;
}

export async function validateExplicitFilePath(cwd: string, value: unknown, runGit: (cwd: string, args: string[]) => Promise<{ exit_code: number | null }>): Promise<string> {
  const path = validateGitPath(value);
  if (path === '.') throw new GitPolicyError('git_broad_path_not_allowed', { path });
  if (path.startsWith(':(')) throw new GitPolicyError('git_magic_path_not_allowed', { path });
  if (/[*?\[]/.test(path)) throw new GitPolicyError('git_wildcard_path_not_allowed', { path });
  const absolutePath = resolve(cwd, path);
  if (existsSync(absolutePath)) {
    if (statSync(absolutePath).isDirectory()) throw new GitPolicyError('git_directory_path_not_allowed', { path });
    return path;
  }
  const tracked = await runGit(cwd, ['ls-files', '--error-unmatch', '--', path]);
  if (tracked.exit_code !== 0) throw new GitPolicyError('git_path_not_found', { path });
  return path;
}

export function requireCommitish(value: unknown): string {
  const commit = requiredNonEmptyString(value, 'git_commitish_required');
  if (commit.startsWith('-')) throw new GitPolicyError('git_leading_dash_commitish_not_allowed', { commit });
  if (!/^[A-Za-z0-9._/@{}~^:-]+$/.test(commit)) throw new GitPolicyError('git_invalid_commitish', { commit });
  return commit;
}

export function optionalRefName(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const ref = String(value).trim();
  if (ref.startsWith('-')) throw new GitPolicyError(`git_leading_dash_${field}_not_allowed`, { [field]: ref });
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) throw new GitPolicyError(`git_invalid_${field}`, { [field]: ref });
  return ref;
}

export function requiredBranchName(value: unknown, field: string = 'branch'): string {
  const branch = String(value ?? '').trim();
  if (!branch) throw new GitPolicyError(`git_${field}_required`, { [field]: branch });
  return validateBranchName(branch, field);
}

export function optionalBranchName(value: unknown, field: string = 'branch'): string | null {
  if (value === undefined || value === null || value === '') return null;
  return validateBranchName(String(value).trim(), field);
}

function validateBranchName(branch: string, field: string): string {
  if (!branch) throw new GitPolicyError(`git_${field}_required`, { [field]: branch });
  if (branch.startsWith('-')) throw new GitPolicyError(`git_leading_dash_${field}_not_allowed`, { [field]: branch });
  if (
    !/^[A-Za-z0-9._/-]+$/.test(branch)
    || branch === '.'
    || branch === '..'
    || branch.includes('..')
    || branch.includes('@{')
    || branch.includes('//')
    || branch.startsWith('/')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.includes('/.')
  ) {
    throw new GitPolicyError(`git_invalid_${field}`, { [field]: branch });
  }
  return branch;
}

function requiredNonEmptyString(value: unknown, code: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new GitPolicyError(code);
  return text;
}

function clampInteger(value: unknown, min: number, max: number, defaultValue: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function optionList(value: unknown): string[] {
  if (value === undefined || value === null || value === true) return [];
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [String(value)].filter(Boolean);
}

function firstOption(value: unknown): string | null {
  const values = optionList(value);
  return values.length > 0 ? values[0] : null;
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function siteControlRoot(siteRoot: string): string {
  const root = resolve(siteRoot);
  return basename(root).toLowerCase() === '.narada' ? root : resolve(root, '.narada');
}

function loadSiteExtraAllowedRoots(siteRoot: string): string[] {
  try {
    const configPath = join(siteControlRoot(siteRoot), 'allowed-roots.json');
    if (!existsSync(configPath)) return [];
    const data = JSON.parse(readFileSync(configPath, 'utf8'));
    if (Array.isArray(data.extra_allowed_roots)) return data.extra_allowed_roots.filter((r: unknown) => typeof r === 'string' && r.trim().length > 0);
  } catch {
    // Best-effort.
  }
  return [];
}
