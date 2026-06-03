import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'inbox-mcp-protocol-'));

try {
  const state = createServerState({ siteRoot: root });
  const init = handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  }, state);
  assert.equal(init.error, undefined);
  assert.equal(init.result.serverInfo.name, 'narada-inbox-mcp');

  const tools = handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state);
  assert.equal(tools.error, undefined);
  const names = tools.result.tools.map((tool: any) => tool.name);
  assert.deepEqual(names, [
    'inbox_doctor',
    'inbox_list',
    'inbox_show',
    'inbox_submit',
    'inbox_next',
    'capa_queue',
    'capability_next',
  ]);
  const inboxList = tools.result.tools.find((tool: any) => tool.name === 'inbox_list');
  assert.deepEqual(inboxList.inputSchema.properties.status.enum, ['received', 'acknowledged', 'dismissed', 'promoted']);
  assert.equal(inboxList.inputSchema.properties.status.default, 'received');
  assert.deepEqual(inboxList.inputSchema.properties.kind.enum, [
    'proposal',
    'observation',
    'command_request',
    'question',
    'knowledge_candidate',
    'task_candidate',
    'incident',
    'upstream_task_candidate',
  ]);
  assert.deepEqual(inboxList.inputSchema.properties.target_role.enum, ['architect', 'builder', 'operator']);
  assert.equal(inboxList.inputSchema.properties.limit.default, 20);

  const inboxSubmit = tools.result.tools.find((tool: any) => tool.name === 'inbox_submit');
  assert.deepEqual(inboxSubmit.inputSchema.properties.kind.enum, inboxList.inputSchema.properties.kind.enum);
  assert.equal(inboxSubmit.inputSchema.properties.payload.default && typeof inboxSubmit.inputSchema.properties.payload.default, 'object');

  console.log('inbox-mcp protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
