import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';
import { writeSpeechTestRegistry } from './test-registry.js';

const root = mkdtempSync(join(tmpdir(), 'speech-mcp-protocol-'));
const registryPath = writeSpeechTestRegistry(root);
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--provider-registry-path', registryPath], { label: 'speech-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'speech-mcp' });
  const tools = protocol.tools.tools as Record<string, any>[];
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ['speech_guidance', 'speech_speak', 'speech_voices', 'speech_listen_status', 'speech_capture_transcribe', 'speech_prompt_capture_response', 'speech_listen_start', 'speech_listen_stop']);

  const speakTool = tools.find((tool: { name: string; annotations: Record<string, unknown>; inputSchema: Record<string, any> }) => tool.name === 'speech_speak');
  assert.equal(speakTool.annotations.readOnlyHint, false);
  assert.ok(speakTool.inputSchema.properties.text);
  assert.ok(speakTool.inputSchema.properties.selection);
  assert.equal(speakTool.inputSchema.properties.provider, undefined);
  assert.equal(speakTool.inputSchema.properties.model, undefined);
  assert.equal(speakTool.inputSchema.properties.api_key, undefined);
  assert.ok(speakTool.inputSchema.properties.output_path);
  assert.ok(speakTool.inputSchema.properties.retain_audio);
  assert.ok(speakTool.inputSchema.properties.selection['x-narada-registry-catalog'].some((entry: Record<string, unknown>) => entry.provider === 'openai-api'));

  const captureTool = tools.find((tool: { name: string; annotations: Record<string, unknown>; inputSchema: Record<string, any> }) => tool.name === 'speech_capture_transcribe');
  assert.equal(captureTool.annotations.readOnlyHint, false);
  assert.ok(captureTool.inputSchema.properties.selection);
  assert.equal(captureTool.inputSchema.properties.provider, undefined);
  assert.equal(captureTool.inputSchema.properties.model, undefined);
  assert.equal(captureTool.inputSchema.properties.api_key, undefined);

  const promptCaptureTool = tools.find((tool: { name: string; annotations: Record<string, unknown>; inputSchema: Record<string, any> }) => tool.name === 'speech_prompt_capture_response');
  assert.equal(promptCaptureTool.annotations.readOnlyHint, false);
  assert.deepEqual(promptCaptureTool.inputSchema.required, ['text']);
  assert.ok(promptCaptureTool.inputSchema.properties.tts_selection);
  assert.ok(promptCaptureTool.inputSchema.properties.transcription_selection);
  assert.equal(promptCaptureTool.inputSchema.properties.tts_model, undefined);
  assert.equal(promptCaptureTool.inputSchema.properties.model, undefined);
  assert.equal(promptCaptureTool.inputSchema.properties.api_key, undefined);

  const listenStartTool = tools.find((tool: { name: string; annotations: Record<string, unknown>; inputSchema: Record<string, any> }) => tool.name === 'speech_listen_start');
  assert.equal(listenStartTool.annotations.readOnlyHint, false);
  assert.ok(listenStartTool.inputSchema.properties.selection);
  assert.equal(listenStartTool.inputSchema.properties.provider, undefined);
  assert.ok(listenStartTool.inputSchema.properties.duration_seconds);

  const listenStatusTool = tools.find((tool: { name: string; annotations: Record<string, unknown> }) => tool.name === 'speech_listen_status');
  assert.equal(listenStatusTool.annotations.readOnlyHint, true);

  const listenStopTool = tools.find((tool: { name: string; annotations: Record<string, unknown> }) => tool.name === 'speech_listen_stop');
  assert.equal(listenStopTool.annotations.idempotentHint, true);

  console.log('speech-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
