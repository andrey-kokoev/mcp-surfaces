import { diagnosticError } from './git-errors.js';

const PATCH_PREVIEW_CHAR_LIMIT = 4000;

export function renderToolResultText(value: unknown): string {
  const record = asRecord(value);
  if (record.schema === 'narada.mcp_output_page.v1') return String(record.output_text ?? '');
  if (record.schema === 'narada.mcp_output_locator.v1' || typeof record.output_ref === 'string' && record.result_materialized === true) {
    const label = typeof record.tool_name === 'string' ? record.tool_name : 'git_result';
    return compactLines([
      `${label}: materialized`,
      `status: ${record.status ?? 'ok'}`,
      'result: materialized',
      `output_ref: ${record.output_ref ?? record.ref ?? ''}`,
      `reader_tool: ${record.reader_tool ?? 'none'}`,
      record.full_output_char_length !== undefined ? `full_output_char_length: ${record.full_output_char_length}` : null,
    ]);
  }
  if (record.schema === 'narada.git.policy.v1') return renderPolicy(record);
  if (record.schema === 'narada.git.status.v1') return renderStatus(record);
  if (record.schema === 'narada.git.repositories_summary.v1') return renderRepositoriesSummary(record);
  if (record.schema === 'narada.git.workflow_record.v1') return renderWorkflowRecord(record);
  if (record.schema === 'narada.git.diff.v1') return renderPatchResult('git_diff', record, 'diff');
  if (record.schema === 'narada.git.add.v1') return renderMutation('git_add', record);
  if (record.schema === 'narada.git.commit.v1') return renderMutation('git_commit', record);
  if (record.schema === 'narada.git.push.v1') return renderMutation('git_push', record);
  if (record.schema === 'narada.git.log.v1') return renderLog(record);
  if (record.schema === 'narada.git.show.v1') return renderPatchResult('git_show', record, 'patch');
  throw diagnosticError('git_unrenderable_result_schema', 'git_unrenderable_result_schema', { schema: record.schema ?? null });
}

function renderStatus(record: Record<string, unknown>): string {
  return compactLines([
    `git_status: ${record.status ?? 'ok'}`,
    `working_directory: ${record.working_directory ?? ''}`,
    `repository_root: ${record.repository_root ?? ''}`,
    `branch: ${record.branch ?? ''}`,
    record.upstream !== undefined ? `upstream: ${record.upstream ?? 'null'}` : null,
    record.remote_names !== undefined ? `remotes: ${arrayCount(record.remote_names)}` : null,
    ...arrayLines(record.remote_names),
    renderPushTarget(record.push_target),
    renderPushRemediation(record.push_remediation),
    `clean: ${record.clean ?? false}`,
    `ahead: ${record.ahead ?? 0}`,
    `behind: ${record.behind ?? 0}`,
    `staged: ${arrayCount(record.staged)}`,
    ...arrayLines(record.staged),
    `unstaged: ${arrayCount(record.unstaged)}`,
    ...arrayLines(record.unstaged),
    `untracked: ${arrayCount(record.untracked)}`,
    ...arrayLines(record.untracked),
    `conflicts: ${arrayCount(record.conflicts)}`,
    ...arrayLines(record.conflicts),
  ]);
}

function renderMutation(label: string, record: Record<string, unknown>): string {
  const committedFiles = Array.isArray(record.committed_files) ? record.committed_files : [];
  return compactLines([
    `${label}: ${record.status ?? 'ok'}`,
    `working_directory: ${record.working_directory ?? ''}`,
    record.commit !== undefined ? `commit: ${record.commit}` : null,
    record.scope_label !== undefined ? `scope_label: ${record.scope_label ?? 'null'}` : null,
    record.committed_file_count !== undefined ? `committed_files: ${record.committed_file_count}` : null,
    ...committedFiles.map((file) => `- ${String(file)}`),
    record.remote !== undefined ? `remote: ${record.remote ?? 'null'}` : null,
    record.branch !== undefined ? `branch: ${record.branch ?? 'null'}` : null,
    record.effective_remote !== undefined ? `effective_remote: ${record.effective_remote ?? 'null'}` : null,
    record.effective_branch !== undefined ? `effective_branch: ${record.effective_branch ?? 'null'}` : null,
    record.effective_target_status !== undefined ? `effective_target_status: ${record.effective_target_status}` : null,
    record.effective_target_reason !== undefined ? `effective_target_reason: ${record.effective_target_reason}` : null,
    record.summary !== undefined ? `summary: ${record.summary}` : null,
    record.output ? 'output:' : null,
    record.output ? String(record.output).trimEnd() : null,
  ]);
}

function renderRepositoriesSummary(record: Record<string, unknown>): string {
  const repositories = Array.isArray(record.repositories) ? record.repositories.map(asRecord) : [];
  const lines = [
    `git_repositories_summary: ${record.status ?? 'ok'}`,
    record.scope_label !== undefined ? `scope_label: ${record.scope_label ?? 'null'}` : null,
    `repositories: ${record.repository_count ?? repositories.length}`,
  ];
  for (const repository of repositories) {
    const latestCommit = asRecord(repository.latest_commit);
    lines.push(
      `- ${repository.repository_root ?? repository.working_directory ?? ''}`,
      `  branch: ${repository.branch ?? 'null'}`,
      `  upstream: ${repository.upstream ?? 'null'}`,
      `  ahead: ${repository.ahead ?? 0}`,
      `  behind: ${repository.behind ?? 0}`,
      `  clean: ${repository.clean ?? false}`,
      `  staged: ${arrayCount(repository.staged)}`,
      `  unstaged: ${arrayCount(repository.unstaged)}`,
      `  untracked: ${arrayCount(repository.untracked)}`,
      `  conflicts: ${arrayCount(repository.conflicts)}`,
      `  unexpected_dirty_paths: ${arrayCount(repository.unexpected_dirty_paths)}`,
      latestCommit.hash ? `  latest_commit: ${latestCommit.short_hash ?? latestCommit.hash} ${latestCommit.subject ?? ''}`.trimEnd() : null,
      `  push_target: ${pushTargetSummary(repository.push_target)}`,
      `  push_remediation: ${pushRemediationSummary(repository.push_remediation)}`,
    );
  }
  return compactLines(lines);
}

function renderWorkflowRecord(record: Record<string, unknown>): string {
  const repositories = Array.isArray(record.repositories) ? record.repositories.map(asRecord) : [];
  return compactLines([
    `git_workflow_record: ${record.status ?? 'recorded'}`,
    `workflow_id: ${record.workflow_id ?? ''}`,
    `scope_label: ${record.scope_label ?? ''}`,
    record.summary !== undefined ? `summary: ${record.summary ?? ''}` : null,
    `repositories: ${repositories.length}`,
    ...repositories.flatMap((repository) => [
      `- ${repository.repository_root ?? repository.working_directory ?? ''}`,
      `  committed_sha: ${repository.committed_sha ?? 'null'}`,
      `  pushed: ${repository.pushed ?? false}`,
      `  push_status: ${repository.push_status ?? 'not_attempted'}`,
      `  unrelated_dirty_paths_left: ${arrayCount(repository.unrelated_dirty_paths_left)}`,
    ]),
    record.ledger_path !== undefined ? `ledger_path: ${record.ledger_path}` : null,
  ]);
}

function renderPushTarget(value: unknown): string | null {
  const target = asRecord(value);
  if (!target.status) return null;
  return `push_target: ${pushTargetSummary(target)}`;
}

function renderPushRemediation(value: unknown): string | null {
  const remediation = asRecord(value);
  if (!remediation.kind) return null;
  return `push_remediation: ${pushRemediationSummary(remediation)}`;
}

function pushTargetSummary(value: unknown): string {
  const target = asRecord(value);
  if (!target.status) return 'unknown';
  const remote = target.remote ?? 'null';
  const branch = target.branch ?? 'null';
  const reason = target.reason ? ` reason=${target.reason}` : '';
  return `${target.status} remote=${remote} branch=${branch}${reason}`;
}

function pushRemediationSummary(value: unknown): string {
  const remediation = asRecord(value);
  if (!remediation.kind) return 'none';
  return `${remediation.kind}: ${remediation.message ?? ''}`.trimEnd();
}

function renderPolicy(record: Record<string, unknown>): string {
  const roots = Array.isArray(record.allowed_roots) ? record.allowed_roots : [];
  return compactLines([
    'git_policy: ok',
    `mode: ${record.mode ?? 'read'}`,
    `allowed_roots: ${roots.length}`,
    ...roots.map((root) => `- ${String(root)}`),
    `max_timeout_ms: ${record.max_timeout_ms ?? ''}`,
    `max_output_bytes: ${record.max_output_bytes ?? ''}`,
    `mutation_audit: ${record.mutation_audit ?? ''}`,
    `push_policy: ${record.push_policy ?? ''}`,
  ]);
}

function renderPatchResult(label: string, record: Record<string, unknown>, field: string): string {
  const patch = String(record[field] ?? '');
  const preview = patch.slice(0, PATCH_PREVIEW_CHAR_LIMIT);
  return compactLines([
    `${label}: ${record.status ?? 'ok'}`,
    `working_directory: ${record.working_directory ?? ''}`,
    record.scope !== undefined ? `scope: ${record.scope}` : null,
    record.commit !== undefined ? `commit: ${record.commit}` : null,
    record.pathspec !== undefined ? `pathspec: ${record.pathspec ?? 'null'}` : null,
    record.offset !== undefined ? `offset: ${record.offset}` : null,
    record.limit !== undefined ? `limit: ${record.limit}` : null,
    record.next_offset !== undefined ? `next_offset: ${record.next_offset ?? 'null'}` : null,
    record.include_untracked !== undefined ? `include_untracked: ${record.include_untracked}` : null,
    record.untracked_paths !== undefined ? `untracked_paths: ${arrayCount(record.untracked_paths)}` : null,
    ...arrayLines(record.untracked_paths),
    record.untracked_paths_omitted !== undefined ? `untracked_paths_omitted: ${record.untracked_paths_omitted}` : null,
    record.untracked_diff_truncated !== undefined ? `untracked_diff_truncated: ${record.untracked_diff_truncated}` : null,
    `${field}_truncated: ${record[`${field}_truncated`] ?? false}`,
    `${field}:`,
    preview,
    patch.length > preview.length ? `[${field} preview truncated]` : null,
  ]);
}

function renderLog(record: Record<string, unknown>): string {
  const commits = Array.isArray(record.commits) ? record.commits : [];
  const lines = commits.map((entry) => {
    const commit = asRecord(entry);
    return `${commit.short_hash ?? commit.hash ?? ''} ${commit.author_date ?? ''} ${commit.subject ?? ''}`.trim();
  });
  return compactLines([
    `git_log: ${record.status ?? 'ok'}`,
    `working_directory: ${record.working_directory ?? ''}`,
    `returned: ${record.returned ?? commits.length}`,
    record.pathspec !== undefined ? `pathspec: ${record.pathspec ?? 'null'}` : null,
    'commits:',
    ...lines,
  ]);
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function arrayLines(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => `- ${String(item)}`) : [];
}

function compactLines(lines: Array<string | null>): string {
  return lines.filter((line) => typeof line === 'string' && line.length > 0).join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
