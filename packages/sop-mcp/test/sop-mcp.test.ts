import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'sop-mcp-behavior-'));
let state: any;

try {
  state = createServerState({ sopRoot: root });

  function callTool(name: string, args: Record<string, unknown>): Record<string, any> {
    return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as Record<string, any>;
  }
  function view(res: Record<string, any>): Record<string, any> {
    return res.result.structuredContent as Record<string, any>;
  }
  function errCode(res: Record<string, any>): string {
    const error = res.error as Record<string, any>;
    assert.ok(error, `Expected error, got result: ${JSON.stringify(res.result)}`);
    return String(error.data.code);
  }

  const steps = [
    { id: 'verify', kind: 'manual', title: 'Verify access', instructions: 'Check that the site root is reachable.', depends_on: [] },
    { id: 'setup', kind: 'note', title: 'Record setup', instructions: 'Document initial state.', depends_on: ['verify'] },
    { id: 'test', kind: 'manual', title: 'Run tests', instructions: 'Execute the test suite.', depends_on: ['setup'] },
  ];

  const create = callTool('sop_template_create', {
    sop_id: 'site-onboarding',
    title: 'Site Onboarding SOP',
    description: 'Procedure for onboarding a new Site.',
    steps,
    trigger_kind: 'manual',
    acceptance_criteria: ['All gates passed'],
    evidence_requirements: ['Test output'],
  });
  assert.equal(view(create).status, 'created');
  assert.equal(view(create).sop_id, 'site-onboarding');
  assert.equal(view(create).version, 1);
  assert.equal(view(create).step_count, 3);

  const dup = callTool('sop_template_create', {
    sop_id: 'site-onboarding',
    title: 'Site Onboarding SOP v2',
    steps: [{ id: 'only', kind: 'note', title: 'Only step', instructions: 'Just this.' }],
  });
  assert.equal(view(dup).status, 'created');
  assert.equal(view(dup).version, 2);

  const show = callTool('sop_template_show', { sop_id: 'site-onboarding' });
  assert.equal(view(show).sop_id, 'site-onboarding');
  assert.equal(view(show).version, 2);
  assert.equal(view(show).title, 'Site Onboarding SOP v2');

  const showV1 = callTool('sop_template_show', { sop_id: 'site-onboarding', version: 1 });
  assert.equal(view(showV1).version, 1);
  assert.equal(view(showV1).title, 'Site Onboarding SOP');

  const list = callTool('sop_template_list', {});
  assert.equal((view(list).items as Array<unknown>).length >= 1, true);

  const search = callTool('sop_template_search', { query: 'Onboarding' });
  const searchData = view(search);
  assert.equal((searchData.items as Array<unknown>).length >= 1, true);
  assert.equal((searchData.items as Array<Record<string, any>>)[0].title.includes('Onboarding'), true);
  assert.equal(searchData.query, 'Onboarding');

  const searchMiss = callTool('sop_template_search', { query: 'zzznonexistent' });
  assert.equal((view(searchMiss).items as Array<unknown>).length, 0);

  const deprecate = callTool('sop_template_deprecate', { sop_id: 'site-onboarding', reason: 'Replaced.' });
  assert.equal(view(deprecate).status, 'deprecated');

  const depShow = callTool('sop_template_show', { sop_id: 'site-onboarding' });
  assert.equal(view(depShow).status, 'deprecated');

  const upCreate = callTool('sop_template_create', {
    sop_id: 'test-runner',
    title: 'Test Runner',
    steps: [
      { id: 'build', kind: 'note', title: 'Build', instructions: 'Build the project.', depends_on: [] },
      { id: 'run', kind: 'manual', title: 'Run tests', instructions: 'Run the test suite.', depends_on: ['build'] },
    ],
  });
  assert.equal(view(upCreate).status, 'created');

  const update = callTool('sop_template_update', {
    sop_id: 'test-runner',
    steps: [
      { id: 'build', kind: 'note', title: 'Build', instructions: 'Build the project.', depends_on: [] },
      { id: 'lint', kind: 'note', title: 'Lint', instructions: 'Run linter.', depends_on: ['build'] },
      { id: 'run', kind: 'manual', title: 'Run tests', instructions: 'Run the test suite.', depends_on: ['lint'] },
    ],
  });
  assert.equal(view(update).status, 'updated');
  assert.equal(view(update).version, 2);
  assert.equal(view(update).step_count, 3);

  assert.equal(errCode(callTool('sop_template_create', {
    sop_id: 'bad', title: 'Bad',
    steps: [{ id: 'a', kind: 'manual', title: 'A', instructions: 'Do A.', depends_on: ['nonexistent'] }],
  })), 'sop_unknown_dependency');

  assert.equal(errCode(callTool('sop_template_create', {
    sop_id: 'bad-kind', title: 'Bad Kind',
    steps: [{ id: 'a', kind: 'impossible', title: 'Bad', instructions: 'Bad.' }],
  })), 'sop_invalid_step_kind');

  const run = callTool('sop_run_start', { sop_id: 'site-onboarding', sop_version: 1, triggered_by: 'test-agent' });
  const runId = String(view(run).run_id);
  assert.ok(runId);

  const status = callTool('sop_run_status', { run_id: runId });
  const stepStates = view(status).step_states as Array<Record<string, any>>;
  const verifyStep = stepStates.find((s) => s.step_id === 'verify');
  assert.ok(verifyStep);
  assert.equal(verifyStep.status, 'running');

  const adv = callTool('sop_run_advance', { run_id: runId, step_id: 'verify', result: { passed: true } });
  const afterAdv = view(adv).step_states as Array<Record<string, any>>;
  assert.equal(afterAdv.find((s) => s.step_id === 'verify')!.status, 'completed');
  assert.equal(afterAdv.find((s) => s.step_id === 'setup')!.status, 'completed');
  assert.equal(afterAdv.find((s) => s.step_id === 'test')!.status, 'running');

  const adv2 = callTool('sop_run_advance', { run_id: runId, step_id: 'test', result: { all_pass: true } });
  assert.equal(view(adv2).status, 'completed');

  const events = callTool('sop_run_events', { run_id: runId });
  assert.ok((view(events).items as Array<unknown>).length >= 1);

  const runList = callTool('sop_run_list', { sop_id: 'site-onboarding', include_terminal: true });
  assert.equal((view(runList).items as Array<unknown>).length >= 1, true);

  callTool('sop_template_create', {
    sop_id: 'cancellable', title: 'Cancellable',
    steps: [
      { id: 'first', kind: 'manual', title: 'First', instructions: 'Do first.', depends_on: [] },
      { id: 'second', kind: 'note', title: 'Second', instructions: 'After.', depends_on: ['first'] },
    ],
  });
  const cRun = callTool('sop_run_start', { sop_id: 'cancellable', triggered_by: 'test' });
  const cRunId = String(view(cRun).run_id);

  const cancel = callTool('sop_run_cancel', { run_id: cRunId, reason: 'No longer needed.' });
  assert.equal(view(cancel).status, 'cancelled');

  assert.equal(view(callTool('sop_run_status', { run_id: cRunId })).status, 'cancelled');

  assert.equal(errCode(callTool('sop_run_advance', { run_id: cRunId, step_id: 'first' })), 'sop_run_terminal');

  assert.equal(errCode(callTool('sop_template_show', { sop_id: 'nonexistent' })), 'sop_not_found');

  assert.equal((view(callTool('sop_template_list', { status: 'draft' })).items as Array<unknown>).length >= 2, true);

  console.log('sop-mcp behavior ok');
} finally {
  if (state) state.db.close();
  rmSync(root, { recursive: true, force: true });
}
