import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

type JsonRecord = Record<string, any>;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = resolve(process.env.NARADA_NATIVE_FILESYSTEM_TEST_EXECUTABLE ?? resolve(packageRoot, 'dist', 'native', 'narada-mcp-runtime.exe'));

function run(mode: 'read' | 'write', root: string, requests: JsonRecord[], auditLogDir?: string): Promise<JsonRecord[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ['filesystem', '--mode', mode, '--allowed-root', root];
    if (auditLogDir) args.push('--audit-log-dir', auditLogDir);
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); rejectPromise(new Error(`native_filesystem_write_timeout:${stderr}`)); }, 10_000);
    child.on('error', (error) => { clearTimeout(timer); rejectPromise(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { rejectPromise(new Error(`native_filesystem_write_exit:${code}:${stderr}`)); return; }
      try { resolvePromise(stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))); }
      catch (error) { rejectPromise(new Error(`native_filesystem_write_invalid_output:${String(error)}:${stdout.slice(0, 1000)}`)); }
    });
    child.stdin.end(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
  });
}

const root = mkdtempSync(join(tmpdir(), 'narada-native-filesystem-write-'));
const auditLogDir = join(root, 'audit');
try {
  const responses = await run('write', root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fs_doctor', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fs_write_file', arguments: { path: 'nested/note.txt', content: 'hello native\n' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fs_read_file', arguments: { path: 'nested/note.txt', offset: 1, limit: 10 } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fs_write_file', arguments: { path: 'nested/note.txt', content: 'changed\n', expected_sha256: 'deadbeef' } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fs_write_file', arguments: { path: '.ai/tmp/hook.js', content: 'console.log(1);' } } },
  ], auditLogDir);
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get(1)?.result?.serverInfo?.name, 'local-filesystem-write-native');
  assert.equal(byId.get(2)?.result?.tools?.some((tool: JsonRecord) => tool.name === 'fs_write_file'), true);
  assert.equal(byId.get(3)?.result?.structuredContent?.effective_permissions?.can_write, true);
  assert.equal(byId.get(4)?.result?.structuredContent?.schema, 'local.filesystem.write_file.v1');
  assert.equal(byId.get(4)?.result?.structuredContent?.status, 'written');
  assert.equal(byId.get(5)?.result?.structuredContent?.content, 'hello native');
  assert.equal(byId.get(6)?.error?.data?.code, 'fs_write_file_expected_sha256_mismatch');
  assert.equal(byId.get(7)?.error?.data?.code, 'transient_executable_write_disallowed');
  assert.match(readFileSync(join(auditLogDir, 'filesystem-mcp-audit.jsonl'), 'utf8'), /"operation":"fs_write_file"/);

  const readResponses = await run('read', root, [
    { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'fs_write_file', arguments: { path: 'blocked.txt', content: 'nope' } } },
  ]);
  const readById = new Map(readResponses.map((response) => [response.id, response]));
  assert.equal(readById.get(8)?.result?.tools?.some((tool: JsonRecord) => tool.name === 'fs_write_file'), false);
  assert.equal(readById.get(9)?.error?.data?.code, 'tool_not_available_in_read_mode');
} finally {
  rmSync(root, { recursive: true, force: true });
}
