import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import { drainJsonRpcFrames, runJsonRpcStdioServer } from '../src/kernel/stdio-json-rpc.js';

const stdin = Readable.from(['{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"progressToken":"task-progress"}}}\n']);
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
assert.equal(lines.length, 3);
assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'task-progress', progress: 0, total: 1, message: 'started' } });
assert.deepEqual(JSON.parse(lines[1]), { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'task-progress', progress: 1, total: 1, message: 'completed' } });
assert.deepEqual(JSON.parse(lines[2]), { jsonrpc: '2.0', id: 1, result: { status: 'ok' } });

const framedBodyOne = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'echo', params: { text: 'Unicode: ☃️ café' } });
const framedBodyTwo = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'echo', params: { text: 'second frame' } });
const frame = (body) => Buffer.concat([
  Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`, 'ascii'),
  Buffer.from(body, 'utf8'),
]);
const framedInput = Buffer.concat([frame(framedBodyOne), frame(framedBodyTwo)]);
const unicodeByte = framedInput.indexOf(Buffer.from('☃', 'utf8'));
const framedStdin = Readable.from([
  framedInput.subarray(0, unicodeByte + 1),
  framedInput.subarray(unicodeByte + 1),
]);
const framedStdout = new PassThrough();
const framedOutput = [];
framedStdout.on('data', (chunk) => framedOutput.push(Buffer.from(chunk)));

await runJsonRpcStdioServer({
  stdin: framedStdin,
  stdout: framedStdout,
  parseJsonRpcInput: (text) => [JSON.parse(text)],
  handleRequest: async (request) => ({ jsonrpc: '2.0', id: request.id, result: { text: request.params.text } }),
});
framedStdout.end();
await once(framedStdout, 'end');

const framedResponses = drainJsonRpcFrames(Buffer.concat(framedOutput));
assert.equal(framedResponses.remaining.length, 0);
assert.deepEqual(framedResponses.requests, [
  { jsonrpc: '2.0', id: 2, result: { text: 'Unicode: ☃️ café' } },
  { jsonrpc: '2.0', id: 3, result: { text: 'second frame' } },
]);

console.log('task-lifecycle-mcp stdio smoke ok');
