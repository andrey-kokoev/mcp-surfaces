import assert from 'node:assert/strict';
import { createServerState, handleRequest } from '../src/main.js';

const state = createServerState({});

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as Promise<Record<string, any>>;
}
function view(res: Record<string, any>): Record<string, any> {
  return res.result.structuredContent as Record<string, any>;
}

const list = await callTool('scheduler_task_list', { limit: 5 });
const listData = view(list);
assert.ok(Array.isArray(listData.items), 'list should return items array');
assert.ok(typeof listData.count === 'number', 'list should have count');
if (listData.items.length > 0) {
  const first = listData.items[0] as Record<string, any>;
  assert.ok(first.task_name, 'task should have task_name');
  assert.ok(first.status, 'task should have status');
}

const knownTask = listData.items[0] as Record<string, any> | undefined;
if (knownTask) {
  const show = await callTool('scheduler_task_show', { task_name: knownTask.task_name as string });
  const showData = view(show);
  assert.ok(showData.task, 'show should return task');
  assert.equal(showData.task.TaskName, knownTask.task_name);

  const history = await callTool('scheduler_task_history', { task_name: knownTask.task_name as string, limit: 3 });
  const historyData = view(history);
  assert.ok(Array.isArray(historyData.items), 'history should return items');
}

console.log('scheduler-mcp behavior ok');
