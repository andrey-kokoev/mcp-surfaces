import { guidanceToolDefinition } from './guidance.js';
export function listTools(mode: string = 'read'): Array<Record<string, any>> {
  const readTools = [
    guidanceToolDefinition(),
    {
      name: 'git_policy_inspect',
      description: 'Inspect the policy governing Git MCP operations.',
      inputSchema: objectSchema({}),
    },
    {
      name: 'git_status',
      description: 'Inspect branch, upstream, remotes, push readiness, and dirty paths before diffing, staging, committing, or pushing.',
      inputSchema: objectSchema({
        working_directory: { type: 'string', description: 'Repository directory under an allowed root. Defaults to the first allowed root.' },
      }),
    },
    {
      name: 'git_fetch',
      description: 'Fetch one explicit branch from one configured remote without tags or arbitrary refspecs.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        remote: { type: 'string', description: 'Configured remote name.' },
        branch: { type: 'string', description: 'Explicit remote branch name.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['remote', 'branch']),
    },
    {
      name: 'git_rebase',
      description: 'Rebase onto one explicit commit-ish with governed dirty-worktree checks and structured conflict recovery.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        onto: { type: 'string', description: 'Explicit branch, tag, or commit to rebase onto.' },
        autostash: { type: 'boolean', default: false, description: 'Required for tracked dirty worktrees; untracked files are always refused.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['onto']),
    },
    {
      name: 'git_rebase_continue',
      description: 'Continue an in-progress rebase after all conflict paths have been resolved and staged.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }),
    },
    {
      name: 'git_rebase_abort',
      description: 'Abort an in-progress rebase and read back the restored repository state.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }),
    },
    {
      name: 'git_merge',
      description: 'Merge one explicit commit-ish with governed dirty-worktree checks and structured conflict recovery.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        target: { type: 'string', description: 'Explicit branch, tag, or commit to merge.' },
        autostash: { type: 'boolean', default: false, description: 'Required for tracked dirty worktrees; untracked files are always refused.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['target']),
    },
    {
      name: 'git_merge_continue',
      description: 'Complete an in-progress merge after all conflict paths have been resolved and staged.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }),
    },
    {
      name: 'git_merge_abort',
      description: 'Abort an in-progress merge and read back the restored repository state.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }),
    },
    {
      name: 'git_sync_status',
      description: 'Inspect whether a rebase or merge is in progress, including conflict paths and governed recovery actions.',
      inputSchema: objectSchema({
        working_directory: { type: 'string', description: 'Repository directory under an allowed root. Defaults to the first allowed root.' },
      }),
    },
    {
      name: 'git_branch_list',
      description: 'List local and/or remote branches with object ids, current-branch state, and upstream metadata.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        scope: { type: 'string', enum: ['local', 'remote', 'all'], default: 'all' },
        limit: { type: 'integer', default: 100, minimum: 1, maximum: 500 },
      }),
    },
    {
      name: 'git_output_show',
      description: 'Read a materialized Git MCP output_ref produced when a large structured result exceeds inline transport limits. Use the original git_diff next_offset inside the materialized result for diff paging; output_show offset pages the materialized JSON wrapper.',
      inputSchema: objectSchema({
        ref: { type: 'string', description: 'Materialized output ref, e.g. mcp_output:<id>. Alias: output_ref.' },
        output_ref: { type: 'string', description: 'Alias for ref.' },
        offset: { type: 'integer', default: 0, description: 'Character offset into the materialized JSON output.' },
        limit: { type: 'integer', default: 10000, minimum: 1, maximum: 20000, description: 'Maximum output characters to return; the transport hard-caps this value.' },
      }),
    },
    {
      name: 'git_changed_summary',
      description: 'Return a compact dirty-state summary: tracked changed paths, untracked counts grouped by top-level directory, and optional pathspec/expected-path relevance matches. Does not include file diffs.',
      inputSchema: objectSchema({
        working_directory: { type: 'string', description: 'Repository directory under an allowed root. Defaults to the first allowed root.' },
        pathspec: { type: 'string', description: 'Optional single pathspec/prefix to highlight as relevant.' },
        pathspecs: { type: 'array', items: { type: 'string' }, description: 'Optional pathspec/prefix list to highlight as relevant.' },
        expected_paths: { type: 'array', items: { type: 'string' }, description: 'Optional expected dirty paths or prefixes for ownership/task relevance.' },
        untracked_sample_limit: { type: 'integer', default: 20, description: 'Maximum untracked path samples to include across groups.' },
      }),
    },
    {
      name: 'git_repositories_summary',
      description: 'Summarize multiple repositories for multi-repo handoff and publication checks, including dirty paths, latest commit, remotes, and push readiness.',
      inputSchema: objectSchema({
        working_directories: { type: 'array', items: { type: 'string' }, description: 'Repository directories under allowed roots.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied label for the workflow being summarized.' },
        expected_paths_by_repository: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
          description: 'Optional map from working directory or repository root to paths expected to be dirty for this workflow.',
        },
      }, ['working_directories']),
    },
    {
      name: 'git_workflow_record',
      description: 'Record the final status of a multi-repository stage/commit/push workflow for handoff. Requires git-mcp mode=write.',
      inputSchema: objectSchema({
        workflow_id: { type: 'string', description: 'Optional caller-supplied stable workflow id.' },
        scope_label: { type: 'string', description: 'Required caller-supplied workflow label.' },
        summary: { type: 'string', description: 'Optional concise workflow summary.' },
        repositories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              working_directory: { type: 'string' },
              staged_paths: { type: 'array', items: { type: 'string' } },
              committed_sha: { type: 'string' },
              pushed: { type: 'boolean' },
              push_status: { type: 'string', enum: ['pushed', 'not_attempted', 'failed', 'not_pushable'] },
              push_reason: { type: 'string' },
              unrelated_dirty_paths_left: { type: 'array', items: { type: 'string' } },
            },
            required: ['working_directory'],
            additionalProperties: false,
          },
        },
      }, ['scope_label', 'repositories']),
    },
    {
      name: 'git_diff',
      description: 'Show a paged Git diff for working tree, staged changes, or one commit; optionally include bounded untracked-file patches for working-tree review.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        scope: { type: 'string', enum: ['working', 'staged', 'commit'], default: 'working' },
        pathspec: { type: 'string', description: 'Optional single Git pathspec. Use pathspecs for multiple paths.' },
        pathspecs: { type: 'array', items: { type: 'string' }, description: 'Optional Git pathspec list for multi-path diffs.' },
        commit: { type: 'string', description: 'Required when scope is commit.' },
        offset: { type: 'integer', default: 0, description: 'Character offset into the complete diff. Use next_offset from the prior result to continue.' },
        limit: { type: 'integer', default: 4000, description: 'Maximum diff characters to return in this page.' },
        include_untracked: { type: 'boolean', default: false, description: 'When scope=working, append bounded patches for untracked files matched by pathspec.' },
      }),
    },
    {
      name: 'git_log',
      description: 'List recent commits, optionally limited to one path.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        limit: { type: 'integer', default: 20 },
        pathspec: { type: 'string', description: 'Optional Git pathspec.' },
      }),
    },
    {
      name: 'git_show',
      description: 'Show one commit with metadata and optional patch.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        commit: { type: 'string' },
        pathspec: { type: 'string', description: 'Optional Git pathspec.' },
        include_patch: { type: 'boolean', default: true },
      }, ['commit']),
    },
  ];
  const writeTools = [
    {
      name: 'git_add',
      description: 'Preflight all explicit paths and stage them atomically; refuses the whole request before mutation when any path is ignored.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Explicit file paths to stage.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['paths']),
    },
    {
      name: 'git_unstage',
      description: 'Unstage explicit file paths from the index without modifying the working tree.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Explicit file paths to unstage.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['paths']),
    },
    {
      name: 'git_commit',
      description: 'Create a commit from already staged changes. In a mixed worktree, expected_staged_paths is required and must exactly match the intended index scope; scope_label is audit metadata and does not isolate the index.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        message: { type: 'string' },
        body: { type: 'string' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
        expected_staged_paths: { type: 'array', items: { type: 'string' }, description: 'Exact set of staged display paths required before mutation when unstaged, untracked, or conflict paths exist outside the index; also guards the index in clean or staged-only worktrees. The commit is refused atomically when the actual index differs.' },
      }, ['message']),
    },
    {
      name: 'git_push',
      description: 'Push the current branch or an explicit remote and branch. Force push is not supported.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        remote: { type: 'string' },
        branch: { type: 'string' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }),
    },
    {
      name: 'git_branch_create',
      description: 'Create a local branch from HEAD or an explicit start point without checking it out.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        name: { type: 'string' },
        start_point: { type: 'string', description: 'Optional commit, branch, or tag; defaults to HEAD.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['name']),
    },
    {
      name: 'git_branch_switch',
      description: 'Switch to an existing local branch without creating, discarding, or force-applying changes.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        branch: { type: 'string' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['branch']),
    },
    {
      name: 'git_branch_rename',
      description: 'Rename an existing local branch to a new local branch name.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        old_name: { type: 'string' },
        new_name: { type: 'string' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['old_name', 'new_name']),
    },
    {
      name: 'git_branch_delete',
      description: 'Delete a local branch only after verifying it is merged into the selected base; force deletion is not supported.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        branch: { type: 'string' },
        base: { type: 'string', description: 'Commit, branch, or tag used for the merged-only safety check; defaults to the current branch.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['branch']),
    },
    {
      name: 'git_branch_delete_remote',
      description: 'Delete a remote branch only after verifying its remote ref is merged into an explicit local base; force deletion is not supported.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        remote: { type: 'string' },
        branch: { type: 'string' },
        base: { type: 'string', description: 'Local commit, branch, or tag used for the merged-only safety check.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['remote', 'branch', 'base']),
    },
    {
      name: 'git_branch_set_upstream',
      description: 'Set a local branch upstream to an existing branch on a configured remote.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        local_branch: { type: 'string', description: 'Local branch; defaults to the current branch.' },
        remote: { type: 'string' },
        remote_branch: { type: 'string', description: 'Remote branch; defaults to local_branch.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['remote']),
    },
    {
      name: 'git_branch_unset_upstream',
      description: 'Remove upstream configuration from a local branch; defaults to the current branch.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        local_branch: { type: 'string', description: 'Local branch; defaults to the current branch.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }),
    },
  ];
  const renderedWriteTools = mode === 'write'
    ? writeTools
    : writeTools.map((tool) => ({ ...tool, description: `${tool.description} Requires git-mcp mode=write.` }));
  return decorateTools([...readTools, ...renderedWriteTools]);
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function decorateTools(tools: Array<Record<string, any>>): Array<Record<string, any>> {
  return tools.map((tool) => ({ ...tool, annotations: toolAnnotations(String(tool.name)), outputSchema: genericToolOutputSchema() }));
}

function toolAnnotations(name: string) {
  const writes = /git_add|git_unstage|git_commit|git_push|git_fetch|git_rebase|git_merge|git_workflow_record|git_branch_(create|switch|rename|delete|set_upstream|unset_upstream)/.test(name);
  return {
    title: name,
    readOnlyHint: !writes,
    destructiveHint: false,
    idempotentHint: /guidance|inspect|status|sync_status|branch_list|summary|diff|log|show|output_show/.test(name),
    openWorldHint: false,
  };
}

function genericToolOutputSchema() {
  return { type: 'object', additionalProperties: true };
}
