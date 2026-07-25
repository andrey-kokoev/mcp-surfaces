import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import { drainJsonRpcFrames, runJsonRpcStdioServer } from '../src/kernel/stdio-json-rpc.js';

const stdin: any = Readable.from(['{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"progressToken":"task-progress"}}}\n']);
const stdout: any = new PassThrough();
let output: any = '';
stdout.setEncoding('utf8');
stdout.on('data', (chunk: any) => { output += chunk; });

await runJsonRpcStdioServer({
  stdin,
  stdout,
  parseJsonRpcInput: (text: any) => [JSON.parse(text)],
  handleRequest: async (request: any) => ({ jsonrpc: '2.0', id: request.id, result: { status: 'ok' } }),
});
stdout.end();
await once(stdout, 'end');

const lines: any = output.trim().split(/\r?\n/).filter(Boolean);
assert.equal(lines.length, 3);
assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'task-progress', progress: 0, total: 1, message: 'started' } });
assert.deepEqual(JSON.parse(lines[1]), { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'task-progress', progress: 1, total: 1, message: 'completed' } });
assert.deepEqual(JSON.parse(lines[2]), { jsonrpc: '2.0', id: 1, result: { status: 'ok' } });

const framedBodyOne: any = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'echo', params: { text: 'Unicode: ☃️ café' } });
const framedBodyTwo: any = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'echo', params: { text: 'second frame' } });
const frame: any = (body: any) => Buffer.concat([
  Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`, 'ascii'),
  Buffer.from(body, 'utf8'),
]);
const framedInput: any = Buffer.concat([frame(framedBodyOne), frame(framedBodyTwo)]);
const unicodeByte: any = framedInput.indexOf(Buffer.from('☃', 'utf8'));
const framedStdin: any = Readable.from([
  framedInput.subarray(0, unicodeByte + 1),
  framedInput.subarray(unicodeByte + 1),
]);
const framedStdout: any = new PassThrough();
const framedOutput: any[] = [];
framedStdout.on('data', (chunk: any) => framedOutput.push(Buffer.from(chunk)));

await runJsonRpcStdioServer({
  stdin: framedStdin,
  stdout: framedStdout,
  parseJsonRpcInput: (text: any) => [JSON.parse(text)],
  handleRequest: async (request: any) => ({ jsonrpc: '2.0', id: request.id, result: { text: request.params.text } }),
});
framedStdout.end();
await once(framedStdout, 'end');

const framedResponses: any = drainJsonRpcFrames(Buffer.concat(framedOutput));
assert.equal(framedResponses.remaining.length, 0);
assert.deepEqual(framedResponses.requests, [
  { jsonrpc: '2.0', id: 2, result: { text: 'Unicode: ☃️ café' } },
  { jsonrpc: '2.0', id: 3, result: { text: 'second frame' } },
]);

console.log('task-lifecycle-mcp stdio smoke ok');
