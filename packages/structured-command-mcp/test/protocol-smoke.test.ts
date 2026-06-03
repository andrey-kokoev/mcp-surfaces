import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

type ToolSummary = { name: string };
type JsonRpcTestResponse = {
  error?: { message: string; data?: Record<string, unknown> };
  result: {
    serverInfo: { name: string };
    tools: ToolSummary[];
  };
};
const root = mkdtempSync(join(tmpdir(), 'structured-command-mcp-protocol-'));

try {
  const state = createServerState({
    allowedRoots: [root],
    allowedCommands: ['node'],
  });

  const init = await handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  }, state) as JsonRpcTestResponse;
  assert.equal(init.error, undefined);
  assert.equal(init.result.serverInfo.name, 'structured-command-mcp');
  const tools = await handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }, state) as JsonRpcTestResponse;
  assert.equal(tools.error, undefined);
  const names = tools.result.tools.map((tool) => tool.name);
  assert.equal(names.includes('structured_command_execute'), true);
  assert.equal(names.includes('structured_command_input_create'), true);
  assert.equal(names.includes('structured_command_output_show'), true);

  console.log('structured-command-mcp protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
