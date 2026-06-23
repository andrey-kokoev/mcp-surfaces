import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'surface-feedback-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const child = spawn(process.execPath, [serverPath, '--feedback-root', root], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

try {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);

  const responses = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const init = responses.find((m) => m.id === 1);
  assert.equal((init.result as Record<string, any>).serverInfo.name, 'surface-feedback-mcp');

  const tools = (responses.find((m) => m.id === 2).result as Record<string, any>).tools;
  assert.deepEqual(tools.map((t: { name: string }) => t.name), ['surface_feedback_doctor', 'surface_feedback_submit', 'surface_feedback_update_status', 'surface_feedback_update_status_batch', 'surface_feedback_import', 'surface_feedback_list', 'surface_feedback_show', 'surface_feedback_stats']);

  const subTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'surface_feedback_submit');
  assert.equal(subTool.annotations.readOnlyHint, false);

  const listTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'surface_feedback_list');
  assert.equal(listTool.annotations.readOnlyHint, true);

  console.log('surface-feedback-mcp protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
