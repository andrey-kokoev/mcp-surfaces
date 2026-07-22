import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskLifecycleProcessClient } from '../src/task-lifecycle-client.js';

const root = mkdtempSync(join(tmpdir(), 'surface-feedback-client-'));
const serverPath = join(root, 'fake-task-lifecycle.mjs');

try {
  writeFileSync(serverPath, `
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const countPath = process.env.FAKE_COUNT_PATH;
let count = 0;
try { count = Number(readFileSync(countPath, 'utf8')); } catch {}
count += 1;
writeFileSync(countPath, String(count));
const mode = process.env.FAKE_MODE;
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (count === 1 && mode === 'invalid') {
    process.stdout.write('not-json\\n');
    return;
  }
  if (count === 1 && mode === 'timeout') return;
  if (count === 1 && mode === 'stale') {
    spawn(process.execPath, ['-e', "setTimeout(() => process.stdout.write('stale-not-json\\\\n'), 1_100)"], { stdio: ['ignore', process.stdout, process.stderr], windowsHide: true });
    return;
  }
  if (count === 2 && mode === 'stale') {
    setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { structuredContent: { status: 'ok', process_count: count } } }) + '\\n'), 150);
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { structuredContent: { status: 'ok', process_count: count } } }) + '\\n');
});
`, 'utf8');

  for (const mode of ['invalid', 'timeout', 'stale'] as const) {
    const countPath = join(root, `${mode}.count`);
    const client = createTaskLifecycleProcessClient({
      siteRoot: root,
      entrypoint: serverPath,
      env: {
        ...process.env,
        FAKE_COUNT_PATH: countPath,
        FAKE_MODE: mode,
      },
      // Fresh child startup can exceed sub-100ms under the workspace suite; keep the timeout intentionally short relative to the production default without racing process launch.
      requestTimeoutMs: 1_000,
    });
    try {
      await assert.rejects(
        client.request({ jsonrpc: '2.0', id: `${mode}-first`, method: 'tools/call', params: {} }),
        new RegExp(mode === 'invalid' ? 'task_lifecycle_invalid_stdout' : 'task_lifecycle_request_timeout'),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      const response = await client.request({ jsonrpc: '2.0', id: `${mode}-second`, method: 'tools/call', params: {} });
      assert.equal((response.result as any).structuredContent.process_count, 2);
      assert.equal(Number(readFileSync(countPath, 'utf8')), 2);
    } finally {
      await client.close();
    }
  }

  console.log('surface-feedback task-lifecycle client recovery ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
