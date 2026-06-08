import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  optionalRefName,
  publicGitPolicy,
  requireCommitish,
  requireWriteMode,
  resolveWorkingDirectory as resolvePolicyWorkingDirectory,
  validateExplicitFilePath,
  validateGitPathspec,
  type GitMcpPolicy,
} from './policy.js';
import { diagnosticError } from './git-errors.js';
import { combineOutput, ensureGitOk, gitText, runGit } from './git-runner.js';
import { parseStatus } from './status-parser.js';
import type { GitMcpState } from './state.js';

const PREVIEW_CHAR_LIMIT = 1000;

export type GitRequestContext = {
  abortSignal?: AbortSignal;
};

export async function callGitTool(name: string, args: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}): Promise<unknown> {
  if (name === 'git_policy_inspect') return publicGitPolicy(state.policy);
  if (name === 'git_status') return gitStatus(args, state, context);
  if (name === 'git_repositories_summary') return gitRepositoriesSummary(args, state, context);
  if (name === 'git_diff') return gitDiff(args, state, context);
  if (name === 'git_add') return gitAdd(args, state, context);
  if (name === 'git_commit') return gitCommit(args, state, context);
  if (name === 'git_push') return gitPush(args, state, context);
  if (name === 'git_log') return gitLog(args, state, context);
  if (name === 'git_show') return gitShow(args, state, context);
  throw diagnosticError('git_mcp_unknown_tool', `git_mcp_unknown_tool:${name}`, { tool_name: name });
}

export async function gitStatus(args: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}): Promise<Record<string, unknown>> {
  const cwd = resolveWorkingDirectory(args, state);
  const root = await gitText(cwd, ['rev-parse', '--show-toplevel'], state.policy, 'git_status_failed', context);
  const status = await gitText(cwd, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'], state.policy, 'git_status_failed', context);
  const parsed = parseStatus(status);
  const branch = typeof parsed.branch === 'string' ? parsed.branch : null;
  const remotes = await listRemotes(cwd, state.policy, context);
  const configuredPushTarget = await resolvePushTarget(cwd, null, null, state.policy, context, remotes);
  return {
    schema: 'narada.git.status.v1',
    status: 'ok',
    working_directory: cwd,
    repository_root: root.trim(),
    ...parsed,
    remotes,
    remote_names: remotes.map((remote) => remote.name),
    push_target: configuredPushTarget,
    push_remediation: pushRemediation(configuredPushTarget, branch, remotes),
  };
}

export async function gitRepositoriesSummary(args: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}) {
  const workingDirectories = stringArray(args.working_directories);
  if (workingDirectories.length === 0) throw diagnosticError('git_repositories_summary_requires_working_directories');
  const scopeLabel = optionalNonEmptyString(args.scope_label);
  const expectedPathsByRepository = asRecord(args.expected_paths_by_repository);
  const repositories = [];
  for (const workingDirectory of workingDirectories) {
    const status = await gitStatus({ working_directory: workingDirectory }, state, context);
    const repositoryRoot = String(status.repository_root ?? workingDirectory);
    const expectedPaths = stringArray(expectedPathsByRepository[repositoryRoot] ?? expectedPathsByRepository[workingDirectory]);
    const statusEntries = Array.isArray(status.status_entries) ? status.status_entries.map(asStatusEntry) : [];
    const dirtyPaths = statusEntries.map((entry) => String(entry.display_path ?? entry.path ?? '')).filter(Boolean);
    const expectedSet = new Set(expectedPaths);
    const unexpectedDirtyPaths = expectedPaths.length > 0
      ? dirtyPaths.filter((path) => !expectedSet.has(path))
      : [];
    const latestCommitResult = await runGit(String(status.working_directory), ['log', '-1', '--pretty=format:%H%x1f%h%x1f%s'], state.policy, context);
    const [hash = null, shortHash = null, subject = null] = latestCommitResult.exit_code === 0
      ? latestCommitResult.output_text.split('\x1f')
      : [];
    repositories.push({
      working_directory: status.working_directory,
      repository_root: status.repository_root,
      branch: status.branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      clean: status.clean,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      conflicts: status.conflicts,
      remotes: status.remotes,
      push_target: status.push_target,
      push_remediation: status.push_remediation,
      expected_paths: expectedPaths,
      unexpected_dirty_paths: unexpectedDirtyPaths,
      latest_commit: hash ? { hash, short_hash: shortHash, subject } : null,
    });
  }
  return {
    schema: 'narada.git.repositories_summary.v1',
    status: 'ok',
    scope_label: scopeLabel,
    repository_count: repositories.length,
    repositories,
  };
}

export async function gitDiff(args: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}) {
  const cwd = resolveWorkingDirectory(args, state);
  const scope = stringEnum(args.scope, ['working', 'staged', 'commit'], 'working');
  const pathspec = optionalPathspec(args.pathspec);
  const gitArgs = scope === 'staged'
    ? ['diff', '--cached', '--no-ext-diff']
    : scope === 'commit'
      ? ['show', '--format=', '--patch', '--no-ext-diff', requireCommitish(args.commit)]
      : ['diff', '--no-ext-diff'];
  if (pathspec) gitArgs.push('--', pathspec);
  const result = await runGit(cwd, gitArgs, state.policy, context);
  ensureGitOk(result, 'git_diff_failed');
  const diff = result.output_text;
  return {
    schema: 'narada.git.diff.v1',
    status: 'ok',
    working_directory: cwd,
    scope,
    pathspec,
    ...(scope === 'commit' ? { commit: String(args.commit) } : {}),
    diff,
    diff_preview: diff.slice(0, PREVIEW_CHAR_LIMIT),
    diff_omitted: false,
    diff_truncated: result.output_truncated,
    diff_char_length: diff.length,
  };
}

export async function gitAdd(args: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}) {
  requireWriteMode(state.policy, 'git_add');
  const cwd = resolveWorkingDirectory(args, state);
  const scopeLabel = optionalNonEmptyString(args.scope_label);
  const paths = await Promise.all(stringArray(args.paths).map((path) => validateExplicitFilePath(cwd, path, (workdir, gitArgs) => runGit(workdir, gitArgs, state.policy, context))));
  if (paths.length === 0) throw diagnosticError('git_add_requires_paths');
  const result = await runGit(cwd, ['add', '--', ...paths], state.policy, context);
  ensureGitOk(result, 'git_add_failed');
  const status = await gitStatus({ working_directory: cwd }, state, context);
  const payload = {
    schema: 'narada.git.add.v1',
    status: 'ok',
    working_directory: cwd,
    scope_label: scopeLabel,
    paths,
    staged_count: paths.length,
    summary: `staged ${paths.length} path${paths.length === 1 ? '' : 's'}`,
    post_status: status,
  };
  audit(state, payload);
  return payload;
}

export async function gitCommit(args: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}) {
  requireWriteMode(state.policy, 'git_commit');
  const cwd = resolveWorkingDirectory(args, state);
  const scopeLabel = optionalNonEmptyString(args.scope_label);
  const message = requiredNonEmptyString(args.message, 'git_commit_requires_message');
  const body = optionalNonEmptyString(args.body);
  const statusBefore = await gitStatus({ working_directory: cwd }, state, context);
  if (!Array.isArray(statusBefore.staged) || statusBefore.staged.length === 0) {
    throw diagnosticError('git_commit_requires_staged_changes');
  }
  const commitArgs = ['commit', '-m', message];
  if (body) commitArgs.push('-m', body);
  const result = await runGit(cwd, commitArgs, state.policy, context);
  ensureGitOk(result, 'git_commit_failed');
  const commit = (await gitText(cwd, ['rev-parse', 'HEAD'], state.policy, 'git_commit_failed', context)).trim();
  const committedEntries = Array.isArray(statusBefore.status_entries)
    ? statusBefore.status_entries.filter((entry) => asStatusEntry(entry).staged)
    : [];
  const committedFiles = committedEntries.map((entry) => asStatusEntry(entry).display_path).filter(Boolean);
  const payload = {
    schema: 'narada.git.commit.v1',
    status: 'ok',
    working_directory: cwd,
    scope_label: scopeLabel,
    commit,
    committed_entries: committedEntries,
    committed_files: committedFiles,
    committed_file_count: committedEntries.length,
    summary: firstNonEmptyLine(result.output_text) ?? `created ${commit}`,
    output: combineOutput(result),
    post_status: await gitStatus({ working_directory: cwd }, state, context),
  };
  audit(state, payload);
  return payload;
}

export async function gitPush(args: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}) {
  requireWriteMode(state.policy, 'git_push');
  const cwd = resolveWorkingDirectory(args, state);
  const scopeLabel = optionalNonEmptyString(args.scope_label);
  const remote = optionalRefName(args.remote, 'remote');
  const branch = optionalRefName(args.branch, 'branch');
  const pushArgs = ['push'];
  if (remote || branch) {
    if (!remote || !branch) throw diagnosticError('git_push_remote_and_branch_required_together');
    pushArgs.push(remote, branch);
  }
  const before = await gitStatus({ working_directory: cwd }, state, context);
  const remotes = Array.isArray(before.remotes) ? before.remotes.map(asRemote) : [];
  const effectiveTarget = await resolvePushTarget(cwd, remote, branch, state.policy, context, remotes);
  if (effectiveTarget.status !== 'resolved') {
    throw diagnosticError('git_push_target_unresolved', `git_push_target_unresolved:${effectiveTarget.reason ?? 'unknown'}`, {
      working_directory: cwd,
      remote: remote ?? null,
      branch: branch ?? null,
      effective_target: effectiveTarget,
      remotes,
      remediation: pushRemediation(effectiveTarget, typeof before.branch === 'string' ? before.branch : null, remotes),
    });
  }
  const result = await runGit(cwd, pushArgs, state.policy, context);
  ensureGitOk(result, 'git_push_failed');
  const payload = {
    schema: 'narada.git.push.v1',
    status: 'ok',
    working_directory: cwd,
    scope_label: scopeLabel,
    remote: remote ?? null,
    branch: branch ?? null,
    effective_remote: effectiveTarget.remote,
    effective_branch: effectiveTarget.branch,
    effective_target_status: effectiveTarget.status,
    ...(effectiveTarget.reason ? { effective_target_reason: effectiveTarget.reason } : {}),
    output: combineOutput(result),
    pre_status: before,
    post_status: await gitStatus({ working_directory: cwd }, state, context),
  };
  audit(state, payload);
  return payload;
}

export async function gitLog(args: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}) {
  const cwd = resolveWorkingDirectory(args, state);
  const limit = clampInteger(args.limit, 1, 100, 20);
  const pathspec = optionalPathspec(args.pathspec);
  const gitArgs = ['log', `-${limit}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s'];
  if (pathspec) gitArgs.push('--', pathspec);
  const output = await gitText(cwd, gitArgs, state.policy, 'git_log_failed', context);
  const commits = output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, shortHash, authorName, authorEmail, authorDate, subject] = line.split('\x1f');
    return { hash, short_hash: shortHash, author_name: authorName, author_email: authorEmail, author_date: authorDate, subject };
  });
  return {
    schema: 'narada.git.log.v1',
    status: 'ok',
    working_directory: cwd,
    limit,
    pathspec,
    returned: commits.length,
    commits,
  };
}

export async function gitShow(args: Record<string, unknown>, state: GitMcpState, context: GitRequestContext = {}) {
  const cwd = resolveWorkingDirectory(args, state);
  const commit = requireCommitish(args.commit);
  const includePatch = args.include_patch !== false;
  const pathspec = optionalPathspec(args.pathspec);
  const metadata = await gitText(cwd, ['show', '--no-patch', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b', commit], state.policy, 'git_show_failed', context);
  const [hash, shortHash, authorName, authorEmail, authorDate, subject, ...bodyParts] = metadata.split('\x1f');
  const patchArgs = ['show', '--format=', '--patch', '--no-ext-diff', commit];
  if (pathspec) patchArgs.push('--', pathspec);
  const patchResult = includePatch ? await runGit(cwd, patchArgs, state.policy, context) : null;
  if (patchResult) ensureGitOk(patchResult, 'git_show_failed');
  const patch = patchResult ? patchResult.output_text.trimStart() : '';
  return {
    schema: 'narada.git.show.v1',
    status: 'ok',
    working_directory: cwd,
    commit,
    hash,
    short_hash: shortHash,
    author_name: authorName,
    author_email: authorEmail,
    author_date: authorDate,
    subject,
    body: bodyParts.join('\x1f').trimEnd(),
    include_patch: includePatch,
    pathspec,
    patch,
    patch_preview: patch.slice(0, PREVIEW_CHAR_LIMIT),
    patch_omitted: false,
    patch_truncated: patchResult?.output_truncated ?? false,
    patch_char_length: patch.length,
  };
}

function resolveWorkingDirectory(args: Record<string, unknown>, state: GitMcpState): string {
  return resolvePolicyWorkingDirectory(args.working_directory, state.policy);
}

async function resolvePushTarget(cwd: string, remote: string | null, branch: string | null, policy: GitMcpPolicy, context: GitRequestContext = {}, remotes: Array<Record<string, unknown>> | null = null) {
  const knownRemotes = remotes ?? await listRemotes(cwd, policy, context);
  if (remote && branch) {
    const exists = knownRemotes.some((candidate) => candidate.name === remote);
    return exists
      ? { status: 'resolved', remote, branch, reason: null }
      : { status: 'unresolved', remote, branch, reason: 'remote_not_configured' };
  }
  const currentBranchResult = await runGit(cwd, ['branch', '--show-current'], policy, context);
  if (currentBranchResult.exit_code !== 0 || currentBranchResult.timed_out) {
    return { status: 'unresolved', remote: null, branch: null, reason: 'current_branch_unavailable' };
  }
  const currentBranch = currentBranchResult.output_text.trim() || null;
  if (!currentBranch) return { status: 'unresolved', remote: null, branch: null, reason: 'detached_head_or_unborn_branch' };
  const upstreamRemoteResult = await runGit(cwd, ['config', '--get', `branch.${currentBranch}.remote`], policy, context);
  const upstreamMergeResult = await runGit(cwd, ['config', '--get', `branch.${currentBranch}.merge`], policy, context);
  if (upstreamRemoteResult.exit_code !== 0 || upstreamMergeResult.exit_code !== 0) {
    return { status: 'unresolved', remote: null, branch: currentBranch, reason: 'upstream_not_configured' };
  }
  const upstreamRemote = upstreamRemoteResult.output_text.trim() || null;
  const upstreamMerge = upstreamMergeResult.output_text.trim() || null;
  const upstreamRemoteExists = upstreamRemote ? knownRemotes.some((candidate) => candidate.name === upstreamRemote) : false;
  if (upstreamRemote && !upstreamRemoteExists) {
    return { status: 'unresolved', remote: upstreamRemote, branch: upstreamMerge?.replace(/^refs\/heads\//, '') ?? currentBranch, reason: 'upstream_remote_not_configured' };
  }
  return {
    status: upstreamRemote && upstreamMerge ? 'resolved' : 'unresolved',
    remote: upstreamRemote,
    branch: upstreamMerge?.replace(/^refs\/heads\//, '') ?? currentBranch,
    reason: upstreamRemote && upstreamMerge ? null : 'upstream_not_configured',
  };
}

async function listRemotes(cwd: string, policy: GitMcpPolicy, context: GitRequestContext = {}) {
  const result = await runGit(cwd, ['remote', '-v'], policy, context);
  ensureGitOk(result, 'git_status_failed');
  const byKey = new Map<string, { name: string; fetch_url: string | null; push_url: string | null }>();
  for (const line of result.output_text.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(.+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, kind] = match;
    const existing = byKey.get(name) ?? { name, fetch_url: null, push_url: null };
    if (kind === 'fetch') existing.fetch_url = url;
    if (kind === 'push') existing.push_url = url;
    byKey.set(name, existing);
  }
  return [...byKey.values()];
}

function pushRemediation(target: Record<string, unknown>, branch: string | null, remotes: Array<Record<string, unknown>>) {
  const reason = String(target.reason ?? '');
  if (target.status === 'resolved') return null;
  if (reason === 'remote_not_configured') {
    return {
      kind: 'configure_remote_or_choose_existing_remote',
      message: `No remote named ${target.remote ?? ''} is configured.`,
      configured_remotes: remotes.map((remote) => remote.name),
      suggested_next_step: 'Add the intended remote, or pass one of the configured remote names.',
    };
  }
  if (reason === 'upstream_not_configured') {
    return {
      kind: 'set_upstream_or_push_explicit_target',
      message: 'Current branch has no upstream configured.',
      configured_remotes: remotes.map((remote) => remote.name),
      suggested_push_shape: branch && remotes.length > 0 ? `git_push(remote=${remotes[0].name}, branch=${branch})` : null,
    };
  }
  if (reason === 'upstream_remote_not_configured') {
    return {
      kind: 'repair_upstream_remote',
      message: `Configured upstream remote ${target.remote ?? ''} is missing from git remote list.`,
      configured_remotes: remotes.map((remote) => remote.name),
      suggested_next_step: 'Add the missing remote or update the branch upstream.',
    };
  }
  return {
    kind: 'inspect_repository_push_target',
    message: `Push target is unresolved: ${reason || 'unknown'}.`,
    configured_remotes: remotes.map((remote) => remote.name),
  };
}

function audit(state: GitMcpState, payload: unknown): void {
  if (!state.auditLogDir) return;
  mkdirSync(state.auditLogDir, { recursive: true });
  appendFileSync(resolve(state.auditLogDir, 'git-mcp.jsonl'), `${JSON.stringify(payload)}\n`, 'utf8');
}

function optionalPathspec(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return validateGitPathspec(value);
}

function requiredNonEmptyString(value: unknown, code: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code);
  return text;
}

function optionalNonEmptyString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function stringEnum(value: unknown, allowed: string[], defaultValue: string): string {
  const text = String(value ?? defaultValue);
  if (!allowed.includes(text)) throw diagnosticError('git_invalid_enum', 'git_invalid_enum', { value: text, allowed });
  return text;
}

function clampInteger(value: unknown, min: number, max: number, defaultValue: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function firstNonEmptyLine(value: string): string | null {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function asStatusEntry(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRemote(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
