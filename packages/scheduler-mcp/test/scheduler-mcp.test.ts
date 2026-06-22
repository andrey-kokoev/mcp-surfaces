import assert from 'node:assert/strict';
import { buildTaskRunCommand, compactScheduledTaskRows, createServerState, handleRequest, schedulerFailureDetails } from '../src/main.js';

const state = createServerState({});

const grouped = compactScheduledTaskRows([
  { TaskName: '\\Narada-Sonar-Daemon', Status: 'Ready', 'Schedule Type': 'At logon time', 'Next Run Time': 'N/A', 'Last Run Time': 'today', 'Last Result': '0', 'Task To Run': 'pwsh.exe' },
  { TaskName: '\\Narada-Sonar-Daemon', Status: 'Ready', 'Schedule Type': 'One Time Only, Minute', 'Next Run Time': 'soon', 'Last Run Time': 'today', 'Last Result': '0', 'Task To Run': 'pwsh.exe', 'Repeat: Every': '5 minutes' },
]);
assert.equal(grouped.length, 1);
assert.equal(grouped[0].task_name, '\\Narada-Sonar-Daemon');
assert.equal(grouped[0].trigger_count, 2);
assert.deepEqual((grouped[0].triggers as Record<string, unknown>[]).map((trigger) => trigger.schedule), ['At logon time', 'One Time Only, Minute']);

const accessDenied = schedulerFailureDetails({ operation: 'create', exitCode: 1, stderr: 'ERROR: Access is denied.', taskName: '\\NeedsAdmin', command: 'pwsh.exe -File tool.ps1' });
assert.equal(accessDenied.classification, 'requires_elevation');
assert.equal(accessDenied.requires_elevation, true);
assert.match(String(accessDenied.remediation), /elevated PowerShell/);

const invalidArgs = schedulerFailureDetails({ operation: 'create', exitCode: 2147500037, stderr: '', taskName: '\\BadTask' });
assert.equal(invalidArgs.classification, 'invalid_arguments_or_unsupported_scheduler_option');
assert.equal(buildTaskRunCommand('pwsh.exe', '-File tool.ps1'), 'pwsh.exe -File tool.ps1');

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

const dryRunUpdate = await callTool('scheduler_task_update_action', {
  task_name: '\\Narada-Sonar-Daemon',
  command: 'pwsh.exe',
  arguments: '-NoProfile -File D:\\code\\narada.sonar\\scripts\\supervisor.ps1 start',
  working_dir: 'D:\\code\\narada.sonar',
  dry_run: true,
});
const dryRunUpdateData = view(dryRunUpdate);
assert.equal(dryRunUpdateData.status, 'planned');
assert.equal(dryRunUpdateData.preserves_triggers, true);
assert.deepEqual(dryRunUpdateData.schtasks_args.slice(0, 4), ['/change', '/tn', '\\Narada-Sonar-Daemon', '/tr']);
assert.match(dryRunUpdateData.working_dir_warning, /cannot set Start In/);

console.log('scheduler-mcp behavior ok');
