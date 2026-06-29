import assert from 'node:assert/strict';
import { createServerState, handleRequest } from '../src/main.js';

const state = createServerState({ siteRoot: 'D:/tmp/operator-routing-mcp-smoke' });
const init = handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, state);
assert.equal(init?.result.serverInfo.name, 'operator-routing-mcp');
const listed = handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state);
assert.equal((listed?.result.tools as Array<Record<string, unknown>>).length, 2);
assert.ok((listed?.result.tools as Array<Record<string, unknown>>).some((tool) => tool.name === 'operator_route_doctor'));
assert.ok((listed?.result.tools as Array<Record<string, unknown>>).some((tool) => tool.name === 'operator_route_request'));

console.log('operator-routing-mcp protocol smoke ok');
