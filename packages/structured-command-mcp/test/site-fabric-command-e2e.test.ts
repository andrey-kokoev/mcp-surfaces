import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('structured-command-site-fabric-e2e');
const outsideRoot = createTemporaryE2eRoot('structured-command-outside-e2e');
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [
  serverPath,
  '--allowed-root', siteRoot,
  '--allow-command', 'node',
  '--max-output-bytes', '120',
], {
  cwd: siteRoot,
  label: 'structured-command Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  return (response.result as JsonRecord)?.structuredContent as JsonRecord ?? response.result as JsonRecord;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'structured-command-mcp',
    requiredTools: ['structured_command_execution_policy_inspect', 'structured_command_execute'],
  });

  const policy = structured(await server.client.request(1, 'tools/call', {
    name: 'structured_command_execution_policy_inspect',
    arguments: {},
  }));
  assert.equal(policy.schema, 'narada.structured_command.execution_policy.v0', JSON.stringify(policy));
  assert.equal((policy.allowed_commands as string[]).includes('node'), true);

  const executed = structured(await server.client.request(2, 'tools/call', {
    name: 'structured_command_execute',
    arguments: {
      command: 'node',
      args: ['-e', 'process.stdout.write("prefix-".repeat(200) + "TAIL_SENTINEL")'],
      working_directory: siteRoot,
      test_scope: 'focused',
      expected_cost: 'low',
    },
  }));
  assert.equal(executed.status, 'ok', JSON.stringify(executed));
  assert.equal(executed.executed, true);
  assert.equal(executed.stdout_truncated, true);
  assert.match(String(executed.stdout), /TAIL_SENTINEL/);
  assert.equal((executed.execution_posture as JsonRecord).source, 'caller_declared');

  const timed = structured(await server.client.request(3, 'tools/call', {
    name: 'structured_command_execute',
    arguments: {
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 1000)'],
      working_directory: siteRoot,
      timeout_ms: 25,
      test_scope: 'focused',
      expected_cost: 'low',
    },
  }));
  assert.equal(timed.status, 'timed_out', JSON.stringify(timed));
  assert.equal(timed.timed_out, true);

  const refused = structured(await server.client.request(4, 'tools/call', {
    name: 'structured_command_execute',
    arguments: { command: 'pwsh', args: ['-NoProfile', '-Command', 'Write-Output blocked'], working_directory: siteRoot },
  }));
  assert.equal(refused.status, 'refused', JSON.stringify(refused));
  assert.ok((refused.refusal_reasons as string[]).some((reason) => reason.includes('command_not_allowed')));

  const outside = structured(await server.client.request(5, 'tools/call', {
    name: 'structured_command_execute',
    arguments: { command: 'node', args: ['--version'], working_directory: outsideRoot },
  }));
  assert.equal(outside.status, 'refused', JSON.stringify(outside));
  assert.ok((outside.refusal_reasons as string[]).some((reason) => reason.includes('working_directory')));

  console.log(JSON.stringify({ status: 'passed', test_id: 'structured-command.site-fabric.policy-and-bounds', cleanup: 'completed_after_finally' }));
} finally {
  await server.close();
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
  assert.equal(removeTemporaryE2eRoot(outsideRoot), true);
}

console.log('structured-command Site fabric e2e ok');
