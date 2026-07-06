import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'speech-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

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
  assert.equal((init.result as Record<string, any>).serverInfo.name, 'speech-mcp');

  const tools = (responses.find((m) => m.id === 2).result as Record<string, any>).tools;
  assert.deepEqual(tools.map((t: { name: string }) => t.name), ['speech_guidance', 'speech_speak', 'speech_voices', 'speech_listen_status', 'speech_capture_transcribe', 'speech_prompt_capture_response', 'speech_listen_start', 'speech_listen_stop']);

  const speakTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'speech_speak');
  assert.equal(speakTool.annotations.readOnlyHint, false);
  assert.ok(speakTool.inputSchema.properties.text);
  assert.ok(speakTool.inputSchema.properties.voice);
  assert.ok(speakTool.inputSchema.properties.rate);
  assert.ok(speakTool.inputSchema.properties.provider);
  assert.ok(speakTool.inputSchema.properties.model);
  assert.ok(speakTool.inputSchema.properties.speed);
  assert.ok(speakTool.inputSchema.properties.api_key);
  assert.ok(speakTool.inputSchema.properties.output_path);
  assert.ok(speakTool.inputSchema.properties.retain_audio);

  const captureTool = tools.find((t: { name: string; annotations: Record<string, unknown>; inputSchema: Record<string, any> }) => t.name === 'speech_capture_transcribe');
  assert.equal(captureTool.annotations.readOnlyHint, false);
  assert.deepEqual(captureTool.inputSchema.properties.provider.enum, ['remote_transcription']);
  assert.deepEqual(captureTool.inputSchema.properties.model.enum, ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']);

  const promptCaptureTool = tools.find((t: { name: string; annotations: Record<string, unknown>; inputSchema: Record<string, any> }) => t.name === 'speech_prompt_capture_response');
  assert.equal(promptCaptureTool.annotations.readOnlyHint, false);
  assert.deepEqual(promptCaptureTool.inputSchema.required, ['text']);
  assert.deepEqual(promptCaptureTool.inputSchema.properties.tts_model.enum, ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);
  assert.deepEqual(promptCaptureTool.inputSchema.properties.model.enum, ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']);

  const listenStartTool = tools.find((t: { name: string; annotations: Record<string, unknown>; inputSchema: Record<string, any> }) => t.name === 'speech_listen_start');
  assert.equal(listenStartTool.annotations.readOnlyHint, false);
  assert.deepEqual(listenStartTool.inputSchema.properties.provider.enum, ['local_sapi', 'remote_transcription']);
  assert.ok(listenStartTool.inputSchema.properties.duration_seconds);

  const listenStatusTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'speech_listen_status');
  assert.equal(listenStatusTool.annotations.readOnlyHint, true);

  const listenStopTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'speech_listen_stop');
  assert.equal(listenStopTool.annotations.idempotentHint, true);

  console.log('speech-mcp protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
