import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerState, handleRequest } from '../src/main.js';

test('speaks the MCP initialize and tools/list contract', async () => {
  const state = createServerState();
  const initialized = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, state);
  assert.equal(initialized?.jsonrpc, '2.0');
  assert.equal((initialized?.result as { serverInfo: { name: string } }).serverInfo.name, 'catalog-observation-mcp');

  const listed = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, state);
  const tools = (listed?.result as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(tools.map(({ name }) => name), [
    'catalog_observation_guidance',
    'catalog_observation_observe',
  ]);
});
