import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;
type RpcResponse = { id?: number | string; result?: JsonRecord; error?: JsonRecord };
type JsonlClient = {
  request: (id: number, method: string, params: JsonRecord) => Promise<RpcResponse>;
  close: () => Promise<void>;
};

const TEST_ID = 'worker-delegation-real-carrier-e2e';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const naradaRoot = resolve(process.env.NARADA_E2E_NARADA_ROOT ?? 'D:/code/narada');
const resultPath = join(packageRoot, '.tmp', 'e2e-results', `${TEST_ID}.json`);
const startedAt = new Date().toISOString();

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `${TEST_ID}-`));
  const runRoot = join(root, '.ai', 'runtime', 'worker-delegation');
  const auditLogDir = join(root, '.ai', 'runtime', 'worker-audit');
  const policyPath = join(root, '.narada', 'worker-policy.toml');
  const mcpFixturePath = join(root, '.ai', 'mcp', 'narada-carrier-fixture.cjs');
  const workerServerPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const runtimeServerPath = process.env.NARADA_E2E_RUNTIME_SERVER_ENTRYPOINT
    ?? join(naradaRoot, 'packages', 'agent-runtime-server', 'bin', 'narada-agent-runtime-server.mjs');
  let worker: ChildProcessWithoutNullStreams | null = null;
  let client: JsonlClient | null = null;
  let provider: ProviderFixture | null = null;
  let status: 'passed' | 'failed' | 'not_run' = 'failed';
  let failureReason: string | null = null;
  let runId: string | null = null;
  let runDir: string | null = null;
  let cleanupStatus: 'passed' | 'failed' = 'passed';

  try {
    const missing = [workerServerPath, runtimeServerPath].find((path) => !existsSync(path));
    if (missing) {
      status = 'not_run';
      failureReason = `built prerequisite missing: ${missing}`;
      process.exitCode = 2;
      return;
    }

    mkdirSync(join(root, '.narada'), { recursive: true });
    mkdirSync(join(root, '.ai', 'mcp'), { recursive: true });
    writeFileSync(mcpFixturePath, [
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  const lines = buffer.split(/\\r?\\n/);",
      "  buffer = lines.pop() || '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue;",
      "    const request = JSON.parse(line);",
      "    if (request.method === 'initialize') reply(request, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'carrier-fixture', version: '1.0.0' } });",
      "    if (request.method === 'tools/list') reply(request, { tools: [] });",
      "    if (request.method === 'tools/call') reply(request, { content: [{ type: 'text', text: 'ok' }] });",
      "  }",
      "});",
      "function reply(request, result) { if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n'); }",
    ].join('\n'), 'utf8');
    writeFileSync(join(root, '.ai', 'mcp', 'narada-carrier-fixture.json'), JSON.stringify({
      mcpServers: {
        'narada-carrier-fixture': { command: process.execPath, args: [mcpFixturePath] },
      },
    }), 'utf8');
    writeFileSync(policyPath, [
      '[worker]',
      'default_runtime = "narada-agent-runtime-server"',
      'default_authority = "read"',
      'default_cognition = "low"',
      `run_root = "${tomlPath(runRoot)}"`,
      `audit_log_dir = "${tomlPath(auditLogDir)}"`,
      '',
      '[worker.policy]',
      'allowed_runtimes = ["narada-agent-runtime-server"]',
      'allowed_authorities = ["read"]',
      'allowed_sandboxes = ["read-only"]',
      'max_run_ms = 45000',
      'max_output_bytes = 200000',
      '',
      '[worker.runtimes.narada_agent_runtime_server]',
      `command = "${tomlPath(process.execPath)}"`,
      `command_args = ["${tomlPath(runtimeServerPath)}"]`,
      'default_sandbox = "read-only"',
      'ephemeral = true',
      'json_events = true',
    ].join('\n'), 'utf8');

    provider = await startProviderFixture();
    worker = spawn(process.execPath, [
      workerServerPath,
      '--site-root', root,
      '--allowed-root', root,
      '--run-root', runRoot,
      '--audit-log-dir', auditLogDir,
      '--default-runtime', 'narada-agent-runtime-server',
      '--agent-runtime-server-command', process.execPath,
      '--agent-runtime-server-command-arg', runtimeServerPath,
    ], {
      cwd: root,
      env: {
        ...process.env,
        NARADA_PROVIDER_SECRET_STORE: 'disabled',
        NARADA_SITE_ROOT: root,
        NARADA_WORKSPACE_ROOT: root,
        NARADA_INTELLIGENCE_PROVIDER: 'kimi-code-api',
        NARADA_AI_API_KEY: 'real-carrier-e2e-fixture-key',
        NARADA_AI_BASE_URL: provider.baseUrl,
        NARADA_AI_MODEL: 'real-carrier-e2e-fixture-model',
        NARADA_AI_THINKING: 'low',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    client = createJsonlClient(worker, 60000);

    const initialized = await client.request(1, 'initialize', { protocolVersion: '2024-11-05' });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));
    const response = await client.request(2, 'tools/call', {
      name: 'worker_run',
      arguments: {
        intent: {
          instruction: 'Read the bounded test context and return the required worker output contract. Do not edit files.',
          mode: 'plan_only',
        },
        constraints: {
          authority: 'read',
          cognition: 'low',
          cwd: root,
          site_root: root,
          provider: 'kimi-code-api',
          wait_for_completion: true,
          overrides: {
            runtime: 'narada-agent-runtime-server',
            model: 'real-carrier-e2e-fixture-model',
            reasoning_effort: 'low',
          },
        },
      },
    });
    assert.equal(response.error, undefined, JSON.stringify(response));
    const firstPage = structured(response);
    let run = firstPage;
    if (firstPage.schema === 'narada.producer_output_page.v1') {
      const outputRef = String(firstPage.output_ref ?? '');
      assert.ok(outputRef, JSON.stringify(firstPage));
      let outputText = String(firstPage.output_text ?? '');
      let nextOffset = firstPage.next_offset === null || firstPage.next_offset === undefined ? null : Number(firstPage.next_offset);
      for (let pageNumber = 0; nextOffset !== null; pageNumber += 1) {
        assert.equal(pageNumber < 8, true, 'worker output pagination exceeded the bounded page count');
        const page = structured(await client.request(10 + pageNumber, 'tools/call', {
          name: 'worker_output_show',
          arguments: { ref: outputRef, offset: nextOffset, limit: 20000 },
        }));
        assert.equal(['narada.producer_output_page.v1', 'narada.mcp_output_page.v1'].includes(String(page.schema)), true, JSON.stringify(page));
        outputText += String(page.output_text ?? '');
        nextOffset = page.next_offset === null || page.next_offset === undefined ? null : Number(page.next_offset);
      }
      run = JSON.parse(outputText) as JsonRecord;
    }
    assert.equal(run.schema, 'narada.worker.run.v1', JSON.stringify(run));
    assert.equal(run.status, 'completed', JSON.stringify(run));
    runId = String(run.run_id);
    runDir = String(run.run_dir);
    assert.match(runId, /^run-/);
    assert.equal(existsSync(join(runDir, 'events.jsonl')), true);
    assert.equal(existsSync(join(runDir, 'last_message.json')), true);
    const lastMessage = JSON.parse(readFileSync(join(runDir, 'last_message.json'), 'utf8')) as JsonRecord;
    assert.equal(lastMessage.review_verdict, 'accepted', JSON.stringify(lastMessage));
    assert.equal(lastMessage.acceptance_verdict, 'passed', JSON.stringify(lastMessage));
    assert.equal(provider.requests.length >= 1, true, 'real carrier did not call the provider boundary');
    assert.equal(provider.requests.every((request) => request.model === 'real-carrier-e2e-fixture-model'), true, JSON.stringify(provider.requests));
    const runtimeEvents = readJsonl(join(runDir, 'events.jsonl'));
    assert.equal(runtimeEvents.some((event) => event.event === 'session_started'), true, JSON.stringify(runtimeEvents));
    assert.equal(runtimeEvents.some((event) => event.event === 'turn_complete' || event.event === 'carrier_turn_completed'), true, JSON.stringify(runtimeEvents));
    status = 'passed';
    console.log(JSON.stringify({
      schema: 'narada.mcp.e2e.result.v1',
      test_id: TEST_ID,
      status,
      carrier: 'narada-agent-runtime-server',
      provider_boundary: 'controlled_http_fixture',
      run_id: runId,
      run_dir: runDir,
      provider_request_count: provider.requests.length,
      durable_artifacts_verified: true,
    }));
  } catch (error) {
    failureReason = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        cleanupStatus = 'failed';
      }
    }
    if (worker && worker.exitCode === null) {
      try { worker.kill(); } catch { cleanupStatus = 'failed'; }
    }
    if (provider) {
      try { await provider.close(); } catch { cleanupStatus = 'failed'; }
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
      carrier: 'narada-agent-runtime-server',
      provider_boundary: 'controlled_http_fixture',
      run_id: runId,
      run_dir: runDir,
      cleanup: { status: cleanupStatus },
      failure_reason: failureReason,
    }, null, 2), 'utf8');
  }
}

type ProviderFixture = {
  baseUrl: string;
  requests: JsonRecord[];
  close: () => Promise<void>;
};

async function startProviderFixture(): Promise<ProviderFixture> {
  const requests: JsonRecord[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const body = JSON.parse(await readRequestBody(request)) as JsonRecord;
    requests.push(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: `real-carrier-e2e-${requests.length}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'real-carrier-e2e-fixture-model',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            summary: 'real Narada carrier completed the delegated worker turn',
            deliverables: [],
            open_questions: [],
            next_actions: [],
            edits_performed: false,
            target_state_changed: false,
            changes: [],
            verification: [{ tool: 'real-carrier-e2e-provider', command: null, status: 'passed', summary: 'provider boundary returned a valid worker contract', command_classification: 'not_applicable' }],
            verification_budget_respected: true,
            broad_unrelated_failures: [],
            exit_interview: null,
            review_verdict: 'accepted',
            acceptance_verdict: 'passed',
            completion_state: 'complete',
          }),
        },
      }],
    }));
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('real_carrier_e2e_provider_address_missing');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

function readRequestBody(request: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function createJsonlClient(child: ChildProcessWithoutNullStreams, timeoutMs: number): JsonlClient {
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
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  };
  child.on('error', rejectAll);
  child.on('close', (code) => {
    if (code !== 0) rejectAll(new Error(`worker delegation child exited with code ${code}`));
  });
  return {
    request(id, method, params) {
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          pending.delete(String(id));
          reject(new Error(`timed out waiting for worker delegation response ${id}`));
        }, timeoutMs);
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

function structured(response: RpcResponse): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = asRecord(response.result);
  return asRecord(result.structuredContent ?? result);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function readJsonl(path: string): JsonRecord[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as JsonRecord);
}

function tomlPath(path: string): string {
  return path.replaceAll('\\', '/').replaceAll('"', '\\"');
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

await main();
