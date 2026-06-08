import { listOutputTools } from '@narada2/mcp-transport';

export function listTools(mode: string = 'read'): Array<Record<string, any>> {
  const readTools = [
    {
      name: 'git_policy_inspect',
      description: 'Inspect the policy governing Git MCP operations.',
      inputSchema: objectSchema({}),
    },
    {
      name: 'git_status',
      description: 'Return Git branch, upstream, remotes, push target diagnostics, and working tree status.',
      inputSchema: objectSchema({
        working_directory: { type: 'string', description: 'Repository directory under an allowed root. Defaults to the first allowed root.' },
      }),
    },
    {
      name: 'git_repositories_summary',
      description: 'Summarize multiple repositories for multi-repo commit/push handoff, including dirty paths, latest commit, remotes, and push readiness.',
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
      name: 'git_diff',
      description: 'Show a bounded Git diff for working tree, staged changes, or one commit.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        scope: { type: 'string', enum: ['working', 'staged', 'commit'], default: 'working' },
        pathspec: { type: 'string', description: 'Optional Git pathspec.' },
        commit: { type: 'string', description: 'Required when scope is commit.' },
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
    ...listOutputTools(),
  ];
  const writeTools = [
    {
      name: 'git_add',
      description: 'Stage explicit file paths.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Explicit file paths to stage.' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
      }, ['paths']),
    },
    {
      name: 'git_commit',
      description: 'Create a commit from already staged changes.',
      inputSchema: objectSchema({
        working_directory: { type: 'string' },
        message: { type: 'string' },
        body: { type: 'string' },
        scope_label: { type: 'string', description: 'Optional caller-supplied audit label for this mutation.' },
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
  const writes = /git_add|git_commit|git_push/.test(name);
  return {
    title: name,
    readOnlyHint: !writes,
    destructiveHint: false,
    idempotentHint: /inspect|status|summary|diff|log|show|output_show/.test(name),
    openWorldHint: false,
  };
}

function genericToolOutputSchema() {
  return { type: 'object', additionalProperties: true };
}
