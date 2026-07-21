import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'local-filesystem-mcp-protocol-'));

try {
  const state = createServerState({
    mode: 'write',
    allowedRoots: [root],
    outputRoot: root,
  });

  const init = handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  }, state);
  assert.equal(init.error, undefined);
  assert.equal(init.result.serverInfo.name, 'local-filesystem-write');
  assert.deepEqual(Object.keys(init.result.capabilities).sort(), ['completions', 'logging', 'prompts', 'resources', 'tools']);

  const tools = handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }, state);
  assert.equal(tools.error, undefined);
  const names = tools.result.tools.map((tool) => tool.name);
  assert.equal(names.includes('fs_read_file'), true);
  assert.equal(names.includes('fs_write_file'), true);
  assert.equal(names.includes('fs_create_directory'), true);
  assert.equal(names.includes('fs_rename_directory'), true);
  assert.equal(names.includes('fs_delete_directory'), true);
  assert.equal(names.includes('mcp_output_show'), false);
  const readFileTool = tools.result.tools.find((tool) => tool.name === 'fs_read_file');
  assert.equal(readFileTool.annotations.readOnlyHint, true);
  assert.equal(readFileTool.outputSchema.type, 'object');
  assert.match(readFileTool.inputSchema.properties.path.description, /first allowed root/);

  const doctor = handleRequest({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'fs_doctor', arguments: {} },
  }, state);
  assert.equal(doctor.result.structuredContent.relative_path_resolution.base, root);
  assert.equal(doctor.result.structuredContent.relative_path_resolution.rule, 'first_allowed_root');
  const relativeStat = handleRequest({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'fs_stat', arguments: { path: '.' } },
  }, state);
  assert.equal(relativeStat.result.structuredContent.path, root);
  const relativeRefusal = handleRequest({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'fs_stat', arguments: { path: '..' } },
  }, state);
  assert.equal((relativeRefusal.error.data.details as any).active_resolution_base, root);
  assert.equal((relativeRefusal.error.data.details as any).relative_path_resolution.rule, 'first_allowed_root');
  const guidance = handleRequest({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'fs_guidance', arguments: {} },
  }, state);
  assert.equal(guidance.result.structuredContent.path_resolution.relative_paths.includes('first allowed root'), true);

  const prompts = handleRequest({ jsonrpc: '2.0', id: 3, method: 'prompts/list', params: {} }, state);
  assert.equal(prompts.result.prompts[0].name, 'local_filesystem_tool_usage');
  const prompt = handleRequest({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'local_filesystem_tool_usage' } }, state);
  assert.match(prompt.result.messages[0].content.text, /allowed roots/);
  const completion = handleRequest({ jsonrpc: '2.0', id: 5, method: 'completion/complete', params: { argument: { name: 'name' } } }, state);
  assert.equal(completion.result.completion.values.includes('fs_read_file'), true);
  const logging = handleRequest({ jsonrpc: '2.0', id: 6, method: 'logging/setLevel', params: { level: 'debug' } }, state);
  assert.deepEqual(logging.result, {});

  const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const child = spawn(process.execPath, [serverPath, '--mode', 'read', '--allowed-root', root, '--output-root', root], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { roots: { listChanged: true } } } })}\n`);
  await waitForLines(() => stdout, 2);
  const firstResponses = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const rootsRequest = firstResponses.find((message) => message.method === 'roots/list');
  assert.ok(rootsRequest);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rootsRequest.id, result: { roots: [{ uri: pathToFileURL(root).href, name: 'protocol-root' }] } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'completion/complete', params: { _meta: { progressToken: 'fs-progress' }, argument: { name: 'path' } } })}\n`);
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);
  const responses = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses.some((message) => message.method === 'notifications/progress' && message.params?.progressToken === 'fs-progress'), true);
  const completionResponse = responses.find((message) => message.id === 2);
  assert.equal(completionResponse.result.completion.values.includes(root), true);

  console.log('local-filesystem-mcp protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function waitForLines(read: () => string, count: number) {
  const started = Date.now();
  while (read().trim().split(/\r?\n/).filter(Boolean).length < count) {
    if (Date.now() - started > 5000) throw new Error(`timed out waiting for ${count} lines`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
