import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'sop-mcp-behavior-'));
const sopsDir = join(root, 'test-sops');
mkdirSync(sopsDir, { recursive: true });
let state: any;

try {
  state = createServerState({ sopRoot: root, sopsDirs: [sopsDir] });

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as Promise<Record<string, any>>;
  }
  function view(res: Record<string, any>): Record<string, any> {
    return res.result.structuredContent as Record<string, any>;
  }
  function errCode(res: Record<string, any>): string {
    const error = res.error as Record<string, any>;
    assert.ok(error, `Expected error, got result: ${JSON.stringify(res.result)}`);
    return String(error.data.code);
  }

  const op = { executor: 'operator', blocking: true };
  const eng = { executor: 'engine', blocking: false };
  const ag = { executor: 'agent', blocking: true };

  const steps = [
    { id: 'verify', ...op, title: 'Verify access', instructions: 'Check that the site root is reachable.', depends_on: [] },
    { id: 'setup', ...eng, title: 'Record setup', instructions: 'Document initial state.', depends_on: ['verify'] },
    { id: 'test', ...op, title: 'Run tests', instructions: 'Execute the test suite.', depends_on: ['setup'] },
  ];

  const create = await call('sop_template_create', {
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

  const doctor = await call('sop_doctor', {});
  assert.equal(view(doctor).schema, 'narada.sop.doctor.v1');
  assert.equal(view(doctor).full_step_definitions_path, 'structuredContent.steps');
  assert.equal((view(doctor).recovery_tools as string[]).includes('sop_template_export'), true);

  const dup = await call('sop_template_create', {
    sop_id: 'site-onboarding',
    title: 'Site Onboarding SOP v2',
    steps: [{ id: 'only', ...eng, title: 'Only step', instructions: 'Just this.' }],
  });
  assert.equal(view(dup).status, 'created');
  assert.equal(view(dup).version, 2);

  const show = await call('sop_template_show', { sop_id: 'site-onboarding' });
  assert.equal(view(show).sop_id, 'site-onboarding');
  assert.equal(view(show).version, 2);
  assert.equal(view(show).title, 'Site Onboarding SOP v2');
  assert.equal(view(show).schema, 'narada.sop.template.v1');
  assert.equal(view(show).render_mode, 'summary_text_with_full_structured_content');
  assert.equal(view(show).full_step_definitions_path, 'structuredContent.steps');
  assert.equal((view(show).steps as Array<Record<string, any>>)[0].instructions, 'Just this.');

  const showV1 = await call('sop_template_show', { sop_id: 'site-onboarding', version: 1 });
  assert.equal(view(showV1).version, 1);
  assert.equal(view(showV1).title, 'Site Onboarding SOP');
  const exportV1 = await call('sop_template_export', { sop_id: 'site-onboarding', version: 1 });
  assert.equal(view(exportV1).export_schema, 'narada.sop.template_export.v1');
  assert.equal(JSON.parse(view(exportV1).raw.steps_json).length, 3);
  assert.equal((view(exportV1).steps as Array<Record<string, any>>)[0].cwd, null);

  const list = await call('sop_template_list', {});
  assert.equal((view(list).items as Array<unknown>).length >= 1, true);

  const search = await call('sop_template_search', { query: 'Onboarding' });
  const searchData = view(search);
  assert.equal((searchData.items as Array<unknown>).length >= 1, true);
  assert.equal((searchData.items as Array<Record<string, any>>)[0].title.includes('Onboarding'), true);
  assert.equal(searchData.query, 'Onboarding');

  const searchMiss = await call('sop_template_search', { query: 'zzznonexistent' });
  assert.equal((view(searchMiss).items as Array<unknown>).length, 0);

  // --- YAML import tests ---

  writeFileSync(join(sopsDir, 'import-test.sop.yaml'), `
sop_id: import-test
title: Imported SOP
description: Created from YAML.
steps:
  - id: step1
    executor: engine
    blocking: false
    title: Step One
    instructions: Do step one.
    depends_on: []
acceptance_criteria:
  - Import succeeds
evidence_requirements:
  - YAML file
`.trim() + '\n', 'utf8');

  const imported = await call('sop_template_import_yaml', { sop_id: 'import-test' });
  assert.equal(view(imported).status, 'created');
  assert.equal(view(imported).sop_id, 'import-test');
  assert.equal(view(imported).version, 1);
  assert.equal(view(imported).title, 'Imported SOP');
  assert.equal(view(imported).step_count, 1);

  const showImported = await call('sop_template_show', { sop_id: 'import-test' });
  assert.equal(view(showImported).title, 'Imported SOP');
  assert.equal(view(showImported).description, 'Created from YAML.');
  assert.equal(view(showImported).status, 'draft');
  assert.equal(view(showImported).trigger_kind, 'manual');
  const importedSteps = view(showImported).steps as Array<Record<string, any>>;
  assert.equal(importedSteps.length, 1);
  assert.equal(importedSteps[0].id, 'step1');
  assert.equal(importedSteps[0].executor, 'engine');

  const reimport = await call('sop_template_import_yaml', { sop_id: 'import-test' });
  assert.equal(view(reimport).status, 'unchanged');
  assert.equal(view(reimport).version, 1);

  writeFileSync(join(sopsDir, 'import-test.sop.yaml'), `
sop_id: import-test
title: Imported SOP v2
description: Updated from YAML.
steps:
  - id: step1
    executor: engine
    blocking: false
    title: Step One
    instructions: Do step one.
    depends_on: []
  - id: step2
    executor: operator
    blocking: true
    title: Step Two
    instructions: Do step two.
    depends_on: [step1]
acceptance_criteria:
  - Updated import succeeds
evidence_requirements:
  - Updated YAML file
`.trim() + '\n', 'utf8');

  const reimportChanged = await call('sop_template_import_yaml', { sop_id: 'import-test' });
  assert.equal(view(reimportChanged).status, 'updated');
  assert.equal(view(reimportChanged).version, 2);
  assert.equal(view(reimportChanged).title, 'Imported SOP v2');
  assert.equal(view(reimportChanged).step_count, 2);

  const showV2 = await call('sop_template_show', { sop_id: 'import-test' });
  assert.equal(view(showV2).version, 2);

  // --- YAML error cases ---

  assert.equal(errCode(await call('sop_template_import_yaml', { sop_id: 'nonexistent' })), 'sop_yaml_not_found');

  writeFileSync(join(sopsDir, 'bad-syntax.sop.yaml'), 'sop_id: bad-syntax\n  steps:\n', 'utf8');

  assert.equal(errCode(await call('sop_template_import_yaml', { sop_id: 'bad-syntax' })), 'sop_yaml_parse_error');

  writeFileSync(join(sopsDir, 'id-mismatch.sop.yaml'), 'sop_id: wrong-id\ntitle: Test\nsteps:\n  - id: s1\n    executor: engine\n    title: S1\n    instructions: Do.\n', 'utf8');

  assert.equal(errCode(await call('sop_template_import_yaml', { sop_id: 'id-mismatch' })), 'sop_yaml_id_mismatch');

  writeFileSync(join(sopsDir, 'bad-schema.sop.yaml'), 'sop_id: bad-schema\ntitle: Bad Schema\nsteps: []\n', 'utf8');

  assert.equal(errCode(await call('sop_template_import_yaml', { sop_id: 'bad-schema' })), 'sop_yaml_schema_error');

  writeFileSync(join(sopsDir, 'bad-dep.sop.yaml'), `
sop_id: bad-dep
title: Bad Dep
steps:
  - id: s1
    executor: engine
    blocking: false
    title: S1
    instructions: Do.
    depends_on: [nonexistent]
`.trim() + '\n', 'utf8');

  assert.equal(errCode(await call('sop_template_import_yaml', { sop_id: 'bad-dep' })), 'sop_unknown_dependency');

  // --- End YAML import tests ---

  const deprecate = await call('sop_template_deprecate', { sop_id: 'site-onboarding', reason: 'Replaced.' });
  assert.equal(view(deprecate).status, 'deprecated');

  const depShow = await call('sop_template_show', { sop_id: 'site-onboarding' });
  assert.equal(view(depShow).status, 'deprecated');

  const upCreate = await call('sop_template_create', {
    sop_id: 'test-runner',
    title: 'Test Runner',
    steps: [
      { id: 'build', ...eng, title: 'Build', instructions: 'Build the project.', depends_on: [] },
      { id: 'run', ...op, title: 'Run tests', instructions: 'Run the test suite.', depends_on: ['build'] },
    ],
  });
  assert.equal(view(upCreate).status, 'created');

  const update = await call('sop_template_update', {
    sop_id: 'test-runner',
    steps: [
      { id: 'build', ...eng, title: 'Build', instructions: 'Build the project.', depends_on: [] },
      { id: 'lint', ...eng, title: 'Lint', instructions: 'Run linter.', depends_on: ['build'] },
      { id: 'run', ...op, title: 'Run tests', instructions: 'Run the test suite.', depends_on: ['lint'] },
    ],
  });
  assert.equal(view(update).status, 'updated');
  assert.equal(view(update).version, 2);
  assert.equal(view(update).step_count, 3);

  assert.equal(errCode(await call('sop_template_create', {
    sop_id: 'bad', title: 'Bad',
    steps: [{ id: 'a', ...op, title: 'A', instructions: 'Do A.', depends_on: ['nonexistent'] }],
  })), 'sop_unknown_dependency');

  assert.equal(errCode(await call('sop_template_create', {
    sop_id: 'bad-executor', title: 'Bad Executor',
    steps: [{ id: 'a', executor: 'impossible', title: 'Bad', instructions: 'Bad.' }],
  })), 'sop_invalid_executor');

  const run = await call('sop_run_start', { sop_id: 'site-onboarding', sop_version: 1, triggered_by: 'test-agent' });
  const runId = String(view(run).run_id);
  assert.ok(runId);

  const status = await call('sop_run_status', { run_id: runId });
  const stepStates = view(status).step_states as Array<Record<string, any>>;
  const verifyStep = stepStates.find((s) => s.step_id === 'verify');
  assert.ok(verifyStep);
  assert.equal(verifyStep.status, 'running');
  assert.equal(verifyStep.blocking, true);
  assert.equal(verifyStep.executor, 'operator');

  const adv = await call('sop_run_advance', { run_id: runId, step_id: 'verify', result: { passed: true } });
  const afterAdv = view(adv).step_states as Array<Record<string, any>>;
  assert.equal(afterAdv.find((s) => s.step_id === 'verify')!.status, 'completed');
  assert.equal(afterAdv.find((s) => s.step_id === 'setup')!.status, 'completed');
  assert.equal(afterAdv.find((s) => s.step_id === 'test')!.status, 'running');

  const adv2 = await call('sop_run_advance', { run_id: runId, step_id: 'test', result: { all_pass: true } });
  assert.equal(view(adv2).status, 'completed');

  const events = await call('sop_run_events', { run_id: runId });
  assert.ok((view(events).items as Array<unknown>).length >= 1);

  const runList = await call('sop_run_list', { sop_id: 'site-onboarding', include_terminal: true });
  assert.equal((view(runList).items as Array<unknown>).length >= 1, true);

  await call('sop_template_create', {
    sop_id: 'cancellable', title: 'Cancellable',
    steps: [
      { id: 'first', ...op, title: 'First', instructions: 'Do first.', depends_on: [] },
      { id: 'second', ...eng, title: 'Second', instructions: 'After.', depends_on: ['first'] },
    ],
  });
  const cRun = await call('sop_run_start', { sop_id: 'cancellable', triggered_by: 'test' });
  const cRunId = String(view(cRun).run_id);

  const cancel = await call('sop_run_cancel', { run_id: cRunId, reason: 'No longer needed.' });
  assert.equal(view(cancel).status, 'cancelled');

  assert.equal(view(await call('sop_run_status', { run_id: cRunId })).status, 'cancelled');

  assert.equal(errCode(await call('sop_run_advance', { run_id: cRunId, step_id: 'first' })), 'sop_run_terminal');

  assert.equal(errCode(await call('sop_template_show', { sop_id: 'nonexistent' })), 'sop_not_found');

  assert.equal((view(await call('sop_template_list', { status: 'draft' })).items as Array<unknown>).length >= 2, true);

  await call('sop_template_create', {
    sop_id: 'agent-test',
    title: 'Agent Test',
    steps: [
      { id: 'prep', ...eng, title: 'Prep', instructions: 'Auto-prep.', depends_on: [] },
      { id: 'investigate', ...ag, title: 'Investigate', instructions: 'Agent investigates the issue.', depends_on: ['prep'] },
      { id: 'review', ...op, title: 'Review findings', instructions: 'Operator reviews agent findings.', depends_on: ['investigate'] },
    ],
  });
  const agentRun = await call('sop_run_start', { sop_id: 'agent-test', triggered_by: 'test' });
  const agentRunView = view(agentRun);
  assert.equal(agentRunView.status, 'awaiting_confirmation');
  const agentSteps = agentRunView.step_states as Array<Record<string, any>>;
  assert.equal(agentSteps.find((s: any) => s.step_id === 'prep')!.status, 'completed');
  assert.equal(agentSteps.find((s: any) => s.step_id === 'investigate')!.status, 'running');
  assert.equal(agentSteps.find((s: any) => s.step_id === 'investigate')!.blocking, true);
  assert.equal(agentSteps.find((s: any) => s.step_id === 'investigate')!.executor, 'agent');
  assert.equal(agentRunView.next_step.step_id, 'investigate');
  assert.equal(agentRunView.next_step.executor, 'agent');

  await call('sop_template_create', {
    sop_id: 'command-test',
    title: 'Command Test',
    steps: [
      { id: 'greet', executor: 'engine', blocking: false, title: 'Greet', instructions: 'Print hello.', command: 'node', args: ['-e', 'process.stdout.write("hello world")'], depends_on: [] },
      { id: 'use_output', executor: 'engine', blocking: false, title: 'Use output', instructions: 'Print the greet output.', command: 'node', args: ['-e', 'process.stdout.write("got: {{greet.stdout}}")'], depends_on: ['greet'] },
      { id: 'verify', ...op, title: 'Verify', instructions: 'Check command output.', depends_on: ['use_output'] },
    ],
  });

  const cmdRun = await call('sop_run_start', { sop_id: 'command-test', triggered_by: 'test' });
  const cmdRunView = view(cmdRun);
  assert.equal(cmdRunView.status, 'awaiting_confirmation');
  const cmdSteps = cmdRunView.step_states as Array<Record<string, any>>;
  const greetStep = cmdSteps.find((s) => s.step_id === 'greet')!;
  assert.equal(greetStep.status, 'completed');
  assert.equal(greetStep.result.stdout, 'hello world');
  assert.equal(greetStep.result.exit_code, 0);

  const useStep = cmdSteps.find((s) => s.step_id === 'use_output')!;
  assert.equal(useStep.status, 'completed');
  assert.equal(useStep.result.stdout, 'got: hello world', `expected 'got: hello world', got: ${JSON.stringify(useStep.result.stdout)}`);

  console.log('sop-mcp behavior ok');
} finally {
  if (state) state.db.close();
  rmSync(root, { recursive: true, force: true });
}
