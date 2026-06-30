import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'completion-audit-mcp-protocol-'));

try {
  const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const child = spawn(process.execPath, [serverPath, '--audit-root', root, '--allowed-root', root], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  writeFrame(child.stdin, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  writeFrame(child.stdin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  writeFrame(child.stdin, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'completion_audit_record',
      arguments: {
        audit_id: 'protocol-audit',
        objective: 'protocol smoke',
        items: [
          { requirement: 'stdio writes audit', evidence: 'protocol smoke test', verdict: 'proved' },
        ],
      },
    },
  });
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);

  const responses = parseFrames(stdout);
  assert.equal(responses.find((message) => message.id === 1)?.result.serverInfo.name, 'completion-audit-mcp');
  const tools = responses.find((message) => message.id === 2)?.result.tools.map((tool) => tool.name);
  assert.deepEqual(tools, ['completion_audit_guidance', 'completion_audit_record']);
  const audit = responses.find((message) => message.id === 3)?.result.structuredContent;
  assert.equal(audit.audit_id, 'protocol-audit');
  assert.equal(audit.completion_proved, true);
  assert.equal(existsSync(join(root, 'completion-audits.jsonl')), true);
  assert.match(readFileSync(join(root, 'completion-audits.jsonl'), 'utf8'), /protocol-audit/);

  console.log('completion-audit-mcp protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}

function writeFrame(stdin: NodeJS.WritableStream, value: unknown) {
  const body = JSON.stringify(value);
  stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
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
