import assert from 'node:assert/strict';
import { createServerState, handleRequest } from '../src/main.js';

const state = createServerState({ narsBaseUrl: 'http://127.0.0.1:9', sessionId: 'carrier_test' });
const init = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, state);
assert.equal(init?.result.serverInfo.name, 'artifacts-mcp');
const listed = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state);
const names = (listed?.result.tools as Array<Record<string, unknown>>).map((tool) => tool.name);
assert.deepEqual(names, ['artifacts_guidance', 'artifacts_doctor', 'artifact_register_file', 'artifact_list', 'artifact_read', 'artifact_present', 'artifact_message_part_create']);

console.log('artifacts-mcp protocol smoke ok');
