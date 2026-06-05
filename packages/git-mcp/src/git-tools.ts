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

export async function callGitTool(name: string, args: Record<string, unknown>, state: GitMcpState): Promise<unknown> {
  if (name === 'git_policy_inspect') return publicGitPolicy(state.policy);
  if (name === 'git_status') return gitStatus(args, state);
  if (name === 'git_diff') return gitDiff(args, state);
  if (name === 'git_add') return gitAdd(args, state);
  if (name === 'git_commit') return gitCommit(args, state);
  if (name === 'git_push') return gitPush(args, state);
  if (name === 'git_log') return gitLog(args, state);
  if (name === 'git_show') return gitShow(args, state);
  throw diagnosticError('git_mcp_unknown_tool', `git_mcp_unknown_tool:${name}`, { tool_name: name });
}

export async function gitStatus(args: Record<string, unknown>, state: GitMcpState): Promise<Record<string, unknown>> {
  const cwd = resolveWorkingDirectory(args, state);
  const root = await gitText(cwd, ['rev-parse', '--show-toplevel'], state.policy, 'git_status_failed');
  const status = await gitText(cwd, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'], state.policy, 'git_status_failed');
  const parsed = parseStatus(status);
  return {
    schema: 'narada.git.status.v1',
    status: 'ok',
    working_directory: cwd,
    repository_root: root.trim(),
    ...parsed,
  };
}

export async function gitDiff(args: Record<string, unknown>, state: GitMcpState) {
  const cwd = resolveWorkingDirectory(args, state);
  const scope = stringEnum(args.scope, ['working', 'staged', 'commit'], 'working');
  const pathspec = optionalPathspec(args.pathspec);
  const gitArgs = scope === 'staged'
    ? ['diff', '--cached', '--no-ext-diff']
    : scope === 'commit'
      ? ['show', '--format=', '--patch', '--no-ext-diff', requireCommitish(args.commit)]
      : ['diff', '--no-ext-diff'];
  if (pathspec) gitArgs.push('--', pathspec);
  const result = await runGit(cwd, gitArgs, state.policy);
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

export async function gitAdd(args: Record<string, unknown>, state: GitMcpState) {
  requireWriteMode(state.policy, 'git_add');
  const cwd = resolveWorkingDirectory(args, state);
  const paths = await Promise.all(stringArray(args.paths).map((path) => validateExplicitFilePath(cwd, path, (workdir, gitArgs) => runGit(workdir, gitArgs, state.policy))));
  if (paths.length === 0) throw diagnosticError('git_add_requires_paths');
  const result = await runGit(cwd, ['add', '--', ...paths], state.policy);
  ensureGitOk(result, 'git_add_failed');
  const status = await gitStatus({ working_directory: cwd }, state);
  const payload = {
    schema: 'narada.git.add.v1',
    status: 'ok',
    working_directory: cwd,
    paths,
    staged_count: paths.length,
    summary: `staged ${paths.length} path${paths.length === 1 ? '' : 's'}`,
    post_status: status,
  };
  audit(state, payload);
  return payload;
}

export async function gitCommit(args: Record<string, unknown>, state: GitMcpState) {
  requireWriteMode(state.policy, 'git_commit');
  const cwd = resolveWorkingDirectory(args, state);
  const message = requiredNonEmptyString(args.message, 'git_commit_requires_message');
  const body = optionalNonEmptyString(args.body);
  const statusBefore = await gitStatus({ working_directory: cwd }, state);
  if (!Array.isArray(statusBefore.staged) || statusBefore.staged.length === 0) {
    throw diagnosticError('git_commit_requires_staged_changes');
  }
  const commitArgs = ['commit', '-m', message];
  if (body) commitArgs.push('-m', body);
  const result = await runGit(cwd, commitArgs, state.policy);
  ensureGitOk(result, 'git_commit_failed');
  const commit = (await gitText(cwd, ['rev-parse', 'HEAD'], state.policy, 'git_commit_failed')).trim();
  const committedEntries = Array.isArray(statusBefore.status_entries)
    ? statusBefore.status_entries.filter((entry) => asStatusEntry(entry).staged)
    : [];
  const committedFiles = committedEntries.map((entry) => asStatusEntry(entry).display_path).filter(Boolean);
  const payload = {
    schema: 'narada.git.commit.v1',
    status: 'ok',
    working_directory: cwd,
    commit,
    committed_entries: committedEntries,
    committed_files: committedFiles,
    committed_file_count: committedEntries.length,
    summary: firstNonEmptyLine(result.output_text) ?? `created ${commit}`,
    output: combineOutput(result),
    post_status: await gitStatus({ working_directory: cwd }, state),
  };
  audit(state, payload);
  return payload;
}

export async function gitPush(args: Record<string, unknown>, state: GitMcpState) {
  requireWriteMode(state.policy, 'git_push');
  const cwd = resolveWorkingDirectory(args, state);
  const remote = optionalRefName(args.remote, 'remote');
  const branch = optionalRefName(args.branch, 'branch');
  const pushArgs = ['push'];
  if (remote || branch) {
    if (!remote || !branch) throw diagnosticError('git_push_remote_and_branch_required_together');
    pushArgs.push(remote, branch);
  }
  const before = await gitStatus({ working_directory: cwd }, state);
  const effectiveTarget = await resolvePushTarget(cwd, remote, branch, state.policy);
  const result = await runGit(cwd, pushArgs, state.policy);
  ensureGitOk(result, 'git_push_failed');
  const payload = {
    schema: 'narada.git.push.v1',
    status: 'ok',
    working_directory: cwd,
    remote: remote ?? null,
    branch: branch ?? null,
    effective_remote: effectiveTarget.remote,
    effective_branch: effectiveTarget.branch,
    effective_target_status: effectiveTarget.status,
    ...(effectiveTarget.reason ? { effective_target_reason: effectiveTarget.reason } : {}),
    output: combineOutput(result),
    pre_status: before,
    post_status: await gitStatus({ working_directory: cwd }, state),
  };
  audit(state, payload);
  return payload;
}

export async function gitLog(args: Record<string, unknown>, state: GitMcpState) {
  const cwd = resolveWorkingDirectory(args, state);
  const limit = clampInteger(args.limit, 1, 100, 20);
  const pathspec = optionalPathspec(args.pathspec);
  const gitArgs = ['log', `-${limit}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s'];
  if (pathspec) gitArgs.push('--', pathspec);
  const output = await gitText(cwd, gitArgs, state.policy, 'git_log_failed');
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

export async function gitShow(args: Record<string, unknown>, state: GitMcpState) {
  const cwd = resolveWorkingDirectory(args, state);
  const commit = requireCommitish(args.commit);
  const includePatch = args.include_patch !== false;
  const pathspec = optionalPathspec(args.pathspec);
  const metadata = await gitText(cwd, ['show', '--no-patch', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b', commit], state.policy, 'git_show_failed');
  const [hash, shortHash, authorName, authorEmail, authorDate, subject, ...bodyParts] = metadata.split('\x1f');
  const patchArgs = ['show', '--format=', '--patch', '--no-ext-diff', commit];
  if (pathspec) patchArgs.push('--', pathspec);
  const patchResult = includePatch ? await runGit(cwd, patchArgs, state.policy) : null;
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

async function resolvePushTarget(cwd: string, remote: string | null, branch: string | null, policy: GitMcpPolicy) {
  if (remote && branch) return { status: 'resolved', remote, branch, reason: null };
  const currentBranchResult = await runGit(cwd, ['branch', '--show-current'], policy);
  if (currentBranchResult.exit_code !== 0 || currentBranchResult.timed_out) {
    return { status: 'unresolved', remote: null, branch: null, reason: 'current_branch_unavailable' };
  }
  const currentBranch = currentBranchResult.output_text.trim() || null;
  if (!currentBranch) return { status: 'unresolved', remote: null, branch: null, reason: 'detached_head_or_unborn_branch' };
  const upstreamRemoteResult = await runGit(cwd, ['config', '--get', `branch.${currentBranch}.remote`], policy);
  const upstreamMergeResult = await runGit(cwd, ['config', '--get', `branch.${currentBranch}.merge`], policy);
  if (upstreamRemoteResult.exit_code !== 0 || upstreamMergeResult.exit_code !== 0) {
    return { status: 'unresolved', remote: null, branch: currentBranch, reason: 'upstream_not_configured' };
  }
  const upstreamRemote = upstreamRemoteResult.output_text.trim() || null;
  const upstreamMerge = upstreamMergeResult.output_text.trim() || null;
  return {
    status: upstreamRemote && upstreamMerge ? 'resolved' : 'unresolved',
    remote: upstreamRemote,
    branch: upstreamMerge?.replace(/^refs\/heads\//, '') ?? currentBranch,
    reason: upstreamRemote && upstreamMerge ? null : 'upstream_not_configured',
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
