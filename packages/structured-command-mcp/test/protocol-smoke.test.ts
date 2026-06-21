import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServerState, executeStructuredCommand, handleRequest } from '../src/main.js';

type ToolSummary = { name: string; annotations: Record<string, unknown>; outputSchema: Record<string, unknown> };
type JsonRpcTestResponse = {
  error?: { message: string; data?: Record<string, unknown> };
  result: {
    serverInfo: { name: string };
    capabilities: Record<string, unknown>;
    tools: ToolSummary[];
  };
};
const root = mkdtempSync(join(tmpdir(), 'structured-command-mcp-protocol-'));

try {
  const state = createServerState({
    allowedRoots: [root],
    allowedCommands: ['node'],
  });

  const init = await handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  }, state) as JsonRpcTestResponse;
  assert.equal(init.error, undefined);
  assert.equal(init.result.serverInfo.name, 'structured-command-mcp');
  assert.deepEqual(Object.keys(init.result.capabilities).sort(), ['completions', 'logging', 'prompts', 'resources', 'tools']);
  const tools = await handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }, state) as JsonRpcTestResponse;
  assert.equal(tools.error, undefined);
  const names = tools.result.tools.map((tool) => tool.name);
  assert.equal(names.includes('structured_command_execute'), true);
  assert.equal(names.includes('structured_command_elevated_window_execute'), true);
  assert.equal(names.includes('structured_command_input_create'), true);
  assert.equal(names.includes('structured_command_output_show'), false);
  const executeTool = tools.result.tools.find((tool) => tool.name === 'structured_command_execute');
  assert.equal(executeTool.annotations.readOnlyHint, false);
  assert.equal(executeTool.outputSchema.type, 'object');

  const prompts = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'prompts/list', params: {} }, state) as any;
  assert.equal(prompts.result.prompts[0].name, 'structured_command_safe_execution');
  const completion = await handleRequest({ jsonrpc: '2.0', id: 4, method: 'completion/complete', params: { argument: { name: 'name' } } }, state) as any;
  assert.equal(completion.result.completion.values.includes('structured_command_execute'), true);
  const logging = await handleRequest({ jsonrpc: '2.0', id: 5, method: 'logging/setLevel', params: { level: 'debug' } }, state) as any;
  assert.deepEqual(logging.result, {});

  const abortController = new AbortController();
  abortController.abort();
  const cancelled = await executeStructuredCommand({ command: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'] }, state, { abortSignal: abortController.signal }) as any;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelled, true);

  const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const child = spawn(process.execPath, [serverPath, '--allowed-root', root, '--allow-command', 'node'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'cancel-me',
    method: 'tools/call',
    params: {
      _meta: { progressToken: 'progress-1' },
      name: 'structured_command_execute',
      arguments: { command: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'], working_directory: root, timeout_ms: 10000 },
    },
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-me', reason: 'test' } })}\n`);
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);
  const messages = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(messages.some((message) => message.method === 'notifications/progress'), true);
  const cancelledResponse = messages.find((message) => message.id === 'cancel-me');
  assert.equal(cancelledResponse.result.structuredContent.status, 'cancelled');
  assert.equal(cancelledResponse.result.structuredContent.cancelled, true);

  const rootsChild = spawn(process.execPath, [serverPath, '--allowed-root', root, '--allow-command', 'node'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let rootsStdout = '';
  let rootsStderr = '';
  rootsChild.stdout.setEncoding('utf8');
  rootsChild.stderr.setEncoding('utf8');
  rootsChild.stdout.on('data', (chunk) => { rootsStdout += chunk; });
  rootsChild.stderr.on('data', (chunk) => { rootsStderr += chunk; });
  rootsChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { capabilities: { roots: { listChanged: true } } } })}\n`);
  await waitForLines(() => rootsStdout, 2);
  const initialRootsMessages = rootsStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const rootsRequest = initialRootsMessages.find((message) => message.method === 'roots/list');
  assert.ok(rootsRequest);
  rootsChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rootsRequest.id, result: { roots: [{ uri: pathToFileURL(root).href, name: 'command-root' }] } })}\n`);
  rootsChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'completion/complete', params: { argument: { name: 'working_directory' } } })}\n`);
  rootsChild.stdin.end();
  const rootsExitCode = await new Promise<number | null>((resolve) => rootsChild.on('close', resolve));
  assert.equal(rootsExitCode, 0, rootsStderr);
  const rootsMessages = rootsStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const rootsCompletion = rootsMessages.find((message) => message.id === 11);
  assert.equal(rootsCompletion.result.completion.values.includes(root), true);

  console.log('structured-command-mcp protocol smoke ok');
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
