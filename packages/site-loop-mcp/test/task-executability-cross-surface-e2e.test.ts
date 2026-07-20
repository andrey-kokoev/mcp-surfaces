import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createTemporaryE2eRoot,
  readMcpOutputText,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  structured,
  type JsonlMcpClient,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';
import { createServerState, handleRequest } from '@narada2/delegated-task-mcp';
import {
  admitTaskExecutabilityAssessment,
  assembleDeclaredEnvironment,
  declaredEnvironmentDigest,
  enqueueTaskExecutabilityRequest,
  recordTaskExecutabilityFailure,
  taskSpecDigest,
} from '@narada2/task-governance-core/task-executability-service';
import {
  TASK_EXECUTABILITY_ASSESSMENT_SCHEMA,
  TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA,
  TASK_EXECUTABILITY_FINDING_SCHEMA,
  type TaskExecutabilityAssessment,
} from '@narada2/task-governance-core/task-executability-contract';
import {
  openTaskLifecycleStore,
  SqliteTaskLifecycleStore,
  type TaskExecutabilityRequestRow,
  type TaskSpecRow,
} from '@narada2/task-governance-core/task-lifecycle-store';
import {
  TaskExecutabilityOrchestrator,
  type DelegatedTaskInvocation,
  type DelegatedTaskPort,
  type DelegatedTaskResult,
  type TaskExecutabilityRequest,
  type TaskLifecyclePort,
} from '@narada2/task-executability-orchestrator';
import { runTaskExecutabilityReconciliation } from '../src/site-loop/task-executability-reconciliation.js';

type AnyRecord = Record<string, any>;

const siteRoot = createTemporaryE2eRoot('site-loop-task-executability-cross-surface-e2e');
const originalSiteId = process.env.NARADA_SITE_ID;
process.env.NARADA_SITE_ID = 'fixture-site';

mkdirSync(join(siteRoot, '.narada'), { recursive: true });
mkdirSync(join(siteRoot, '.ai', 'agents'), { recursive: true });
writeFileSync(join(siteRoot, '.narada', 'task-lifecycle.toml'), '[roster]\nroles_are_obligation_targets = true\n', 'utf8');
writeFileSync(join(siteRoot, '.ai', 'task-executability-policy.json'), JSON.stringify({
  schema: 'narada.task_executability_policy.v1',
  enforcement: 'strict',
  evaluator_profile: 'shoshin-v1',
}), 'utf8');
writeFileSync(join(siteRoot, '.ai', 'agents', 'roster.json'), JSON.stringify({
  schema: 'narada.agent_roster.v1',
  agents: [{ agent_id: 'fixture.builder', role: 'builder', status: 'active', capabilities: [] }],
}, null, 2), 'utf8');

const lifecycleServerPath = resolve(process.cwd(), '../task-lifecycle-mcp/dist/src/task-lifecycle/task-mcp-server.js');
let lifecycleServer: ReturnType<typeof spawnJsonlMcpServer> | null = null;

function taskServer(): ReturnType<typeof spawnJsonlMcpServer> {
  return spawnJsonlMcpServer(process.execPath, [lifecycleServerPath, '--site-root', siteRoot], {
    cwd: siteRoot,
    env: siteFabricChildEnv(siteRoot, { NARADA_AGENT_ID: 'fixture.builder', NARADA_SITE_ID: 'fixture-site' }),
    label: 'task-executability cross-surface lifecycle',
  });
}

function closeStore(store: SqliteTaskLifecycleStore): void {
  try {
    store.db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    store.db.close();
  }
}

async function openLifecycleServer(): Promise<ReturnType<typeof spawnJsonlMcpServer>> {
  const server = taskServer();
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'narada-task-lifecycle-mcp',
    requiredTools: [
      'mcp_payload_create',
      'task_lifecycle_create',
      'task_lifecycle_executability_status',
    ],
  });
  lifecycleServer = server;
  return server;
}

async function closeLifecycleServer(): Promise<void> {
  if (!lifecycleServer) return;
  await lifecycleServer.close();
  lifecycleServer = null;
}

async function toolJson(client: JsonlMcpClient, id: number, name: string, args: JsonRecord): Promise<JsonRecord> {
  const first = structured(await client.request(id, 'tools/call', { name, arguments: args }));
  if (typeof first.output_ref !== 'string') return first;
  const materialized = await readMcpOutputText(
    first,
    async ({ offset, limit, pageNumber }) => structured(await client.request(`${id}-${pageNumber}`, 'tools/call', {
      name: 'mcp_output_show',
      arguments: { ref: first.output_ref, offset, limit },
    })),
    { pageSize: 8_000, maxPages: 8, maxTextChars: 200_000 },
  );
  return JSON.parse(materialized.text) as JsonRecord;
}

async function createTask(client: JsonlMcpClient, id: number, taskKey: string, dangling = false): Promise<{ taskId: string; taskNumber: number }> {
  const payload = await toolJson(client, id, 'mcp_payload_create', {
    payload_id: `task-executability-cross-surface-${taskKey}`,
    payload: {
      title: dangling ? 'Dangling executability fixture' : 'Executable executability fixture',
      goal: dangling ? 'Resolve the review references before dispatch.' : 'Perform the bounded fixture operation.',
      required_work: dangling
        ? ['Resolve numbered review findings 1-8 before execution.']
        : ['Perform the bounded fixture operation without external side effects.'],
      acceptance_criteria: dangling
        ? ['All findings 1-8 have a concrete resolution.']
        : ['The bounded fixture operation is ready for a worker.'],
      target_role: 'builder',
    },
  });
  const payloadRef = String(payload.ref ?? payload.payload_ref ?? '');
  assert.match(payloadRef, /^mcp_payload:/, JSON.stringify(payload));
  const created = await toolJson(client, id + 1, 'task_lifecycle_create', { payload_ref: payloadRef });
  const followUp = created.follow_up as AnyRecord;
  assert.equal(followUp?.schema, 'narada.task.executability.follow_up.v1', JSON.stringify(created));
  const taskNumber = Number(created.task_number);
  const taskId = String(created.task_id ?? followUp.task_id);
  assert.ok(Number.isInteger(taskNumber) && taskNumber > 0, JSON.stringify(created));
  assert.ok(taskId, JSON.stringify(created));
  return { taskId, taskNumber };
}

function jsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function taskPacket(row: TaskExecutabilityRequestRow, spec: TaskSpecRow | undefined): AnyRecord {
  return {
    schema: 'narada.task.executability.packet.v1',
    task_id: row.task_id,
    task_number: row.task_number,
    title: spec?.title ?? null,
    goal: spec?.goal_markdown ?? null,
    context: spec?.context_markdown ?? null,
    required_work: spec?.required_work_markdown ?? null,
    non_goals: spec?.non_goals_markdown ?? null,
    acceptance_criteria: jsonArray(spec?.acceptance_criteria_json),
    dependencies: jsonArray(spec?.dependencies_json),
    source: spec ? 'task_lifecycle.task_specs' : 'task_lifecycle.request_only',
    missing_spec: !spec,
  };
}

function makeLifecyclePort(
  store: SqliteTaskLifecycleStore,
  contexts: Map<string, TaskExecutabilityRequest>,
): TaskLifecyclePort {
  return {
    async leaseNextExecutabilityRequest({ consumer_id, lease_duration_minutes }) {
      const row = store.leaseNextExecutabilityRequest(consumer_id, lease_duration_minutes);
      if (!row) return undefined;
      const spec = store.getTaskSpecByNumber(row.task_number);
      const attempt = store.getLatestExecutabilityAttempt(row.request_id);
      const request = {
        ...row,
        lease_owner: row.lease_owner ?? consumer_id,
        lease_expires_at: row.lease_expires_at ?? new Date(Date.now() + lease_duration_minutes * 60_000).toISOString(),
        task_packet: taskPacket(row, spec),
        environment: assembleDeclaredEnvironment(siteRoot),
        ...(attempt && attempt.state !== 'leased'
          ? {
              latest_attempt: {
                delegated_task_id: attempt.delegated_task_id,
                worker_run_id: attempt.worker_run_id,
                state: attempt.state as 'dispatched' | 'completed' | 'failed_retryable' | 'failed_terminal',
              },
            }
          : {}),
      } satisfies TaskExecutabilityRequest;
      contexts.set(request.request_id, request);
      return request;
    },
    async recordExecutabilityDispatch(args) {
      store.recordExecutabilityDispatch({
        request_id: args.request_id,
        state: args.state,
        delegated_task_id: args.delegated_task_id,
        worker_run_id: args.worker_run_id,
        error_json: args.error ? JSON.stringify(args.error) : null,
      });
    },
    async completeExecutabilityAssessment(args) {
      const current = store.getExecutabilityRequest(args.request_id);
      if (!current || (current.state !== 'leased' && current.state !== 'dispatched')) return { status: 'stale', reason: 'request_not_currently_leased' };
      if (current.lease_owner !== args.lease_owner || !current.lease_expires_at || Date.parse(current.lease_expires_at) <= Date.now()) return { status: 'stale', reason: 'lease_not_owned_or_expired' };
      try {
        admitTaskExecutabilityAssessment({ store, requestId: args.request_id, assessment: args.assessment });
        return { status: 'completed' };
      } catch (error) {
        return { status: 'rejected', reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async failExecutabilityRequest(args) {
      const current = store.getExecutabilityRequest(args.request_id);
      if (!current || current.lease_owner !== args.lease_owner) return;
      recordTaskExecutabilityFailure({ store, requestId: args.request_id, state: args.state, failure: args.failure });
    },
  };
}

function assessmentForInvocation(invocation: DelegatedTaskInvocation, delegatedTaskId: string, workerRunId: string): TaskExecutabilityAssessment {
  const packet = invocation.task_packet as AnyRecord;
  const dangling = String(packet.required_work ?? '').includes('findings 1-8');
  const findings = dangling
    ? [{
        schema: TASK_EXECUTABILITY_FINDING_SCHEMA,
        kind: 'unresolved_reference',
        severity: 'blocking',
        code: 'unresolved_review_reference',
        message: 'Numbered review findings 1-8 are not resolved in the task packet.',
        ref: 'findings-1-8',
      }]
    : [];
  return {
    schema: TASK_EXECUTABILITY_ASSESSMENT_SCHEMA,
    assessment_id: `assessment_fixture_${invocation.task_number}_${invocation.idempotency_key.replace(/[^a-z0-9]+/giu, '_')}`,
    request_id: invocation.idempotency_key.replace(/^task-executability-assessment:/, ''),
    task_id: invocation.task_id,
    task_number: invocation.task_number,
    task_spec_digest: invocation.task_packet && typeof invocation.task_packet === 'object'
      ? String((invocation as AnyRecord).task_spec_digest ?? '')
      : '',
    environment_digest: String((invocation as AnyRecord).environment_digest ?? ''),
    verdict: dangling ? 'needs_revision' : 'executable',
    findings,
    evaluator: {
      schema: TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA,
      profile: invocation.evaluator_profile,
      profile_version: invocation.evaluator_profile_version,
      cognition: 'low',
      provider: 'fixture',
      model: 'fixture-low-cognition',
      delegated_task_id: delegatedTaskId,
      worker_run_id: workerRunId,
    },
    created_at: '2020-01-01T00:00:00.000Z',
    dimensions: [],
  } as unknown as TaskExecutabilityAssessment;
}

function makeDelegatedPort(
  contexts: Map<string, TaskExecutabilityRequest>,
  counters: { runs: number; polls: number },
): DelegatedTaskPort {
  return {
    async run(invocation) {
      counters.runs += 1;
      const delegatedTaskId = `fixture-delegated-${invocation.task_number}`;
      const workerRunId = `fixture-worker-${counters.runs}`;
      return {
        status: 'completed',
        delegated_task_id: delegatedTaskId,
        worker_run_id: workerRunId,
        output: {
          ...assessmentForInvocation(invocation, delegatedTaskId, workerRunId),
          task_spec_digest: contexts.get(invocation.idempotency_key)?.task_spec_digest ?? '',
          environment_digest: contexts.get(invocation.idempotency_key)?.environment_digest ?? '',
        },
      };
    },
    async poll(args) {
      counters.polls += 1;
      const request = contexts.get(args.idempotency_key);
      assert.ok(request, `missing recovery request context for ${args.idempotency_key}`);
      const invocation = {
        idempotency_key: args.idempotency_key,
        task_id: request.task_id,
        task_number: request.task_number,
        task_packet: request.task_packet,
        environment: request.environment,
        evaluator_profile: request.evaluator_profile,
        evaluator_profile_version: request.evaluator_profile_version,
      } as DelegatedTaskInvocation;
      const delegatedTaskId = args.delegated_task_id ?? `fixture-recovered-delegated-${request.task_number}`;
      const workerRunId = args.worker_run_id ?? 'fixture-recovered-worker';
      return {
        status: 'completed',
        delegated_task_id: delegatedTaskId,
        worker_run_id: workerRunId,
        output: {
          ...assessmentForInvocation(invocation, delegatedTaskId, workerRunId),
          task_spec_digest: request.task_spec_digest,
          environment_digest: request.environment_digest,
        },
      };
    },
  };
}

function makeOrchestrator(store: SqliteTaskLifecycleStore, consumerId: string, counters: { runs: number; polls: number }) {
  const contexts = new Map<string, TaskExecutabilityRequest>();
  return {
    contexts,
    orchestrator: new TaskExecutabilityOrchestrator(
      makeLifecyclePort(store, contexts),
      makeDelegatedPort(contexts, counters),
      { consumer_id: consumerId, max_attempts: 2, max_run_ms: 1_000 },
    ),
  };
}

async function delegatedDispatchCheck(store: SqliteTaskLifecycleStore, task: { taskId: string; taskNumber: number }): Promise<JsonRecord> {
  const state = createServerState({ taskRoot: siteRoot, siteRoot, outputRoot: siteRoot, allowedRoots: [siteRoot] });
  state.taskLifecycleStore = store;
  const response = await handleRequest({
    jsonrpc: '2.0',
    id: 'task-executability-cross-surface-dispatch',
    method: 'tools/call',
    params: {
      name: 'delegated_task_run',
      arguments: {
        objective: 'Dispatch the current executable fixture.',
        request_id: 'task-executability-cross-surface-dispatch',
        source_task_ref: { kind: 'task_lifecycle', task_id: task.taskId, task_number: task.taskNumber },
        constraints: { authority: 'read', cwd: siteRoot, site_root: siteRoot },
        workflow: { steps: [{ id: 'note', kind: 'note' }] },
        execution: { start: false },
      },
    },
  }, state);
  assert.equal(response?.error, undefined, JSON.stringify(response));
  const ownedStore = ((state as AnyRecord).taskLifecycleStore ?? null) as AnyRecord | null;
  if (ownedStore) closeStore(ownedStore as unknown as SqliteTaskLifecycleStore);
  return ((response?.result as AnyRecord)?.structuredContent ?? response?.result ?? {}) as JsonRecord;
}

try {
  const firstServer = await openLifecycleServer();
  const executableTask = await createTask(firstServer.client, 10, 'executable');
  const danglingTask = await createTask(firstServer.client, 20, 'dangling', true);
  const pendingExecutable = await toolJson(firstServer.client, 30, 'task_lifecycle_executability_status', { task_number: executableTask.taskNumber });
  assert.equal((pendingExecutable.request as AnyRecord).state, 'pending', JSON.stringify(pendingExecutable));
  await closeLifecycleServer();

  let store = openTaskLifecycleStore(siteRoot);
  const initialCounters = { runs: 0, polls: 0 };
  const initial = makeOrchestrator(store, 'site-loop-initial', initialCounters);
  const initialResult = await runTaskExecutabilityReconciliation(siteRoot, {
    orchestrator: initial.orchestrator,
    limit: 2,
  } as unknown as JsonRecord);
  assert.equal(initialResult.status, 'ok', JSON.stringify(initialResult));
  assert.equal((initialResult.counts as AnyRecord).completed, 2, JSON.stringify(initialResult));
  assert.equal(initialCounters.runs, 2);

  const executableSpec = store.getTaskSpec(executableTask.taskId);
  assert.ok(executableSpec);
  const oldRequest = store.listExecutabilityRequestsForTask(executableTask.taskId, 10)[0];
  assert.equal(oldRequest.state, 'completed');
  store.upsertTaskSpec({
    ...executableSpec,
    goal_markdown: `${executableSpec.goal_markdown} Changed after assessment.`,
    updated_at: new Date().toISOString(),
  });
  const changedSpec = store.getTaskSpec(executableTask.taskId)!;
  const changedEnvironment = assembleDeclaredEnvironment(siteRoot);
  const changedRequest = enqueueTaskExecutabilityRequest({
    store,
    siteRoot,
    taskId: executableTask.taskId,
    taskNumber: executableTask.taskNumber,
    spec: {
      title: changedSpec.title,
      goal: changedSpec.goal_markdown,
      context: changedSpec.context_markdown,
      required_work: changedSpec.required_work_markdown,
      non_goals: changedSpec.non_goals_markdown,
      acceptance_criteria: jsonArray(changedSpec.acceptance_criteria_json) as string[],
      dependencies: jsonArray(changedSpec.dependencies_json).map(Number),
    },
    environment: changedEnvironment,
  });
  assert.notEqual(changedRequest.request_id, oldRequest.request_id);
  assert.equal(store.getExecutabilityRequest(oldRequest.request_id)?.superseded_by_request_id, changedRequest.request_id);
  closeStore(store);

  const secondServer = await openLifecycleServer();
  const raceTask = await createTask(secondServer.client, 40, 'race');
  const restartTask = await createTask(secondServer.client, 50, 'restart');
  await closeLifecycleServer();

  store = openTaskLifecycleStore(siteRoot);
  const staleCounters = { runs: 0, polls: 0 };
  const stale = makeOrchestrator(store, 'site-loop-stale', staleCounters);
  const staleResult = await runTaskExecutabilityReconciliation(siteRoot, { orchestrator: stale.orchestrator, limit: 1 } as unknown as JsonRecord);
  assert.equal(staleResult.status, 'ok', JSON.stringify(staleResult));
  assert.equal((staleResult.counts as AnyRecord).completed, 1, JSON.stringify(staleResult));

  const concurrentCounters = { runs: 0, polls: 0 };
  const concurrentA = makeOrchestrator(store, 'site-loop-race-a', concurrentCounters);
  const concurrentB = makeOrchestrator(store, 'site-loop-race-b', concurrentCounters);
  const [raceA, raceB] = await Promise.all([
    concurrentA.orchestrator.reconcileAll(1),
    concurrentB.orchestrator.reconcileAll(1),
  ]);
  assert.equal(concurrentCounters.runs, 1, JSON.stringify({ raceA, raceB }));
  assert.equal([raceA.results[0].outcome, raceB.results[0].outcome].filter((value) => value === 'completed').length, 1);
  assert.equal([raceA.results[0].outcome, raceB.results[0].outcome].filter((value) => value === 'idle').length, 1);

  const crashed = store.listExecutabilityRequestsForTask(restartTask.taskId, 10)[0];
  const leased = store.leaseExecutabilityRequest(crashed.request_id, 'crashed-site-loop', 10);
  assert.ok(leased);
  store.recordExecutabilityDispatch({
    request_id: crashed.request_id,
    state: 'dispatched',
    delegated_task_id: 'fixture-crashed-delegated',
    worker_run_id: 'fixture-crashed-worker',
  });
  store.db.prepare('update task_executability_requests set state = ?, lease_expires_at = ?, updated_at = ? where request_id = ?')
    .run('dispatched', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', crashed.request_id);
  closeStore(store);

  store = openTaskLifecycleStore(siteRoot);
  const recoveryCounters = { runs: 0, polls: 0 };
  const recovery = makeOrchestrator(store, 'site-loop-restarted', recoveryCounters);
  const recovered = await recovery.orchestrator.reconcileAll(1);
  assert.equal(recovered.results[0].outcome, 'completed', JSON.stringify(recovered));
  assert.equal(recoveryCounters.runs, 0);
  assert.equal(recoveryCounters.polls, 1);

  const dispatch = await delegatedDispatchCheck(store, executableTask);
  assert.equal((dispatch.task_executability_dispatch as AnyRecord).decision, 'allow', JSON.stringify(dispatch));
  assert.equal((dispatch.task_executability_dispatch as AnyRecord).basis, 'assessment', JSON.stringify(dispatch));
  closeStore(store);

  const finalServer = await openLifecycleServer();
  const finalExecutable = await toolJson(finalServer.client, 60, 'task_lifecycle_executability_status', { task_number: executableTask.taskNumber });
  const finalDangling = await toolJson(finalServer.client, 70, 'task_lifecycle_executability_status', { task_number: danglingTask.taskNumber });
  assert.equal(finalExecutable.currency, 'current', JSON.stringify(finalExecutable));
  assert.equal(finalExecutable.verdict, 'executable', JSON.stringify(finalExecutable));
  assert.equal(finalDangling.currency, 'current', JSON.stringify(finalDangling));
  assert.equal(finalDangling.verdict, 'needs_revision', JSON.stringify(finalDangling));
  assert.ok((finalDangling.findings as AnyRecord[]).some((finding) => finding.ref === 'findings-1-8'), JSON.stringify(finalDangling));
  await closeLifecycleServer();

  console.log(JSON.stringify({
    schema: 'narada.task_executability.cross_surface_e2e.v1',
    status: 'passed',
    deterministic: true,
    no_nars_creation_recovered_by_site_loop: true,
    restart_recovered_via_persisted_worker_identity: true,
    concurrent_execution_count: 1,
    dangling_reference_verdict: 'needs_revision',
    enforced_dispatch_basis: 'assessment',
  }));
} finally {
  await closeLifecycleServer();
  if (originalSiteId === undefined) delete process.env.NARADA_SITE_ID;
  else process.env.NARADA_SITE_ID = originalSiteId;
  const removed = removeTemporaryE2eRoot(siteRoot);
  if (!removed) {
    console.error(JSON.stringify({
      schema: 'narada.task_executability.cross_surface_e2e.cleanup_failure.v1',
      site_root: siteRoot,
      ai_entries: readdirSync(join(siteRoot, '.ai'), { withFileTypes: true }).map((entry) => entry.name),
    }));
  }
  assert.equal(removed, true);
}

