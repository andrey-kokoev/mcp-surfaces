import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServerState,
  gitAdd,
  gitChangedSummary,
  gitCommit,
  gitDiff,
  gitLog,
  gitPush,
  gitRepositoriesSummary,
  gitShow,
  gitStatus,
  gitWorkflowRecord,
  handleRequest,
} from '../src/main.js';
import { runGit } from '../src/git-runner.js';

type RpcResponse = {
  result?: Record<string, any>;
  error?: Record<string, any>;
};

const root = mkdtempSync(join(tmpdir(), 'git-mcp-'));
const repo = join(root, 'repo');
const remote = join(root, 'remote.git');

git(root, ['init', '--bare', '--initial-branch=main', remote]);
git(root, ['init', '--initial-branch=main', repo]);
git(repo, ['config', 'user.email', 'agent@example.test']);
git(repo, ['config', 'user.name', 'Agent Test']);
git(repo, ['config', 'core.autocrlf', 'false']);
git(repo, ['remote', 'add', 'origin', remote]);
const siteRoot = join(root, 'site-root');
mkdirSync(join(siteRoot, '.narada'), { recursive: true });
writeFileSync(join(siteRoot, '.narada', 'secrets.json'), JSON.stringify({ env: { GIT_MCP_TEST_SECRET: 'from-site-secret' } }), 'utf8');
const originalGitSecret = process.env.GIT_MCP_TEST_SECRET;
delete process.env.GIT_MCP_TEST_SECRET;

const state = createServerState({ allowedRoot: root, outputRoot: root, mode: 'write', maxOutputBytes: 2 * 1024 * 1024 });
const readState = createServerState({ allowedRoot: root, outputRoot: root, mode: 'read' });
const secretState = createServerState({ allowedRoot: siteRoot, mode: 'read' });
assert.equal(secretState.env.GIT_MCP_TEST_SECRET, 'from-site-secret');
assert.equal(secretState.policy.allowedRoots.includes(siteRoot), true);
assert.equal(process.env.GIT_MCP_TEST_SECRET, undefined);
if (originalGitSecret === undefined) delete process.env.GIT_MCP_TEST_SECRET;
else process.env.GIT_MCP_TEST_SECRET = originalGitSecret;
const rpc = handleRequest as unknown as (request: Record<string, unknown>, requestState: ReturnType<typeof createServerState>) => Promise<RpcResponse>;

const abortController = new AbortController();
abortController.abort();
const cancelledGit = await runGit(repo, ['status'], state.policy, { abortSignal: abortController.signal });
assert.equal(cancelledGit.cancelled, true);
assert.equal(cancelledGit.timed_out, false);
assert.equal(cancelledGit.exit_code, null);

const secretGitEnv = await runGit(repo, ['var', 'GIT_AUTHOR_IDENT'], secretState.policy, { env: secretState.env });
assert.equal(secretGitEnv.exit_code, 0);

const unbornRepo = join(root, 'unborn');
git(root, ['init', '--initial-branch=main', unbornRepo]);
const unbornStatus = await gitStatus({ working_directory: unbornRepo }, state);
assert.equal(unbornStatus.branch, 'main');
assert.equal(unbornStatus.unborn, true);

const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state);
const toolNames = tools.result?.tools.map((tool) => tool.name).sort();
assert.deepEqual(toolNames.filter((tool) => tool.startsWith('git_')), [
  'git_add',
  'git_changed_summary',
  'git_commit',
  'git_diff',
  'git_log',
  'git_output_show',
  'git_policy_inspect',
  'git_push',
  'git_repositories_summary',
  'git_show',
  'git_status',
  'git_workflow_record',
]);

const readTools = await rpc({ jsonrpc: '2.0', id: 21, method: 'tools/list', params: {} }, readState);
const readToolNames = readTools.result?.tools.map((tool) => tool.name).sort();
assert.equal(readToolNames.includes('git_status'), true);
assert.equal(readToolNames.includes('git_add'), true);
const readAddTool = readTools.result?.tools.find((tool) => tool.name === 'git_add');
assert.match(readAddTool.description, /mode=write/);

const policy = await rpc({
  jsonrpc: '2.0',
  id: 22,
  method: 'tools/call',
  params: { name: 'git_policy_inspect', arguments: {} },
}, state);
assert.equal(policy.result?.structuredContent.mode, 'write');
assert.equal(policy.result?.structuredContent.max_output_bytes, 2 * 1024 * 1024);
assert.match(policy.result?.content[0].text, /git_policy: ok/);
assert.match(policy.result?.content[0].text, /mode: write/);

let status = await gitStatus({ working_directory: repo }, state);
assert.equal(status.clean, true);
assert.equal(String(status.repository_root).replaceAll('\\', '/').endsWith('/repo'), true);
assert.deepEqual(status.remote_names, ['origin']);
assert.deepEqual((status.remotes as any[]).map((candidate) => ({ name: candidate.name, fetch_url: candidate.fetch_url, push_url: candidate.push_url })), [
  { name: 'origin', fetch_url: remote, push_url: remote },
]);
assert.equal((status.push_target as any).status, 'unresolved');
assert.equal((status.push_target as any).reason, 'upstream_not_configured');
assert.equal((status.push_remediation as any).kind, 'set_upstream_or_push_explicit_target');

const noRemoteRepo = join(root, 'no-remote');
git(root, ['init', '--initial-branch=main', noRemoteRepo]);
git(noRemoteRepo, ['config', 'user.email', 'agent@example.test']);
git(noRemoteRepo, ['config', 'user.name', 'Agent Test']);
writeFileSync(join(noRemoteRepo, 'README.md'), 'local only\n', 'utf8');
git(noRemoteRepo, ['add', 'README.md']);
git(noRemoteRepo, ['commit', '-m', 'Initial local commit']);
const noRemoteStatus = await gitStatus({ working_directory: noRemoteRepo }, state);
assert.deepEqual(noRemoteStatus.remote_names, []);
assert.equal((noRemoteStatus.push_target as any).reason, 'upstream_not_configured');
const missingRemotePush = await rpc({
  jsonrpc: '2.0',
  id: 25,
  method: 'tools/call',
  params: { name: 'git_push', arguments: { working_directory: noRemoteRepo, remote: 'origin', branch: 'main' } },
}, state);
assert.equal(missingRemotePush.error?.data.code, 'git_push_target_unresolved');
assert.equal(missingRemotePush.error?.data.details.effective_target.reason, 'remote_not_configured');
assert.match(missingRemotePush.error?.data.details.remediation.message, /No remote named origin/);

writeFileSync(join(repo, 'README.md'), 'hello\n', 'utf8');
mkdirSync(join(repo, 'runtime', 'tmp'), { recursive: true });
mkdirSync(join(repo, 'notes'), { recursive: true });
writeFileSync(join(repo, 'runtime', 'tmp', 'artifact.log'), 'runtime artifact\n', 'utf8');
writeFileSync(join(repo, 'notes', 'task.md'), 'task note\n', 'utf8');
status = await gitStatus({ working_directory: repo }, state);
assert.deepEqual(status.untracked, ['README.md', 'notes/task.md', 'runtime/tmp/artifact.log']);
const changedSummary = await gitChangedSummary({ working_directory: repo, expected_paths: ['README.md', 'notes'], untracked_sample_limit: 2 }, state);
assert.equal(changedSummary.schema, 'narada.git.changed_summary.v1');
assert.equal(changedSummary.tracked_changed_count, 0);
assert.equal(changedSummary.untracked_count, 3);
assert.deepEqual((changedSummary.untracked_groups as any[]).map((group) => ({ top_level: group.top_level, count: group.count })), [
  { top_level: '(root)', count: 1 },
  { top_level: 'notes', count: 1 },
  { top_level: 'runtime', count: 1 },
]);
assert.deepEqual(changedSummary.relevant_changed_paths, ['README.md', 'notes/task.md']);
const untrackedDiff = await gitDiff({ working_directory: repo, scope: 'working', pathspec: 'README.md', include_untracked: true }, state);
assert.deepEqual(untrackedDiff.untracked_paths, ['README.md']);
assert.match(untrackedDiff.diff, /\+hello/);

const addResult = await gitAdd({ working_directory: repo, paths: ['README.md'] }, state);
assert.deepEqual((addResult.post_status as any).staged, ['README.md']);
const postAddSummary = await gitChangedSummary({ working_directory: repo, pathspec: 'README.md' }, state);
assert.deepEqual(postAddSummary.tracked_changed_paths, ['README.md']);
assert.deepEqual(postAddSummary.relevant_changed_paths, ['README.md']);

const stagedDiff = await gitDiff({ working_directory: repo, scope: 'staged' }, state);
assert.match(stagedDiff.diff, /README\.md/);
assert.match(stagedDiff.diff, /\+hello/);

const commitResult = await gitCommit({ working_directory: repo, message: 'Initial commit' }, state);
assert.match(commitResult.commit, /^[0-9a-f]{40}$/);

const logResult = await gitLog({ working_directory: repo, limit: 5 }, state);
assert.equal(logResult.returned, 1);
assert.equal(logResult.commits[0].subject, 'Initial commit');

const showResult = await gitShow({ working_directory: repo, commit: 'HEAD', include_patch: true }, state);
assert.equal(showResult.subject, 'Initial commit');
assert.match(showResult.patch, /README\.md/);

const failedShow = await rpc({
  jsonrpc: '2.0',
  id: 23,
  method: 'tools/call',
  params: { name: 'git_show', arguments: { working_directory: repo, commit: 'missing-ref' } },
}, state);
assert.equal(failedShow.error?.data.code, 'git_show_failed');
assert.equal(typeof failedShow.error?.data.details.exit_code, 'number');
assert.equal(typeof failedShow.error?.data.details.diagnostic_text, 'string');

const unknownTool = await rpc({
  jsonrpc: '2.0',
  id: 24,
  method: 'tools/call',
  params: { name: 'git_unknown', arguments: {} },
}, state);
assert.equal(unknownTool.error?.data.code, 'git_mcp_unknown_tool');

writeFileSync(join(repo, 'README.md'), 'hello\nworld\n', 'utf8');
const workingDiff = await gitDiff({ working_directory: repo, scope: 'working', pathspec: 'README.md' }, state);
assert.match(workingDiff.diff, /\+world/);
assert.equal(workingDiff.offset, 0);
assert.equal(workingDiff.next_offset, null);

await assert.rejects(
  () => gitAdd({ working_directory: repo, paths: ['.'] }, state),
  /git_broad_path_not_allowed/,
);

await assert.rejects(
  () => gitShow({ working_directory: repo, commit: '--all' }, state),
  /git_leading_dash_commitish_not_allowed/,
);

await gitAdd({ working_directory: repo, paths: ['README.md'] }, state);
await gitCommit({ working_directory: repo, message: 'Update readme' }, state);

git(repo, ['mv', 'README.md', 'RENAMED.md']);
const renameStatus = await gitStatus({ working_directory: repo }, state);
assert.deepEqual(renameStatus.staged, ['README.md <- RENAMED.md']);
assert.deepEqual((renameStatus.status_entries as any[]).filter((entry) => !entry.untracked).map((entry) => ({
  x: entry.x,
  y: entry.y,
  path: entry.path,
  original_path: entry.original_path,
})), [{ x: 'R', y: ' ', path: 'RENAMED.md', original_path: 'README.md' }]);
const renameCommit = await gitCommit({ working_directory: repo, message: 'Rename readme' }, state);
assert.deepEqual(renameCommit.committed_files, ['README.md <- RENAMED.md']);
assert.deepEqual((renameCommit.committed_entries as any[]).map((entry) => ({
  x: entry.x,
  y: entry.y,
  path: entry.path,
  original_path: entry.original_path,
})), [{ x: 'R', y: ' ', path: 'RENAMED.md', original_path: 'README.md' }]);
git(repo, ['commit', '--allow-empty', '-m', 'éééé']);

const byteLimitedState = createServerState({ allowedRoot: root, outputRoot: root, maxOutputBytes: 3 });
const byteLimited = await runGit(repo, ['log', '-1', '--format=%s'], byteLimitedState.policy);
assert.equal(byteLimited.output_truncated, true);
assert.equal(Buffer.byteLength(byteLimited.output_text, 'utf8') <= 3, true);

const bigFile = join(repo, 'big.txt');
writeFileSync(bigFile, 'small\n', 'utf8');
git(repo, ['add', 'big.txt']);
git(repo, ['commit', '-m', 'Add big file base']);
writeFileSync(bigFile, `${'x\n'.repeat(2_300_000)}`, 'utf8');
const bigDiff = await gitDiff({ working_directory: repo, scope: 'working', pathspec: 'big.txt' }, state);
assert.equal(bigDiff.diff_truncated, true);
git(repo, ['restore', '--', 'big.txt']);

const pushResult = await gitPush({ working_directory: repo, remote: 'origin', branch: currentBranch(repo) }, state);
assert.match(pushResult.output, /(new branch|main -> main|master -> master)/);

const repositoriesSummary = await gitRepositoriesSummary({
  working_directories: [repo, noRemoteRepo],
  scope_label: 'test-summary',
  expected_paths_by_repository: { [repo]: [] },
}, state);
assert.equal(repositoriesSummary.scope_label, 'test-summary');
assert.equal(repositoriesSummary.repository_count, 2);
assert.equal((repositoriesSummary.repositories as any[])[0].remotes[0].name, 'origin');
assert.equal((repositoriesSummary.repositories as any[])[1].push_target.reason, 'upstream_not_configured');

const workflowRecord = await gitWorkflowRecord({
  workflow_id: 'wf-test',
  scope_label: 'test-summary',
  summary: 'test workflow record',
  repositories: [
    {
      working_directory: repo,
      staged_paths: ['README.md'],
      committed_sha: String(pushResult.pre_status ? '' : ''),
      pushed: true,
      push_status: 'pushed',
      unrelated_dirty_paths_left: [],
    },
    {
      working_directory: noRemoteRepo,
      staged_paths: ['README.md'],
      pushed: false,
      push_status: 'not_pushable',
      push_reason: 'no remote configured',
      unrelated_dirty_paths_left: [],
    },
  ],
}, state);
assert.equal(workflowRecord.workflow_id, 'wf-test');
assert.equal(workflowRecord.scope_label, 'test-summary');
assert.equal(existsSync(workflowRecord.ledger_path), true);
const workflowLedgerLines = readFileSync(workflowRecord.ledger_path, 'utf8').trim().split(/\r?\n/);
assert.equal(JSON.parse(workflowLedgerLines.at(-1) ?? '{}').workflow_id, 'wf-test');
await assert.rejects(
  () => gitWorkflowRecord({
    scope_label: 'bad-status',
    repositories: [
      { working_directory: repo, push_status: 'maybe' },
    ],
  }, state),
  /git_invalid_enum/,
);

const statusCall = await rpc({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'git_status', arguments: { working_directory: repo } },
}, state);
assert.match(statusCall.result?.content[0].text, /git_status: ok/);
assert.match(statusCall.result?.content[0].text, /clean: false/);
assert.match(statusCall.result?.content[0].text, /untracked: 2/);
assert.equal(statusCall.result?.structuredContent.clean, false);

const outside = await rpc({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'git_status', arguments: { working_directory: tmpdir() } },
}, state);
assert.equal(outside.error?.data.code, 'git_working_directory_outside_allowed_roots');

const optionLikePush = await rpc({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'git_push', arguments: { working_directory: repo, remote: '--force', branch: 'main' } },
}, state);
assert.equal(optionLikePush.error?.data.code, 'git_leading_dash_remote_not_allowed');

const readModeAdd = await rpc({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: { name: 'git_add', arguments: { working_directory: repo, paths: ['RENAMED.md'] } },
}, readState);
assert.equal(readModeAdd.error?.data.code, 'git_write_mode_required');
assert.equal(readModeAdd.error?.data.details.required_mode, 'write');
assert.match(readModeAdd.error?.data.details.hint, /mode=write/);

writeFileSync(join(repo, 'summary.txt'), 'summary\n', 'utf8');
await rpc({
  jsonrpc: '2.0',
  id: 61,
  method: 'tools/call',
  params: { name: 'git_add', arguments: { working_directory: repo, paths: ['summary.txt'] } },
}, state);
const commitCall = await rpc({
  jsonrpc: '2.0',
  id: 62,
  method: 'tools/call',
  params: { name: 'git_commit', arguments: { working_directory: repo, message: 'Summary commit' } },
}, state);
assert.match(commitCall.result?.content[0].text, /git_commit: ok/);
assert.match(commitCall.result?.content[0].text, /committed_files: 1/);
assert.match(commitCall.result?.content[0].text, /summary\.txt/);

const pushCall = await rpc({
  jsonrpc: '2.0',
  id: 63,
  method: 'tools/call',
  params: { name: 'git_push', arguments: { working_directory: repo, remote: 'origin', branch: currentBranch(repo) } },
}, state);
assert.match(pushCall.result?.content[0].text, /git_push: ok/);
assert.match(pushCall.result?.content[0].text, /effective_remote: origin/);
assert.match(pushCall.result?.content[0].text, /effective_branch: main/);

writeFileSync(join(repo, 'RENAMED.md'), `${'changed\n'.repeat(2_300_000)}`, 'utf8');
const materialized = await rpc({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'git_diff', arguments: { working_directory: repo, scope: 'working', pathspec: 'RENAMED.md' } },
}, state);
assert.equal(materialized.result?.structuredContent.schema, 'narada.git.diff.v1');
assert.equal(materialized.result?.structuredContent.output_ref, undefined);
assert.match(materialized.result?.structuredContent.diff, /diff --git/);
assert.equal(materialized.result?.structuredContent.offset, 0);
assert.equal(materialized.result?.structuredContent.limit, 4000);
assert.equal(materialized.result?.structuredContent.next_offset, 4000);
assert.equal(materialized.result?.structuredContent.diff_truncated, true);
assert.equal(materialized.result?.content.length, 1);
const diffPage2 = await gitDiff({ working_directory: repo, scope: 'working', pathspec: 'RENAMED.md', offset: materialized.result?.structuredContent.next_offset, limit: 2000 }, state);
assert.equal(diffPage2.offset, 4000);
assert.equal(diffPage2.limit, 2000);
assert.equal(diffPage2.diff.length, 2000);

const largeInlineDiff = await rpc({
  jsonrpc: '2.0',
  id: 71,
  method: 'tools/call',
  params: { name: 'git_diff', arguments: { working_directory: repo, scope: 'working', pathspec: 'RENAMED.md', limit: 12000 } },
}, state);
assert.equal(largeInlineDiff.result?.structuredContent.schema, 'narada.producer_output_page.v1');
assert.equal(largeInlineDiff.result?.structuredContent.result_materialized, true);
assert.equal(largeInlineDiff.result?.structuredContent.reader_tool, 'git_output_show');
assert.match(String(largeInlineDiff.result?.structuredContent.output_ref), /^mcp_output:/);
assert.match(String(largeInlineDiff.result?.structuredContent.remediation), /original tool's own next_offset/);
const shownLargeInlineDiff = await rpc({
  jsonrpc: '2.0',
  id: 72,
  method: 'tools/call',
  params: { name: 'git_output_show', arguments: { ref: largeInlineDiff.result?.structuredContent.output_ref, limit: 30000 } },
}, state);
assert.equal(shownLargeInlineDiff.result?.structuredContent.schema, 'narada.mcp_output_page.v1');
assert.match(shownLargeInlineDiff.result?.structuredContent.output_text, /"schema": "narada.git.diff.v1"/);
assert.match(shownLargeInlineDiff.result?.structuredContent.output_text, /"limit": 12000/);
assert.match(shownLargeInlineDiff.result?.structuredContent.output_text, /"next_offset": 12000/);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function currentBranch(cwd: string): string {
  return git(cwd, ['branch', '--show-current']).trim();
}
