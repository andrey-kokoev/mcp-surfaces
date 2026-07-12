import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'surface-feedback-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--feedback-root', root], { label: 'surface-feedback-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'surface-feedback-mcp' });
  const tools = protocol.tools.tools as Record<string, any>[];
  assert.deepEqual(tools.map((t: { name: string }) => t.name), ['surface_feedback_guidance', 'surface_feedback_doctor', 'surface_feedback_submit', 'surface_feedback_live_proof_template', 'surface_feedback_update_status', 'surface_feedback_convert_to_task', 'surface_feedback_update_status_batch', 'surface_feedback_import', 'surface_feedback_list', 'surface_feedback_actionable_queue', 'surface_feedback_show', 'surface_feedback_stats']);

  const subTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'surface_feedback_submit');
  assert.equal(subTool.annotations.readOnlyHint, false);

  const convertTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'surface_feedback_convert_to_task');
  assert.equal(convertTool.annotations.readOnlyHint, false);
  assert.equal(convertTool.annotations.idempotentHint, true);

  const listTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'surface_feedback_list');
  assert.equal(listTool.annotations.readOnlyHint, true);

  const queueTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'surface_feedback_actionable_queue');
  assert.equal(queueTool.annotations.readOnlyHint, true);

  console.log('surface-feedback-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
