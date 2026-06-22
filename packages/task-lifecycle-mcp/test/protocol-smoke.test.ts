import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleTaskLifecycleMcpRequest } from '../src/task-lifecycle/task-mcp-server.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-mcp-protocol-'));
mkdirSync(join(siteRoot, '.ai'), { recursive: true });

const runtimeOptions = {
  argv: ['--site-root', siteRoot],
  cwd: siteRoot,
  env: { ...process.env, NARADA_AGENT_ID: 'sonar.resident' },
  stdout: { write: () => true },
  stderr: { write: () => true },
};

const init = await handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05' },
}, runtimeOptions);
assert.equal(init.error, undefined);
assert.equal(init.result.serverInfo.name, 'narada-task-lifecycle-mcp');

const tools = await handleTaskLifecycleMcpRequest({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
});
assert.equal(tools.error, undefined);
const names = tools.result.tools.map((tool) => tool.name);
assert.equal(names.includes('task_lifecycle_next'), true);
assert.equal(names.includes('task_lifecycle_doctor'), true);
assert.equal(names.includes('mcp_output_show'), false);

console.log('task-lifecycle-mcp protocol smoke ok');
