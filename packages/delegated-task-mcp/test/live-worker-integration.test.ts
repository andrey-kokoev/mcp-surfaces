import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

if (process.argv.includes('--provider')) {
  await runProviderIntegration();
} else {
  await runDeterministicFailureIntegration();
}

async function runDeterministicFailureIntegration(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'delegated-task-mcp-live-failure-'));
  try {
    const state = createServerState({
      taskRoot: join(root, '.tasks'),
      allowedRoots: [root],
      workerTool: async (name: string) => {
        if (name === 'worker_run') throw new Error('deterministic worker runtime failure');
        throw new Error(`unexpected worker tool in deterministic failure test: ${name}`);
      },
    });
    const run = await callTool(state, 'delegated_task_run', {
      objective: 'Deterministic live worker failure propagation',
      constraints: { authority: 'read', cwd: root },
      workflow: { steps: [{ id: 'audit', kind: 'review', instruction: 'deterministic failure' }] },
      execution: { wait_for_completion: true },
      result_policy: { include_diagnostics_by_default: true },
    });
    assert.equal(run.error, undefined, JSON.stringify(run));
    const view = run.result.structuredContent as Record<string, any>;
    assert.equal(view.task_status, 'failed', JSON.stringify(view));

    const result = await callTool(state, 'delegated_task_result', { task_id: view.task_id, include_diagnostics: true });
    assert.equal(result.error, undefined, JSON.stringify(result));
    const resultView = result.result.structuredContent as Record<string, any>;
    assert.equal(resultView.result.worker_launch_failure_count, 1);
    assert.match(String(resultView.result.worker_launch_failures[0].message), /deterministic worker runtime failure/);

    console.log('delegated-task-mcp deterministic live-worker failure propagation ok');
  } finally {
    await cleanupRoot(root);
  }
}

async function runProviderIntegration(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'delegated-task-mcp-live-provider-'));
  try {
    writeFileSync(join(root, 'README.md'), '# live delegated task test\n', 'utf8');
    const codexScript = join(dirname(process.execPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!existsSync(codexScript)) {
      console.log(`delegated-task-mcp provider integration skipped: codex script missing: ${codexScript}`);
      return;
    }
    const state = createServerState({
      taskRoot: join(root, '.tasks'),
      allowedRoots: [root],
      workerPolicy: {
        defaultRuntime: 'codex',
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

    if (run.error) throw new Error(`delegated-task-mcp provider integration failed: ${JSON.stringify(run.error)}`);
    const view = run.result.structuredContent as Record<string, any>;
    if (view.task_status !== 'completed') {
      const diagnostic = await callTool(state, 'delegated_task_result', { task_id: view.task_id, include_diagnostics: true });
      throw new Error(`delegated-task-mcp provider integration failed: ${JSON.stringify(diagnostic.result?.structuredContent ?? diagnostic.error ?? view)}`);
    }
    assert.match(String(view.worker_refs?.[0]?.run_id ?? ''), /^run-/);

    const result = await callTool(state, 'delegated_task_result', { task_id: view.task_id, include_diagnostics: true });
    const resultView = result.result.structuredContent as Record<string, any>;
    assert.equal(resultView.result.worker_refs.length, 1);
    assert.match(String(resultView.result.worker_refs[0].run_id), /^run-/);
    assert.equal(resultView.result.acceptance_verdict, 'passed');

    console.log('delegated-task-mcp provider integration ok');
  } finally {
    await cleanupRoot(root);
  }
}

async function callTool(state: ReturnType<typeof createServerState>, name: string, arguments_: Record<string, unknown>) {
  return await handleRequest({
    jsonrpc: '2.0',
    id: `${name}-${Date.now()}-${Math.random()}`,
    method: 'tools/call',
    params: { name, arguments: arguments_ },
  }, state);
}

async function cleanupRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  console.warn(`delegated-task-mcp live integration cleanup deferred: ${root}`);
}
