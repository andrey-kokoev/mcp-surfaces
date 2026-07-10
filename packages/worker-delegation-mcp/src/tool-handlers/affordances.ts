import {
  affordanceToolAction,
  createAffordanceDocument,
  validateAffordanceDocument,
  type AffordanceAction,
  type AffordancePanel,
  type AffordanceRef,
} from '@narada2/mcp-affordances';
import type { WorkerMcpState } from '../state.js';

export function workerOperatorAffordances(state: WorkerMcpState): Record<string, unknown> {
  const actions: AffordanceAction[] = [
    affordanceToolAction({
      id: 'refresh_dashboard',
      label: 'Refresh dashboard',
      intent: 'refresh',
      tool: 'worker_dashboard_describe',
      arguments: { mode: 'all_active', include_terminal: false, limit: 25 },
      description: 'Refresh active worker run topology, compact statuses, progress, and pending joins.',
      audience: ['operator', 'agent'],
      danger_level: 'none',
      read_only: true,
      idempotent: true,
    }),
    affordanceToolAction({
      id: 'list_runs',
      label: 'List runs',
      intent: 'inspect',
      tool: 'worker_runs_list',
      arguments: { include_running: true, include_completed: true, verbose: false, limit: 50 },
      description: 'List recent worker runs so outstanding run ids can be rediscovered.',
      audience: ['operator', 'agent'],
      danger_level: 'none',
      read_only: true,
      idempotent: true,
    }),
    affordanceToolAction({
      id: 'show_run',
      label: 'Show run',
      intent: 'inspect',
      tool: 'worker_run_status',
      description: 'Inspect one worker run by run id.',
      audience: ['operator', 'agent'],
      danger_level: 'none',
      read_only: true,
      idempotent: true,
      input_schema: {
        type: 'object',
        required: ['run_id'],
        properties: { run_id: { type: 'string' } },
      },
    }),
    affordanceToolAction({
      id: 'wait_run',
      label: 'Wait for run',
      intent: 'inspect',
      tool: 'worker_run_wait',
      description: 'Wait briefly for one worker run to finish, then return latest status.',
      audience: ['operator', 'agent'],
      danger_level: 'low',
      read_only: true,
      idempotent: false,
      input_schema: {
        type: 'object',
        required: ['run_id'],
        properties: {
          run_id: { type: 'string' },
          timeout_ms: { type: 'integer', minimum: 0, maximum: 300000 },
          summary_only: { type: 'boolean' },
        },
      },
    }),
    affordanceToolAction({
      id: 'synthesize_runs',
      label: 'Synthesize runs',
      intent: 'inspect',
      tool: 'worker_runs_synthesize',
      description: 'Return normalized cross-worker synthesis for completed or running worker ids.',
      audience: ['operator', 'agent'],
      danger_level: 'none',
      read_only: true,
      idempotent: true,
      input_schema: {
        type: 'object',
        required: ['run_ids'],
        properties: { run_ids: { type: 'array', items: { type: 'string' } } },
      },
    }),
    affordanceToolAction({
      id: 'start_read_worker',
      label: 'Start read worker',
      intent: 'run',
      tool: 'worker_run',
      description: 'Start one bounded read-authority worker run.',
      audience: ['operator', 'agent'],
      danger_level: 'low',
      read_only: false,
      idempotent: false,
      confirmation: { required: true, message: 'Start a delegated read worker run.' },
      input_schema: workerRunInputSchema('read'),
    }),
    affordanceToolAction({
      id: 'start_write_worker',
      label: 'Start write worker',
      intent: 'run',
      tool: 'worker_run',
      description: 'Start one bounded write-authority worker run.',
      audience: ['operator'],
      danger_level: 'high',
      read_only: false,
      idempotent: false,
      confirmation: { required: true, message: 'Start a delegated write worker run.' },
      input_schema: workerRunInputSchema('write'),
    }),
    affordanceToolAction({
      id: 'edit_worker_shortcut',
      label: 'Edit worker',
      intent: 'run',
      tool: 'worker_edit',
      description: 'Start the edit-capable low-cognition worker shortcut.',
      audience: ['operator'],
      danger_level: 'high',
      read_only: false,
      idempotent: false,
      confirmation: { required: true, message: 'Start an edit-capable worker.' },
      input_schema: {
        type: 'object',
        required: ['cwd', 'instruction'],
        properties: {
          cwd: { type: 'string' },
          instruction: { type: 'string' },
          resumable: { type: 'boolean' },
          wait_for_completion: { type: 'boolean' },
          exit_interview: { type: 'boolean' },
        },
      },
    }),
    affordanceToolAction({
      id: 'resume_worker',
      label: 'Resume worker',
      intent: 'run',
      tool: 'worker_resume',
      description: 'Continue an existing worker session.',
      audience: ['operator', 'agent'],
      danger_level: 'medium',
      read_only: false,
      idempotent: false,
      confirmation: { required: true, message: 'Resume an existing worker session.' },
      input_schema: {
        type: 'object',
        required: ['worker_session_id', 'constraints'],
        properties: {
          worker_session_id: { type: 'string' },
          intent: { type: 'object', additionalProperties: true },
          constraints: { type: 'object', additionalProperties: true },
        },
      },
    }),
    affordanceToolAction({
      id: 'reap_stale_run',
      label: 'Reap stale run',
      intent: 'recover',
      tool: 'worker_run_reap',
      description: 'Abort a managed active worker run when possible, or persist terminal cleanup for a stale orphaned record with evidence.',
      audience: ['operator', 'maintainer'],
      danger_level: 'high',
      read_only: false,
      idempotent: false,
      destructive: true,
      confirmation: { required: true, message: 'Mark a stale worker run record as reaped.' },
      input_schema: {
        type: 'object',
        required: ['run_id', 'reason'],
        properties: {
          run_id: { type: 'string' },
          reason: { type: 'string' },
          force: { type: 'boolean' },
        },
      },
    }),
  ];

  const refs: AffordanceRef[] = [
    {
      id: 'worker_artifacts',
      label: 'Worker artifacts',
      target: { kind: 'resource', uri: 'worker-artifact:*' },
      description: 'Worker run artifacts exposed through resources/list and resources/read.',
    },
  ];

  const panels: AffordancePanel[] = [
    {
      id: 'active_runs',
      title: 'Active Runs',
      kind: 'runs',
      priority: 10,
      actions: ['refresh_dashboard', 'list_runs', 'show_run', 'wait_run'],
      refs: ['worker_artifacts'],
      metrics: [
        { id: 'active_run_count', label: 'Active runs', value: state.activeRunCount, severity: state.activeRunCount > 0 ? 'info' : 'ok' },
        { id: 'max_parallel_runs', label: 'Max parallel', value: state.policy.maxParallelRuns, severity: 'info' },
      ],
    },
    {
      id: 'synthesis',
      title: 'Synthesis',
      kind: 'diagnostics',
      priority: 20,
      actions: ['synthesize_runs'],
    },
    {
      id: 'launch',
      title: 'Launch',
      kind: 'controls',
      priority: 30,
      actions: ['start_read_worker', 'start_write_worker', 'edit_worker_shortcut', 'resume_worker'],
      data: {
        default_authority: state.policy.defaultAuthority,
        default_cognition: state.policy.defaultCognition,
        default_runtime: state.policy.defaultRuntime,
      },
    },
    {
      id: 'recovery',
      title: 'Recovery',
      kind: 'controls',
      priority: 40,
      actions: ['reap_stale_run'],
    },
  ];

  const document = createAffordanceDocument({
    surface_id: 'worker-delegation',
    title: 'Worker delegation operator affordances',
    audience: ['operator', 'agent', 'maintainer'],
    summary: 'UI-neutral affordances for inspecting, launching, resuming, synthesizing, and recovering delegated worker runs.',
    panels,
    actions,
    refs,
    refresh: { mode: 'poll', interval_ms: 5000, actions: ['refresh_dashboard'] },
    source: { tool: 'worker_operator_affordances' },
  });
  const validation = validateAffordanceDocument(document);
  if (validation.status !== 'ok') {
    throw new Error(`worker_operator_affordances_invalid: ${validation.errors.join('; ')}`);
  }
  return document;
}

function workerRunInputSchema(authority: 'read' | 'write'): Record<string, unknown> {
  return {
    type: 'object',
    required: ['intent', 'constraints'],
    properties: {
      intent: {
        type: 'object',
        required: ['instruction'],
        properties: {
          instruction: { type: 'string' },
          mode: { type: 'string', enum: authority === 'read' ? ['audit_only', 'plan_only'] : ['implement', 'implement_and_verify'] },
        },
      },
      constraints: {
        type: 'object',
        required: ['cwd'],
        properties: {
          cwd: { type: 'string' },
          authority: { type: 'string', const: authority },
          cognition: { type: 'string', enum: ['low', 'medium', 'high'] },
          resumable: { type: 'boolean' },
          wait_for_completion: { type: 'boolean' },
          exit_interview: { type: 'boolean' },
        },
      },
    },
  };
}
