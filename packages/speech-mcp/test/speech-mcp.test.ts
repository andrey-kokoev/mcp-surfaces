import assert from 'node:assert/strict';
import { buildListenAdapterArgs, createServerState, handleRequest, resolveOpenAiApiKey } from '../src/main.js';

const state = createServerState({});

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as Promise<Record<string, any>>;
}
function view(res: Record<string, any>): Record<string, any> {
  return res.result.structuredContent as Record<string, any>;
}

const sapiVoices = view(await call('speech_voices', { provider: 'sapi' }));
assert.equal(sapiVoices.status, 'ok');
assert.equal(sapiVoices.provider, 'sapi');
assert.ok(Array.isArray(sapiVoices.voices));
assert.ok(sapiVoices.count >= 1, `Expected at least 1 SAPI voice, got ${sapiVoices.count}`);

const openaiVoices = view(await call('speech_voices', { provider: 'openai_api' }));
assert.equal(openaiVoices.status, 'ok');
assert.equal(openaiVoices.provider, 'openai_api');
assert.deepEqual(openaiVoices.voices, ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
assert.equal(openaiVoices.count, 6);

const sapiSpoken = view(await call('speech_speak', { text: 'This is a test. One two three.', provider: 'sapi' }));
assert.equal(sapiSpoken.status, 'spoken');
assert.equal(sapiSpoken.provider, 'sapi');

const originalSecretStoreMode = process.env.NARADA_PROVIDER_SECRET_STORE;
process.env.NARADA_PROVIDER_SECRET_STORE = 'disabled';
try {
  const openaiNoKey = await call('speech_speak', { text: 'Hello', provider: 'openai_api' });
  assert.ok(openaiNoKey.error, 'Expected error for openai_api without key');
  assert.match(openaiNoKey.error.data.message, /speech_openai_no_key/);
} finally {
  if (originalSecretStoreMode === undefined) delete process.env.NARADA_PROVIDER_SECRET_STORE;
  else process.env.NARADA_PROVIDER_SECRET_STORE = originalSecretStoreMode;
}

assert.equal(resolveOpenAiApiKey({ api_key: 'explicit-key' }, state, {}), 'explicit-key');
assert.equal(resolveOpenAiApiKey({}, state, { OPENAI_API_KEY: 'env-key' } as NodeJS.ProcessEnv), 'env-key');

const secretLookupState = createServerState({
  secretLookupCommand: process.execPath,
  secretLookupCommandArgs: ['-e', "if (process.env.NARADA_SECRET_LOOKUP_NAME === 'narada/provider/openai-api/api-key') process.stdout.write('secretstore-key')"],
});
assert.equal(resolveOpenAiApiKey({}, secretLookupState, {}), 'secretstore-key');

assert.equal(resolveOpenAiApiKey({}, state, { NARADA_PROVIDER_SECRET_STORE: 'disabled' } as NodeJS.ProcessEnv), null);

const listenBlockedState = createServerState({ listenAdapterPath: 'D:/definitely/missing/Start-VoiceIntentLocalMonitor.ps1' });
const listenStatus = view(await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_listen_status', arguments: {} } }, listenBlockedState) as Record<string, any>);
assert.equal(listenStatus.status, 'blocked');
assert.equal((listenStatus.adapter as Record<string, unknown>).ready, false);
assert.deepEqual((listenStatus.policy as Record<string, any>).allowed_providers, ['local_sapi']);
assert.equal((listenStatus.policy as Record<string, any>).audio_cues, true);

const missingAdapterStart = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_listen_start', arguments: { provider: 'local_sapi', duration_seconds: 5 } } }, listenBlockedState) as Record<string, any>;
assert.ok(missingAdapterStart.error, 'Expected missing adapter refusal');
assert.equal(missingAdapterStart.error.data.code, 'speech_listen_adapter_missing');
assert.match(missingAdapterStart.error.data.details.remediation, /Start-VoiceIntentLocalMonitor\.ps1/);

const remoteAudioRefused = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_listen_start', arguments: { provider: 'remote_transcription' } } }, listenBlockedState) as Record<string, any>;
assert.equal(remoteAudioRefused.error.data.code, 'speech_remote_audio_egress_not_admitted');

const remoteAudioAdmittedState = createServerState({ allowRemoteAudioEgress: true, listenAdapterPath: 'D:/definitely/missing/Start-VoiceIntentLocalMonitor.ps1' });
const remoteAudioAdmittedStatus = view(await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_listen_status', arguments: {} } }, remoteAudioAdmittedState) as Record<string, any>);
assert.deepEqual((remoteAudioAdmittedStatus.policy as Record<string, any>).allowed_providers, ['local_sapi', 'remote_transcription']);

assert.deepEqual(
  buildListenAdapterArgs('D:/voice/Start-VoiceIntentLocalMonitor.ps1', 'local_sapi', 12, 'listen-test', true),
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/voice/Start-VoiceIntentLocalMonitor.ps1', '-DurationSeconds', '12', '-Calibrate', '-DisableDebugAudioCues'],
);

assert.deepEqual(
  buildListenAdapterArgs('D:/voice/Start-VoiceIntentLocalMonitor.ps1', 'local_sapi', 12, 'listen-test', false),
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/voice/Start-VoiceIntentLocalMonitor.ps1', '-DurationSeconds', '12', '-DisableDebugAudioCues'],
);

if (process.env.OPENAI_API_KEY) {
  const openaiSpoken = view(await call('speech_speak', { text: 'OpenAI TTS test.', provider: 'openai_api' }));
  assert.equal(openaiSpoken.status, 'spoken');
  assert.equal(openaiSpoken.provider, 'openai_api');
  console.log('openai_api speak ok');
}

console.log('speech-mcp behavior ok');
