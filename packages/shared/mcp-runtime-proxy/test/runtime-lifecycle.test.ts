import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  RuntimeLifecycleError,
  terminateRecordedRuntimeInstances,
} from '../src/runtime-lifecycle.js';

function record(root: string, input: {
  schema?: string;
  proxy_pid: number;
  child_pid?: number | null;
  heartbeat_at?: string;
  lease_expires_at?: string;
}): string {
  const path = join(root, `instance-${input.proxy_pid}.json`);
  writeFileSync(path, JSON.stringify({
    schema: input.schema ?? 'narada.mcp_runtime_proxy.instance.v3',
    proxy_pid: input.proxy_pid,
    child_pid: input.child_pid ?? null,
    supervisor_pid: null,
    managed_child_pid: null,
    server_pid: null,
    heartbeat_at: input.heartbeat_at ?? '2026-07-25T20:00:00.000Z',
    lease_expires_at: input.lease_expires_at ?? '2026-07-25T20:01:00.000Z',
  }));
  return path;
}

test('hard cutover terminates current V3 and legacy proxy records and removes them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-cutover-'));
  try {
    const v3 = record(root, { proxy_pid: 101 });
    const v2 = record(root, {
      schema: 'narada.mcp_runtime_proxy.instance.v2',
      proxy_pid: 102,
    });
    const alive = new Set([101, 102]);
    const result = await terminateRecordedRuntimeInstances({
      diagnostics_dir: root,
      now: new Date('2026-07-25T20:00:30.000Z'),
      is_pid_alive: (pid) => alive.has(pid),
      terminate_pid: (pid) => {
        alive.delete(pid);
      },
      wait: async () => {},
      poll_interval_ms: 1,
    });
    assert.equal(result.status, 'terminated');
    assert.deepEqual(result.terminated_proxy_pids, [101, 102]);
    assert.equal(existsSync(v3), false);
    assert.equal(existsSync(v2), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hard cutover refuses a live PID whose identity lease expired', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-cutover-stale-'));
  try {
    const path = record(root, {
      proxy_pid: 201,
      heartbeat_at: '2026-07-25T19:00:00.000Z',
      lease_expires_at: '2026-07-25T19:01:00.000Z',
    });
    await assert.rejects(
      terminateRecordedRuntimeInstances({
        diagnostics_dir: root,
        now: new Date('2026-07-25T20:00:00.000Z'),
        identity_grace_ms: 0,
        is_pid_alive: (pid) => pid === 201,
        terminate_pid: () => {
          throw new Error('must not signal stale identity');
        },
      }),
      (error: unknown) =>
        error instanceof RuntimeLifecycleError
        && error.code === 'runtime_instance_identity_stale',
    );
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).proxy_pid, 201);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hard cutover force-terminates surviving proxy and child PIDs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-cutover-force-'));
  try {
    record(root, { proxy_pid: 301, child_pid: 302 });
    const alive = new Set([301, 302]);
    const forced: number[] = [];
    const result = await terminateRecordedRuntimeInstances({
      diagnostics_dir: root,
      now: new Date('2026-07-25T20:00:30.000Z'),
      graceful_timeout_ms: 0,
      force_timeout_ms: 0,
      is_pid_alive: (pid) => alive.has(pid),
      terminate_pid: (pid, force) => {
        if (!force) return;
        forced.push(pid);
        alive.delete(pid);
      },
      wait: async () => {},
    });
    assert.deepEqual(forced.sort(), [301, 302]);
    assert.deepEqual(result.forced_pids, [301, 302]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hard cutover terminates a recorded orphan child after its proxy exited', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-cutover-orphan-'));
  try {
    record(root, { proxy_pid: 401, child_pid: 402 });
    const alive = new Set([402]);
    const forced: number[] = [];
    const result = await terminateRecordedRuntimeInstances({
      diagnostics_dir: root,
      now: new Date('2026-07-25T20:00:30.000Z'),
      graceful_timeout_ms: 0,
      force_timeout_ms: 0,
      is_pid_alive: (pid) => alive.has(pid),
      terminate_pid: (pid, force) => {
        assert.equal(force, true);
        forced.push(pid);
        alive.delete(pid);
      },
      wait: async () => {},
    });
    assert.deepEqual(forced, [402]);
    assert.deepEqual(result.terminated_proxy_pids, []);
    assert.deepEqual(result.forced_pids, [402]);
    assert.equal(result.live_instance_count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
