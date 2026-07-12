import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  asRecord,
  createJsonlClient,
  createTemporaryE2eRoot,
  readMcpOutputText,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnContentLengthMcpServer,
  spawnJsonlMcpServer,
  structured,
  tomlPath,
} from '../src/main.js';

const fixture = spawnJsonlMcpServer(process.execPath, [
  '-e',
  [
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { for (const line of chunk.split(/\\r?\\n/).filter(Boolean)) { const request = JSON.parse(line); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { structuredContent: { schema: 'fixture.response.v1', method: request.method } } }) + '\\n'); } });",
  ].join('\n'),
], { label: 'mcp-e2e-harness-fixture', timeoutMs: 2_000 });

const response = await fixture.client.request(1, 'initialize', { protocolVersion: '2024-11-05' });
assert.equal(structured(response).schema, 'fixture.response.v1');
assert.equal(structured(response).method, 'initialize');
await fixture.close();

const framedFixture = spawnContentLengthMcpServer(process.execPath, [
  '-e',
  [
    "let buffer = Buffer.alloc(0);",
    "const separator = String.fromCharCode(13, 10, 13, 10);",
    "process.stdin.on('data', (chunk) => {",
    "  buffer = Buffer.concat([buffer, chunk]);",
    "  while (true) {",
    "    const headerEnd = buffer.indexOf(separator);",
    "    if (headerEnd < 0) break;",
    "    const header = buffer.subarray(0, headerEnd).toString('utf8');",
    "    const match = /Content-Length:[ ]*([0-9]+)/i.exec(header);",
    "    if (!match) throw new Error('missing content length');",
    "    const bodyStart = headerEnd + separator.length;",
    "    const length = Number(match[1]);",
    "    if (buffer.length < bodyStart + length) break;",
    "    const request = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString('utf8'));",
    "    buffer = buffer.subarray(bodyStart + length);",
    "    const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { structuredContent: { schema: 'framed.fixture.v1', method: request.method } } });",
    "    process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + separator + body);",
    "  }",
    "});",
  ].join(String.fromCharCode(10)),
], { label: 'mcp-e2e-harness-framed-fixture', timeoutMs: 2_000 });

const framedResponse = await framedFixture.client.request(2, 'initialize', { protocolVersion: '2024-11-05' });
assert.equal(structured(framedResponse).schema, 'framed.fixture.v1');
assert.equal(structured(framedResponse).method, 'initialize');
await framedFixture.close();

const protocolFixture = spawnJsonlMcpServer(process.execPath, [
  '-e',
  [
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { for (const line of chunk.split(/\\r?\\n/).filter(Boolean)) { const request = JSON.parse(line); if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { serverInfo: { name: 'protocol-fixture' }, capabilities: { tools: {} } } }) + '\\n'); if (request.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'fixture_tool' }] } }) + '\\n'); } });",
  ].join('\n'),
], { label: 'mcp-e2e-harness-protocol-fixture', timeoutMs: 2_000 });
const protocol = await runMcpProtocolSmoke(protocolFixture.client, {
  expectedServerName: 'protocol-fixture',
  requiredTools: ['fixture_tool'],
});
assert.deepEqual(protocol.toolNames, ['fixture_tool']);
await protocolFixture.close();

const output = await readMcpOutputText(
  { output_text: '{"status":"', next_offset: 4 },
  async ({ offset }) => offset === 4
    ? { output_text: 'completed"}', next_offset: null }
    : {},
  { pageSize: 4 },
);
assert.equal(output.text, '{"status":"completed"}');
assert.equal(output.pages, 2);
await assert.rejects(
  () => readMcpOutputText(
    { output_text: '', next_offset: 0 },
    async () => ({ output_text: '', next_offset: 0 }),
    { initialReadOffset: 0 },
  ),
  /offset did not advance/,
);

assert.deepEqual(asRecord({ value: 1 }), { value: 1 });
assert.deepEqual(asRecord(null), {});
assert.equal(tomlPath('C:\\tmp\\value\"x'), 'C:/tmp/value\\"x');

const root = createTemporaryE2eRoot('shared harness test');
assert.equal(removeTemporaryE2eRoot(root), true);

const rawChild = spawn(process.execPath, [
  '-e',
  "process.stdin.on('data', () => process.stdout.write('\\n')); process.stdin.resume();",
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const client = createJsonlClient(rawChild, { label: 'raw-client-fixture', timeoutMs: 2_000 });
await client.close();

console.log(JSON.stringify({
  schema: 'narada.mcp.e2e.result.v1',
  test_id: 'mcp-e2e-harness',
  status: 'passed',
  shared_mechanics: ['jsonl_transport', 'content_length_transport', 'protocol_smoke', 'bounded_output_readback', 'bounded_child_cleanup', 'temporary_root', 'result_normalization'],
}));
