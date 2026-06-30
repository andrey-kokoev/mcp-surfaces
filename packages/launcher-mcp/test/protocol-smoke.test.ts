import assert from 'node:assert/strict';
import { createServerState, handleRequest } from '../src/main.js';

type JsonRpcTestResponse = { error?: { message: string }; result: { serverInfo: { name: string }; tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
const rpc = handleRequest as unknown as (...args: Parameters<typeof handleRequest>) => Promise<JsonRpcTestResponse>;

const state = createServerState({ naradaRoot: 'C:/Users/Andrey/Narada' });
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, state);
assert.equal(init.error, undefined);
assert.equal(init.result.serverInfo.name, 'launcher-mcp');

const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state);
assert.equal(tools.error, undefined);
assert.deepEqual(tools.result.tools.map((tool) => tool.name), [
  'launcher_guidance',
  'launcher_doctor',
  'launcher_options_list',
  'launcher_registry_list',
  'launcher_plan',
  'launcher_option_matrix',
  'launcher_coherence_check',
]);
assert.equal(tools.result.tools.every((tool) => tool.annotations.readOnlyHint), true);

console.log('launcher-mcp protocol smoke ok');
