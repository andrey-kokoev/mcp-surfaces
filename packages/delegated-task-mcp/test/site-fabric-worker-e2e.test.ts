import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;
type RpcResponse = { id?: number | string; result?: JsonRecord; error?: JsonRecord };
type JsonlClient = {
  request: (id: number, method: string, params: JsonRecord) => Promise<RpcResponse>;
  close: () => Promise<void>;
};

const TEST_ID = 'delegated-task-site-fabric-worker-e2e';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resultPath = join(packageRoot, '.tmp', 'e2e-results', `${TEST_ID}.json`);
const startedAt = new Date().toISOString();

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `${TEST_ID}-`));
  const taskRoot = join(root, '.ai', 'delegated-tasks');
  const outputRoot = join(root, '.ai', 'output');
  const runRoot = join(root, '.ai', 'runtime', 'worker-delegation');
  const targetPath = join(root, 'delegated-task-target.txt');
  const runtimeEvidencePath = join(root, '.ai', 'runtime', 'fixture-evidence.json');
  const fixturePath = join(root, '.ai', 'runtime', 'controlled-worker-runtime.cjs');
  const policyPath = join(root, '.narada', 'worker-policy.toml');
  const providerRegistryPath = join(root, 'packages', 'carrier-provider-contract', 'contracts', 'provider-registry.json');
  const delegatedTaskServerPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const loaderServerPath = fileURLToPath(new URL('../../../mcp-loader-mcp/dist/src/main.js', import.meta.url));
  const fabricPath = join(root, '.ai', 'mcp', 'config.json');
  let loaderClient: JsonlClient | null = null;
  let loaderConnectionId: string | null = null;
  let status: 'passed' | 'failed' | 'not_run' = 'failed';
  let cleanupStatus: 'passed' | 'failed' = 'passed';
  let failureReason: string | null = null;
  let taskId: string | null = null;
  let workerRunId: string | null = null;
  let runtimeEvidence: JsonRecord | null = null;

  try {
    const missingPrerequisite = [delegatedTaskServerPath, loaderServerPath].find((path) => !existsSync(path));
    if (missingPrerequisite) {
      status = 'not_run';
      failureReason = `built prerequisite missing: ${missingPrerequisite}`;
      process.exitCode = 2;
      return;
    }

    mkdirSync(join(root, '.narada'), { recursive: true });
    mkdirSync(join(root, '.ai', 'mcp'), { recursive: true });
    mkdirSync(dirname(providerRegistryPath), { recursive: true });
    mkdirSync(dirname(runtimeEvidencePath), { recursive: true });
    writeFileSync(targetPath, 'fixture-data\n', 'utf8');
    writeFileSync(providerRegistryPath, JSON.stringify({
      schema: 'narada.provider.registry.fixture.v1',
      default_provider: 'codex-subscription',
      providers: {
        'codex-subscription': {
          base_url: 'https://provider-fixture.invalid',
          default_model: 'fixture-low-model',
          default_thinking: 'low',
          available_models: ['fixture-low-model'],
          cognition_defaults: {
            low: { model: 'fixture-low-model', reasoning_effort: 'low' },
            medium: { model: 'fixture-low-model', reasoning_effort: 'medium' },
            high: { model: 'fixture-low-model', reasoning_effort: 'high' },
          },
          credential_requirement: { kind: 'none' },
          base_url_env_names: [],
          model_env_names: ['CODEX_MODEL'],
        },
      },
    }, null, 2), 'utf8');
    writeFileSync(fixturePath, [
      "const { readFileSync, writeFileSync } = require('node:fs');",
      `const TARGET_PATH = ${JSON.stringify(targetPath)};`,
      `const EVIDENCE_PATH = ${JSON.stringify(runtimeEvidencePath)};`,
      "let buffer = '';",
      "let handled = false;",
      "process.stdin.setEncoding('utf8');",
      "process.stdout.write(JSON.stringify({ event: 'session_started', session_id: 'delegated-task-site-fabric-worker', agent_id: 'worker.fixture', mcp_operational_state: 'healthy' }) + '\\n');",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  const lines = buffer.split(/\\r?\\n/);",
      "  buffer = lines.pop() || '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue;",
      "    const frame = JSON.parse(line);",
      "    if (frame.method === 'session.submit' && !handled) {",
      "      handled = true;",
      "      handleSubmit(frame).catch((error) => process.stdout.write(JSON.stringify({ event: 'turn_failed', request_id: frame.id, turn_id: 'turn-failed', error: error instanceof Error ? error.message : String(error) }) + '\\n'));",
      "    }",
      "    if (frame.method === 'session.close') process.exit(0);",
      "  }",
      "});",
      "function emit(frame, output) {",
      "  process.stdout.write(JSON.stringify({ event: 'turn_started', request_id: frame.id, turn_id: 'turn-complete' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ event: 'assistant_message', request_id: frame.id, turn_id: 'turn-complete', content: JSON.stringify(output) }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ event: 'turn_complete', request_id: frame.id, turn_id: 'turn-complete', terminal_state: 'completed', delegated_mutation_admitted: false, carrier_mutation_admitted: false }) + '\\n');",
      "}",
      "async function handleSubmit(frame) {",
      "  const content = String(frame.params && frame.params.content || '');",
      "  if (!content.includes('E2E_DELEGATED_TASK_TARGET=')) throw new Error('delegated task prompt marker missing');",
      "  const target = readFileSync(TARGET_PATH, 'utf8').trim();",
      "  writeFileSync(EVIDENCE_PATH, JSON.stringify({ site_root: process.env.NARADA_SITE_ROOT || null, workspace_root: process.env.NARADA_WORKSPACE_ROOT || null, provider: process.env.NARADA_INTELLIGENCE_PROVIDER || null, model: process.env.NARADA_AI_MODEL || null, thinking: process.env.NARADA_AI_THINKING || null, target }, null, 2));",
      "  emit(frame, { summary: 'delegated task worker runtime completed', deliverables: [], open_questions: [], next_actions: [], edits_performed: false, target_state_changed: false, changes: [], verification: [{ tool: 'controlled-worker-runtime', command: null, status: 'passed', summary: 'read target=' + target, command_classification: 'not_applicable' }], verification_budget_respected: true, broad_unrelated_failures: [], exit_interview: null, review_verdict: 'accepted', acceptance_verdict: 'passed', completion_state: 'complete' });",
      "}",
    ].join('\n'), 'utf8');
    writeFileSync(policyPath, [
      '[worker]',
      'default_runtime = "narada-agent-runtime-server"',
      'default_authority = "read"',
      'default_cognition = "low"',
      `run_root = "${tomlPath(runRoot)}"`,
      '',
      '[worker.policy]',
      'allowed_runtimes = ["narada-agent-runtime-server"]',
      'allowed_authorities = ["read"]',
      'allowed_sandboxes = ["read-only"]',
      'max_run_ms = 30000',
      'max_output_bytes = 200000',
      '',
      '[worker.runtimes.narada_agent_runtime_server]',
      `command = "${tomlPath(process.execPath)}"`,
      `command_args = ["${tomlPath(fixturePath)}"]`,
      'default_sandbox = "read-only"',
      'ephemeral = true',
      'json_events = true',
    ].join('\n'), 'utf8');

    const delegatedArgs = [
      delegatedTaskServerPath,
      '--task-root', taskRoot,
      '--output-root', outputRoot,
      '--site-root', root,
      '--allowed-root', root,
      '--worker-policy-config', policyPath,
    ];
    writeFileSync(fabricPath, JSON.stringify({
      schema: 'narada.mcp.fabric.fixture.v1',
      site_id: 'delegated-task-e2e-site',
      generated_by: TEST_ID,
      mcpServers: {
        'delegated-task': {
          command: 'node',
          args: delegatedArgs,
          tools: ['delegated_task_policy_inspect', 'delegated_task_run', 'delegated_task_result', 'delegated_task_status', 'delegated_task_events'],
        },
      },
    }, null, 2), 'utf8');

    const loader = spawn(process.execPath, [loaderServerPath, '--allowed-site-root', root], {
      cwd: root,
      env: { ...process.env, NARADA_PROVIDER_SECRET_STORE: 'disabled' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    loaderClient = createJsonlClient(loader);
    const initialize = await loaderClient.request(1, 'initialize', { protocolVersion: '2024-11-05' });
    assert.equal(initialize.error, undefined, JSON.stringify(initialize));

    const surfaces = structured(await loaderClient.request(2, 'tools/call', {
      name: 'mcp_loader_list_site_surfaces',
      arguments: { site_root: root },
    }));
    assert.equal(surfaces.schema, 'narada.mcp_loader.site_surfaces.v1');
    assert.equal((surfaces.surfaces as JsonRecord[]).some((surface) => surface.surface_id === 'delegated-task'), true);

    const diagnostics = structured(await loaderClient.request(3, 'tools/call', {
      name: 'mcp_loader_site_fabric_diagnostics',
      arguments: { site_root: root },
    }));
    const delegatedDiagnostic = (diagnostics.diagnostics as JsonRecord[]).find((entry) => entry.surface_id === 'delegated-task');
    assert.equal(delegatedDiagnostic?.entrypoint_exists, true);

    const attached = structured(await loaderClient.request(4, 'tools/call', {
      name: 'mcp_loader_attach_surface',
      arguments: { site_root: root, surface_id: 'delegated-task' },
    }));
    assert.equal(attached.schema, 'narada.mcp_loader.surface_attached.v1');
    assert.equal(attached.entrypoint, canonicalPath(delegatedTaskServerPath), JSON.stringify(attached));
    const attachedArgs = Array.isArray(attached.args) ? attached.args.map(String) : [];
    assert.equal(attachedArgs.includes('--worker-policy-config'), true, JSON.stringify(attached));
    const policyArgIndex = attachedArgs.indexOf('--worker-policy-config');
    assert.equal(canonicalPath(attachedArgs[policyArgIndex + 1] ?? ''), canonicalPath(policyPath), JSON.stringify(attached));
    loaderConnectionId = String(attached.connection_id);

    const attachedTools = structured(await loaderClient.request(5, 'tools/call', {
      name: 'mcp_loader_list_tools',
      arguments: { connection_id: loaderConnectionId },
    }));
    const toolNames = (attachedTools.tools as JsonRecord[]).map((tool) => tool.name);
    for (const requiredTool of ['delegated_task_policy_inspect', 'delegated_task_run', 'delegated_task_result', 'delegated_task_events']) assert.equal(toolNames.includes(requiredTool), true, `missing ${requiredTool}`);

    const policyResult = await callAttached(loaderClient, loaderConnectionId, 7, 'delegated_task_policy_inspect', {});
    const policyView = asRecord(policyResult.structuredContent ?? policyResult);
    const workerPolicy = asRecord(policyView.worker_policy);
    assert.equal(workerPolicy.default_runtime, 'narada-agent-runtime-server', JSON.stringify(workerPolicy));
    const runtimePolicy = asRecord(asRecord(workerPolicy.runtimes)['narada-agent-runtime-server']);
    assert.equal(canonicalPath(String(runtimePolicy.command ?? '')), canonicalPath(process.execPath), JSON.stringify(runtimePolicy));

    const refusal = await loaderClient.request(8, 'tools/call', {
      name: 'mcp_loader_attach_surface',
      arguments: { site_root: root, surface_id: 'not-admitted' },
    });
    assert.ok(refusal.error, 'undeclared surface must be refused by loader admission');

    const runResult = await callAttached(loaderClient, loaderConnectionId, 9, 'delegated_task_run', {
      objective: 'Run one controlled delegated worker task through the Site fabric.',
      intent: { instruction: 'Read the bounded target and report the observed value.', mode: 'implement_and_verify' },
      constraints: {
        authority: 'read',
        cwd: root,
        site_root: root,
        provider: 'codex-subscription',
        cognition: 'low',
        wait_for_completion: true,
        overrides: { runtime: 'narada-agent-runtime-server' },
        preflight_paths: [{ path: targetPath, access: 'read', label: 'controlled target' }],
      },
      workflow: {
        steps: [{ id: 'read-target', kind: 'review', instruction: `Read the target. E2E_DELEGATED_TASK_TARGET=${targetPath}` }],
      },
      acceptance: { review_quorum: { min_passed: 1, max_failed: 0 } },
      execution: { wait_for_completion: true, timeout_ms: 30000, poll_ms: 100 },
      result_policy: { include_diagnostics_by_default: true },
      idempotency_key: 'delegated-task-site-fabric-worker-e2e-run',
    });
    const runView = asRecord(runResult.structuredContent ?? runResult);
    if (runView.task_status !== 'completed') {
      const failedResult = await callAttached(loaderClient, loaderConnectionId, 80, 'delegated_task_result', { task_id: String(runView.task_id), include_diagnostics: true });
      throw new Error(`delegated task failed: ${JSON.stringify(failedResult.structuredContent ?? failedResult)}`);
    }
    taskId = String(runView.task_id);
    const workerRefs = Array.isArray(runView.worker_refs) ? runView.worker_refs.map(asRecord) : [];
    assert.equal(workerRefs.length, 1, JSON.stringify(runView));
    workerRunId = String(workerRefs[0].run_id);
    const runDir = String(workerRefs[0].run_dir);
    assert.match(workerRunId, /^run-/);
    assert.equal(pathInside(runDir, root), true);
    assert.equal(existsSync(join(runDir, 'last_message.json')), true);
    assert.equal(existsSync(join(runDir, 'events.jsonl')), true);
    const workerLastMessage = JSON.parse(readFileSync(join(runDir, 'last_message.json'), 'utf8')) as JsonRecord;
    assert.equal(workerLastMessage.review_verdict, 'accepted', JSON.stringify(workerLastMessage));
    assert.equal(workerLastMessage.acceptance_verdict, 'passed', JSON.stringify(workerLastMessage));

    const taskResult = await callAttached(loaderClient, loaderConnectionId, 10, 'delegated_task_result', { task_id: taskId, include_diagnostics: true });
    const taskResultView = asRecord(taskResult.structuredContent ?? taskResult);
    const durableResult = asRecord(taskResultView.result);
    assert.equal(durableResult.acceptance_verdict, 'passed', JSON.stringify(taskResultView));
    assert.equal(Array.isArray(durableResult.worker_refs), true);

    const taskEvents = await callAttached(loaderClient, loaderConnectionId, 11, 'delegated_task_events', { task_id: taskId, limit: 50, offset: 0 });
    const taskEventsView = asRecord(taskEvents.structuredContent ?? taskEvents);
    assert.equal(Array.isArray(taskEventsView.events), true);
    assert.ok((taskEventsView.events as unknown[]).length >= 2);

    const taskPath = join(taskRoot, 'tasks', taskId, 'task.json');
    const eventsPath = join(taskRoot, 'tasks', taskId, 'events.jsonl');
    assert.equal(existsSync(taskPath), true);
    assert.equal(existsSync(eventsPath), true);
    const durableTask = JSON.parse(readFileSync(taskPath, 'utf8')) as JsonRecord;
    assert.equal(durableTask.status, 'completed');
    assert.equal(readFileSync(eventsPath, 'utf8').trim().length > 0, true);
    assert.equal(existsSync(runtimeEvidencePath), true);
    runtimeEvidence = JSON.parse(readFileSync(runtimeEvidencePath, 'utf8')) as JsonRecord;
    assert.equal(runtimeEvidence.site_root, root);
    assert.equal(runtimeEvidence.workspace_root, root);
    assert.equal(runtimeEvidence.provider, 'codex-subscription');
    assert.equal(runtimeEvidence.model, 'fixture-low-model');
    assert.equal(runtimeEvidence.thinking, 'low');
    assert.equal(runtimeEvidence.target, 'fixture-data');
    status = 'passed';
    console.log(JSON.stringify({ schema: 'narada.mcp.e2e.result.v1', test_id: TEST_ID, status, site_fabric_admission: delegatedDiagnostic?.classification ?? null, task_id: taskId, worker_run_id: workerRunId, durable_task_verified: true, runtime_binding_verified: true }));
  } catch (error) {
    failureReason = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    if (loaderClient && loaderConnectionId) {
      try {
        await loaderClient.request(90, 'tools/call', { name: 'mcp_loader_detach', arguments: { connection_id: loaderConnectionId } });
      } catch {
        cleanupStatus = 'failed';
      }
    }
    if (loaderClient) {
      try {
        await loaderClient.close();
      } catch {
        cleanupStatus = 'failed';
      }
    }
    if (!removeRoot(root)) cleanupStatus = 'failed';
    if (cleanupStatus === 'failed') {
      status = 'failed';
      failureReason ??= 'cleanup_failed';
      process.exitCode = 1;
    }
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({
      schema: 'narada.mcp.e2e.result.v1',
      test_id: TEST_ID,
      status,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      site_root: root,
      site_fabric: { path: fabricPath, admission: status === 'passed' ? 'declared_and_attached' : 'not_verified' },
      operation: { delegated_task_child: true, worker_runtime_child: true, durable_task_state: taskId !== null, output_artifacts: workerRunId !== null },
      task_id: taskId,
      worker_run_id: workerRunId,
      runtime_evidence: runtimeEvidence,
      cleanup: { status: cleanupStatus, loader_connection_detached: loaderConnectionId !== null && cleanupStatus === 'passed' },
      failure_reason: failureReason,
    }, null, 2), 'utf8');
  }
}

async function callAttached(client: JsonlClient, connectionId: string, id: number, toolName: string, args: JsonRecord): Promise<JsonRecord> {
  const response = await client.request(id, 'tools/call', {
    name: 'mcp_loader_call_tool',
    arguments: { connection_id: connectionId, tool_name: toolName, arguments: args },
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  const envelope = structured(response);
  assert.equal(envelope.schema, 'narada.mcp_loader.tool_result.v1');
  const result = asRecord(envelope.result);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result;
}

function structured(response: RpcResponse): JsonRecord {
  return asRecord(asRecord(response.result).structuredContent ?? response.result);
}

function createJsonlClient(child: ChildProcessWithoutNullStreams): JsonlClient {
  let buffer = '';
  const pending = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as RpcResponse;
      const entry = message.id === undefined ? undefined : pending.get(String(message.id));
      if (!entry) continue;
      pending.delete(String(message.id));
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  });
  const rejectAll = (error: Error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  };
  child.on('error', rejectAll);
  child.on('close', (code) => {
    if (code !== 0) rejectAll(new Error(`mcp-loader child exited with code ${code}`));
  });
  return {
    request(id, method, params) {
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          pending.delete(String(id));
          reject(new Error(`timed out waiting for mcp-loader response ${id}`));
        }, 30000);
        pending.set(String(id), { resolve: resolvePromise, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async close() {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      if (child.exitCode !== null) return;
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => { try { child.kill(); } catch { /* best effort */ } resolvePromise(); }, 3000);
        child.once('close', () => { clearTimeout(timer); resolvePromise(); });
      });
    },
  };
}

function removeRoot(root: string): boolean {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt < 4) continue;
    }
  }
  return false;
}

function pathInside(candidate: string, root: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value === '' || !value.startsWith('..');
}

function canonicalPath(value: string): string {
  return resolve(value).replaceAll('\\', '/');
}

function tomlPath(path: string): string {
  return path.replaceAll('\\', '/').replaceAll('"', '\\"');
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

void main().catch(() => { process.exitCode = 1; });
