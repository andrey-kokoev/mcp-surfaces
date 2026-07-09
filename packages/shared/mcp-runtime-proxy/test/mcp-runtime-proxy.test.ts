import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'mcp-runtime-proxy-'));

try {
  const childEntrypoint = join(root, 'failing-child.mjs');
  writeFileSync(childEntrypoint, "process.stderr.write('import failed: missing shared dist\\n'); process.exit(42);\n", 'utf8');
  const proxyEntrypoint = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const child = spawn(process.execPath, [
    proxyEntrypoint,
    '--surface-id',
    'test-surface',
    '--entrypoint',
    childEntrypoint,
    '--',
    '--site-root',
    root,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 42);
  assert.match(stderr, /missing shared dist/);

  const response = JSON.parse(stdout.trim());
  assert.equal(response.id, 1);
  assert.equal(response.error.data.schema, 'narada.mcp_runtime_proxy.error.v1');
  assert.equal(response.error.data.code, 'child_exited_before_response');
  assert.equal(response.error.data.surface_id, 'test-surface');
  assert.equal(response.error.data.exit_code, 42);
  assert.match(response.error.data.stderr_tail, /missing shared dist/);

  const silentEntrypoint = join(root, 'silent-child.mjs');
  writeFileSync(silentEntrypoint, "process.stdin.resume(); setInterval(() => {}, 1000);\n", 'utf8');
  const silentProxy = spawn(process.execPath, [
    proxyEntrypoint,
    '--surface-id',
    'silent-surface',
    '--entrypoint',
    silentEntrypoint,
    '--request-timeout-ms',
    '100',
    '--',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let silentStdout = '';
  silentProxy.stdout.setEncoding('utf8');
  silentProxy.stdout.on('data', (chunk) => { silentStdout += chunk; });
  silentProxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'slow-1', method: 'tools/call', params: { name: 'slow_read', arguments: { timeout_ms: 5 } } })}\n`);

  const silentExitCode = await new Promise<number | null>((resolve) => silentProxy.on('close', resolve));
  assert.notEqual(silentExitCode, 0);
  const timeoutResponse = JSON.parse(silentStdout.trim());
  assert.equal(timeoutResponse.id, 'slow-1');
  assert.equal(timeoutResponse.error.data.schema, 'narada.mcp_runtime_proxy.error.v1');
  assert.equal(timeoutResponse.error.data.code, 'child_request_timeout');
  assert.equal(timeoutResponse.error.data.method, 'tools/call');
  assert.equal(timeoutResponse.error.data.surface_id, 'silent-surface');
  assert.equal(timeoutResponse.error.data.timeout_layer, 'mcp_runtime_proxy_watchdog');
  assert.equal(timeoutResponse.error.data.proxy_request_timeout_ms, 100);
  assert.equal(timeoutResponse.error.data.requested_tool_timeout_ms, 5);
  assert.equal(timeoutResponse.error.data.surface_timeout_expected_before_proxy, true);
  assert.equal(timeoutResponse.error.data.kill_grace_ms, 5000);

  console.log('mcp-runtime-proxy behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
