import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const diagnosticsDir = join(root, 'diagnostics');
  const silentProxy = spawn(process.execPath, [
    proxyEntrypoint,
    '--surface-id',
    'silent-surface',
    '--entrypoint',
    silentEntrypoint,
    '--request-timeout-ms',
    '100',
    '--diagnostics-dir',
    diagnosticsDir,
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
  assert.equal(typeof timeoutResponse.error.data.forensic_artifact_path, 'string');
  assert.match(timeoutResponse.error.data.forensic_artifact_path, /silent-surface/);
  const artifacts = readdirSync(diagnosticsDir).filter((file) => file.endsWith('.json'));
  assert.equal(artifacts.length, 1);
  const artifact = JSON.parse(readFileSync(join(diagnosticsDir, artifacts[0]), 'utf8'));
  assert.equal(artifact.schema, 'narada.mcp_runtime_proxy.forensic_artifact.v1');
  assert.equal(artifact.event, 'proxy_child_request_timeout');
  assert.equal(artifact.surface.surface_id, 'silent-surface');
  assert.equal(artifact.request.id, 'slow-1');
  assert.equal(artifact.request.method, 'tools/call');
  assert.equal(artifact.request.tool_name, 'slow_read');
  assert.equal(artifact.request.requested_tool_timeout_ms, 5);
  assert.equal(typeof artifact.request.args_hash, 'string');
  assert.equal(artifact.request.args_summary.timeout_ms, 5);
  assert.equal(artifact.pending_requests.length, 0);
  assert.equal(artifact.proxy.request_timeout_ms, 100);
  assert.equal(artifact.child_process.entrypoint, silentEntrypoint);
  assert.equal(typeof artifact.child_process.entrypoint_sha256, 'string');
  assert.equal(artifact.diagnostic.code, 'child_request_timeout');
  assert.ok(artifact.request.lifecycle.some((event: Record<string, unknown>) => event.event === 'proxy_timeout'));
  assert.ok(artifact.request.lifecycle.some((event: Record<string, unknown>) => event.event === 'child_termination_requested'));

  const framedChildEntrypoint = join(root, 'framed-child.mjs');
  writeFileSync(framedChildEntrypoint, "process.stdin.setEncoding('utf8'); process.stdin.once('data', (chunk) => { const request = JSON.parse(chunk.trim()); const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'framed-child', version: '1' } } }); process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body); setTimeout(() => process.exit(0), 20); });\n", 'utf8');
  const framedProxy = spawn(process.execPath, [
    proxyEntrypoint,
    '--surface-id',
    'framed-surface',
    '--entrypoint',
    framedChildEntrypoint,
    '--',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let framedStdout = '';
  framedProxy.stdout.setEncoding('utf8');
  framedProxy.stdout.on('data', (chunk) => { framedStdout += chunk; });
  framedProxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
  framedProxy.stdin.end();
  await new Promise<number | null>((resolve) => framedProxy.on('close', resolve));
  assert.doesNotMatch(framedStdout, /Content-Length:/i);
  assert.equal(JSON.parse(framedStdout.trim()).id, 'init-1');

  const normalizedChildEntrypoint = join(root, 'normalized-child.mjs');
  writeFileSync(normalizedChildEntrypoint, "process.stdin.setEncoding('utf8'); process.stdin.once('data', (chunk) => { if (/Content-Length:/i.test(chunk)) process.exit(41); const request = JSON.parse(chunk.trim()); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n'); setTimeout(() => process.exit(0), 20); });\n", 'utf8');
  const normalizedProxy = spawn(process.execPath, [proxyEntrypoint, '--surface-id', 'normalized-surface', '--entrypoint', normalizedChildEntrypoint, '--'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let normalizedStdout = '';
  normalizedProxy.stdout.setEncoding('utf8');
  normalizedProxy.stdout.on('data', (chunk) => { normalizedStdout += chunk; });
  const framedRequest = JSON.stringify({ jsonrpc: '2.0', id: 'framed-init', method: 'initialize', params: {} });
  normalizedProxy.stdin.write(`Content-Length: ${Buffer.byteLength(framedRequest, 'utf8')}\r\n\r\n${framedRequest}`);
  normalizedProxy.stdin.end();
  const normalizedExitCode = await new Promise<number | null>((resolve) => normalizedProxy.on('close', resolve));
  assert.equal(normalizedExitCode, 0);
  assert.match(normalizedStdout, /^Content-Length:/i);
  assert.match(normalizedStdout, /"id":"framed-init"/);

  console.log('mcp-runtime-proxy behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
