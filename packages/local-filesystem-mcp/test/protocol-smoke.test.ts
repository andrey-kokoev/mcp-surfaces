import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'local-filesystem-mcp-protocol-'));

try {
  const state = createServerState({
    mode: 'write',
    allowedRoots: [root],
    outputRoot: root,
  });

  const init = handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  }, state);
  assert.equal(init.error, undefined);
  assert.equal(init.result.serverInfo.name, 'local-filesystem-write');

  const tools = handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }, state);
  assert.equal(tools.error, undefined);
  const names = tools.result.tools.map((tool) => tool.name);
  assert.equal(names.includes('fs_read_file'), true);
  assert.equal(names.includes('fs_write_file'), true);
  assert.equal(names.includes('mcp_output_show'), true);

  console.log('local-filesystem-mcp protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
