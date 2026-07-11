import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCaptureTranscribeAdapterArgs, buildListenAdapterArgs, compactMonitorResult, createServerState, handleRequest, parseArgs, resolveOpenAiApiKey, transcriptFromMonitorResult } from '../src/main.js';
import { drainJsonRpcFrames } from '../src/protocol.js';
import { writeSpeechTestRegistry } from './test-registry.js';

const root = mkdtempSync(join(tmpdir(), 'speech-mcp-test-'));
const registryPath = writeSpeechTestRegistry(root);
const missingAdapterPath = join(root, 'missing', 'Start-VoiceIntentLocalMonitor.ps1');

function newState(options: Record<string, unknown> = {}) {
  return createServerState({ providerRegistryPath: registryPath, listenAdapterPath: missingAdapterPath, announceSpeaker: false, ...options });
}

const state = newState({ audibleOutputForTest: (event: Record<string, unknown>) => ({ status: 'spoken', provider: event.provider, text: event.text }) });

async function call(name: string, args: Record<string, unknown>, targetState = state): Promise<Record<string, any>> {
  return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, targetState) as Promise<Record<string, any>>;
}

function view(response: Record<string, any>): Record<string, any> {
  return response.result.structuredContent as Record<string, any>;
}

const defaultSpeech = view(await call('speech_speak', { text: 'registry default' }));
assert.equal(defaultSpeech.status, 'spoken');
assert.deepEqual(defaultSpeech.resolved_selection, { provider: 'sapi', model: 'default', capability: 'tts', adapter: 'sapi', status: 'active' });
assert.equal(defaultSpeech.selection_source, 'registry');

const explicitSpeech = view(await call('speech_speak', { text: 'explicit local', selection: { provider: 'sapi', model: 'default' } }));
assert.equal(explicitSpeech.selection_source, 'request');
assert.equal(explicitSpeech.resolved_selection.provider, 'sapi');
assert.equal((await call('speech_speak', { text: 'legacy', provider: 'sapi' })).error.data.code, 'speech_legacy_selection_argument');
assert.equal((await call('speech_speak', { text: 'legacy', selection: { provider: 'openai-api' }, api_key: 'no' })).error.data.code, 'speech_legacy_selection_argument');

const openaiVoices = view(await call('speech_voices', { selection: { provider: 'openai-api' } }));
assert.equal(openaiVoices.provider, 'openai-api');
assert.equal(openaiVoices.model, 'tts-1');
assert.deepEqual(openaiVoices.voices.map((voice: Record<string, string>) => voice.id), ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
assert.equal(openaiVoices.resolved_selection.voice, 'nova');

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalSecretStoreMode = process.env.NARADA_PROVIDER_SECRET_STORE;
const noKeyState = newState();
delete process.env.OPENAI_API_KEY;
process.env.NARADA_PROVIDER_SECRET_STORE = 'disabled';
try {
  assert.equal((await call('speech_speak', { text: 'no key', selection: { provider: 'openai-api' } }, noKeyState)).error.data.code, 'speech_provider_no_key');
} finally {
  if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  if (originalSecretStoreMode === undefined) delete process.env.NARADA_PROVIDER_SECRET_STORE;
  else process.env.NARADA_PROVIDER_SECRET_STORE = originalSecretStoreMode;
}
assert.equal(resolveOpenAiApiKey(state, 'openai-api', { OPENAI_API_KEY: 'env-key' } as NodeJS.ProcessEnv), 'env-key');
const secretLookupState = newState({ secretLookupCommand: process.execPath, secretLookupCommandArgs: ['-e', "if (process.env.NARADA_SECRET_LOOKUP_NAME === 'narada/provider/openai-api/api-key') process.stdout.write('secretstore-key')"] });
assert.equal(resolveOpenAiApiKey(secretLookupState, 'openai-api', {}), 'secretstore-key');
assert.equal(resolveOpenAiApiKey(state, 'openai-api', { NARADA_PROVIDER_SECRET_STORE: 'disabled' } as NodeJS.ProcessEnv), null);

const tools = ((await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state)) as Record<string, any>).result.tools;
const speakTool = tools.find((tool: Record<string, any>) => tool.name === 'speech_speak');
assert.ok(speakTool.inputSchema.properties.selection);
assert.equal(speakTool.inputSchema.properties.api_key, undefined);
assert.equal(speakTool.inputSchema.properties.provider, undefined);
assert.ok(speakTool.inputSchema.properties.selection['x-narada-registry-catalog'].some((entry: Record<string, unknown>) => entry.provider === 'openai-api'));
const promptTool = tools.find((tool: Record<string, any>) => tool.name === 'speech_prompt_capture_response');
assert.ok(promptTool.inputSchema.properties.tts_selection);
assert.ok(promptTool.inputSchema.properties.transcription_selection);
const guidance = view(await call('speech_guidance', {}));
assert.equal((guidance.provider_registry as Record<string, unknown>).path, registryPath);

const listenStatus = view(await call('speech_listen_status', {}));
assert.equal(listenStatus.status, 'blocked');
assert.equal((listenStatus.policy as Record<string, any>).default_selection.provider, 'sapi');
assert.deepEqual((listenStatus.policy as Record<string, any>).allowed_providers, ['sapi']);
assert.equal((await call('speech_listen_start', { provider: 'local_sapi' })).error.data.code, 'speech_legacy_selection_argument');
assert.equal((await call('speech_listen_start', { selection: { provider: 'sapi' } })).error.data.code, 'speech_listen_adapter_missing');
assert.equal((await call('speech_listen_start', { selection: { provider: 'openai-api' } })).error.data.code, 'speech_remote_audio_egress_not_admitted');
assert.equal((await call('speech_capture_transcribe', {})).error.data.code, 'speech_listen_adapter_missing');
assert.equal((await call('speech_capture_transcribe', { selection: { provider: 'openai-api' } })).error.data.code, 'speech_remote_audio_egress_not_admitted');
assert.equal((await call('speech_prompt_capture_response', { text: 'Hello', tts_provider: 'sapi' })).error.data.code, 'speech_legacy_selection_argument');

assert.deepEqual(buildCaptureTranscribeAdapterArgs('D:/voice/Start-VoiceIntentLocalMonitor.ps1', { input_wav: 'D:/tmp/input.wav', retain_audio: false }, 7, false), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/voice/Start-VoiceIntentLocalMonitor.ps1', '-DurationSeconds', '7', '-RetainAudio', '-DispatchDryRun', '-PassThru', '-InputWav', 'D:/tmp/input.wav', '-DisableDebugAudioCues']);
assert.deepEqual(buildListenAdapterArgs('D:/voice/Start-VoiceIntentLocalMonitor.ps1', 'openai-transcription', 12, 'listen-test', true), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/voice/Start-VoiceIntentLocalMonitor.ps1', '-DurationSeconds', '12', '-RecognitionAdapter', 'openai-transcriptions', '-Calibrate', '-DisableDebugAudioCues']);