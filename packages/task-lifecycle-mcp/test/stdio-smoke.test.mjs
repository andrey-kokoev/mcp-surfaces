import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import { runJsonRpcStdioServer } from '../src/kernel/stdio-json-rpc.mjs';

const stdin = Readable.from(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n']);
const stdout = new PassThrough();
let output = '';
stdout.setEncoding('utf8');
stdout.on('data', (chunk) => { output += chunk; });

await runJsonRpcStdioServer({
  stdin,
  stdout,
  parseJsonRpcInput: (text) => [JSON.parse(text)],
  handleRequest: async (request) => ({ jsonrpc: '2.0', id: request.id, result: { status: 'ok' } }),
});
stdout.end();
await once(stdout, 'end');

const lines = output.trim().split(/\r?\n/).filter(Boolean);
assert.equal(lines.length, 1);
assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 1, result: { status: 'ok' } });

console.log('task-lifecycle-mcp stdio smoke ok');
