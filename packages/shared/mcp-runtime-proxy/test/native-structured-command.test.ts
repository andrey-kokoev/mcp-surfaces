import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

type JsonRecord = Record<string, any>;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspaceRoot = resolve(packageRoot, '..', '..', '..');
const executable = resolve(process.env.NARADA_NATIVE_STRUCTURED_COMMAND_TEST_EXECUTABLE ?? resolve(packageRoot, 'dist', 'native', 'narada-mcp-runtime.exe'));

function run(root: string, requests: JsonRecord[], auditLogDir: string): Promise<JsonRecord[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ['structured-command', '--allowed-root', root, '--allow-command', 'node', '--audit-log-dir', auditLogDir], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); rejectPromise(new Error(`native_structured_command_timeout:${stderr}`)); }, 15_000);
    child.on('error', (error) => { clearTimeout(timer); rejectPromise(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { rejectPromise(new Error(`native_structured_command_exit:${code}:${stderr}`)); return; }
      try { resolvePromise(stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))); }
      catch (error) { rejectPromise(new Error(`native_structured_command_invalid_output:${String(error)}:${stdout.slice(0, 1000)}`)); }
    });
    child.stdin.end(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
  });
}

const root = mkdtempSync(join(tmpdir(), 'narada-native-structured-command-'));
const auditLogDir = join(root, 'audit');
try {
  const responses = await run(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'structured_command_execution_policy_inspect', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'structured_command_execute', arguments: { command: 'node', args: ['-e', 'process.stdout.write("native-structured")'], working_directory: root, timeout_ms: 5000 } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'structured_command_execute', arguments: { command: 'cmd.exe', args: ['/c', 'echo refused'], working_directory: root } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'structured_command_execute', arguments: { command: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], working_directory: root, timeout_ms: 100 } } },
  ], auditLogDir);
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get(1)?.result?.serverInfo?.name, 'structured-command-native');
  assert.deepEqual(byId.get(2)?.result?.tools?.map((tool: JsonRecord) => tool.name), [
    'structured_command_guidance',
    'structured_command_execution_policy_inspect',
    'structured_command_execute',
  ]);
  assert.equal(byId.get(3)?.result?.structuredContent?.schema, 'narada.structured_command.execution_policy.v0');
  assert.equal(byId.get(3)?.result?.structuredContent?.shell_interpolation, false);
  assert.equal(byId.get(4)?.result?.structuredContent?.schema, 'narada.structured_command.execution_result.v0');
  assert.equal(byId.get(4)?.result?.structuredContent?.status, 'ok');
  assert.equal(byId.get(4)?.result?.structuredContent?.stdout, 'native-structured');
  assert.equal(byId.get(5)?.result?.structuredContent?.status, 'refused');
  assert.equal(byId.get(5)?.result?.structuredContent?.decision?.reasons?.some((reason: string) => reason.startsWith('blocked_command:')), true);
  assert.equal(byId.get(6)?.result?.structuredContent?.status, 'timed_out');
  assert.match(readFileSync(join(auditLogDir, 'structured-command.jsonl'), 'utf8'), /narada\.structured_command\.execution_result\.v0/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
