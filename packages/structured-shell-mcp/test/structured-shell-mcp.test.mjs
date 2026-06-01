import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServerState,
  handleRequest,
  runStructuredCommand,
} from '../src/main.mjs';

const root = mkdtempSync(join(tmpdir(), 'structured-shell-mcp-'));
const auditLogDir = join(root, 'audit');
const state = createServerState({
  allowedRoot: root,
  allowCommand: ['node'],
  allowPrefix: ['git status'],
  auditLogDir,
  outputRoot: root,
});

const init = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, state);
assert.equal(init.result.serverInfo.name, 'structured-shell-mcp');

const tools = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state);
assert.ok(tools.result.tools.some((tool) => tool.name === 'shell_command_run'));

const ok = await runStructuredCommand({
  command: 'node',
  args: ['--version'],
  working_directory: root,
}, state);
assert.equal(ok.status, 'ok');
assert.equal(ok.executed, true);
assert.match(ok.stdout, /^v\d+/);

const refusedCommand = await runStructuredCommand({
  command: 'pwsh',
  args: ['-NoProfile'],
  working_directory: root,
}, state);
assert.equal(refusedCommand.status, 'refused');
assert.equal(refusedCommand.executed, false);

const refusedRoot = await runStructuredCommand({
  command: 'node',
  args: ['--version'],
  working_directory: tmpdir(),
}, state);
assert.equal(refusedRoot.status, 'refused');

const call = await handleRequest({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'shell_command_run',
    arguments: { command: 'node', args: ['--version'], working_directory: root },
  },
}, state);
assert.equal(call.result.content[0].type, 'text');

const audit = readFileSync(join(auditLogDir, 'structured-shell.jsonl'), 'utf8');
assert.match(audit, /structured_shell\.command_result/);

console.log('structured shell MCP tests passed');
