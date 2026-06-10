import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'scheduler-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const child = spawn(process.execPath, [serverPath, '--allowed-root', root], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

try {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);

  const responses = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const init = responses.find((message) => message.id === 1);
  assert.equal((init.result as Record<string, any>).serverInfo.name, 'scheduler-mcp');
  assert.ok((init.result as Record<string, any>).capabilities.tools);

  const tools = (responses.find((message) => message.id === 2).result as Record<string, any>).tools;
  const expectedTools = [
    'scheduler_task_list',
    'scheduler_task_show',
    'scheduler_task_create',
    'scheduler_task_delete',
    'scheduler_task_enable',
    'scheduler_task_disable',
    'scheduler_task_run',
    'scheduler_task_history',
  ];
  assert.deepEqual(tools.map((t: { name: string }) => t.name), expectedTools);

  const listTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'scheduler_task_list');
  assert.equal(listTool.annotations.readOnlyHint, true);

  const createTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'scheduler_task_create');
  assert.equal(createTool.annotations.readOnlyHint, false);
  assert.equal(createTool.annotations.destructiveHint, false);

  const deleteTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'scheduler_task_delete');
  assert.equal(deleteTool.annotations.destructiveHint, true);

  const createProps = (tools.find((t: { name: string }) => t.name === 'scheduler_task_create') as any).inputSchema.properties;
  assert.ok(createProps.task_name);
  assert.ok(createProps.command);
  assert.ok(createProps.schedule);
  assert.ok(createProps.arguments);
  assert.ok(createProps.working_dir);

  const showTool = tools.find((t: { name: string; inputSchema: { properties: Record<string, unknown> } }) => t.name === 'scheduler_task_show');
  assert.ok(showTool.inputSchema.properties.task_name);

  console.log('scheduler-mcp protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
