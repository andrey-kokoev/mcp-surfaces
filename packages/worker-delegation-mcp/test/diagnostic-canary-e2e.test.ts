import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asRecord,
  createTemporaryE2eRoot,
  readMcpOutputText,
  removeTemporaryE2eRoot,
  spawnJsonlMcpServer,
  structured,
  type JsonlMcpClient,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';
import {
  diagnosticError,
  observeChild,
  writeDiagnosticAttempt,
  type DiagnosticAttempt,
  type DiagnosticStage,
} from './diagnostic-evidence.js';

const TEST_ID = 'worker-delegation-diagnostic-canary';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resultPath = join(packageRoot, '.tmp', 'e2e-results', `${TEST_ID}.json`);
const attemptId = `${TEST_ID}-${process.pid}-${Date.now()}`;
const startedAt = new Date().toISOString();

type PhaseResult = {
  status: 'passed' | 'failed';
  started_at: string;
  finished_at?: string;
  error?: { message: string; stack: string | null };
};

let root: string | null = null;
let client: JsonlMcpClient | null = null;
let worker: ReturnType<typeof spawnJsonlMcpServer>['child'] | null = null;
let childSnapshot: (() => Record<string, unknown>) | null = null;
let runRecord: JsonRecord | null = null;
let runDir: string | null = null;
let currentStage: DiagnosticStage = 'preflight';
let cleanupStatus: string = 'unverified';

const attempt: DiagnosticAttempt = {
  schema: 'narada.worker.e2e.attempt.v1',
  result_schema: 'narada.mcp.e2e.result.v1',
  test_id: TEST_ID,
  attempt_id: attemptId,
  mode: 'deterministic_direct_stdio',
  provider_boundary: 'controlled_runtime_fixture',
  status: 'failed',
  stage: currentStage,
  failure_stage: null,
  started_at: startedAt,
  phases: {},
  request: {
    operation: 'worker_run',
    mode: 'plan_only',
    authority: 'read',
    wait_for_completion: true,
    wait_timeout_ms: 5_000,
    edits_allowed: false,
    git_operations_allowed: false,
  },
};

function persist(): void {
  attempt.stage = currentStage;
  if (childSnapshot) attempt.child = childSnapshot();
  writeDiagnosticAttempt(resultPath, attempt);
}

async function phase<T>(name: DiagnosticStage, operation: () => Promise<T>): Promise<T> {
  currentStage = name;
  attempt.stage = name;
  const phaseRecord: PhaseResult = { status: 'failed', started_at: new Date().toISOString() };
  (attempt.phases as Record<string, PhaseResult>)[name] = phaseRecord;
  persist();
  try {
    const value = await operation();
    phaseRecord.status = 'passed';
    phaseRecord.finished_at = new Date().toISOString();
    persist();
    return value;
  } catch (error) {
    phaseRecord.error = diagnosticError(error);
    phaseRecord.finished_at = new Date().toISOString();
    attempt.failure_stage = name;
    attempt.error = phaseRecord.error;
    persist();
    throw error;
  }
}

function createDeterministicRuntime(path: string): void {
  writeFileSync(path, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const lastMessagePath = outputIndex >= 0 ? args[outputIndex + 1] : null;
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  if (lastMessagePath) {
    fs.writeFileSync(lastMessagePath, JSON.stringify({
      summary: 'deterministic diagnostic canary completed',
      deliverables: [],
      open_questions: [],
      next_actions: [],
      edits_performed: false,
      target_state_changed: false,
      changes: [],
      verification: [{
        tool: 'deterministic-runtime-fixture',
        command: null,
        status: 'passed',
        summary: prompt.includes('Do not edit') ? 'read-only guard observed' : 'prompt received',
        command_classification: 'not_applicable'
      }],
      verification_budget_respected: true,
      broad_unrelated_failures: [],
      exit_interview: null
    }));
  }
  process.stdout.write(JSON.stringify({ thread_id: 'diagnostic-canary-thread' }) + '\\n');
});
`, 'utf8');
}

async function main(): Promise<void> {
  try {
    root = createTemporaryE2eRoot(TEST_ID);
    const runRoot = join(root, '.ai', 'runtime', 'worker-delegation');
    const auditLogDir = join(root, '.ai', 'runtime', 'worker-audit');
    const runtimePath = join(root, 'deterministic-runtime.cjs');
    const workerServerPath = fileURLToPath(new URL('../src/main.js', import.meta.url));

    await phase('preflight', async () => {
      mkdirSync(join(root!, '.narada'), { recursive: true });
      createDeterministicRuntime(runtimePath);
      const missing = [workerServerPath, runtimePath].find((path) => !existsSync(path));
      assert.equal(missing, undefined, `built prerequisite missing: ${missing ?? 'unknown'}`);
      attempt.site_root = root;
      attempt.server = {
        entrypoint: workerServerPath,
        runtime: 'codex',
        runtime_command: process.execPath,
        runtime_script: runtimePath,
      };
    });

    const spawned = await phase('mcp_initialize', async () => {
      const handle = spawnJsonlMcpServer(process.execPath, [
        workerServerPath,
        '--site-root', root!,
        '--allowed-root', root!,
        '--run-root', runRoot,
        '--audit-log-dir', auditLogDir,
        '--default-runtime', 'codex',
        '--codex-command', process.execPath,
        '--codex-command-arg', runtimePath,
      ], {
        cwd: root!,
        env: {
          ...process.env,
          NARADA_PROVIDER_SECRET_STORE: 'disabled',
          NARADA_SITE_ROOT: root!,
          NARADA_WORKSPACE_ROOT: root!,
        },
        timeoutMs: 20_000,
        label: TEST_ID,
      });
      worker = handle.child;
      childSnapshot = observeChild(worker);
      client = handle.client;
      const response = await client.request(1, 'initialize', { protocolVersion: '2024-11-05' });
      assert.equal(response.error, undefined, JSON.stringify(response));
      const initialize = asRecord(response.result);
      assert.equal(asRecord(initialize.serverInfo).name, 'worker-delegation-mcp');
      attempt.mcp_initialize = {
        protocol_version: initialize.protocolVersion,
        server_name: asRecord(initialize.serverInfo).name,
      };
      return handle;
    });

    await phase('tools_list', async () => {
      const response = await client!.request(2, 'tools/list', {});
      assert.equal(response.error, undefined, JSON.stringify(response));
      const tools = asRecord(response.result);
      const toolNames = Array.isArray(tools.tools)
        ? tools.tools.map((tool) => String(asRecord(tool).name))
        : [];
      for (const requiredTool of ['worker_run', 'worker_run_wait', 'worker_output_show']) {
        assert.equal(toolNames.includes(requiredTool), true, `missing required tool: ${requiredTool}`);
      }
      attempt.tools_list = { tool_count: toolNames.length, required_tools: ['worker_run', 'worker_run_wait', 'worker_output_show'] };
    });

    await phase('worker_admission', async () => {
      const response = await client!.request(3, 'tools/call', {
        name: 'worker_run',
        arguments: {
          intent: {
            instruction: 'Read the bounded canary context and return the worker output contract. Do not edit files or invoke tools.',
            mode: 'plan_only',
          },
          constraints: {
            authority: 'read',
            cognition: 'low',
            cwd: root,
            site_root: root,
            wait_for_completion: true,
            wait_timeout_ms: 5_000,
            overrides: {
              runtime: 'codex',
              model: 'deterministic-canary',
              reasoning_effort: 'low',
              skip_git_repo_check: true,
            },
          },
        },
      });
      const firstPage = structured(response);
      attempt.worker_response = {
        schema: firstPage.schema,
        status: firstPage.status,
        output_ref: firstPage.output_ref ?? firstPage.ref ?? null,
      };

      if (firstPage.schema === 'narada.producer_output_page.v1') {
        const outputRef = String(firstPage.output_ref ?? firstPage.ref ?? '');
        assert.ok(outputRef, JSON.stringify(firstPage));
        const output = await readMcpOutputText(firstPage, async ({ offset, limit, pageNumber }) => {
          const page = structured(await client!.request(100 + pageNumber, 'tools/call', {
            name: 'worker_output_show',
            arguments: { ref: outputRef, offset, limit },
          }));
          return page;
        });
        runRecord = JSON.parse(output.text) as JsonRecord;
        attempt.output_readback = { output_ref: outputRef, pages: output.pages, text_chars: output.text.length };
      } else {
        runRecord = firstPage;
        attempt.output_readback = { inline: true };
      }
      runDir = typeof runRecord.run_dir === 'string' ? runRecord.run_dir : null;
      attempt.run = {
        run_id: runRecord.run_id ?? null,
        run_dir: runDir,
        schema: runRecord.schema ?? null,
        status: runRecord.status ?? null,
      };
    });

    await phase('runtime_session', async () => {
      assert.ok(runRecord, 'worker result was not materialized');
      assert.equal(runRecord.schema, 'narada.worker.run.v1', JSON.stringify(runRecord));
      assert.equal(runRecord.status, 'completed', JSON.stringify(runRecord));
      assert.equal(typeof runRecord.run_id, 'string');
      assert.equal(typeof runDir, 'string');
      assert.equal(existsSync(runDir!), true, `run directory missing: ${runDir}`);
      attempt.implementation_identity = asRecord(asRecord(runRecord.resolved_worker_config).implementation_identity);
    });

    await phase('terminal_event', async () => {
      assert.ok(runDir);
      const eventsPath = join(runDir!, 'events.jsonl');
      assert.equal(existsSync(eventsPath), true, `events artifact missing: ${eventsPath}`);
      const events = readFileSync(eventsPath, 'utf8');
      assert.match(events, /diagnostic-canary-thread/);
      attempt.terminal_event = { events_path: eventsPath, bytes: Buffer.byteLength(events, 'utf8'), observed: true };
    });

    await phase('output_contract', async () => {
      assert.ok(runRecord);
      assert.equal(typeof runRecord.summary, 'string', JSON.stringify(runRecord));
      assert.equal(runRecord.edits_performed, false);
      assert.equal(runRecord.target_state_changed, false);
      attempt.output_contract = {
        summary: runRecord.summary,
        edits_performed: runRecord.edits_performed,
        target_state_changed: runRecord.target_state_changed,
        worker_output_state: runRecord.worker_output_state ?? null,
      };
    });

    await phase('persistence', async () => {
      assert.ok(runDir);
      const requiredArtifacts = ['request.json', 'resolved_worker_config.json', 'events.jsonl', 'last_message.json', 'result.json'];
      const found = Object.fromEntries(requiredArtifacts.map((name) => [name, existsSync(join(runDir!, name))]));
      for (const [name, present] of Object.entries(found)) assert.equal(present, true, `missing run artifact: ${name}`);
      attempt.persistence = { run_dir: runDir, required_artifacts: found };
    });

    attempt.status = 'passed';
    attempt.stage = 'cleanup';
    currentStage = 'cleanup';
    attempt.pass_gate = {
      direct_stdio_mcp: true,
      read_only_canary: true,
      terminal_event: true,
      output_contract: true,
      durable_run_artifacts: true,
      external_provider: 'not_run',
    };
  } catch (error) {
    attempt.status = 'failed';
    attempt.stage = currentStage;
    attempt.failure_stage ??= currentStage;
    attempt.error ??= diagnosticError(error);
    process.exitCode = 1;
  } finally {
    currentStage = 'cleanup';
    attempt.stage = 'cleanup';
    let cleanupError: { message: string; stack: string | null } | null = null;
    try {
      if (client) await client.close();
    } catch (error) {
      cleanupError = diagnosticError(error);
    }
    if (worker && worker.exitCode === null) {
      try {
        worker.kill();
      } catch (error) {
        cleanupError ??= diagnosticError(error);
      }
    }
    if (cleanupError) {
      attempt.cleanup_error = cleanupError;
      if (attempt.status === 'passed') {
        attempt.status = 'failed';
        attempt.failure_stage = 'cleanup';
        attempt.error = cleanupError;
        process.exitCode = 1;
      }
    }

    const shouldPreserveFailureRoot = attempt.status === 'failed' && root !== null;
    if (shouldPreserveFailureRoot) {
      cleanupStatus = 'preserved_for_diagnostics';
      attempt.cleanup = { status: cleanupStatus, retained_root: root };
    } else if (root !== null && removeTemporaryE2eRoot(root)) {
      cleanupStatus = 'completed_after_finally';
      attempt.cleanup = { status: cleanupStatus };
    } else {
      cleanupStatus = 'failed';
      attempt.cleanup = { status: cleanupStatus };
      if (attempt.status === 'passed') {
        attempt.status = 'failed';
        attempt.failure_stage = 'cleanup';
        attempt.error = { message: 'temporary root cleanup failed', stack: null };
        process.exitCode = 1;
      }
    }

    attempt.finished_at = new Date().toISOString();
    attempt.child = childSnapshot ? childSnapshot() : null;
    persist();
    console.log(JSON.stringify({
      schema: attempt.schema,
      test_id: TEST_ID,
      attempt_id: attemptId,
      status: attempt.status,
      failure_stage: attempt.failure_stage,
      result_path: resultPath,
      cleanup: attempt.cleanup,
    }));
  }
}

void main().catch((error) => {
  attempt.status = 'failed';
  attempt.failure_stage ??= currentStage;
  attempt.error ??= diagnosticError(error);
  process.exitCode = 1;
  persist();
});
