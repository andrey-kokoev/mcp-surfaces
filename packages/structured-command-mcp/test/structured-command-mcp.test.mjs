import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServerState,
  executeStructuredCommand,
  handleRequest,
} from '../src/main.mjs';

const root = mkdtempSync(join(tmpdir(), 'structured-command-mcp-'));
const auditLogDir = join(root, 'audit');
const state = createServerState({
  allowedRoot: root,
  allowCommand: ['node'],
  allowPrefix: ['git status'],
  auditLogDir,
});

const init = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, state);
assert.equal(init.result.serverInfo.name, 'structured-command-mcp');

const tools = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state);
const toolNames = tools.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(toolNames, [
  'structured_command_execute',
  'structured_command_execution_policy_inspect',
]);

const ok = await executeStructuredCommand({
  command: 'node',
  args: ['--version'],
  working_directory: root,
}, state);
assert.equal(ok.status, 'ok');
assert.equal(ok.executed, true);
assert.match(ok.stdout, /^v\d+/);

const refusedCommand = await executeStructuredCommand({
  command: 'pwsh',
  args: ['-NoProfile'],
  working_directory: root,
}, state);
assert.equal(refusedCommand.status, 'refused');
assert.equal(refusedCommand.executed, false);

const refusedRoot = await executeStructuredCommand({
  command: 'node',
  args: ['--version'],
  working_directory: tmpdir(),
}, state);
assert.equal(refusedRoot.status, 'refused');

await assert.rejects(
  () => executeStructuredCommand({
    command: 'node',
    args: ['x'.repeat(201)],
    working_directory: root,
  }, state),
  /structured_command_input_too_long:arguments\.args\[0\]:201>200/,
);

const policy = await handleRequest({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'structured_command_execution_policy_inspect',
    arguments: {},
  },
}, state);
assert.match(policy.result.content[0].text, /structured_command\.execution_policy/);
assert.ok(policy.result.content[0].text.length <= 200);
assert.equal(policy.result.structuredContent.truncated, true);

const call = await handleRequest({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'structured_command_execute',
    arguments: { command: 'node', args: ['--version'], working_directory: root },
  },
}, state);
assert.equal(call.result.content[0].type, 'text');
assert.match(call.result.content[0].text, /structured_command\.execution_result/);
assert.ok(call.result.content[0].text.length <= 200);
assert.equal(call.result.structuredContent.truncated, true);

const audit = readFileSync(join(auditLogDir, 'structured-command.jsonl'), 'utf8');
assert.match(audit, /structured_command\.execution_result/);

console.log('structured command MCP tests passed');
