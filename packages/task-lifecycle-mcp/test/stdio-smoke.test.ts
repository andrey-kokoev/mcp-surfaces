import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainJsonRpcFrames, runJsonRpcStdioServer } from '../src/kernel/stdio-json-rpc.js';
import { runTaskLifecycleMcpStdioServer } from '../src/task-lifecycle/task-mcp-server.js';

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

const unpreparedRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-mcp-stdio-unprepared-'));
const realStdin = Readable.from([
  JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n',
  JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list', params: {} }) + '\n',
  JSON.stringify({ jsonrpc: '2.0', id: 103, method: 'tools/call', params: { name: 'task_lifecycle_doctor', arguments: {} } }) + '\n',
  JSON.stringify({ jsonrpc: '2.0', id: 104, method: 'tools/call', params: { name: 'task_lifecycle_list', arguments: {} } }) + '\n',
]);
const realStdout: any = new PassThrough();
let realOutput = '';
realStdout.setEncoding('utf8');
realStdout.on('data', (chunk: any) => { realOutput += chunk; });

await runTaskLifecycleMcpStdioServer({
  stdin: realStdin,
  stdout: realStdout,
  stderr: { write: () => true },
  argv: ['--site-root', unpreparedRoot],
  cwd: unpreparedRoot,
  env: { ...process.env, NARADA_AGENT_ID: 'stdio-smoke', NARADA_TASK_LIFECYCLE_FAST_SQLITE: '0' },
});
realStdout.end();
await once(realStdout, 'end');

const realResponses = realOutput.trim().split(/\r?\n/).filter(Boolean).map((line: any) => JSON.parse(line));
const realResponsesById = new Map(realResponses.map((response: any) => [response.id, response]));
assert.equal(realResponsesById.get(101)?.result?.serverInfo?.name, 'narada-task-lifecycle-mcp');
assert.equal(Array.isArray(realResponsesById.get(102)?.result?.tools), true);
assert.equal(realResponsesById.get(103)?.result?.structuredContent?.preparation?.status, 'missing');
assert.equal(realResponsesById.get(104)?.error?.data?.schema, 'narada.task_lifecycle.not_ready.v1');
assert.equal(realResponsesById.get(104)?.error?.data?.remediation?.prepare_command, 'task-lifecycle-mcp --prepare --site-root <site-root>');

console.log('task-lifecycle-mcp stdio smoke ok');
