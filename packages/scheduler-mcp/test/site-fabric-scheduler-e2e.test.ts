import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  installE2eArtifactRecorder,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  structured,
  type JsonRecord,
  type JsonRpcResponse,
  type SpawnedJsonlMcpServer,
} from '@narada2/mcp-e2e-harness';

const TEST_ID = 'scheduler-mcp-pc-host-lifecycle-e2e';
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
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
const POLL_MS = boundedInteger(process.env.NARADA_E2E_PC_HOST_POLL_MS, 250, 2_000);
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));

type FixtureEvidence = {
  schema: string;
  token: string;
  phase: 'started' | 'completed';
  pid: number;
  parent_pid: number;
  started_at: string;
  completed_at?: string;
};

type CleanupEvidence = {
  status: 'passed' | 'failed' | 'not_required';
  task_deleted: boolean;
  task_absent_after_delete: boolean;
  fixture_process_started: boolean;
  fixture_process_exited: boolean;
  scheduler_mcp_exited: boolean;
  fixture_launcher_removed: boolean;
  temporary_root_removed: boolean;
  failures: string[];
};

const recorder = installE2eArtifactRecorder(ARTIFACT_PATH, {
  schema: 'narada.scheduler_mcp.pc_host_lifecycle_e2e.result.v1',
  test_id: TEST_ID,
  authority: 'pc_host',
});

let scheduler: SpawnedJsonlMcpServer | null = null;
let temporaryRoot: string | null = null;
let fixtureLauncherPath: string | null = null;
let taskName = ['', `NaradaMcpSurfacesE2e-${process.pid}-${Date.now()}`].join('\\');
let taskCreated = false;
let taskMayExist = false;
let taskDeleted = false;
let taskAbsentAfterDelete = false;
let fixtureProcessExited = false;
let schedulerMcpExited = false;
let fixtureLauncherRemoved = true;
let fixture: FixtureEvidence | null = null;
let history: JsonRecord | null = null;
let action: JsonRecord | null = null;
let requestId = 0;
const cleanupFailures: string[] = [];

await main();

async function main(): Promise<void> {
  let status: 'passed' | 'failed' | 'not_run' = 'failed';
  let failureReason: string | null = null;
  let exitCode = 1;

  try {
    if (!AUTHORITY_ENABLED) {
      status = 'not_run';
      failureReason = 'pc_host_authority_opt_in_required:NARADA_E2E_PC_HOST_AUTHORITY=1';
      exitCode = 2;
      return;
    }
    if (process.platform !== 'win32') {
      status = 'not_run';
      failureReason = `pc_host_requires_windows:${process.platform}`;
      exitCode = 2;
      return;
    }

    temporaryRoot = await mkdtemp(join(tmpdir(), `${TEST_ID}-`));
    const markerPath = join(temporaryRoot, 'scheduler-fixture-result.json');
    const fixtureScriptPath = join(temporaryRoot, 'scheduler-fixture.cjs');
    const token = `${TEST_ID}:${Date.now()}`;
    writeFileSync(fixtureScriptPath, fixtureScript(), 'utf8');
    fixtureLauncherPath = join(temporaryRoot, 'scheduler-fixture-launcher.ps1');
    writeFileSync(fixtureLauncherPath, fixtureLauncher(fixtureScriptPath, markerPath, token), 'utf8');
    const launcherCommand = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const launcherArguments = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ${quoteWindows(fixtureLauncherPath)}`;

    scheduler = spawnJsonlMcpServer(process.execPath, [serverPath], {
      cwd: temporaryRoot,
      env: siteFabricChildEnv(temporaryRoot, { NARADA_SITE_ROOT: temporaryRoot }),
      label: 'scheduler PC-host lifecycle e2e',
      timeoutMs: TIMEOUT_MS,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
    });

    await runMcpProtocolSmoke(scheduler.client, {
      expectedServerName: 'scheduler-mcp',
      requiredTools: [
        'scheduler_task_create',
        'scheduler_task_show',
        'scheduler_task_update_action',
        'scheduler_task_run',
        'scheduler_task_history',
        'scheduler_task_delete',
      ],
    });

    const create = await call('scheduler_task_create', {
      task_name: taskName,
      command: quoteWindows(launcherCommand),
      arguments: launcherArguments,
      working_dir: temporaryRoot,
      schedule: 'once',
      start_time: futureStartTime(),
      description: 'Disposable bounded Scheduler MCP PC-host lifecycle proof.',
    });
    taskMayExist = true;
    if (create.error) {
      if (authorityUnavailable(create)) {
        taskMayExist = false;
        status = 'not_run';
        failureReason = `scheduler_authority_unavailable:${boundedText(JSON.stringify(create.error), 2_000)}`;
        exitCode = 2;
        return;
      }
      throw new Error(`scheduler_task_create_failed:${boundedText(JSON.stringify(create.error), 4_000)}`);
    }
    const created = structured(create);
    assert.equal(created.status, 'created', JSON.stringify(created));
    assert.equal(created.working_dir_applied, true, JSON.stringify(created));
    taskCreated = true;
    action = {
      command: launcherCommand,
      arguments: launcherArguments,
      working_dir: temporaryRoot,
    };

    const shown = await callRequired('scheduler_task_show', { task_name: taskName });
    const shownTask = asRecord(shown.task);
    assert.equal(shownTask.TaskName, taskName, JSON.stringify(shown));
    const taskToRun = String(shownTask['Task To Run'] ?? '');
    assert.match(taskToRun, /scheduler-fixture-launcher\.ps1/i, JSON.stringify(shown));
    assert.match(taskToRun, /powershell(?:\.exe)?/i, JSON.stringify(shown));
    assert.match(taskToRun, /-WindowStyle\s+Hidden/i, JSON.stringify(shown));
    assert.doesNotMatch(taskToRun, /cmd(?:\.exe)?|\.cmd(?:\s|$)/i, JSON.stringify(shown));
    assert.equal(resolve(String(shownTask['Start In'] ?? shownTask['Start In Directory'] ?? '')), resolve(temporaryRoot), JSON.stringify(shown));

    const updated = await callRequired('scheduler_task_update_action', {
      task_name: taskName,
      command: quoteWindows(launcherCommand),
      arguments: launcherArguments,
      working_dir: temporaryRoot,
    });
    assert.equal(updated.status, 'updated', JSON.stringify(updated));
    assert.equal(updated.working_dir_applied, true, JSON.stringify(updated));
    const updatedShown = await callRequired('scheduler_task_show', { task_name: taskName });
    const updatedTask = asRecord(updatedShown.task);
    assert.equal(resolve(String(updatedTask['Start In'] ?? updatedTask['Start In Directory'] ?? '')), resolve(temporaryRoot), JSON.stringify(updatedShown));

    const run = await callRequired('scheduler_task_run', { task_name: taskName });
    assert.equal(run.status, 'started', JSON.stringify(run));

    fixture = await waitFor(() => {
      const current = readFixture(markerPath, token);
      return current?.phase === 'completed' ? current : false;
    }, 'fixture_start_and_completion');
    assert.equal(fixture.phase, 'completed', JSON.stringify(fixture));
    assert.ok(fixture.pid > 0, JSON.stringify(fixture));
    assert.ok(fixture.parent_pid > 0, JSON.stringify(fixture));
    fixtureProcessExited = await waitFor(() => !isProcessAlive(fixture?.pid ?? 0), 'fixture_process_exit');
    assert.equal(fixtureProcessExited, true);

    history = await waitFor(async () => {
      const current = await callRequired('scheduler_task_history', { task_name: taskName, limit: 5 });
      const item = Array.isArray(current.items) ? asRecord(current.items[0]) : {};
      return isSuccessfulHistory(item) ? current : false;
    }, 'scheduler_history_completion');
    const historyItem = asRecord((history.items as unknown[])[0]);
    assert.equal(isSuccessfulHistory(historyItem), true, JSON.stringify(history));

    status = 'passed';
    exitCode = 0;
  } catch (error) {
    status = 'failed';
    failureReason = error instanceof Error ? error.message : String(error);
    exitCode = 1;
  } finally {
    await cleanupTask();
    if (scheduler) {
      try {
        await scheduler.close();
      } catch (error) {
        cleanupFailures.push(`scheduler_mcp_close:${error instanceof Error ? error.message : String(error)}`);
      }
      schedulerMcpExited = scheduler.child.exitCode !== null;
      if (!schedulerMcpExited) cleanupFailures.push('scheduler_mcp_process_still_running');
      scheduler = null;
    }

    const preserveRoot = status === 'failed' && KEEP_FAILURE_ROOT;
    let temporaryRootRemoved = temporaryRoot === null;
    if (temporaryRoot && !preserveRoot) {
      try {
        await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        temporaryRootRemoved = !existsSync(temporaryRoot);
        if (!temporaryRootRemoved) cleanupFailures.push('temporary_root_still_exists');
      } catch (error) {
        temporaryRootRemoved = false;
        cleanupFailures.push(`temporary_root_remove:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (fixtureLauncherPath) {
      try {
        await rm(fixtureLauncherPath, { force: true, maxRetries: 3, retryDelay: 100 });
        fixtureLauncherRemoved = !existsSync(fixtureLauncherPath);
        if (!fixtureLauncherRemoved) cleanupFailures.push('fixture_launcher_still_exists');
      } catch (error) {
        fixtureLauncherRemoved = false;
        cleanupFailures.push(`fixture_launcher_remove:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const noResourcesRequired = status === 'not_run'
      && scheduler === null
      && temporaryRoot === null
      && !taskMayExist;
    const cleanup: CleanupEvidence = {
      status: noResourcesRequired
        ? 'not_required'
        : cleanupFailures.length === 0
          && (!taskCreated || taskDeleted)
          && (!taskCreated || taskAbsentAfterDelete)
          && (!fixture || fixtureProcessExited)
          && schedulerMcpExited
          && fixtureLauncherRemoved
          && temporaryRootRemoved
          ? 'passed'
          : preserveRoot && cleanupFailures.length === 0
            ? 'not_required'
            : 'failed',
      task_deleted: taskDeleted,
      task_absent_after_delete: taskAbsentAfterDelete,
      fixture_process_started: fixture !== null,
      fixture_process_exited: fixtureProcessExited,
      scheduler_mcp_exited: schedulerMcpExited,
      fixture_launcher_removed: fixtureLauncherRemoved,
      temporary_root_removed: temporaryRootRemoved,
      failures: cleanupFailures,
    };
    if (status === 'passed' && cleanup.status !== 'passed') {
      status = 'failed';
      exitCode = 1;
      failureReason = failureReason ?? 'cleanup_incomplete';
    }
    recorder.finalize({
      status,
      failure_reason: failureReason,
      task_name: taskName,
      temporary_root: preserveRoot ? temporaryRoot : null,
      action,
      fixture,
      history,
      cleanup,
      finished_at: new Date().toISOString(),
    });
    console.log(JSON.stringify({
      status,
      test_id: TEST_ID,
      task_name: taskName,
      artifact_path: ARTIFACT_PATH,
      cleanup: {
        task_created: taskCreated,
        task_deleted: taskDeleted,
        task_absent_after_delete: taskAbsentAfterDelete,
        fixture_process_started: fixture !== null,
        fixture_process_exited: fixtureProcessExited,
        scheduler_mcp_exited: schedulerMcpExited,
        fixture_launcher_removed: fixtureLauncherRemoved,
      },
    }));
    process.exitCode = exitCode;
  }
}

function fixtureLauncher(scriptPath: string, markerPath: string, token: string): string {
  const powershellLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    `$process = Start-Process -FilePath ${powershellLiteral(process.execPath)} -ArgumentList @(${powershellLiteral(quoteWindows(scriptPath))}, ${powershellLiteral(quoteWindows(markerPath))}, ${powershellLiteral(quoteWindows(token))}) -WindowStyle Hidden -Wait -PassThru`,
    'exit $process.ExitCode',
  ].join('\r\n') + '\r\n';
}

async function call(name: string, args: JsonRecord): Promise<JsonRecord> {
  assert.ok(scheduler, 'scheduler MCP is not running');
  return await scheduler.client.request(++requestId, 'tools/call', {
    name,
    arguments: args,
  }) as JsonRpcResponse;
}

async function callRequired(name: string, args: JsonRecord): Promise<JsonRecord> {
  const response = await call(name, args);
  if (response.error) throw new Error(`${name}:${boundedText(JSON.stringify(response.error), 4_000)}`);
  return structured(response);
}

async function cleanupTask(): Promise<void> {
  if (!taskMayExist || !scheduler) return;
  try {
    const deleted = await call('scheduler_task_delete', { task_name: taskName });
    if (deleted.error) {
      const message = JSON.stringify(deleted.error);
      if (!/not_found|cannot find|does not exist/i.test(message)) {
        cleanupFailures.push(`task_delete:${boundedText(message, 2_000)}`);
      }
    } else {
      const result = structured(deleted);
      taskDeleted = result.status === 'deleted';
      if (!taskDeleted) cleanupFailures.push(`task_delete_unexpected:${boundedText(JSON.stringify(result), 2_000)}`);
    }
    const absent = await call('scheduler_task_show', { task_name: taskName });
    taskAbsentAfterDelete = Boolean(absent.error && /not_found|cannot find|does not exist/i.test(JSON.stringify(absent.error)));
    if (!taskAbsentAfterDelete) cleanupFailures.push('task_still_present_after_delete');
  } catch (error) {
    cleanupFailures.push(`task_cleanup:${error instanceof Error ? error.message : String(error)}`);
  }
}

function fixtureScript(): string {
  return [
    "const fs = require('node:fs');",
    "const markerPath = process.argv[2];",
    "const token = process.argv[3];",
    "const started = { schema: 'narada.scheduler_mcp.fixture.v1', token, phase: 'started', pid: process.pid, parent_pid: process.ppid, started_at: new Date().toISOString() };",
    'fs.writeFileSync(markerPath, JSON.stringify(started), \'utf8\');',
    'setTimeout(() => { fs.writeFileSync(markerPath, JSON.stringify({ ...started, phase: \'completed\', completed_at: new Date().toISOString() }), \'utf8\'); }, 750);',
  ].join('\n');
}

function readFixture(path: string, token: string): FixtureEvidence | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as FixtureEvidence;
    return value.token === token && (value.phase === 'started' || value.phase === 'completed') ? value : null;
  } catch {
    return null;
  }
}

function isSuccessfulHistory(item: JsonRecord): boolean {
  const lastRun = String(item.last_run ?? '').trim().toLowerCase();
  const result = String(item.last_result ?? '').trim().toLowerCase();
  if (!lastRun || lastRun === 'n/a' || lastRun === 'never') return false;
  return result === '0' || result === '0x0' || result === 'success';
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function authorityUnavailable(response: JsonRecord): boolean {
  const errorText = JSON.stringify(response.error).toLowerCase();
  return errorText.includes('access denied')
    || errorText.includes('"requires_elevation":true')
    || errorText.includes('schtasks.exe not found')
    || errorText.includes('authority unavailable');
}

function futureStartTime(): string {
  const start = new Date(Date.now() + 300_000);
  return `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
}

function quoteWindows(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

async function waitFor<T>(check: () => T | Promise<T>, label: string): Promise<Exclude<T, false | null | undefined>> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== false && value !== null && value !== undefined) return value as Exclude<T, false | null | undefined>;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_MS));
  }
  throw new Error(`timeout:${label}${lastError ? `:${boundedText(lastError, 500)}` : ''}`);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}...`;
}
