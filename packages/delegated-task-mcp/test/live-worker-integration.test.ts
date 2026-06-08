import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'delegated-task-mcp-live-'));

try {
  writeFileSync(join(root, 'README.md'), '# live delegated task test\n', 'utf8');
  const codexScript = join(dirname(process.execPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!existsSync(codexScript)) {
    console.log(`delegated-task-mcp live worker integration skipped: codex script missing: ${codexScript}`);
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
  }
  const state = createServerState({
    taskRoot: join(root, '.tasks'),
    allowedRoots: [root],
    workerPolicy: {
      allowedAuthorities: ['read'],
      allowedRoots: [root],
      maxRunMs: 180000,
      codexCommand: process.execPath,
      codexCommandArgs: [codexScript],
    },
  });

  const run = await callTool(state, 'delegated_task_run', {
    objective: 'Live worker integration smoke',
    constraints: {
      authority: 'read',
      cwd: root,
      overrides: { skip_git_repo_check: true },
    },
    workflow: {
      steps: [
        {
          id: 'audit',
          kind: 'review',
          instruction: 'Read the current directory context and report that this is a live delegated worker integration smoke. Do not edit files.',
        },
      ],
    },
    acceptance: {
      review_quorum: { min_passed: 1, max_failed: 0 },
    },
    execution: { wait_for_completion: true, timeout_ms: 180000, poll_ms: 250 },
    result_policy: { include_diagnostics_by_default: true },
  });

  if (run.error) {
    console.log(`delegated-task-mcp live worker integration skipped: ${JSON.stringify(run.error)}`);
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
  }
  const view = run.result.structuredContent as Record<string, any>;
  assert.equal(view.task_status, 'completed', JSON.stringify(view));
  assert.match(String(view.worker_refs?.[0]?.run_id ?? ''), /^run-/);

  const result = await callTool(state, 'delegated_task_result', { task_id: view.task_id, include_diagnostics: true });
  const resultView = result.result.structuredContent as Record<string, any>;
  assert.equal(resultView.result.worker_refs.length, 1);
  assert.match(String(resultView.result.worker_refs[0].run_id), /^run-/);
  assert.equal(resultView.result.acceptance_verdict, 'passed');

  console.log('delegated-task-mcp live worker integration ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function callTool(state: ReturnType<typeof createServerState>, name: string, arguments_: Record<string, unknown>) {
  return await handleRequest({
    jsonrpc: '2.0',
    id: `${name}-${Date.now()}-${Math.random()}`,
    method: 'tools/call',
    params: { name, arguments: arguments_ },
  }, state);
}
