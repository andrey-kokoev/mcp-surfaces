import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

// Fresh-process e2e for sfb_36762540-087: structured-command behind
// mcp-runtime-proxy over a real MCP stdio transport. The tool's declared
// timeout_ms must be answered by the surface's own bounded timeout result; the
// proxy watchdog must not preempt it with child_request_timeout, and the same
// transport must stay usable for the next call. The mcp-loader is
// intentionally not involved: its nested timeout_ms doubles as its outer call
// deadline, which cannot express this assertion.
//
// Sizing: the watchdog (1000ms) sits at the surface's own timeout (1000ms), so
// only the honored window (timeout + grace = 4000ms) lets the answer through —
// without honoring, the watchdog fires first and kills the child. The grace is
// wide because Windows process spawn plus taskkill teardown regularly adds
// several hundred milliseconds on a loaded machine.
const siteRoot = createTemporaryE2eRoot('structured-command-proxy-timeout-e2e');
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const proxyPath = fileURLToPath(new URL('../../../shared/mcp-runtime-proxy/dist/src/main.js', import.meta.url));
const proxy = spawnJsonlMcpServer(process.execPath, [
  proxyPath,
  '--surface-id', 'structured-command',
  '--entrypoint', serverPath,
  '--request-timeout-ms', '1000',
  '--tool-timeout-grace-ms', '3000',
  '--',
  '--allowed-root', siteRoot,
  '--allow-command', 'node',
], {
  cwd: siteRoot,
  timeoutMs: 20_000,
  label: 'structured-command behind mcp-runtime-proxy',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  return (response.result as JsonRecord)?.structuredContent as JsonRecord ?? response.result as JsonRecord;
}

try {
  await runMcpProtocolSmoke(proxy.client, {
    expectedServerName: 'structured-command-mcp',
    requiredTools: ['structured_command_execute'],
  });

  // The command runs 30s but the tool timeout is 1000ms: the surface must
  // return its own timed_out result at ~1s, inside the honored window
  // (1000ms + 3000ms grace) instead of the 1000ms proxy watchdog.
  const timedResponse = await proxy.client.request(3, 'tools/call', {
    name: 'structured_command_execute',
    _meta: { narada_request_timeout_ms: 1000 },
    arguments: {
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      working_directory: siteRoot,
      timeout_ms: 1000,
    },
  });
  assert.equal(timedResponse.error, undefined, `proxy must not preempt the surface timeout with its own: ${JSON.stringify(timedResponse.error)}`);
  const timed = structured(timedResponse);
  assert.equal(timed.status, 'timed_out', JSON.stringify(timed));
  assert.equal(timed.timed_out, true);
  assert.equal(timed.timeout_ms, 1000);
  assert.match(String(timed.execution_ref), /^structured_command_execution:/);

  // The same transport stays alive: a follow-up call on the same connection
  // succeeds (the proxy never SIGTERMed the shared child).
  assert.equal(proxy.child.exitCode, null, 'proxy exited after the timed-out call');
  const ok = structured(await proxy.client.request(4, 'tools/call', {
    name: 'structured_command_execute',
    arguments: {
      command: 'node',
      args: ['--version'],
      working_directory: siteRoot,
      timeout_ms: 5000,
    },
  }));
  assert.equal(ok.status, 'ok', JSON.stringify(ok));
  assert.match(String(ok.stdout), /^v\d+/);

  console.log(JSON.stringify({ status: 'passed', test_id: 'structured-command.proxy-timeout.e2e', cleanup: 'completed_after_finally' }));
} finally {
  await proxy.close();
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}

console.log('structured-command proxy timeout e2e ok');
