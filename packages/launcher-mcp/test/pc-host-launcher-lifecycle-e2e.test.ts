import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createJsonlClient,
  installE2eArtifactRecorder,
  structured,
  type JsonRecord,
  type JsonlMcpClient,
} from '@narada2/mcp-e2e-harness';

const TEST_ID = 'launcher-mcp-pc-host-lifecycle-e2e';
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const MCP_SURFACES_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const NARADA_ROOT = resolve(process.env.NARADA_E2E_NARADA_ROOT ?? 'D:/code/narada');
const CLI_PATH = resolve(process.env.NARADA_E2E_CLI_ENTRYPOINT ?? join(
  NARADA_ROOT,
  'packages',
  'layers',
  'cli',
  'dist',
  'main.js',
));
const NARS_SESSION_SERVER_PATH = join(
  MCP_SURFACES_ROOT,
  'packages',
  'nars-session-mcp',
  'dist',
  'src',
  'main.js',
);
const ARTIFACT_PATH = resolve(process.env.NARADA_E2E_ARTIFACT_PATH ?? join(
  PACKAGE_ROOT,
  '.tmp-tests',
  'e2e-results',
  `${TEST_ID}.json`,
));
const AUTHORITY_ENABLED = process.env.NARADA_E2E_PC_HOST_AUTHORITY === '1'
  || process.argv.includes('--pc-host-authority');
const KEEP_FAILURE_ROOT = process.env.NARADA_E2E_KEEP_FAILURE_ROOT === '1'
  || process.argv.includes('--keep-failure-root');
const TIMEOUT_MS = boundedInteger(process.env.NARADA_E2E_PC_HOST_TIMEOUT_MS, 30_000, 60_000);
const CLOSE_TIMEOUT_MS = boundedInteger(process.env.NARADA_E2E_PC_HOST_CLOSE_TIMEOUT_MS, 5_000, 15_000);
const SITE_ID = 'launcher-pc-host-e2e';
const AGENT_ID = 'launcher-pc-host-e2e.resident';

type ProcessRow = {
  pid: number;
  parent_pid: number;
  name: string;
  executable_path: string | null;
  command_line: string | null;
  window_handle: number;
  window_title: string;
};

type ProcessSnapshot = {
  root_pid: number;
  rows: ProcessRow[];
  raw_output_tail: string;
};

type FixtureEvidence = {
  pid: number;
  ppid: number;
  site_root: string | null;
  launch_session_id: string | null;
  process_ownership: string | null;
  process_role: string | null;
};

type LaunchEvidence = {
  launch_session_id: string;
  launcher_output: string;
  session_id: string;
  session_record: JsonRecord;
  startup_event: JsonRecord;
  launch_result: JsonRecord;
  fixture: FixtureEvidence;
  runtime_pid: number;
  process_snapshot_running: ProcessSnapshot;
  process_snapshot_after_close: ProcessSnapshot;
  runtime_health: JsonRecord;
  provider_request_count: number;
};

type ProviderFixture = {
  base_url: string;
  requests: JsonRecord[];
  close: () => Promise<void>;
};

type SessionMcp = {
  process: ChildProcessWithoutNullStreams;
  client: JsonlMcpClient;
  close: () => Promise<void>;
};

type CapturedProcess = {
  process: ChildProcess;
  output: () => string;
  close: () => Promise<void>;
};

const recorder = installE2eArtifactRecorder(ARTIFACT_PATH, {
  schema: 'narada.launcher_mcp.pc_host_lifecycle_e2e.result.v1',
  test_id: TEST_ID,
  site_id: SITE_ID,
  agent_id: AGENT_ID,
  authority: 'pc_host',
});

let temporarySiteRoot: string | null = null;
let provider: ProviderFixture | null = null;
let sessionMcp: SessionMcp | null = null;
let activeLaunch: Partial<LaunchEvidence> | null = null;
const cleanupFailures: string[] = [];
const launcherProcesses: CapturedProcess[] = [];
const launches: LaunchEvidence[] = [];
let progressStage = 'not_started';

function recordProgress(stage: string, details: JsonRecord = {}): void {
  progressStage = stage;
  if (!temporarySiteRoot) return;
  try {
    const progressPath = join(temporarySiteRoot, '.ai', 'pc-host-lifecycle-progress.json');
    writeFileSync(progressPath, JSON.stringify({
      schema: 'narada.launcher_mcp.pc_host_lifecycle_progress.v1',
      test_id: TEST_ID,
      stage,
      updated_at: new Date().toISOString(),
      ...details,
    }, null, 2), 'utf8');
  } catch {
    // Progress is diagnostic only and must never change the test outcome.
  }
}

await main();

async function main(): Promise<void> {
  let status: 'passed' | 'failed' | 'not_run' = 'failed';
  let failure_reason: string | null = null;
  let exitCode = 1;

  try {
    recordProgress('checking_prerequisites');
    const missingPrerequisite = [CLI_PATH, NARS_SESSION_SERVER_PATH].find((path) => !existsSync(path));
    if (!AUTHORITY_ENABLED) {
      status = 'not_run';
      failure_reason = 'pc_host_authority_opt_in_required:NARADA_E2E_PC_HOST_AUTHORITY=1';
      exitCode = 2;
      return;
    }
    if (process.platform !== 'win32') {
      status = 'not_run';
      failure_reason = `pc_host_requires_windows:${process.platform}`;
      exitCode = 2;
      return;
    }
    if (missingPrerequisite) {
      status = 'not_run';
      failure_reason = `built_prerequisite_missing:${missingPrerequisite}`;
      exitCode = 2;
      return;
    }

    temporarySiteRoot = await createSiteFixture();
    recordProgress('site_fixture_created');
    provider = await startProviderFixture();
    recordProgress('provider_fixture_started');
    sessionMcp = await startSessionMcp(temporarySiteRoot);
    recordProgress('session_mcp_started');

    const first = await launchAndExercise('first');
    launches.push(first);
    await closeAndVerify(first);

    const second = await launchAndExercise('second');
    launches.push(second);
    assert.notEqual(second.session_id, first.session_id, 'restart must create a new NARS session');
    assert.notEqual(second.launch_session_id, first.launch_session_id, 'restart must create a new launch session binding');
    await closeAndVerify(second);

    status = 'passed';
    exitCode = 0;
  } catch (error) {
    failure_reason = error instanceof Error ? error.stack ?? error.message : String(error);
    exitCode = 1;
  } finally {
    const activeLaunchAtFailure = activeLaunch;
    recordProgress('cleanup_started', { active_launch: activeLaunchAtFailure });
    await cleanup();
    progressStage = 'cleanup_completed';
    recorder.finalize({
      status,
      failure_reason,
      launches,
      cleanup: {
        status: cleanupFailures.length === 0 && (temporarySiteRoot === null || !existsSync(temporarySiteRoot)) ? 'passed' : 'failed',
        temporary_site_root_removed: temporarySiteRoot === null || !existsSync(temporarySiteRoot),
        scheduler_entries_created: 0,
        launcher_process_count: launcherProcesses.length,
        failures: cleanupFailures,
      },
      active_launch: activeLaunchAtFailure,
      progress_stage: progressStage,
      launcher_outputs: launcherProcesses.map((launcher) => launcher.output()),
      finished_at: new Date().toISOString(),
    });
    process.exitCode = exitCode;
    process.stdout.write(`${JSON.stringify({
      schema: 'narada.launcher_mcp.pc_host_lifecycle_e2e.result.v1',
      test_id: TEST_ID,
      status,
      authority: 'pc_host',
      artifact_path: ARTIFACT_PATH,
      failure_reason,
      launch_count: launches.length,
    }, null, 2)}\n`);
  }
}

async function createSiteFixture(): Promise<string> {
  const siteRoot = await mkdtemp(join(tmpdir(), `${TEST_ID}-`));
  await mkdir(join(siteRoot, '.narada', 'crew', 'nars-sessions'), { recursive: true });
  await mkdir(join(siteRoot, '.ai', 'mcp'), { recursive: true });

  const fixturePath = join(siteRoot, '.ai', 'pc-host-fixture.cjs');
  const evidencePath = join(siteRoot, '.ai', 'pc-host-fixture-evidence.json');
  writeFileSync(fixturePath, fixtureServerSource(), 'utf8');
  writeFileSync(join(siteRoot, '.ai', 'mcp', 'pc-host-fixture.json'), JSON.stringify({
    mcpServers: {
      'narada-pc-host-fixture': {
        command: process.execPath,
        args: [fixturePath, evidencePath],
        startup_timeout_sec: 10,
        request_timeout_ms: 10_000,
      },
    },
  }, null, 2), 'utf8');
  return siteRoot;
}

function fixtureServerSource(): string {
  return String.raw`const fs = require('node:fs');
const baseEvidencePath = process.argv[2];
const launchSessionId = process.env.NARADA_LAUNCH_SESSION_ID || 'pid-' + process.pid;
const evidenceSuffix = String(launchSessionId).replace(/[^A-Za-z0-9._-]/g, '_');
const evidencePath = baseEvidencePath.replace(/\.json$/i, '-' + evidenceSuffix + '.json');
fs.writeFileSync(evidencePath, JSON.stringify({
  pid: process.pid,
  ppid: process.ppid,
  site_root: process.env.NARADA_SITE_ROOT || null,
  launch_session_id: process.env.NARADA_LAUNCH_SESSION_ID || null,
  process_ownership: process.env.NARADA_PROCESS_OWNERSHIP || null,
  process_role: process.env.NARADA_PROCESS_ROLE || null
}, null, 2));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'pc-host-fixture', version: '1.0.0' }
      } }) + '\n');
    } else if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        tools: [{ name: 'pc_host_fixture_echo', description: 'PC host lifecycle fixture tool', inputSchema: { type: 'object', properties: {} } }]
      } }) + '\n');
    } else if (request.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'pc_host_fixture_ok' }] } }) + '\n');
    }
  }
});
`;
}

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
      id: `pc-host-fixture-${requests.length}`,
      object: 'chat.completion',
      model: String(body.model ?? 'pc-host-fixture-model'),
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'PC_HOST_LAUNCHER_OK' },
      }],
    }));
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('pc_host_provider_address_missing');
  return {
    base_url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function startSessionMcp(siteRoot: string): Promise<SessionMcp> {
  const child = spawn(process.execPath, [NARS_SESSION_SERVER_PATH], {
    cwd: siteRoot,
    env: {
      ...process.env,
      NARADA_SITE_ROOT: siteRoot,
      NARADA_SITE_ID: SITE_ID,
      NARADA_NARS_SESSION_SOURCE_KIND: 'operator',
      NARADA_OPERATOR_ID: AGENT_ID,
      NARADA_NARS_SESSION_REQUEST_TIMEOUT_MS: '15_000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const typedChild = child as ChildProcessWithoutNullStreams;
  const client = createJsonlClient(typedChild, { timeoutMs: 15_000, label: 'pc-host nars-session MCP' });
  const initialized = await client.request(1, 'initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized));
  return {
    process: typedChild,
    client,
    close: async () => {
      try { await client.close(); } finally { await stopProcess(typedChild); }
    },
  };
}

async function launchAndExercise(label: string): Promise<LaunchEvidence> {
  if (!temporarySiteRoot || !provider || !sessionMcp) throw new Error('pc_host_fixture_not_ready');
  const launchSessionId = `pc-host-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  recordProgress(`launch_${label}_starting`, { launch_session_id: launchSessionId });
  activeLaunch = { launch_session_id: launchSessionId };
  const launcher = spawnCaptured(process.execPath, [
    CLI_PATH,
    'operator-surface',
    'runtime',
    'start',
    'agent-web-ui',
    '--site-root', temporarySiteRoot,
    '--target-site-id', SITE_ID,
    '--workspace-root', NARADA_ROOT,
    '--agent', AGENT_ID,
    '--runtime', 'narada-agent-runtime-server',
    '--intelligence-provider', 'kimi-code-api',
    '--mcp-scope', 'local-site',
    '--launch-session-id', launchSessionId,
    '--exec',
    '--format', 'json',
  ], {
    cwd: NARADA_ROOT,
    env: {
      ...process.env,
      NARADA_PROVIDER_SECRET_STORE: 'disabled',
      NARADA_INTELLIGENCE_PROVIDER: 'kimi-code-api',
      NARADA_AI_API_KEY: 'pc-host-fixture-key',
      NARADA_AI_BASE_URL: provider.base_url,
      NARADA_AI_MODEL: 'pc-host-fixture-model',
      NARADA_AI_THINKING: 'low',
      KIMI_CODE_API_KEY: 'pc-host-fixture-key',
      KIMI_CODE_API_BASE_URL: provider.base_url,
      KIMI_CODE_MODEL: 'pc-host-fixture-model',
    },
  });
  launcherProcesses.push(launcher);
  activeLaunch.launcher_output = launcher.output();

  const record = await waitFor(() => findSessionRecord(temporarySiteRoot, AGENT_ID, launchSessionId), `session_record_${label}`);
  recordProgress(`launch_${label}_session_record`, { launch_session_id: launchSessionId, session_id: record.session_id });
  activeLaunch.session_record = record;
  activeLaunch.launcher_output = launcher.output();
  activeLaunch.session_id = String(record.session_id);
  assert.equal(record.runtime_kind, 'narada-agent-runtime-server', JSON.stringify(record));
  assert.equal(record.launch_operator_surface_kind, 'agent-web-ui', JSON.stringify(record));
  assert.match(String(record.event_endpoint), /^ws:\/\/127\.0\.0\.1:\d+\/events$/);
  assert.match(String(record.health_endpoint), /^http:\/\/127\.0\.0\.1:\d+\/health$/);

  const startupEvent = await waitFor(() => readJsonLines(String(record.events_path)).find((event) => event.event === 'session_started'), `startup_event_${label}`);
  assert.equal(startupEvent.mcp_scope, 'local-site', JSON.stringify(startupEvent));
  assert.notEqual(startupEvent.mcp_operational_state, 'disabled', JSON.stringify(startupEvent));

  const launchResult = await waitFor(() => findLaunchResult([temporarySiteRoot as string, NARADA_ROOT], launchSessionId), `launch_result_${label}`);
  recordProgress(`launch_${label}_result`, { launch_session_id: launchSessionId, session_id: record.session_id });
  activeLaunch.launch_result = launchResult;
  const requiredEnvironment = asRecord(launchResult.required_environment);
  assert.equal(requiredEnvironment.NARADA_LAUNCH_SESSION_ID, launchSessionId, JSON.stringify(launchResult));
  assert.equal(requiredEnvironment.NARADA_PROCESS_OWNERSHIP, 'session_owned', JSON.stringify(launchResult));
  assert.equal(requiredEnvironment.NARADA_PROCESS_ROLE, 'runtime_server', JSON.stringify(launchResult));

  const runtimeHealth = await waitFor(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      const response = await fetch(String(record.health_endpoint), { signal: controller.signal });
      if (!response.ok) return false;
      const body = (await response.text()).slice(0, 4_000);
      const value = JSON.parse(body) as unknown;
      return asRecord(value).status ? asRecord(value) : false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }, `runtime_health_${label}`);
  activeLaunch.runtime_health = runtimeHealth;
  recordProgress(`launch_${label}_runtime_ready`, { launch_session_id: launchSessionId, session_id: record.session_id });

  const requestCountBefore = provider.requests.length;
  const delivered = structured(await sessionMcp.client.request(10 + launches.length, 'tools/call', {
    name: 'nars_session_input_deliver',
    arguments: {
      site_id: SITE_ID,
      session_id: record.session_id,
      delivery: 'send',
      idempotency_key: `${TEST_ID}-${label}-input`,
      content: 'Reply with exactly PC_HOST_LAUNCHER_OK. Do not perform any other work.',
    },
  }));
  assert.equal(delivered.status, 'admitted', JSON.stringify(delivered));
  recordProgress(`launch_${label}_input_delivered`, { launch_session_id: launchSessionId, session_id: record.session_id });

  await waitFor(() => provider?.requests.length > requestCountBefore, `provider_turn_${label}`);
  const newRequests = provider.requests.slice(requestCountBefore);
  const inheritedToolNames = newRequests.flatMap((request) => {
    const tools = Array.isArray(request.tools) ? request.tools : [];
    return tools.map((tool) => asRecord(asRecord(tool).function).name).filter((name): name is string => typeof name === 'string');
  });
  assert.equal(inheritedToolNames.includes('pc_host_fixture_echo'), true, JSON.stringify(newRequests));
  await waitFor(() => readJsonLines(String(record.events_path)).some((event) => event.event === 'carrier_turn_completed'), `turn_completed_${label}`);

  const fixtureEvidencePath = fixtureEvidencePathFor(temporarySiteRoot, launchSessionId);
  const fixture = await waitFor(() => readJsonFile(fixtureEvidencePath) as FixtureEvidence | false, `fixture_evidence_${label}`);
  recordProgress(`launch_${label}_fixture_evidence`, { launch_session_id: launchSessionId, fixture_pid: fixture.pid, runtime_pid: fixture.ppid });
  activeLaunch.fixture = fixture;
  assert.equal(fixture.launch_session_id, launchSessionId, JSON.stringify(fixture));
  assert.equal(fixture.process_ownership, 'session_owned', JSON.stringify(fixture));
  assert.equal(fixture.process_role, 'mcp_child', JSON.stringify(fixture));
  assert.equal(fixture.site_root, temporarySiteRoot, JSON.stringify(fixture));
  assert.ok(Number.isInteger(fixture.pid) && fixture.pid > 0, JSON.stringify(fixture));
  assert.ok(Number.isInteger(fixture.ppid) && fixture.ppid > 0, JSON.stringify(fixture));
  activeLaunch.runtime_pid = fixture.ppid;

  const processSnapshot = await waitFor(async () => {
    const snapshot = await captureProcessTree(fixture.ppid);
    return snapshot.rows.some((row) => row.pid === fixture.pid) ? snapshot : false;
  }, `process_tree_${label}`);
  activeLaunch.process_snapshot_running = processSnapshot;
  const runtime = processSnapshot.rows.find((row) => row.pid === fixture.ppid);
  assert.ok(runtime, JSON.stringify(processSnapshot));
  assert.match(String(runtime.command_line), /narada-agent-runtime-server/i, JSON.stringify(runtime));
  assert.equal(processSnapshot.rows.every((row) => row.window_handle === 0), true, JSON.stringify(processSnapshot));
  assert.equal(processSnapshot.rows.every((row) => row.pid === fixture.ppid || processSnapshot.rows.some((parent) => parent.pid === row.parent_pid)), true, JSON.stringify(processSnapshot));
  recordProgress(`launch_${label}_verified`, { launch_session_id: launchSessionId, runtime_pid: fixture.ppid });

  return {
    launch_session_id: launchSessionId,
    launcher_output: launcher.output(),
    session_id: String(record.session_id),
    session_record: record,
    startup_event: startupEvent,
    launch_result: launchResult,
    fixture,
    runtime_pid: fixture.ppid,
    process_snapshot_running: processSnapshot,
    process_snapshot_after_close: { root_pid: fixture.ppid, rows: [], raw_output_tail: '' },
    runtime_health: runtimeHealth,
    provider_request_count: newRequests.length,
  };
}

async function closeAndVerify(launch: LaunchEvidence): Promise<void> {
  const endpoint = String(launch.session_record.event_endpoint);
  recordProgress(`close_${launch.launch_session_id}_starting`, { session_id: launch.session_id, runtime_pid: launch.runtime_pid });
  await closeNarsSession(endpoint);
  await waitFor(() => readJsonLines(String(launch.session_record.events_path)).some((event) => event.event === 'session_closed'), `session_closed_${launch.launch_session_id}`, CLOSE_TIMEOUT_MS);
  const afterClose = await waitFor(async () => {
    const snapshot = await captureProcessTree(launch.runtime_pid);
    return snapshot.rows.length === 0 ? snapshot : false;
  }, `process_tree_teardown_${launch.launch_session_id}`, 10_000);
  launch.process_snapshot_after_close = afterClose;
  recordProgress(`close_${launch.launch_session_id}_verified`, { session_id: launch.session_id, runtime_pid: launch.runtime_pid });
  activeLaunch = null;
}

async function closeNarsSession(eventEndpoint: string): Promise<void> {
  const WebSocketConstructor = (globalThis as unknown as {
    WebSocket?: new (url: string) => {
      addEventListener?: (event: string, listener: () => void) => void;
      on?: (event: string, listener: () => void) => void;
      send: (value: string) => void;
      close: () => void;
    };
  }).WebSocket;
  if (!WebSocketConstructor) throw new Error('pc_host_websocket_unavailable');
  const socket = new WebSocketConstructor(eventEndpoint) as unknown as NodeJS.EventEmitter & {
    send: (value: string) => void;
    close: () => void;
  };
  try {
    const errorPromise = once(socket, 'error').then(([error]) => {
      throw error instanceof Error ? error : new Error(`websocket_error:${String(error)}`);
    });
    await Promise.race([
      once(socket, 'open'),
      errorPromise,
      new Promise((_, rejectPromise) => setTimeout(() => rejectPromise(new Error(`websocket_open_timeout:${CLOSE_TIMEOUT_MS}`)), CLOSE_TIMEOUT_MS)),
    ]);
    socket.send(JSON.stringify({ id: `pc-host-close-${Date.now()}`, method: 'session.close', params: {} }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  } finally {
    socket.close();
  }
}

function fixtureEvidencePathFor(siteRoot: string, launchSessionId: string): string {
  const suffix = launchSessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(siteRoot, '.ai', `pc-host-fixture-evidence-${suffix}.json`);
}

async function captureProcessTree(rootPid: number): Promise<ProcessSnapshot> {
  if (process.platform !== 'win32') return { root_pid: rootPid, rows: [], raw_output_tail: '' };
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$rootPid = ${Math.trunc(rootPid)}`,
    '$all = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parent_pid=[int]$_.ParentProcessId; name=[string]$_.Name; executable_path=[string]$_.ExecutablePath; command_line=([string]$_.CommandLine).Substring(0, [Math]::Min(1000, ([string]$_.CommandLine).Length)) } })',
    '$ids = New-Object System.Collections.Generic.HashSet[int]',
    '$null = $ids.Add($rootPid)',
    '$changed = $true',
    'while ($changed) { $changed = $false; foreach ($row in $all) { if ($ids.Contains($row.parent_pid) -and $ids.Add($row.pid)) { $changed = $true } } }',
    '$selected = @($all | Where-Object { $ids.Contains($_.pid) })',
    '$output = @($selected | ForEach-Object { $handle=0; $title=""; try { $p=Get-Process -Id $_.pid -ErrorAction Stop; $handle=[int64]$p.MainWindowHandle; $title=[string]$p.MainWindowTitle } catch {}; [pscustomobject]@{ pid=$_.pid; parent_pid=$_.parent_pid; name=$_.name; executable_path=$_.executable_path; command_line=$_.command_line; window_handle=$handle; window_title=$title } })',
    '$output | ConvertTo-Json -Compress -Depth 3',
  ].join('; ');
  const result = await runCaptured('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], 10_000, 200_000);
  if (result.exit_code !== 0) throw new Error(`process_snapshot_failed:${result.stderr}`);
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout.trim() || '[]'); } catch (error) {
    throw new Error(`process_snapshot_invalid_json:${error instanceof Error ? error.message : String(error)}:${result.stdout.slice(-2000)}`);
  }
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => asRecord(row)).filter((row) => Number.isInteger(row.pid)).map((row) => ({
    pid: Number(row.pid),
    parent_pid: Number(row.parent_pid),
    name: String(row.name ?? ''),
    executable_path: typeof row.executable_path === 'string' && row.executable_path ? row.executable_path : null,
    command_line: typeof row.command_line === 'string' && row.command_line ? row.command_line : null,
    window_handle: Number(row.window_handle ?? 0),
    window_title: String(row.window_title ?? ''),
  }));
  return { root_pid: rootPid, rows, raw_output_tail: result.stdout.slice(-2000) };
}

async function cleanup(): Promise<void> {
  recordProgress('cleanup_session');
  if (activeLaunch?.session_record?.event_endpoint) {
    try {
      await closeNarsSession(String(activeLaunch.session_record.event_endpoint));
    } catch (error) {
      cleanupFailures.push(`session_close:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (activeLaunch?.runtime_pid && temporarySiteRoot) {
    recordProgress('cleanup_runtime', { runtime_pid: activeLaunch.runtime_pid });
    try {
      await terminateCapturedRuntime(activeLaunch.runtime_pid, temporarySiteRoot);
    } catch (error) {
      cleanupFailures.push(`runtime_terminate:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  activeLaunch = null;
  if (sessionMcp) {
    recordProgress('cleanup_session_mcp');
    try { await sessionMcp.close(); } catch (error) {
      cleanupFailures.push(`session_mcp_close:${error instanceof Error ? error.message : String(error)}`);
    }
    sessionMcp = null;
  }
  for (const launcher of launcherProcesses) {
    recordProgress('cleanup_launcher');
    try { await launcher.close(); } catch (error) {
      cleanupFailures.push(`launcher_close:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (provider) {
    recordProgress('cleanup_provider');
    try { await provider.close(); } catch (error) {
      cleanupFailures.push(`provider_close:${error instanceof Error ? error.message : String(error)}`);
    }
    provider = null;
  }
  if (temporarySiteRoot && !KEEP_FAILURE_ROOT) {
    recordProgress('cleanup_temporary_root');
    try { await rm(temporarySiteRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (error) {
      cleanupFailures.push(`temporary_root_remove:${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function terminateCapturedRuntime(runtimePid: number, siteRoot: string): Promise<void> {
  const snapshot = await captureProcessTree(runtimePid);
  const runtime = snapshot.rows.find((row) => row.pid === runtimePid);
  if (!runtime) return;
  const commandLine = String(runtime.command_line ?? '').toLowerCase();
  if (!commandLine.includes('narada-agent-runtime-server') || !commandLine.includes(siteRoot.toLowerCase())) {
    throw new Error(`refused_unverified_runtime_pid:${runtimePid}`);
  }
  const result = await runCaptured('taskkill.exe', ['/PID', String(runtimePid), '/T', '/F'], 10_000, 20_000);
  if (result.exit_code !== 0) throw new Error(`taskkill_failed:${result.stderr || result.stdout}`);
  await waitFor(async () => (await captureProcessTree(runtimePid)).rows.length === 0, `forced_runtime_teardown_${runtimePid}`, 10_000);
}

function findSessionRecord(siteRoot: string, agentId: string, launchSessionId: string): JsonRecord | false {
  for (const sessionsRoot of [join(siteRoot, '.narada', 'crew', 'nars-sessions'), join(siteRoot, 'crew', 'nars-sessions')]) {
    if (!existsSync(sessionsRoot)) continue;
    const entries = readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).slice(0, 128);
    for (const entry of entries) {
      const recordPath = join(sessionsRoot, entry.name, 'session-index-record.json');
      const record = readJsonFile(recordPath);
      if (!record || record.agent_id !== agentId || !record.session_id) continue;
      if (record.launch_session_id === launchSessionId) return record;
    }
  }
  return false;
}

function findLaunchResult(siteRoots: string[], launchSessionId: string): JsonRecord | false {
  for (const siteRoot of siteRoots) {
    const resultRoot = join(siteRoot, '.ai', 'runtime', 'agent-start-results');
    if (!existsSync(resultRoot)) continue;
    const entries = readdirSync(resultRoot, { withFileTypes: true }).slice(0, 128);
    const candidates = entries.filter((entry) => entry.isFile()).map((entry) => join(resultRoot, entry.name)).concat(
      entries.filter((entry) => entry.isDirectory()).map((entry) => join(resultRoot, entry.name, `${entry.name}.result.json`)),
      entries.filter((entry) => entry.isDirectory()).map((entry) => join(resultRoot, entry.name, 'result.json')),
    );
    for (const path of candidates) {
      const result = readJsonFile(path);
      if (!result) continue;
      const environment = asRecord(result.required_environment);
      if (environment.NARADA_LAUNCH_SESSION_ID === launchSessionId || result.launch_session_id === launchSessionId) return result;
    }
  }
  return false;
}

function readJsonLines(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-4000).map((line) => JSON.parse(line) as JsonRecord);
}

function readJsonFile(path: string): JsonRecord | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return asRecord(value);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

async function waitFor<T>(
  check: () => T | false | null | undefined | Promise<T | false | null | undefined>,
  label: string,
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`${label}_timeout:${lastError instanceof Error ? lastError.message : ''}`);
}

function spawnCaptured(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): CapturedProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  child.stderr?.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  return {
    process: child,
    output: () => output,
    close: () => stopProcess(child),
  };
}

async function runCaptured(command: string, args: string[], timeoutMs: number, maxOutputBytes: number): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-maxOutputBytes); });
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-maxOutputBytes); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const [code] = await once(child, 'close') as [number | null];
  clearTimeout(timer);
  if (timedOut) throw new Error(`bounded_process_timeout:${command}`);
  return { exit_code: code ?? 1, stdout, stderr };
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([once(child, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function readRequestBody(request: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectPromise);
  });
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
