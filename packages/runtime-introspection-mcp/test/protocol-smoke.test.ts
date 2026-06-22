import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

try {
  writeFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  writeFrame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  writeFrame({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'runtime_introspection_analyze',
      arguments: {
        format: 'generic-events',
        events: [
          {
            event_id: 'smoke-1',
            timestamp: '2026-06-20T14:00:00.000Z',
            input_adapter: 'mcp',
            kind: 'tool_call',
            status: 'ok',
            surface_id: 'local-filesystem',
            tool_name: 'fs_read_file',
            duration_ms: 4,
          },
        ],
      },
    },
  });
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);

  const responses = parseFrames(stdout);
  assert.equal(responses.find((message) => message.id === 1)?.result.serverInfo.name, 'runtime-introspection-mcp');
  const listedTools = responses.find((message) => message.id === 2)?.result.tools;
  assert.deepEqual(listedTools.map((tool) => tool.name), [
    'runtime_introspection_formats',
    'runtime_introspection_analyze',
    'runtime_introspection_top',
    'runtime_introspection_show',
  ]);
  assert.equal(listedTools.every((tool) => tool.annotations.readOnlyHint === true), true);
  const analysis = responses.find((message) => message.id === 3)?.result.structuredContent;
  assert.equal(analysis.schema, 'narada.runtime_introspection.analysis.v1');
  assert.equal(analysis.summary.event_count, 1);
  assert.equal(analysis.counts.by_surface['local-filesystem'], 1);
  assert.equal(stderr.trim(), '');

  console.log('runtime-introspection-mcp protocol smoke ok');
} finally {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.kill();
}

function writeFrame(value: unknown) {
  const body = JSON.stringify(value);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function parseFrames(output: string): any[] {
  const messages = [];
  let remaining = output;
  while (remaining.length > 0) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    assert.notEqual(headerEnd, -1, `missing frame header in ${remaining}`);
    const header = remaining.slice(0, headerEnd);
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    assert.ok(Number.isInteger(length));
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    messages.push(JSON.parse(remaining.slice(bodyStart, bodyEnd)));
    remaining = remaining.slice(bodyEnd);
  }
  return messages;
}
