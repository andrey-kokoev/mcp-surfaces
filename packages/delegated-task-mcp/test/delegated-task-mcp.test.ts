import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'delegated-task-mcp-behavior-'));
const workerCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const runStatuses = new Map<string, Record<string, unknown>>();

try {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const ok = true;\n', 'utf8');
  writeFileSync(join(root, 'src', 'policy.ts'), 'export const policy = "review";\n', 'utf8');
  const multiRepoRoot = join(root, 'multi-repo-workspace');
  mkdirSync(join(multiRepoRoot, 'repo-a', '.git'), { recursive: true });
  mkdirSync(join(multiRepoRoot, 'repo-b', '.git'), { recursive: true });
  const originalDelegatedTaskSecret = process.env.DELEGATED_TASK_TEST_SECRET;
  delete process.env.DELEGATED_TASK_TEST_SECRET;
  const siteRoot = join(root, 'site-root');
  const extraRoot = join(root, 'extra-root');
  mkdirSync(join(siteRoot, '.narada'), { recursive: true });
  writeFileSync(join(siteRoot, '.narada', 'secrets.json'), JSON.stringify({ env: { DELEGATED_TASK_TEST_SECRET: 'from-site-secret' } }), 'utf8');
  writeFileSync(join(siteRoot, '.narada', 'allowed-roots.json'), JSON.stringify({ extra_allowed_roots: [extraRoot] }), 'utf8');
  const providerRegistryPath = join(root, 'provider-registry.json');
  writeFileSync(providerRegistryPath, JSON.stringify({ providers: { test: { credential_requirement: { kind: 'api_key_secret', env_names: ['MOONSHOT_API_KEY'], secret_ref: 'delegated-task-provider-secret' } } } }), 'utf8');
  const originalMoonshotApiKey = process.env.MOONSHOT_API_KEY;
  delete process.env.MOONSHOT_API_KEY;

  const state = createServerState({
    siteRoot,
    taskRoot: root,
    allowedRoots: [root],
    providerRegistryPath,
    workerPolicy: { defaultRuntime: 'codex' },
    secretLookupCommand: process.execPath,
    secretLookupCommandArgs: ['-e', 'process.stdout.write(process.env.NARADA_SECRET_LOOKUP_NAME === "delegated-task-provider-secret" ? "provider-secret-from-store" : "")'],
    policy: { allowed_workflow_kinds: ['worker', 'review', 'repair', 'verify', 'research', 'gate', 'join', 'note'] },
    workerTool: async (name: string, args: Record<string, unknown>) => {
      workerCalls.push({ name, args });
      if (name === 'worker_run_status') {
        const runId = String(args.run_id);
        const status = runStatuses.get(runId);
        if (!status) throw new Error(`worker_run_not_found: ${runId}`);
        if (status.status === 'recover_with_wait') throw new Error(`worker_run_not_found: ${runId}`);
        if (status.timeout_forever === true) return status;
        runStatuses.set(runId, { ...status, status: 'completed', summary: `${runId} completed after wait` });
        return runStatuses.get(runId)!;
      }
      if (name === 'worker_run_wait') {
        const runId = String(args.run_id);
        const status = runStatuses.get(runId);
        if (!status) throw new Error(`worker_run_not_found: ${runId}`);
        const recovered = { ...status, status: 'completed', summary: `${runId} recovered by wait` };
        runStatuses.set(runId, recovered);
        return recovered;
      }

      const instruction = JSON.stringify(args);
      if (instruction.includes('launch failure worker')) throw new Error('worker launch denied by test policy');
      const runId = `run-test-${workerCalls.filter((call) => call.name === 'worker_run').length}`;
      const status = instruction.includes('async missing status worker') ? 'recover_with_wait'
        : instruction.includes('async worker') || instruction.includes('timeout worker') ? 'running'
        : instruction.includes('fail once') && ![...runStatuses.values()].some((run) => String(run.summary).includes('fail once')) ? 'failed'
          : 'completed';
      const result = {
        schema: 'narada.worker.run.v1',
        status,
        run_id: runId,
        run_dir: join(root, 'worker-runs', runId),
        output_ref: `output-${runId}`,
        result_ref: `result-${runId}`,
        worker_session_id: null,
        runtime: 'codex',
        provider: 'openai',
        resolved_worker_config: { runtime: 'codex', provider: 'openai', max_run_ms: 600000 },
        progress: { event_count: 2, latest_event_type: 'assistant.delta', latest_event_preview: `${runId} heartbeat`, latest_event_at: new Date().toISOString(), readable: true, tail_truncated: false },
        status_liveness: { state: 'active', process_liveness: 'unknown', started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), max_run_ms: 600000, stale_for_ms: 0 },
        progress_state: { state: status === 'running' ? 'thinking' : status, current_action: `${runId} heartbeat`, recommended_action: status === 'running' ? 'wait' : 'inspect_result' },
        budget_status: { elapsed_ms: 10, max_run_ms: 600000, remaining_ms: 599990, percent_used: 0.000016, stale_for_ms: 0, event_count: 2 },
        recent_activity: [{ type: 'assistant.delta', kind: 'model_turn', preview: `${runId} heartbeat`, summary: `${runId} heartbeat`, timestamp: new Date().toISOString() }],
        timing: { started_at: new Date().toISOString(), finished_at: status === 'running' ? null : new Date().toISOString(), duration_ms: status === 'running' ? null : 1 },
        confidence: 'complete',
        summary: instruction.includes('accepted findings summary only') ? 'review_verdict=accepted_with_findings; edits_performed=false; reviewed successfully' : instruction.includes('positive summary no explicit verdict') ? 'artifact passed required content, forbidden pattern, privacy posture, core answer, and Slidev structure checks' : instruction.includes('fail once') ? 'fail once recovered' : `${runId} ${status}`,
        timeout_forever: instruction.includes('timeout worker'),
        acceptance_verdict: instruction.includes('Step kind: review')
          ? instruction.includes('Step instruction: inconclusive review') || instruction.includes('positive summary no explicit verdict') || instruction.includes('accepted findings summary only') ? undefined : instruction.includes('Step instruction: explicit review failure') || instruction.includes('Step instruction: rejected review') ? 'failed' : 'accepted'
          : undefined,
        changed_files: instruction.includes('nested probe') ? [] : ['src/main.ts'],
        deliverables: instruction.includes('read-only audit readback') ? [{ path: 'src/policy.ts', description: 'Read during audit' }] : [],
        nested_workflows: instruction.includes('nested probe') ? [{ task_id: 'task_nested_probe', task_status: 'failed', acceptance_verdict: 'passed', changed_files: ['nested/output.txt'], verification: [{ tool: 'delegated-task', command: 'nested probe', status: 'failed' }] }] : [],
        verification_results: [{ tool: 'structured-command', command: 'pnpm test:delegated-task', status: 'passed' }],
        residual_risks: status === 'running' ? ['worker still running'] : [],
        observed_incoherencies: [],
        ...(instruction.includes('expired terminal worker') ? {
          status: 'failed',
          confidence: 'partial',
          completion_state: 'partial',
          summary: '',
          error: 'worker_run_expired_without_terminal_output: run stayed running past max_run_ms plus grace without a usable last_message.json',
          error_classification: 'worker_run_expired_without_terminal_output',
          diagnostic_tail: 'runtime process stopped before final message',
          runtime_warnings: ['worker_run_expired_without_terminal_output: run stayed running past max_run_ms plus grace without a usable last_message.json'],
        } : {}),
        exit_interview: (args.constraints as Record<string, unknown> | undefined)?.exit_interview === true ? {
          ergonomics_feedback: 'Worker exit interview captured by delegated task.',
          friction_points: ['exit interview propagation required explicit test coverage'],
          missing_affordances: ['delegated task handoff should aggregate exit interviews'],
          observed_incoherencies: ['delegated_task_exit_interview_path_was_previously_unprocessed'],
          suggested_improvements: ['surface exit interview count in terminal summary'],
        } : null,
      };
      runStatuses.set(runId, result);
      return result;
    },
  });
  assert.equal(state.workerState.env.DELEGATED_TASK_TEST_SECRET, 'from-site-secret');
  assert.equal(state.workerState.env.MOONSHOT_API_KEY, 'provider-secret-from-store');
  assert.equal(process.env.DELEGATED_TASK_TEST_SECRET, undefined);
  assert.equal(process.env.MOONSHOT_API_KEY, undefined);
  assert.equal(state.allowedRoots.some((allowedRoot) => allowedRoot === extraRoot), true);
  assert.notEqual(state.workerState.policy.runRoot, join(root, 'worker-runs'));
  const explicitWorkerRunRoot = join(root, 'explicit-worker-runs');
  const explicitWorkerRootState = createServerState({ taskRoot: root, allowedRoots: [root], workerPolicy: { runRoot: explicitWorkerRunRoot } });
  assert.equal(explicitWorkerRootState.workerState.policy.runRoot, explicitWorkerRunRoot);
  if (originalDelegatedTaskSecret === undefined) delete process.env.DELEGATED_TASK_TEST_SECRET;
  else process.env.DELEGATED_TASK_TEST_SECRET = originalDelegatedTaskSecret;
  if (originalMoonshotApiKey === undefined) delete process.env.MOONSHOT_API_KEY;
  else process.env.MOONSHOT_API_KEY = originalMoonshotApiKey;

  const policy = await callTool(state, 'delegated_task_policy_inspect', {});
  const policyView = policy.result.structuredContent as Record<string, any>;
  assert.equal(policyView.status, 'ok');
  assert.equal(policyView.allowed_workflow_kinds.includes('review'), true);
  assert.equal(policyView.condition_language.includes('all(<expr>,<expr>)'), true);
  assert.equal(policyView.policy_schema, 'narada.delegated_task.policy.v1');
  assert.equal(policyView.workflow_engine.milestone_support.workflow_milestones, true);
  assert.equal(policyView.workflow_engine.authority_gate_support.delegated_task_executes_git, false);
  assert.equal(policyView.template_catalog.some((template: Record<string, any>) => template.template_id === 'commit_push_guarded'), true);

  const catalog = await callTool(state, 'delegated_task_template_catalog', { template_id: 'commit_push_guarded' });
  const catalogView = catalog.result.structuredContent as Record<string, any>;
  assert.equal(catalogView.status, 'ok');
  assert.equal(catalogView.templates[0].feedback_ids.includes('sfb_98a64342-379'), true);
  assert.equal(catalogView.templates[0].authority_gates.push.required_authority, 'command');
  assert.equal(catalogView.templates[0].worker_delegation_contract.routed_feedback_ids.includes('sfb_7e043d77-074'), true);

  const tools = await handleRequest({ jsonrpc: '2.0', id: 'tools-list', method: 'tools/list', params: {} }, state);
  const toolsView = tools?.result as Record<string, any>;
  const runTool = toolsView.tools.find((item: Record<string, any>) => item.name === 'delegated_task_run');
  assert.equal(Array.isArray(runTool.inputSchema.properties.workflow.examples), true);
  assert.equal(runTool.inputSchema.properties.workflow.description.includes('Workflow DAG'), true);
  assert.ok(runTool.inputSchema.properties.workflow.properties.instruction);
  assert.ok(runTool.inputSchema.properties.workflow.properties.milestones);
  assert.ok(runTool.inputSchema.properties.workflow.properties.authority_gates);

  const invalid = await callTool(state, 'delegated_task_validate', {
    objective: 'Invalid graph',
    workflow: {
      steps: [
        { id: 'a', kind: 'worker', depends_on: ['missing'], if: 'all(step:a:completed)' },
      ],
    },
    acceptance: { residual_risk_policy: 'invalid-policy' },
  });
  const invalidView = invalid.result.structuredContent as Record<string, any>;
  assert.equal(invalidView.status, 'rejected');
  assert.equal(invalidView.diagnostics.some((item: Record<string, unknown>) => item.code === 'unknown_dependency'), true);
  assert.equal(invalidView.diagnostics.some((item: Record<string, unknown>) => item.code === 'invalid_condition'), true);
  assert.equal(invalidView.diagnostics.some((item: Record<string, unknown>) => item.code === 'acceptance_residual_risk_policy_invalid'), true);
  assert.equal(invalidView.validation_hints.expected_shape, 'directed_acyclic_graph');
  assert.equal(invalidView.validation_hints.unknown_dependency_count, 1);

  const unknownShape = await callTool(state, 'delegated_task_validate', {
    objective: 'Unknown keys',
    constraints: { authority: 'read', cwd: root, surprise: true },
    acceptance: { required_files: ['src/main.ts'], surprise: true },
    result_policy: { max_worker_refs: 2, surprise: true },
  });
  const unknownShapeView = unknownShape.result.structuredContent as Record<string, any>;
  assert.equal(unknownShapeView.status, 'rejected');
  assert.equal(unknownShapeView.diagnostics.some((item: Record<string, unknown>) => item.code === 'constraints_unknown_key'), true);
  assert.equal(unknownShapeView.diagnostics.some((item: Record<string, unknown>) => item.code === 'acceptance_unknown_key'), true);
  assert.equal(unknownShapeView.diagnostics.some((item: Record<string, unknown>) => item.code === 'result_policy_unknown_key'), true);

  const siteRootShape = await callTool(state, 'delegated_task_validate', {
    objective: 'Site-bound worker graph',
    constraints: { authority: 'read', cwd: root, site_root: siteRoot },
    workflow: { steps: [{ id: 'site-bound', kind: 'research', instruction: 'Inspect site-bound runtime' }] },
  });
  const siteRootShapeView = siteRootShape.result.structuredContent as Record<string, any>;
  assert.equal(siteRootShapeView.status, 'ok');

  const crossRepoShape = await callTool(state, 'delegated_task_validate', {
    objective: 'Cross-repo research graph',
    constraints: { authority: 'read', cwd: multiRepoRoot },
    workflow: { steps: [{ id: 'research', kind: 'research', instruction: 'Inspect all repos' }] },
  });
  const crossRepoShapeView = crossRepoShape.result.structuredContent as Record<string, any>;
  assert.equal(crossRepoShapeView.status, 'ok');
  assert.equal(crossRepoShapeView.diagnostics.some((item: Record<string, unknown>) => item.code === 'codex_cross_repo_workspace_requires_skip_git_repo_check' && item.severity === 'warning'), true);

  const crossRepoSkippedShape = await callTool(state, 'delegated_task_validate', {
    objective: 'Cross-repo research graph with skip',
    constraints: { authority: 'read', cwd: multiRepoRoot, skip_git_repo_check: true },
    workflow: { steps: [{ id: 'research', kind: 'research', instruction: 'Inspect all repos' }] },
  });
  const crossRepoSkippedShapeView = crossRepoSkippedShape.result.structuredContent as Record<string, any>;
  assert.equal(crossRepoSkippedShapeView.status, 'ok');
  assert.equal(crossRepoSkippedShapeView.diagnostics.some((item: Record<string, unknown>) => item.code === 'codex_cross_repo_workspace_requires_skip_git_repo_check'), false);

  const preset = await callTool(state, 'delegated_task_validate', {
    objective: 'Preset graph',
    workflow: { strategy: 'implement_review_repair_verify' },
  });
  const presetView = preset.result.structuredContent as Record<string, any>;
  assert.equal(presetView.status, 'ok');
  assert.deepEqual(presetView.workflow_preview.steps.map((step: Record<string, unknown>) => step.id), ['implement', 'review', 'repair', 'verify']);
  assert.deepEqual(presetView.workflow_preview.shape.entry_step_ids, ['implement']);
  assert.equal(presetView.workflow_preview.shape.edges.some((edge: Record<string, unknown>) => edge.from === 'implement' && edge.to === 'review'), true);
  assert.equal(presetView.workflow_preview.shape.edges.some((edge: Record<string, unknown>) => edge.from === 'repair' && edge.to === 'verify'), true);
  assert.deepEqual(presetView.workflow_preview.authority_gates, {
    commit: {
      operation: 'commit',
      mode: 'requires_explicit_authority',
      reason: 'commit is modeled as an explicit gate and is never executed by delegated-task-mcp',
      required_authority: 'write',
    },
    push: {
      operation: 'push',
      mode: 'requires_explicit_authority',
      reason: 'push must stay opt-in and owned by caller policy or worker constraints',
      required_authority: 'command',
    },
  });

  const noImplicitGates = await callTool(state, 'delegated_task_validate', {
    objective: 'Plain workflow has no publication gates',
    workflow: { steps: [{ id: 'implement', kind: 'worker' }] },
  });
  const noImplicitGatesView = noImplicitGates.result.structuredContent as Record<string, any>;
  assert.equal(noImplicitGatesView.status, 'ok');
  assert.deepEqual(noImplicitGatesView.workflow_preview.authority_gates, {});

  const milestoneTemplate = await callTool(state, 'delegated_task_validate', {
    objective: 'Preview guarded template milestones',
    constraints: { authority: 'command', cwd: root },
    workflow: { template_id: 'commit_push_guarded' },
  });
  const milestoneTemplateView = milestoneTemplate.result.structuredContent as Record<string, any>;
  assert.equal(milestoneTemplateView.status, 'ok');
  assert.equal(milestoneTemplateView.workflow_preview.template_id, 'commit_push_guarded');
  assert.equal(milestoneTemplateView.workflow_preview.milestones.some((milestone: Record<string, any>) => milestone.id === 'publication-gate'), true);
  assert.equal(milestoneTemplateView.workflow_preview.steps.some((step: Record<string, any>) => step.authority_gate?.operation === 'push'), true);

  const milestonePreview = await callTool(state, 'delegated_task_validate', {
    objective: 'Preview explicit milestones',
    constraints: { authority: 'write', cwd: root },
    workflow: {
      milestones: [{ id: 'ship', title: 'Ship', step_ids: ['implement'], acceptance_scope: ['required_tests'] }],
      authority_gates: { commit: { mode: 'requires_explicit_authority', required_authority: 'write' } },
      steps: [{ id: 'implement', kind: 'worker', milestone_id: 'ship', authority_gate: { operation: 'commit', mode: 'requires_explicit_authority', required_authority: 'write' } }],
    },
  });
  const milestonePreviewView = milestonePreview.result.structuredContent as Record<string, any>;
  assert.equal(milestonePreviewView.status, 'ok');
  assert.equal(milestonePreviewView.workflow_preview.milestones[0].id, 'ship');
  assert.equal(milestonePreviewView.workflow_preview.steps[0].milestone_id, 'ship');
  assert.equal(milestonePreviewView.workflow_preview.steps[0].authority_gate.required_authority, 'write');

  const templateCatalog = await callTool(state, 'delegated_task_template_catalog', {});
  const templateCatalogView = templateCatalog.result.structuredContent as Record<string, any>;
  assert.equal(templateCatalogView.status, 'ok');
  assert.equal(templateCatalogView.templates.some((template: Record<string, unknown>) => template.template_id === 'implement_review_repair_verify'), true);

  const legacyWorkOrder = await callTool(state, 'delegated_task_validate', {
    objective: 'Legacy work order graph',
    workflow: {
      template_id: 'implement_review',
      imports: ['task_a70abebd40847000', 'task_aedc86df78be77f4'],
      work_order: [
        { id: 'implement', kind: 'worker', imports: ['sfb_074b9629-4a8'], instruction: 'Implement without git commit or push' },
        { id: 'review', kind: 'review', depends_on: ['implement'] },
      ],
      migration: { from: 'legacy-work-order' },
    },
  });
  const legacyWorkOrderView = legacyWorkOrder.result.structuredContent as Record<string, any>;
  assert.equal(legacyWorkOrderView.status, 'ok');
  assert.deepEqual(legacyWorkOrderView.workflow_preview.steps.map((step: Record<string, unknown>) => step.id), ['implement', 'review']);
  assert.equal(legacyWorkOrderView.workflow_preview.work_order.source, 'legacy_step_list');
  assert.deepEqual(legacyWorkOrderView.workflow_preview.imports.workflow, ['task_a70abebd40847000', 'task_aedc86df78be77f4']);
  assert.deepEqual(legacyWorkOrderView.workflow_preview.imports.by_step.implement, ['sfb_074b9629-4a8']);

  const additiveWorkOrder = await callTool(state, 'delegated_task_validate', {
    objective: 'Explicit DAG governed by work order',
    constraints: { authority: 'read', cwd: root },
    workflow: {
      steps: [{ id: 'implement', kind: 'worker', instruction: 'Implement without commit or push' }],
      work_order: {
        scope: ['packages/delegated-task-mcp'],
        budget: { max_verification_attempts: 1, timeout_ms: 600000 },
        verification: {
          focused_tests: [{ command: 'pnpm --filter @narada2/delegated-task-mcp test', status: 'passed' }],
          verification_budget: { max_attempts: 1, max_commands: 1 },
        },
        acceptance: { residual_risk_policy: 'allow' },
      },
    },
  });
  const additiveWorkOrderView = additiveWorkOrder.result.structuredContent as Record<string, any>;
  assert.equal(additiveWorkOrderView.status, 'ok');
  assert.equal(additiveWorkOrderView.diagnostics.some((item: Record<string, unknown>) => item.code === 'workflow_steps_and_work_order_conflict'), false);
  assert.equal(additiveWorkOrderView.workflow_preview.work_order.source, 'governing_contract');
  assert.deepEqual(additiveWorkOrderView.workflow_preview.work_order.scope, ['packages/delegated-task-mcp']);
  assert.deepEqual(additiveWorkOrderView.workflow_preview.steps.map((step: Record<string, unknown>) => step.id), ['implement']);

  const declarativeWorkOrder = await callTool(state, 'delegated_task_validate', {
    objective: 'Declarative item map workflow',
    constraints: { authority: 'write', cwd: root },
    workflow: {
      work_order: {
        items: [{ id: 'alpha', path: 'src/main.ts' }, { id: 'beta', path: 'src/policy.ts' }],
        stage_policy: { execution: { schedule_by_disjoint_write_set: true } },
        budget: { max_minutes: 10, allowed_repositories: [root] },
        stages: [
          { id: 'research', kind: 'research', mode: 'map', instruction: 'Research {{item.id}} at {{item.path}}', join: true },
          { id: 'synthesize', kind: 'worker', depends_on: ['research'], instruction: 'Synthesize write plan' },
          { id: 'execute', kind: 'worker', mode: 'map', depends_on: ['synthesize'], instruction: 'Execute {{item.id}}', write_set: ['{{item.path}}'], join: { id: 'execution-join' } },
          { id: 'review', kind: 'review', depends_on: ['execute'], instruction: 'Review derived execution topology' },
        ],
      },
    },
  });
  const declarativeWorkOrderView = declarativeWorkOrder.result.structuredContent as Record<string, any>;
  assert.equal(declarativeWorkOrderView.status, 'ok');
  assert.equal(declarativeWorkOrderView.workflow_preview.declarative_expansion.expanded, true);
  assert.deepEqual(declarativeWorkOrderView.workflow_preview.steps.map((step: Record<string, unknown>) => step.id), ['research-alpha', 'research-beta', 'research-join', 'synthesize', 'execute-alpha', 'execute-beta', 'execution-join', 'review']);
  assert.deepEqual(declarativeWorkOrderView.workflow_preview.steps.find((step: Record<string, any>) => step.id === 'execute-alpha').write_set, ['src/main.ts']);
  assert.equal(declarativeWorkOrderView.workflow_preview.shape.edges.some((edge: Record<string, unknown>) => edge.from === 'research-join' && edge.to === 'synthesize'), true);

  const publishGate = await callTool(state, 'delegated_task_validate', {
    objective: 'Implement and git push the branch',
    constraints: { authority: 'write', cwd: root },
    workflow: { steps: [{ id: 'implement', kind: 'worker', instruction: 'git commit and push the changes' }] },
  });
  const publishGateView = publishGate.result.structuredContent as Record<string, any>;
  assert.equal(publishGateView.status, 'rejected');
  assert.equal(publishGateView.diagnostics.some((item: Record<string, unknown>) => item.code === 'git_publish_requires_command_authority'), true);

  const negatedPublishGate = await callTool(state, 'delegated_task_validate', {
    objective: 'Implement the change. Do not commit or push.',
    constraints: { authority: 'write', cwd: root },
    workflow: { steps: [{ id: 'implement', kind: 'worker', instruction: 'No git commit/push; preserve caller publication control.' }] },
  });
  const negatedPublishGateView = negatedPublishGate.result.structuredContent as Record<string, any>;
  assert.equal(negatedPublishGateView.status, 'ok');
  assert.equal(negatedPublishGateView.diagnostics.some((item: Record<string, unknown>) => String(item.code).startsWith('git_publish_requires_')), false);

  const commitReadGate = await callTool(state, 'delegated_task_validate', {
    objective: 'Implement and git commit the changes',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'implement', kind: 'worker', instruction: 'git commit the changes' }] },
  });
  const commitReadGateView = commitReadGate.result.structuredContent as Record<string, any>;
  assert.equal(commitReadGateView.status, 'rejected');
  assert.equal(commitReadGateView.diagnostics.some((item: Record<string, unknown>) => item.code === 'git_publish_requires_write_authority'), true);

  const commitWriteGate = await callTool(state, 'delegated_task_validate', {
    objective: 'Implement and git commit the changes',
    constraints: { authority: 'write', cwd: root },
    workflow: { steps: [{ id: 'implement', kind: 'worker', instruction: 'git commit the changes' }] },
  });
  const commitWriteGateView = commitWriteGate.result.structuredContent as Record<string, any>;
  assert.equal(commitWriteGateView.status, 'ok');
  assert.equal(commitWriteGateView.diagnostics.some((item: Record<string, unknown>) => String(item.code).startsWith('git_publish_requires_')), false);

  const conditionHint = await callTool(state, 'delegated_task_validate', {
    objective: 'Invalid condition suggestion',
    workflow: { steps: [{ id: 'a', kind: 'worker' }, { id: 'b', kind: 'note', depends_on: ['a'], if: 'all(step:a:completed)' }] },
  });
  const conditionHintView = conditionHint.result.structuredContent as Record<string, any>;
  const conditionDiagnostic = conditionHintView.diagnostics.find((item: Record<string, unknown>) => item.code === 'invalid_condition');
  assert.ok(conditionDiagnostic);
  assert.equal(Array.isArray(conditionDiagnostic.suggestions), true);
  assert.equal(conditionHintView.validation_hints.condition_language.includes('step:<step_id>:<status>'), true);

  const run = await callTool(state, 'delegated_task_run', {
    objective: 'Implement complete delegated task orchestration',
    idempotency_key: 'same-key',
    constraints: { authority: 'write', cwd: root, max_concurrency: 3 },
    workflow: {
      steps: [
        { id: 'implement-a', kind: 'worker', instruction: 'Implement part A' },
        { id: 'implement-b', kind: 'worker', instruction: 'Implement part B' },
        { id: 'review', kind: 'review', depends_on: ['implement-a', 'implement-b'], instruction: 'Review the implementation' },
        { id: 'join', kind: 'join', depends_on: ['implement-a', 'implement-b', 'review'] },
        { id: 'gate', kind: 'gate', depends_on: ['join'] },
        { id: 'note', kind: 'note', depends_on: ['gate'], instruction: 'Record final note' },
      ],
    },
    acceptance: {
      required_files: ['src/main.ts', { path: 'src/policy.ts', contains: 'review' }],
      required_tests: [{ command: 'pnpm test:delegated-task', status: 'passed' }],
      focused_tests: [{ command: 'pnpm test:delegated-task', status: 'passed' }],
      verification_budget: { max_attempts: 10, max_commands: 10 },
      required_tools: [{ name: 'structured-command' }],
      forbidden_patterns: [{ pattern: 'forbidden-never' }],
      review_quorum: { min_passed: 1, max_failed: 0 },
      residual_risk_policy: 'none_allowed',
    },
    result_policy: { expose_worker_refs: false, max_events: 4, max_worker_refs: 2, max_result_items: 1, compact_completed_worker_refs: true },
    execution: { wait_for_completion: true, max_concurrency: 3 },
  });

  assert.equal(run.error, undefined);
  const runResult = run.result.structuredContent as Record<string, any>;
  assert.equal(runResult.status, 'accepted_for_execution');
  assert.equal(runResult.task_status, 'completed');
  assert.match(runResult.task_id, /^task_/);
  assert.ok(statSync(runResult.task_path).isFile());
  assert.match(readFileSync(runResult.task_path, 'utf8'), /"objective": "Implement complete delegated task orchestration"/);

  const repeat = await callTool(state, 'delegated_task_run', { idempotency_key: 'same-key' });
  assert.equal((repeat.result.structuredContent as Record<string, any>).task_id, runResult.task_id);

  const status = await callTool(state, 'delegated_task_status', { task_id: runResult.task_id });
  const statusResult = status.result.structuredContent as Record<string, any>;
  assert.equal(statusResult.task_status, 'completed');
  assert.equal(statusResult.step_counts.total, 6);
  assert.equal(statusResult.step_status_counts.completed, 5);
  assert.equal(statusResult.step_status_counts.noted, 1);
  assert.equal(statusResult.acceptance_verdict, 'passed');
  assert.equal(statusResult.progress_delta.changed, false);
  assert.equal(statusResult.step_findings.some((finding: Record<string, unknown>) => finding.step_id === 'review' && finding.verification_count === 1), true);
  assert.equal(statusResult.review_consensus.consensus, 'passed');
  assert.equal(statusResult.closeout_synthesis.next_action, 'ready_for_closeout');

  const result = await callTool(state, 'delegated_task_result', { task_id: runResult.task_id, include_diagnostics: true });
  const resultView = result.result.structuredContent as Record<string, any>;
  assert.equal(resultView.result.acceptance_verdict, 'passed');
  assert.deepEqual(resultView.result.worker_refs.map((ref: Record<string, unknown>) => ref.run_id), ['run-test-1', 'run-test-2']);
  assert.equal(resultView.result.worker_refs_truncated, true);
  assert.equal(Array.isArray(resultView.result.output_refs), true);
  assert.equal(resultView.result.output_refs.some((ref: Record<string, unknown>) => ref.name === 'worker_refs'), true);
  assert.deepEqual(resultView.result.changed_files, ['src/main.ts']);
  assert.equal(resultView.result.changed_files_count, 1);
  assert.deepEqual(resultView.result.real_changed_files, ['src/main.ts']);
  assert.equal(resultView.result.real_changed_files_count, 1);
  assert.deepEqual(resultView.result.affected_refs, []);
  assert.equal(resultView.result.affected_refs_count, 0);
  assert.deepEqual(resultView.result.changed_file_refs, [{ path: 'src/main.ts', kind: 'real_file' }]);
  assert.deepEqual(resultView.result.parent_changed_files, []);
  assert.equal(resultView.result.parent_changed_files_count, 0);
  assert.deepEqual(resultView.result.worker_reported_changed_files, ['src/main.ts']);
  assert.equal(resultView.result.worker_reported_changed_files_count, 1);
  assert.deepEqual(resultView.result.observed_files, ['src/main.ts']);
  assert.deepEqual(resultView.result.nested_workflow_changed_files, []);
  assert.equal(resultView.result.verification.length, 1);
  assert.equal(resultView.result.verification_count, 1);
  assert.equal(resultView.result.acceptance_evidence.some((check: Record<string, any>) => check.kind === 'focused_test' && check.status === 'passed'), true);
  assert.equal(resultView.result.acceptance_evidence.some((check: Record<string, any>) => check.kind === 'verification_budget' && check.status === 'passed'), true);
  assert.equal(resultView.result.terminal_summary.acceptance_verdict, 'passed');
  assert.equal(resultView.result.terminal_summary.steps_terminal, true);
  assert.equal(resultView.result.terminal_summary.acceptance_terminal, true);
  assert.deepEqual(resultView.result.terminal_summary.pending_acceptance_items, []);
  assert.equal(resultView.result.terminal_summary.real_changed_files_count, 1);
  assert.equal(resultView.result.closeout_synthesis.closeout_ready, true);
  assert.equal(resultView.result.closeout_synthesis.condition_language, 'acceptance:passed');
  assert.equal(resultView.result.review_consensus.consensus, 'passed');
  assert.equal(resultView.result.operator_summary.root_cause, 'none');
  assert.equal(resultView.result.operator_summary.next_directive, 'ready_for_closeout');
  assert.equal(resultView.result.target_state_changed.repo_files_changed.changed, true);
  assert.deepEqual(resultView.result.target_state_changed.repo_files_changed.paths, ['src/main.ts']);
  assert.equal(resultView.result.target_state_changed.delegated_task_artifacts_created.changed, true);
  assert.match(resultView.result.target_state_changed.delegated_task_artifacts_created.paths[0], /tasks/);
  assert.equal(resultView.result.target_state_changed.worker_runtime_artifacts_created.changed, true);
  assert.equal(resultView.result.graph_execution_synthesis.parent_workflow_status, 'completed');
  assert.equal(resultView.result.graph_execution_synthesis.synthesized_verdict, 'accepted');
  assert.equal(resultView.result.graph_execution_synthesis.orchestration_success, true);
  assert.equal(resultView.result.graph_execution_synthesis.step_status.length, 6);
  assert.equal(resultView.result.graph_execution_synthesis.step_status.find((step: Record<string, any>) => step.step_id === 'implement-a').current_run_id, null);
  assert.deepEqual(resultView.result.graph_execution_synthesis.step_status.find((step: Record<string, any>) => step.step_id === 'implement-a').run_ids, ['run-test-1']);
  assert.equal(resultView.result.graph_execution_synthesis.worker_summaries.length, 3);
  assert.match(resultView.result.graph_execution_synthesis.worker_summaries[0].output_ref, /^output-run-test-/);
  assert.equal(resultView.result.graph_execution_synthesis.worker_summaries[0].diagnostic_flags.verification_count, 1);
  assert.equal(resultView.result.join_syntheses.length, 1);
  assert.equal(resultView.result.join_syntheses[0].worker_ref_count, 3);
  assert.equal(resultView.result.join_syntheses[0].worker_summaries.length, 3);
  assert.equal(resultView.diagnostics.task_id, runResult.task_id);

  const compactResult = await callTool(state, 'delegated_task_result', { task_id: runResult.task_id });
  const compactResultView = compactResult.result.structuredContent as Record<string, any>;
  assert.equal(compactResultView.result.worker_refs, undefined);
  assert.equal(compactResultView.result.worker_ref_count, 3);
  assert.equal(compactResultView.result.worker_refs_redacted, true);
  assert.equal(compactResultView.result.operator_summary.root_cause, 'none');
  assert.match(compactResultView.result.graph_execution_synthesis.worker_summaries[0].result_ref, /^result-run-test-/);

  const summary = await callTool(state, 'delegated_task_summary', { task_id: runResult.task_id });
  const summaryView = summary.result.structuredContent as Record<string, any>;
  assert.equal(summaryView.status, 'ok');
  assert.equal(summaryView.child_evidence.length, 3);
  assert.deepEqual(summaryView.changed_files, ['src/main.ts']);
  assert.deepEqual(summaryView.real_changed_files, ['src/main.ts']);
  assert.deepEqual(summaryView.affected_refs, []);
  assert.equal(summaryView.terminal_summary.acceptance_verdict, 'passed');
  assert.equal(summaryView.step_findings.length, 6);
  assert.equal(summaryView.review_consensus.consensus, 'passed');
  assert.equal(summaryView.closeout_synthesis.closeout_ready, true);

  const nestedRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise nested probe separation',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'probe', kind: 'research', instruction: 'nested probe' }] },
    execution: { wait_for_completion: true },
  });
  const nestedView = nestedRun.result.structuredContent as Record<string, any>;
  assert.equal(nestedView.task_status, 'completed');
  const nestedResult = await callTool(state, 'delegated_task_result', { task_id: nestedView.task_id, include_diagnostics: true });
  const nestedResultView = nestedResult.result.structuredContent as Record<string, any>;
  assert.deepEqual(nestedResultView.result.worker_reported_changed_files, []);
  assert.deepEqual(nestedResultView.result.nested_workflow_changed_files, ['nested/output.txt']);
  assert.equal(nestedResultView.result.nested_workflow_count, 1);
  assert.equal(nestedResultView.result.nested_workflow_verification_count, 1);
  assert.deepEqual(nestedResultView.result.changed_files, ['nested/output.txt']);
  assert.deepEqual(nestedResultView.result.real_changed_files, []);
  assert.deepEqual(nestedResultView.result.affected_refs, ['nested/output.txt']);
  assert.deepEqual(nestedResultView.result.changed_file_refs, [{ path: 'nested/output.txt', kind: 'affected_ref' }]);
  assert.equal(nestedResultView.result.terminal_summary.affected_refs_count, 1);
  assert.equal(nestedResultView.result.target_state_changed.repo_files_changed.changed, false);
  assert.equal(nestedResultView.result.target_state_changed.nested_delegated_task_changed_files.changed, true);
  assert.equal(nestedResultView.result.graph_execution_synthesis.nested_delegated_task_calls[0].task_status, 'failed');

  const readOnlyAuditRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise read-only audit readback separation',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'audit', kind: 'research', instruction: 'read-only audit readback' }] },
    execution: { wait_for_completion: true },
  });
  const readOnlyAuditView = readOnlyAuditRun.result.structuredContent as Record<string, any>;
  assert.equal(readOnlyAuditView.task_status, 'completed');
  const readOnlyAuditResult = await callTool(state, 'delegated_task_result', { task_id: readOnlyAuditView.task_id, include_diagnostics: true });
  const readOnlyAuditResultView = readOnlyAuditResult.result.structuredContent as Record<string, any>;
  assert.deepEqual(readOnlyAuditResultView.result.changed_files, []);
  assert.deepEqual(readOnlyAuditResultView.result.real_changed_files, []);
  assert.deepEqual(readOnlyAuditResultView.result.worker_reported_changed_files, []);
  assert.deepEqual(readOnlyAuditResultView.result.observed_files, ['src/policy.ts', 'src/main.ts']);
  assert.equal(readOnlyAuditResultView.result.target_state_changed.repo_files_changed.changed, false);
  assert.deepEqual(readOnlyAuditResultView.result.target_state_changed.repo_files_changed.paths, []);
  assert.equal(readOnlyAuditResultView.result.target_state_changed.worker_observed_changed_files.changed, true);
  assert.deepEqual(readOnlyAuditResultView.result.target_state_changed.worker_observed_changed_files.paths, ['src/policy.ts', 'src/main.ts']);

  const failedReviewRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise explicit review failure',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'review', kind: 'review', instruction: 'explicit review failure' }] },
    acceptance: { review_quorum: { min_passed: 1, max_failed: 0 } },
    execution: { wait_for_completion: true },
  });
  const failedReviewView = failedReviewRun.result.structuredContent as Record<string, any>;
  assert.equal(failedReviewView.task_status, 'failed');

  const siteRootRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise site_root pass-through',
    constraints: { authority: 'read', cwd: root, site_root: siteRoot },
    workflow: { steps: [{ id: 'site-bound', kind: 'research', instruction: 'site_root pass through' }] },
    execution: { wait_for_completion: true },
  });
  const siteRootRunView = siteRootRun.result.structuredContent as Record<string, any>;
  assert.equal(siteRootRunView.task_status, 'completed');
  const siteRootWorkerCall = workerCalls.find((call) => call.name === 'worker_run' && JSON.stringify(call.args).includes('site_root pass through'));
  assert.equal((siteRootWorkerCall?.args.constraints as Record<string, unknown>).site_root, siteRoot);

  const recoveredWaitRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise worker status recovery',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'async-recover', kind: 'research', instruction: 'async missing status worker' }] },
    execution: { start: true, wait_for_completion: false },
  });
  const recoveredWaitRunView = recoveredWaitRun.result.structuredContent as Record<string, any>;
  assert.equal(recoveredWaitRunView.task_status, 'running');
  const recoveredRunId = recoveredWaitRunView.progress.running_run_ids[0];
  const recoveredStatus = await callTool(state, 'delegated_task_status', { task_id: recoveredWaitRunView.task_id, refresh: true });
  const recoveredStatusView = recoveredStatus.result.structuredContent as Record<string, any>;
  assert.equal(recoveredStatusView.task_status, 'completed');
  assert.equal(workerCalls.some((call) => call.name === 'worker_run_wait' && String(call.args.run_id) === recoveredRunId), true);
  const recoveredResult = await callTool(state, 'delegated_task_result', { task_id: recoveredWaitRunView.task_id, include_diagnostics: true });
  const recoveredResultView = recoveredResult.result.structuredContent as Record<string, any>;
  assert.equal(recoveredResultView.result.steps_terminal, true);
  assert.equal(recoveredResultView.result.residual_risks.includes('worker_runs_still_in_progress'), false);
  assert.deepEqual(recoveredResultView.result.progress.running_run_ids, []);
  assert.deepEqual(recoveredResultView.result.progress.historical_run_ids, [recoveredRunId]);
  assert.equal(recoveredResultView.result.step_states['async-recover'].current_run_id, null);

  const writeSetRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise disjoint write-set scheduling',
    constraints: { authority: 'write', cwd: root, max_concurrency: 3 },
    workflow: {
      work_order: {
        items: [{ id: 'a', path: 'src/main.ts' }, { id: 'b', path: 'src/main.ts' }],
        stage_policy: { execution: { schedule_by_disjoint_write_set: true } },
        stages: [{ id: 'execute', kind: 'worker', mode: 'map', instruction: 'async worker write-set {{item.id}}', write_set: ['{{item.path}}'], join: true }],
      },
    },
    execution: { start: true, wait_for_completion: false, max_concurrency: 3 },
  });
  const writeSetRunView = writeSetRun.result.structuredContent as Record<string, any>;
  assert.equal(writeSetRunView.task_status, 'running');
  const writeSetStatus = await callTool(state, 'delegated_task_status', { task_id: writeSetRunView.task_id });
  const writeSetStatusView = writeSetStatus.result.structuredContent as Record<string, any>;
  assert.deepEqual(writeSetStatusView.scheduler_state.running_step_ids, ['execute-a']);
  assert.deepEqual(writeSetStatusView.scheduler_state.write_set_conflicts.map((item: Record<string, unknown>) => item.step_id), ['execute-b']);
  const writeSetAdvance = await callTool(state, 'delegated_task_advance', { task_id: writeSetRunView.task_id });
  const writeSetAdvanceView = writeSetAdvance.result.structuredContent as Record<string, any>;
  assert.equal(writeSetAdvanceView.scheduler_state.running_step_ids.includes('execute-b'), true);
  const writeSetResult = await callTool(state, 'delegated_task_result', { task_id: writeSetRunView.task_id, include_diagnostics: true });
  const writeSetResultView = writeSetResult.result.structuredContent as Record<string, any>;
  assert.equal(writeSetResultView.result.graph_execution_synthesis.derived_topology.write_set_scheduling, true);
  assert.equal(writeSetResultView.result.graph_execution_synthesis.derived_topology.write_sets.length, 2);

  const implicitPositiveReviewRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise staccato positive review summary without explicit verdict',
    constraints: { authority: 'write', cwd: root },
    workflow: {
      steps: [
        { id: 'implement', kind: 'worker', instruction: 'Create top10 supplement' },
        { id: 'review', kind: 'review', depends_on: ['implement'], instruction: 'positive summary no explicit verdict' },
      ],
    },
    acceptance: { review_quorum: { min_passed: 1, max_failed: 0 }, residual_risk_policy: 'allow' },
    execution: { wait_for_completion: true },
  });
  const implicitPositiveReviewView = implicitPositiveReviewRun.result.structuredContent as Record<string, any>;
  assert.equal(implicitPositiveReviewView.task_status, 'completed');
  const implicitPositiveReviewResult = await callTool(state, 'delegated_task_result', { task_id: implicitPositiveReviewView.task_id, include_diagnostics: true });
  const implicitPositiveReviewResultView = implicitPositiveReviewResult.result.structuredContent as Record<string, any>;
  assert.equal(implicitPositiveReviewResultView.result.acceptance_verdict, 'passed');
  assert.deepEqual(implicitPositiveReviewResultView.result.acceptance_evidence.find((check: Record<string, any>) => check.kind === 'review_quorum'), { kind: 'review_quorum', min_passed: 1, max_failed: 0, passed: 1, failed: 0, status: 'passed' });
  assert.deepEqual(implicitPositiveReviewResultView.result.terminal_summary.pending_review_items, []);
  assert.deepEqual(implicitPositiveReviewResultView.result.residual_risks, []);
  assert.equal(implicitPositiveReviewResultView.result.review_consensus.consensus, 'passed');
  const implicitPositiveReviewCall = workerCalls.find((call) => call.name === 'worker_run' && JSON.stringify(call.args).includes('positive summary no explicit verdict'));
  assert.match(JSON.stringify(implicitPositiveReviewCall?.args), /review_verdict as one of accepted, rejected, or accepted_with_findings/);

  const acceptedFindingsSummaryRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise accepted_with_findings summary parsing',
    constraints: { authority: 'write', cwd: root },
    workflow: {
      steps: [
        { id: 'implement', kind: 'worker', instruction: 'Implement summary verdict case' },
        { id: 'review', kind: 'review', depends_on: ['implement'], instruction: 'accepted findings summary only' },
      ],
    },
    acceptance: { review_quorum: { min_passed: 1, max_failed: 0 }, residual_risk_policy: 'allow' },
    execution: { wait_for_completion: true },
  });
  const acceptedFindingsSummaryView = acceptedFindingsSummaryRun.result.structuredContent as Record<string, any>;
  assert.equal(acceptedFindingsSummaryView.task_status, 'completed');
  const acceptedFindingsSummaryResult = await callTool(state, 'delegated_task_result', { task_id: acceptedFindingsSummaryView.task_id, include_diagnostics: true });
  const acceptedFindingsSummaryResultView = acceptedFindingsSummaryResult.result.structuredContent as Record<string, any>;
  assert.deepEqual(acceptedFindingsSummaryResultView.result.acceptance_evidence.find((check: Record<string, any>) => check.kind === 'review_quorum'), { kind: 'review_quorum', min_passed: 1, max_failed: 0, passed: 1, failed: 0, status: 'passed' });
  assert.equal(acceptedFindingsSummaryResultView.result.review_consensus.consensus, 'passed');

  const exitInterviewRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise delegated task exit interview propagation',
    constraints: { authority: 'read', cwd: root, exit_interview: true },
    workflow: { steps: [{ id: 'audit', kind: 'research', instruction: 'exit interview requested through constraints' }] },
    result_policy: { expose_worker_refs: false },
    execution: { wait_for_completion: true },
  });
  const exitInterviewView = exitInterviewRun.result.structuredContent as Record<string, any>;
  assert.equal(exitInterviewView.task_status, 'completed');
  const exitInterviewCall = workerCalls.find((call) => call.name === 'worker_run' && JSON.stringify(call.args).includes('exit interview requested through constraints'));
  assert.equal((exitInterviewCall?.args.constraints as Record<string, unknown>).exit_interview, true);
  const exitInterviewResult = await callTool(state, 'delegated_task_result', { task_id: exitInterviewView.task_id, include_diagnostics: true });
  const exitInterviewResultView = exitInterviewResult.result.structuredContent as Record<string, any>;
  assert.equal(exitInterviewResultView.result.exit_interview_count, 1);
  assert.equal(exitInterviewResultView.result.exit_interviews[0].step_id, 'audit');
  assert.deepEqual(exitInterviewResultView.result.exit_interview_feedback.friction_points, ['exit interview propagation required explicit test coverage']);
  assert.equal(exitInterviewResultView.result.observed_incoherencies.includes('delegated_task_exit_interview_path_was_previously_unprocessed'), true);
  assert.equal(exitInterviewResultView.result.terminal_summary.exit_interview_count, 1);

  const expiredTerminalRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise delegated task expired terminal diagnostics',
    constraints: { authority: 'read', cwd: root, exit_interview: true },
    workflow: { steps: [{ id: 'audit', kind: 'research', instruction: 'expired terminal worker' }] },
    result_policy: { expose_worker_refs: false },
    execution: { wait_for_completion: true },
  });
  const expiredTerminalView = expiredTerminalRun.result.structuredContent as Record<string, any>;
  assert.equal(expiredTerminalView.task_status, 'failed');
  const expiredTerminalResult = await callTool(state, 'delegated_task_result', { task_id: expiredTerminalView.task_id, include_diagnostics: true });
  const expiredTerminalResultView = expiredTerminalResult.result.structuredContent as Record<string, any>;
  assert.equal(expiredTerminalResultView.result.worker_terminal_diagnostic_count, 1);
  assert.equal(expiredTerminalResultView.result.worker_terminal_diagnostics[0].error_classification, 'worker_run_expired_without_terminal_output');
  assert.match(expiredTerminalResultView.result.worker_terminal_diagnostics[0].diagnostic_tail, /runtime process stopped before final message/);
  assert.equal(expiredTerminalResultView.result.terminal_summary.worker_terminal_diagnostic_count, 1);
  assert.equal(expiredTerminalResultView.result.graph_execution_synthesis.worker_terminal_diagnostics[0].run_id, expiredTerminalResultView.result.worker_terminal_diagnostics[0].run_id);

  const repairedReviewRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise rejected review repair routing',
    constraints: { authority: 'write', cwd: root },
    workflow: {
      steps: [
        { id: 'implement', kind: 'worker', instruction: 'Implement rejected review case' },
        { id: 'review', kind: 'review', depends_on: ['implement'], instruction: 'rejected review' },
        { id: 'repair', kind: 'repair', depends_on: ['review'], if: 'review_failed', instruction: 'Repair rejected review' },
        { id: 'rereview', kind: 'review', depends_on: ['repair'], instruction: 'Accepted repaired review' },
        { id: 'verify', kind: 'verify', depends_on: ['rereview'], instruction: 'Verify repaired review' },
      ],
    },
    acceptance: { review_quorum: { min_passed: 1, max_failed: 0 } },
    execution: { wait_for_completion: true },
  });
  const repairedReviewView = repairedReviewRun.result.structuredContent as Record<string, any>;
  assert.equal(repairedReviewView.task_status, 'completed');
  const repairedReviewResult = await callTool(state, 'delegated_task_result', { task_id: repairedReviewView.task_id, include_diagnostics: true });
  const repairedReviewResultView = repairedReviewResult.result.structuredContent as Record<string, any>;
  assert.equal(repairedReviewResultView.result.step_states.repair.status, 'completed');
  assert.equal(repairedReviewResultView.result.acceptance_verdict, 'passed');
  assert.deepEqual(repairedReviewResultView.result.acceptance_evidence.find((check: Record<string, any>) => check.kind === 'review_quorum'), { kind: 'review_quorum', min_passed: 1, max_failed: 0, passed: 1, failed: 0, status: 'passed' });
  assert.equal(repairedReviewResultView.result.terminal_summary.review_passed_count, 1);
  assert.equal(repairedReviewResultView.result.terminal_summary.next_action, 'ready_for_closeout');

  const repairWithoutRereviewRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise repair without re-review',
    constraints: { authority: 'write', cwd: root },
    workflow: {
      steps: [
        { id: 'implement', kind: 'worker', instruction: 'Implement repair without rereview' },
        { id: 'review', kind: 'review', depends_on: ['implement'], instruction: 'rejected review' },
        { id: 'repair', kind: 'repair', depends_on: ['review'], if: 'review_failed', instruction: 'Repair rejected review' },
        { id: 'verify', kind: 'verify', depends_on: ['repair'], instruction: 'Verify without re-review' },
      ],
    },
    acceptance: { review_quorum: { min_passed: 1, max_failed: 0 } },
    execution: { wait_for_completion: true },
  });
  const repairWithoutRereviewView = repairWithoutRereviewRun.result.structuredContent as Record<string, any>;
  assert.equal(repairWithoutRereviewView.task_status, 'completed');
  const repairWithoutRereviewResult = await callTool(state, 'delegated_task_result', { task_id: repairWithoutRereviewView.task_id, include_diagnostics: true });
  const repairWithoutRereviewResultView = repairWithoutRereviewResult.result.structuredContent as Record<string, any>;
  assert.equal(repairWithoutRereviewResultView.result.acceptance_verdict, 'pending');
  assert.deepEqual(repairWithoutRereviewResultView.result.acceptance_evidence.find((check: Record<string, any>) => check.kind === 'review_quorum'), { kind: 'review_quorum', min_passed: 1, max_failed: 0, passed: 0, failed: 0, status: 'pending' });
  assert.equal(repairWithoutRereviewResultView.result.terminal_summary.next_action, 'await_review_resolution');
  assert.equal(repairWithoutRereviewResultView.result.terminal_summary.steps_terminal, true);
  assert.equal(repairWithoutRereviewResultView.result.terminal_summary.acceptance_terminal, false);
  assert.equal(repairWithoutRereviewResultView.result.terminal_summary.pending_acceptance_items.some((item: Record<string, any>) => item.kind === 'review_quorum'), true);
  assert.equal(repairWithoutRereviewResultView.result.terminal_summary.pending_review_items.some((item: Record<string, any>) => item.kind === 'review_quorum'), true);
  assert.equal(repairWithoutRereviewResultView.result.graph_execution_synthesis.synthesized_verdict, 'workflow_complete_acceptance_pending');
  assert.equal(repairWithoutRereviewResultView.result.operator_summary.root_cause, 'acceptance_pending');

  const skippedRepairRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise rejected review with skipped repair',
    constraints: { authority: 'write', cwd: root },
    workflow: {
      steps: [
        { id: 'implement', kind: 'worker', instruction: 'Implement skipped repair case' },
        { id: 'review', kind: 'review', depends_on: ['implement'], instruction: 'rejected review' },
        { id: 'repair', kind: 'repair', depends_on: ['review'], if: 'not(review_failed)', instruction: 'Skipped repair' },
        { id: 'verify', kind: 'verify', depends_on: ['repair'], instruction: 'Verify skipped repair' },
      ],
    },
    acceptance: { review_quorum: { min_passed: 1, max_failed: 0 } },
    execution: { wait_for_completion: true },
  });
  const skippedRepairView = skippedRepairRun.result.structuredContent as Record<string, any>;
  assert.equal(skippedRepairView.task_status, 'failed');
  const skippedRepairResult = await callTool(state, 'delegated_task_result', { task_id: skippedRepairView.task_id, include_diagnostics: true });
  const skippedRepairResultView = skippedRepairResult.result.structuredContent as Record<string, any>;
  assert.equal(skippedRepairResultView.result.step_states.repair.status, 'skipped');
  assert.equal(skippedRepairResultView.result.acceptance_verdict, 'failed');
  assert.deepEqual(skippedRepairResultView.result.acceptance_evidence.find((check: Record<string, any>) => check.kind === 'review_quorum'), { kind: 'review_quorum', min_passed: 1, max_failed: 0, passed: 0, failed: 1, status: 'failed' });
  assert.equal(skippedRepairResultView.result.terminal_summary.next_action, 'repair_failed_review');

  const cappedEvents = await callTool(state, 'delegated_task_events', { task_id: runResult.task_id, limit: 10, offset: 0 });
  const cappedEventsView = cappedEvents.result.structuredContent as Record<string, any>;
  assert.equal(cappedEventsView.limit, 4);
  assert.equal(cappedEventsView.events.length, 4);
  assert.equal(cappedEventsView.compacted, true);
  assert.equal(cappedEventsView.event_counts_by_kind.task_created, 1);
  assert.equal(Object.values(cappedEventsView.event_summary_by_step).some((step: any) => step.event_counts_by_kind.step_completed === 1), true);

  const conditionalRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise rich conditions',
    constraints: { authority: 'read', cwd: root },
    workflow: {
      steps: [
        { id: 'base', kind: 'worker', instruction: 'Base work' },
        { id: 'conditional', kind: 'note', depends_on: ['base'], if: 'all(step:base:completed,not(result_has:absent-token))', instruction: 'Conditional note' },
      ],
    },
    execution: { wait_for_completion: true },
  });
  const conditionalView = conditionalRun.result.structuredContent as Record<string, any>;
  assert.equal(conditionalView.task_status, 'completed');
  const conditionalResult = await callTool(state, 'delegated_task_result', { task_id: conditionalView.task_id, include_diagnostics: true });
  const conditionalResultView = conditionalResult.result.structuredContent as Record<string, any>;
  assert.equal(conditionalResultView.result.step_states.conditional.status, 'noted');

  const legacyTaskId = 'task_legacy_global_active';
  mkdirSync(join(root, 'tasks', legacyTaskId), { recursive: true });
  writeFileSync(join(root, 'tasks', legacyTaskId, 'task.json'), JSON.stringify({
    schema: 'narada.delegated_task.task.v1',
    task_id: legacyTaskId,
    status: 'running',
    objective: 'Legacy active task without ownership metadata',
    constraints: {},
    workflow: { steps: [] },
    acceptance: {},
    result_policy: { include_diagnostics_by_default: false, expose_worker_refs: true, compact_completed_worker_refs: false, max_events: 100, max_worker_refs: 50, max_result_items: 200 },
    execution: { start: true, wait_for_completion: false, timeout_ms: 0, poll_ms: 500, resumable: true, exit_interview: false, max_concurrency: 10, max_retries: 0 },
    idempotency_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cancelled_at: null,
    summary: null,
    result: { schema: 'narada.delegated_task.handoff.v1', acceptance_verdict: 'pending', progress: { running_run_ids: [] } },
  }, null, 2), 'utf8');
  const otherSiteTaskId = 'task_other_site_active';
  mkdirSync(join(root, 'tasks', otherSiteTaskId), { recursive: true });
  writeFileSync(join(root, 'tasks', otherSiteTaskId, 'task.json'), JSON.stringify({
    schema: 'narada.delegated_task.task.v1',
    task_id: otherSiteTaskId,
    owner_site_id: 'other-site',
    owner_site_root: join(root, 'other-site'),
    created_by_site_id: 'other-site',
    visibility_scope: 'site',
    task_root_scope: 'shared_physical_store',
    status: 'running',
    objective: 'Other site active task',
    constraints: {},
    workflow: { steps: [] },
    acceptance: {},
    result_policy: { include_diagnostics_by_default: false, expose_worker_refs: true, compact_completed_worker_refs: false, max_events: 100, max_worker_refs: 50, max_result_items: 200 },
    execution: { start: true, wait_for_completion: false, timeout_ms: 0, poll_ms: 500, resumable: true, exit_interview: false, max_concurrency: 10, max_retries: 0 },
    idempotency_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cancelled_at: null,
    summary: null,
    result: { schema: 'narada.delegated_task.handoff.v1', acceptance_verdict: 'pending', progress: { running_run_ids: [] } },
  }, null, 2), 'utf8');

  const listed = await callTool(state, 'delegated_tasks_list', { limit: 20 });
  const listedView = listed.result.structuredContent as Record<string, any>;
  assert.equal(listedView.site_scope, 'current_site');
  assert.equal(listedView.current_site_id, 'site-root');
  assert.equal(listedView.tasks.some((task: Record<string, unknown>) => task.task_id === legacyTaskId), false);
  assert.equal(listedView.tasks.some((task: Record<string, unknown>) => task.task_id === otherSiteTaskId), false);
  assert.equal(listedView.include_terminal, false);
  assert.equal(listedView.tasks.some((task: Record<string, unknown>) => task.task_id === runResult.task_id), false);
  assert.equal(listedView.tasks.every((task: Record<string, any>) => task.list_category === 'active_queue'), true);
  assert.equal(listedView.tasks.every((task: Record<string, any>) => task.owner_site_id === 'site-root'), true);
  const listedGlobal = await callTool(state, 'delegated_tasks_list', { limit: 50, site_scope: 'all_sites' });
  const listedGlobalView = listedGlobal.result.structuredContent as Record<string, any>;
  const globalLegacyRow = listedGlobalView.tasks.find((task: Record<string, unknown>) => task.task_id === legacyTaskId);
  assert.equal(listedGlobalView.tasks.some((task: Record<string, unknown>) => task.task_id === otherSiteTaskId), true);
  assert.equal(globalLegacyRow.visibility_scope, 'user_global_legacy');
  assert.equal(globalLegacyRow.owner_site_id, 'unknown');
  assert.ok(listedGlobalView.queue_summary.by_owner_site['other-site']);
  assert.ok(listedGlobalView.queue_summary.by_owner_site.unknown);
  const listedUserGlobal = await callTool(state, 'delegated_tasks_list', { limit: 50, site_scope: 'user_global' });
  const listedUserGlobalView = listedUserGlobal.result.structuredContent as Record<string, any>;
  assert.equal(listedUserGlobalView.tasks.some((task: Record<string, unknown>) => task.task_id === legacyTaskId), true);
  assert.equal(listedUserGlobalView.tasks.some((task: Record<string, unknown>) => task.task_id === otherSiteTaskId), false);
  const otherSiteCancelDenied = await callTool(state, 'delegated_task_cancel', { task_id: otherSiteTaskId, reason: 'cross-site denial test' });
  assert.equal((otherSiteCancelDenied.error as Record<string, any>).data.code, 'delegated_task_cross_site_mutation_denied');
  const listedHistory = await callTool(state, 'delegated_tasks_list', { limit: 20, include_terminal: true });
  const listedHistoryView = listedHistory.result.structuredContent as Record<string, any>;
  const completedHistoryRow = listedHistoryView.tasks.find((task: Record<string, unknown>) => task.task_id === runResult.task_id);
  assert.ok(completedHistoryRow);
  assert.equal(completedHistoryRow.list_category, 'terminal_history');
  assert.equal(completedHistoryRow.operator_posture.active, false);
  assert.equal(completedHistoryRow.operator_posture.active_execution, false);
  assert.equal(completedHistoryRow.operator_posture.terminal_posture, 'no_active_execution');
  assert.equal(completedHistoryRow.operator_posture.operator_category, 'archive_ready_for_acknowledgement');
  assert.equal(completedHistoryRow.operator_posture.next_action, 'acknowledge_closeout');
  assert.equal(listedView.tasks.every((task: Record<string, any>) => task.operator_posture?.schema === 'narada.delegated_task.operator_posture.v1'), true);

  const scopedCurrentRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise current-site queue ownership',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'owned', kind: 'note', instruction: 'Current site queue row' }] },
    execution: { start: false },
  });
  const scopedCurrentView = scopedCurrentRun.result.structuredContent as Record<string, any>;
  assert.equal(scopedCurrentView.ownership.owner_site_id, 'site-root');
  assert.equal(scopedCurrentView.ownership.visibility_scope, 'site');
  const scopedCurrentTaskPath = join(root, 'tasks', scopedCurrentView.task_id, 'task.json');
  const scopedCurrentTask = JSON.parse(readFileSync(scopedCurrentTaskPath, 'utf8')) as Record<string, any>;
  assert.equal(scopedCurrentTask.owner_site_id, 'site-root');
  assert.equal(scopedCurrentTask.created_by_site_id, 'site-root');
  const legacyTask = { ...scopedCurrentTask, task_id: 'task_legacyglobal', owner_site_id: undefined, owner_site_root: undefined, created_by_site_id: undefined, visibility_scope: undefined, task_root_scope: undefined, objective: 'Legacy global active queue row', updated_at: new Date().toISOString() };
  const foreignTask = { ...scopedCurrentTask, task_id: 'task_foreignsite', owner_site_id: 'other-site', owner_site_root: join(root, 'other-site'), created_by_site_id: 'other-site', visibility_scope: 'site', objective: 'Foreign site active queue row', updated_at: new Date().toISOString() };
  mkdirSync(join(root, 'tasks', legacyTask.task_id), { recursive: true });
  mkdirSync(join(root, 'tasks', foreignTask.task_id), { recursive: true });
  writeFileSync(join(root, 'tasks', legacyTask.task_id, 'task.json'), `${JSON.stringify(legacyTask, null, 2)}\n`, 'utf8');
  writeFileSync(join(root, 'tasks', foreignTask.task_id, 'task.json'), `${JSON.stringify(foreignTask, null, 2)}\n`, 'utf8');

  const currentSiteList = await callTool(state, 'delegated_tasks_list', { limit: 100 });
  const currentSiteListView = currentSiteList.result.structuredContent as Record<string, any>;
  assert.equal(currentSiteListView.site_scope, 'current_site');
  assert.equal(currentSiteListView.tasks.some((task: Record<string, any>) => task.task_id === scopedCurrentView.task_id), true);
  assert.equal(currentSiteListView.tasks.some((task: Record<string, any>) => task.task_id === 'task_foreignsite'), false);
  assert.equal(currentSiteListView.tasks.some((task: Record<string, any>) => task.task_id === 'task_legacyglobal'), false);
  const allSiteList = await callTool(state, 'delegated_tasks_list', { limit: 100, site_scope: 'all_sites' });
  const allSiteListView = allSiteList.result.structuredContent as Record<string, any>;
  const legacyRow2 = allSiteListView.tasks.find((task: Record<string, any>) => task.task_id === 'task_legacyglobal');
  const foreignRow2 = allSiteListView.tasks.find((task: Record<string, any>) => task.task_id === 'task_foreignsite');
  assert.equal(legacyRow2.owner_site_id, 'unknown');
  assert.equal(legacyRow2.visibility_scope, 'user_global_legacy');
  assert.equal(foreignRow2.owner_site_id, 'other-site');
  const deniedForeignCancel = await callTool(state, 'delegated_task_cancel', { task_id: 'task_foreignsite', reason: 'should require explicit cross-site override' });
  assert.equal((deniedForeignCancel.error as Record<string, any>).data.code, 'delegated_task_cross_site_mutation_denied');
  const deniedLegacyCancel = await callTool(state, 'delegated_task_cancel', { task_id: 'task_legacyglobal', reason: 'should require explicit legacy override' });
  assert.equal((deniedLegacyCancel.error as Record<string, any>).data.code, 'delegated_task_cross_site_mutation_denied');
  const allowedForeignCancel = await callTool(state, 'delegated_task_cancel', { task_id: 'task_foreignsite', reason: 'explicit cross-site override', expected_owner_site_id: 'other-site', allow_cross_site: true });
  const allowedForeignCancelView = allowedForeignCancel.result.structuredContent as Record<string, any>;
  assert.equal(allowedForeignCancelView.task_status, 'cancelled');
  assert.equal(allowedForeignCancelView.ownership.owner_site_id, 'other-site');

  const foreignAckTask = { ...foreignTask, task_id: 'task_foreignack', status: 'completed', objective: 'Foreign terminal row', updated_at: new Date().toISOString(), result: { ...scopedCurrentTask.result, acceptance_verdict: 'passed' } };
  const foreignTakeoverTask = { ...foreignTask, task_id: 'task_foreigntakeover', status: 'running', objective: 'Foreign takeover row', updated_at: new Date().toISOString() };
  mkdirSync(join(root, 'tasks', foreignAckTask.task_id), { recursive: true });
  mkdirSync(join(root, 'tasks', foreignTakeoverTask.task_id), { recursive: true });
  writeFileSync(join(root, 'tasks', foreignAckTask.task_id, 'task.json'), `${JSON.stringify(foreignAckTask, null, 2)}\n`, 'utf8');
  writeFileSync(join(root, 'tasks', foreignTakeoverTask.task_id, 'task.json'), `${JSON.stringify(foreignTakeoverTask, null, 2)}\n`, 'utf8');
  const deniedForeignAck = await callTool(state, 'delegated_task_acknowledge', { task_id: 'task_foreignack', acknowledged_by: 'test' });
  assert.equal((deniedForeignAck.error as Record<string, any>).data.code, 'delegated_task_cross_site_mutation_denied');
  const allowedForeignAck = await callTool(state, 'delegated_task_acknowledge', { task_id: 'task_foreignack', acknowledged_by: 'test', expected_owner_site_id: 'other-site', allow_cross_site: true });
  assert.equal((allowedForeignAck.result.structuredContent as Record<string, any>).ownership.owner_site_id, 'other-site');
  const deniedForeignTakeover = await callTool(state, 'delegated_task_parent_takeover', { task_id: 'task_foreigntakeover', reason: 'test takeover' });
  assert.equal((deniedForeignTakeover.error as Record<string, any>).data.code, 'delegated_task_cross_site_mutation_denied');
  const allowedForeignTakeover = await callTool(state, 'delegated_task_parent_takeover', { task_id: 'task_foreigntakeover', reason: 'test takeover', expected_owner_site_id: 'other-site', allow_cross_site: true });
  assert.equal((allowedForeignTakeover.result.structuredContent as Record<string, any>).ownership.owner_site_id, 'other-site');

  const beforeConcurrencyCalls = workerCalls.filter((call) => call.name === 'worker_run').length;
  const limitedRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise max concurrency',
    constraints: { authority: 'read', cwd: root, max_concurrency: 2 },
    acceptance: { forbidden_patterns: ['definitely-not-present-in-results'] },
    workflow: {
      steps: [
        { id: 'a', kind: 'worker', instruction: 'async worker a' },
        { id: 'b', kind: 'worker', instruction: 'async worker b' },
        { id: 'c', kind: 'worker', instruction: 'async worker c' },
      ],
    },
  });
  const limitedView = limitedRun.result.structuredContent as Record<string, any>;
  assert.equal(limitedView.task_status, 'running');
  const limitedStatus = await callTool(state, 'delegated_task_status', { task_id: limitedView.task_id, refresh: false });
  const limitedStatusView = limitedStatus.result.structuredContent as Record<string, any>;
  assert.equal(limitedStatusView.acceptance_verdict, 'pending');
  assert.equal(limitedStatusView.active_step_posture.length, 2);
  assert.equal(limitedStatusView.active_step_posture[0].worker_status, 'running');
  assert.equal(limitedStatusView.active_step_posture[0].status_liveness, 'active');
  assert.equal(limitedStatusView.active_step_posture[0].runtime, 'codex');
  assert.equal(limitedStatusView.active_step_posture[0].provider, 'openai');
  assert.equal(limitedStatusView.active_step_posture[0].latest_event_kind, 'assistant.delta');
  assert.match(limitedStatusView.active_step_posture[0].latest_event_preview, /heartbeat/);
  assert.equal(limitedStatusView.active_step_posture[0].worker_progress_state.state, 'thinking');
  assert.equal(limitedStatusView.active_step_posture[0].recommended_action, 'wait');
  assert.equal(limitedStatusView.active_step_posture[0].budget_status.event_count, 2);
  assert.equal(limitedStatusView.active_step_posture[0].recent_activity_preview[0].kind, 'model_turn');
  assert.equal(typeof limitedStatusView.active_step_posture[0].heartbeat_age_ms, 'number');
  assert.equal(limitedStatusView.active_step_posture[0].expected_timeout_ms, 600000);
  assert.match(limitedStatusView.active_step_posture[0].deadline_at, /T/);
  const limitedResult = await callTool(state, 'delegated_task_result', { task_id: limitedView.task_id, refresh: false, include_diagnostics: true });
  const limitedResultView = limitedResult.result.structuredContent as Record<string, any>;
  assert.equal(limitedResultView.result.acceptance_verdict, 'pending');
  assert.equal(limitedResultView.result.acceptance_precheck_verdict, 'passed');
  assert.equal(limitedResultView.result.acceptance_status, 'pending_terminal_completion');
  assert.match(limitedResultView.result.summary, /acceptance=pending/);
  assert.doesNotMatch(limitedResultView.result.summary, /acceptance=passed/);
  assert.equal(workerCalls.filter((call) => call.name === 'worker_run').length - beforeConcurrencyCalls, 2);
  const limitedEvents = await callTool(state, 'delegated_task_events', { task_id: limitedView.task_id, limit: 10 });
  const limitedEventsView = limitedEvents.result.structuredContent as Record<string, any>;
  assert.ok(limitedEventsView.last_meaningful_event_by_active_step.a);
  assert.ok(limitedEventsView.last_meaningful_event_by_active_step.b);
  const cancelled = await callTool(state, 'delegated_task_cancel', { task_id: limitedView.task_id, reason: 'caller stopped concurrency test' });
  assert.equal((cancelled.result.structuredContent as Record<string, any>).task_status, 'cancelled');
  const cancelledResult = await callTool(state, 'delegated_task_result', { task_id: limitedView.task_id, include_diagnostics: true });
  const cancelledResultView = cancelledResult.result.structuredContent as Record<string, any>;
  assert.equal(cancelledResultView.result.acceptance_verdict, 'cancelled');
  assert.deepEqual(cancelledResultView.result.progress.running_run_ids, []);
  assert.equal(cancelledResultView.result.progress.running, 0);
  assert.equal(cancelledResultView.result.progress.liveness, 'terminal_no_active_execution');
  assert.deepEqual(cancelledResultView.result.step_states.a.run_ids, [limitedView.progress.running_run_ids[0]]);
  assert.equal(cancelledResultView.result.step_states.a.current_run_id, null);
  assert.deepEqual(cancelledResultView.result.active_step_posture ?? [], []);
  assert.equal(cancelledResultView.result.worker_refs.every((ref: Record<string, any>) => ref.cancellation.requested === true), true);
  const cancelledHistory = await callTool(state, 'delegated_tasks_list', { limit: 50, include_terminal: true });
  const cancelledHistoryView = cancelledHistory.result.structuredContent as Record<string, any>;
  const cancelledRow = cancelledHistoryView.tasks.find((task: Record<string, unknown>) => task.task_id === limitedView.task_id);
  assert.equal(cancelledRow.operator_posture.operator_category, 'operator_inbox_cancelled');
  assert.equal(cancelledRow.operator_posture.next_action, 'acknowledge_cancelled_history');
  assert.deepEqual(cancelledRow.operator_posture.running_run_ids, []);

  const asyncRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise async wait',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'async', kind: 'worker', instruction: 'async worker' }] },
  });
  const asyncTask = asyncRun.result.structuredContent as Record<string, any>;
  assert.equal(asyncTask.task_status, 'running');
  const waited = await callTool(state, 'delegated_task_wait', { task_id: asyncTask.task_id, timeout_ms: 1000, poll_ms: 50 });
  const waitedView = waited.result.structuredContent as Record<string, any>;
  assert.equal(workerCalls.some((call) => call.name === 'worker_run_status'), true);
  assert.equal(waitedView.status, 'finished');
  assert.equal(waitedView.task_status, 'completed', JSON.stringify(waitedView));
  assert.equal(waitedView.progress_delta.to_task_status, 'completed');

  const timeoutRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise async wait timeout progress delta',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'timeout', kind: 'worker', instruction: 'timeout worker' }] },
  });
  const timeoutTask = timeoutRun.result.structuredContent as Record<string, any>;
  assert.equal(timeoutTask.task_status, 'running');
  const timedOut = await callTool(state, 'delegated_task_wait', { task_id: timeoutTask.task_id, timeout_ms: 0, poll_ms: 50 });
  const timedOutView = timedOut.result.structuredContent as Record<string, any>;
  assert.equal(timedOutView.status, 'timeout');
  assert.equal(timedOutView.timeout_diagnostics.progress_delta.to_task_status, 'running');
  assert.equal(timedOutView.timeout_diagnostics.next_action, 'wait_or_refresh_running_workers');
  await callTool(state, 'delegated_task_cancel', { task_id: timeoutTask.task_id, reason: 'caller stopped timeout test' });

  const readOnlyRefreshRunCalls = workerCalls.filter((call) => call.name === 'worker_run').length;
  const readOnlyRefreshStatusCalls = workerCalls.filter((call) => call.name === 'worker_run_status').length;
  const readOnlyRefreshRun = await callTool(state, 'delegated_task_run', {
    objective: 'Refresh running worker without scheduling dependent step',
    constraints: { authority: 'read', cwd: root },
    workflow: {
      steps: [
        { id: 'first', kind: 'worker', instruction: 'async worker read-only refresh first' },
        { id: 'second', kind: 'worker', depends_on: ['first'], instruction: 'second worker should not start from status refresh' },
      ],
    },
  });
  const readOnlyRefreshTask = readOnlyRefreshRun.result.structuredContent as Record<string, any>;
  assert.equal(readOnlyRefreshTask.task_status, 'running');
  assert.equal(workerCalls.filter((call) => call.name === 'worker_run').length - readOnlyRefreshRunCalls, 1);
  const staleStatus = await callTool(state, 'delegated_task_status', { task_id: readOnlyRefreshTask.task_id });
  const staleStatusView = staleStatus.result.structuredContent as Record<string, any>;
  assert.equal(staleStatusView.task_status, 'running');
  assert.equal(workerCalls.filter((call) => call.name === 'worker_run_status').length, readOnlyRefreshStatusCalls);
  const refreshedStatus = await callTool(state, 'delegated_task_status', { task_id: readOnlyRefreshTask.task_id, refresh: true });
  const refreshedStatusView = refreshedStatus.result.structuredContent as Record<string, any>;
  assert.equal(refreshedStatusView.step_status_counts.completed, 1);
  assert.equal(refreshedStatusView.step_status_counts.pending, 1);
  assert.equal(refreshedStatusView.scheduler_state.state, 'ready_pending_steps');
  assert.deepEqual(refreshedStatusView.scheduler_state.ready_step_ids, ['second']);
  assert.equal(refreshedStatusView.operator_posture.next_action, 'advance_ready_steps');
  assert.equal(workerCalls.filter((call) => call.name === 'worker_run').length - readOnlyRefreshRunCalls, 1);
  const refreshedResult = await callTool(state, 'delegated_task_result', { task_id: readOnlyRefreshTask.task_id, refresh: true, include_diagnostics: true });
  const refreshedResultView = refreshedResult.result.structuredContent as Record<string, any>;
  assert.equal(refreshedResultView.result.step_states.first.status, 'completed');
  assert.equal(refreshedResultView.result.step_states.second.status, 'pending');
  assert.equal(workerCalls.filter((call) => call.name === 'worker_run').length - readOnlyRefreshRunCalls, 1);
  const advancedReady = await callTool(state, 'delegated_task_advance', { task_id: readOnlyRefreshTask.task_id });
  const advancedReadyView = advancedReady.result.structuredContent as Record<string, any>;
  assert.equal(workerCalls.filter((call) => call.name === 'worker_run').length - readOnlyRefreshRunCalls, 2);
  assert.equal(advancedReadyView.task_status, 'completed');
  assert.deepEqual(advancedReadyView.scheduler_state.ready_step_ids, []);

  const retryRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise retry repair',
    constraints: { authority: 'write', cwd: root, max_retries: 1 },
    workflow: { steps: [{ id: 'repair', kind: 'repair', instruction: 'fail once then repair' }] },
    execution: { wait_for_completion: true, max_retries: 1 },
  });
  const retryView = retryRun.result.structuredContent as Record<string, any>;
  assert.equal(retryView.task_status, 'completed');
  const retryResult = await callTool(state, 'delegated_task_result', { task_id: retryView.task_id, include_diagnostics: true });
  const retryResultView = retryResult.result.structuredContent as Record<string, any>;
  assert.equal(retryResultView.result.step_states.repair.attempts, 2);

  const blocked = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise blocked dependency',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'downstream', kind: 'worker', depends_on: ['missing'], instruction: 'Should block' }] },
    execution: { wait_for_completion: true },
  });
  const blockedError = blocked.error as Record<string, any>;
  assert.equal(blockedError.data.code, 'delegated_task_validation_failed');

  const beforeMappedWorkerCalls = workerCalls.length;
  const mappedWorkerRun = await callTool(state, 'delegated_task_run', {
    objective: 'Map delegated task worker convenience constraints',
    constraints: { authority: 'read', cwd: root, site_root: siteRoot, runtime: 'narada-agent-runtime-server', model: 'test-model', sandbox: 'read-only', skip_git_repo_check: true, max_concurrency: 1 },
    workflow: { steps: [{ id: 'mapped-worker', kind: 'research', instruction: 'Inspect mapped worker args' }] },
    execution: { wait_for_completion: true, resumable: false, max_concurrency: 1 },
  });
  assert.equal((mappedWorkerRun.result.structuredContent as Record<string, any>).task_status, 'completed');
  const mappedWorkerCall = workerCalls.slice(beforeMappedWorkerCalls).find((call) => call.name === 'worker_run');
  assert.ok(mappedWorkerCall);
  const mappedConstraints = mappedWorkerCall.args.constraints as Record<string, any>;
  assert.equal(mappedConstraints.runtime, undefined);
  assert.equal(mappedConstraints.model, undefined);
  assert.equal(mappedConstraints.sandbox, undefined);
  assert.equal(mappedConstraints.skip_git_repo_check, undefined);
  assert.equal(mappedConstraints.max_concurrency, undefined);
  assert.equal(mappedConstraints.site_root, siteRoot);
  assert.deepEqual(mappedConstraints.overrides, { runtime: 'narada-agent-runtime-server', model: 'test-model', sandbox: 'read-only', skip_git_repo_check: true });

  const launchFailureRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise worker launch failure diagnostics',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'launch-failure', kind: 'research', instruction: 'launch failure worker' }] },
    execution: { wait_for_completion: true },
  });
  const launchFailureView = launchFailureRun.result.structuredContent as Record<string, any>;
  assert.equal(launchFailureView.task_status, 'failed');
  const launchFailureResult = await callTool(state, 'delegated_task_result', { task_id: launchFailureView.task_id, include_diagnostics: true });
  const launchFailureResultView = launchFailureResult.result.structuredContent as Record<string, any>;
  assert.equal(launchFailureResultView.result.worker_launch_failure_count, 1);
  assert.equal(launchFailureResultView.result.worker_launch_failures[0].step_id, 'launch-failure');
  assert.match(launchFailureResultView.result.worker_launch_failures[0].message, /worker launch denied/);
  assert.equal(launchFailureResultView.result.observed_incoherencies.some((item: string) => item.includes('worker_launch_failed:launch-failure')), true);

  const missing = await callTool(state, 'delegated_task_status', { task_id: 'task_missing' });
  const missingError = missing.error as Record<string, any>;
  assert.equal(missingError.data.code, 'delegated_task_not_found');
  assert.match(missingError.message, /delegated_task_not_found/);

  console.log('delegated-task-mcp behavior ok');
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
