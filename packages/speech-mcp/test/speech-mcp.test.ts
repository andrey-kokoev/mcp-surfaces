import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCaptureTranscribeAdapterArgs, buildListenAdapterArgs, compactMonitorResult, createServerState, handleRequest, parseArgs, resolveOpenAiApiKey, transcriptFromMonitorResult } from '../src/main.js';
import { drainJsonRpcFrames } from '../src/protocol.js';

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

const sapiSpoken = view(await call('speech_speak', { text: 'This is a test. One two three.', provider: 'sapi', speaker_agent_id: 'speech-test.agent' }));
assert.equal(sapiSpoken.status, 'spoken');
assert.equal(sapiSpoken.provider, 'sapi');
assert.equal(sapiSpoken.speaker_announcement_audio.provider, 'sapi');
assert.match(sapiSpoken.speaker_announcement_audio.path, /\.wav$/);

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

const audibleLockDir = join(tmpdir(), `speech-mcp-audible-test-${process.pid}-${Date.now()}.lock`);
let activeAudibleOutputs = 0;
let maxActiveAudibleOutputs = 0;
let releaseFirstAudibleOutput: (() => void) | null = null;
const firstAudibleOutputGate = new Promise<void>((resolve) => { releaseFirstAudibleOutput = resolve; });
const audibleEvents: string[] = [];
const queuedSpeechState = createServerState({
  announceSpeaker: false,
  audibleOutputLockDir: audibleLockDir,
  audibleOutputForTest: async (event: Record<string, unknown>) => {
    const text = String(event.text ?? '');
    activeAudibleOutputs++;
    maxActiveAudibleOutputs = Math.max(maxActiveAudibleOutputs, activeAudibleOutputs);
    audibleEvents.push(`start:${text}`);
    if (text === 'first') await firstAudibleOutputGate;
    await new Promise((resolve) => setTimeout(resolve, 10));
    audibleEvents.push(`end:${text}`);
    activeAudibleOutputs--;
    return { status: 'spoken', provider: String(event.provider ?? 'sapi'), text };
  },
});
try {
  const firstSpeak = handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_speak', arguments: { text: 'first', provider: 'sapi' } } }, queuedSpeechState) as Promise<Record<string, any>>;
  await new Promise((resolve) => setTimeout(resolve, 25));
  const secondSpeak = handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'speech_speak', arguments: { text: 'second', provider: 'sapi' } } }, queuedSpeechState) as Promise<Record<string, any>>;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(audibleEvents, ['start:first']);

  const captureWhileSpeaking = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'speech_capture_transcribe', arguments: { provider: 'remote_transcription' } } }, queuedSpeechState) as Record<string, any>;
  assert.equal(captureWhileSpeaking.error.data.code, 'speech_remote_audio_egress_not_admitted');

  releaseFirstAudibleOutput?.();
  const [firstResult, secondResult] = await Promise.all([firstSpeak, secondSpeak]);
  assert.equal(view(firstResult).status, 'spoken');
  assert.equal(view(secondResult).status, 'spoken');
  assert.equal(maxActiveAudibleOutputs, 1);
  assert.deepEqual(audibleEvents, ['start:first', 'end:first', 'start:second', 'end:second']);
  assert.equal(view(firstResult).audible_output.serialized, true);
  assert.equal(view(firstResult).audible_output.lock_scope, 'host');
} finally {
  rmSync(audibleLockDir, { recursive: true, force: true });
}

let announcedSpeechText = '';
const announcedSpeechState = createServerState({
  announceSpeaker: true,
  audibleOutputLockDir: join(tmpdir(), `speech-mcp-speaker-test-${process.pid}-${Date.now()}.lock`),
  audibleOutputForTest: (event: Record<string, unknown>) => {
    announcedSpeechText = String(event.text ?? '');
    return { status: 'spoken', provider: String(event.provider ?? 'sapi'), text: announcedSpeechText };
  },
});
try {
  const announcedSpeech = view(await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_speak', arguments: { text: 'hello operator', provider: 'sapi', speaker_agent_id: 'narada-test.agent' } } }, announcedSpeechState) as Record<string, any>);
  assert.equal(announcedSpeechText, 'narada-test.agent here: hello operator');
  assert.equal(announcedSpeech.speaker_announcement.announced, true);
  assert.equal(announcedSpeech.speaker_announcement.agent_id, 'narada-test.agent');
  assert.equal(announcedSpeech.speaker_announcement.prefix_text, 'narada-test.agent here:');
  assert.equal(announcedSpeech.requested_text_length, 'hello operator'.length);
  assert.equal(announcedSpeech.spoken_text_length, 'narada-test.agent here: hello operator'.length);

  const unannouncedSpeech = view(await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'speech_speak', arguments: { text: 'quiet message', provider: 'sapi', speaker_agent_id: 'narada-test.agent', announce_speaker: false } } }, announcedSpeechState) as Record<string, any>);
  assert.equal(announcedSpeechText, 'quiet message');
  assert.equal(unannouncedSpeech.speaker_announcement.enabled, false);
  assert.equal(unannouncedSpeech.speaker_announcement.announced, false);
} finally {
  rmSync(announcedSpeechState.audibleOutputLockDir, { recursive: true, force: true });
}

const listenBlockedState = createServerState({ listenAdapterPath: 'D:/definitely/missing/Start-VoiceIntentLocalMonitor.ps1' });
const listenStatus = view(await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_listen_status', arguments: {} } }, listenBlockedState) as Record<string, any>);
assert.equal(listenStatus.status, 'blocked');
assert.equal((listenStatus.adapter as Record<string, unknown>).ready, false);
assert.deepEqual((listenStatus.policy as Record<string, any>).allowed_providers, ['local_sapi']);
assert.equal((listenStatus.policy as Record<string, any>).audio_cues, true);
assert.equal((listenStatus.policy as Record<string, any>).announce_speaker_default, true);

const missingAdapterStart = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_listen_start', arguments: { provider: 'local_sapi', duration_seconds: 5 } } }, listenBlockedState) as Record<string, any>;
assert.ok(missingAdapterStart.error, 'Expected missing adapter refusal');
assert.equal(missingAdapterStart.error.data.code, 'speech_listen_adapter_missing');
assert.match(missingAdapterStart.error.data.details.remediation, /Start-VoiceIntentLocalMonitor\.ps1/);

const remoteAudioRefused = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_listen_start', arguments: { provider: 'remote_transcription' } } }, listenBlockedState) as Record<string, any>;
assert.equal(remoteAudioRefused.error.data.code, 'speech_remote_audio_egress_not_admitted');

const remoteAudioAdmittedState = createServerState({ allowRemoteAudioEgress: true, listenAdapterPath: 'D:/definitely/missing/Start-VoiceIntentLocalMonitor.ps1' });
const remoteAudioAdmittedStatus = view(await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_listen_status', arguments: {} } }, remoteAudioAdmittedState) as Record<string, any>);
assert.deepEqual((remoteAudioAdmittedStatus.policy as Record<string, any>).allowed_providers, ['local_sapi', 'remote_transcription']);
assert.equal((remoteAudioAdmittedStatus.policy as Record<string, any>).openai_transcription_model, 'gpt-4o-transcribe');

const captureNeedsRemote = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_capture_transcribe', arguments: { provider: 'local_sapi' } } }, remoteAudioAdmittedState) as Record<string, any>;
assert.equal(captureNeedsRemote.error.data.code, 'speech_capture_invalid_provider');
assert.deepEqual(captureNeedsRemote.error.data.details.allowed, ['remote_transcription']);
assert.deepEqual(captureNeedsRemote.error.data.details.listen_session_providers, ['local_sapi', 'remote_transcription']);

const captureRemoteRefused = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_capture_transcribe', arguments: { provider: 'remote_transcription' } } }, listenBlockedState) as Record<string, any>;
assert.equal(captureRemoteRefused.error.data.code, 'speech_remote_audio_egress_not_admitted');

const promptCaptureRemoteRefused = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speech_prompt_capture_response', arguments: { text: 'Hello', tts_provider: 'sapi' } } }, listenBlockedState) as Record<string, any>;
assert.equal(promptCaptureRemoteRefused.error.data.code, 'speech_remote_audio_egress_not_admitted');

assert.deepEqual(
  buildCaptureTranscribeAdapterArgs('D:/voice/Start-VoiceIntentLocalMonitor.ps1', { input_wav: 'D:/tmp/input.wav', retain_audio: false }, 7, false),
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/voice/Start-VoiceIntentLocalMonitor.ps1', '-DurationSeconds', '7', '-RetainAudio', '-DispatchDryRun', '-PassThru', '-InputWav', 'D:/tmp/input.wav', '-DisableDebugAudioCues'],
);

assert.deepEqual(
  buildCaptureTranscribeAdapterArgs('D:/voice/Start-VoiceIntentLocalMonitor.ps1', { retain_audio: false }, 7, false),
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/voice/Start-VoiceIntentLocalMonitor.ps1', '-DurationSeconds', '7', '-RetainAudio', '-DispatchDryRun', '-PassThru', '-Device', 'auto', '-DisableDebugAudioCues'],
);

assert.deepEqual(
  buildCaptureTranscribeAdapterArgs('D:/voice/Start-VoiceIntentLocalMonitor.ps1', { self_test_synthetic: true, retain_audio: false }, 7, false),
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/voice/Start-VoiceIntentLocalMonitor.ps1', '-DurationSeconds', '7', '-RetainAudio', '-DispatchDryRun', '-PassThru', '-SelfTestSynthetic', '-DisableDebugAudioCues'],
);

assert.equal(parseArgs(['--no-listen-audio-cues']).listenAudioCues, false);

const nonAsciiFrameBody = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'speech_speak', arguments: { text: 'hello Привет' } } });
const nonAsciiDrained = drainJsonRpcFrames(Buffer.from(`Content-Length: ${Buffer.byteLength(nonAsciiFrameBody, 'utf8')}\r\n\r\n${nonAsciiFrameBody}`, 'utf8'));
assert.equal(nonAsciiDrained.requests.length, 1);
assert.equal((((nonAsciiDrained.requests[0].params as Record<string, any>).arguments as Record<string, any>).text), 'hello Привет');
assert.equal(nonAsciiDrained.remaining.length, 0);

const compactMonitor = compactMonitorResult({
  schema: 'narada.voice.local_monitor_run.v0',
  source_mode: 'live_microphone',
  source_device: '[5] Remote Audio, Windows DirectSound',
  source_sample_rate: 48000,
  capture_selection: { selection: 'auto', sample_rate: 48000 },
});
assert.equal(compactMonitor.source_device, '[5] Remote Audio, Windows DirectSound');
assert.equal(compactMonitor.source_sample_rate, 48000);
assert.deepEqual(compactMonitor.capture_selection, { selection: 'auto', sample_rate: 48000 });

const transcript = transcriptFromMonitorResult({ downstream: { stdout: JSON.stringify({ schema: 'narada.voice.recognition_adapter_result.v0', status: 'transcribed', provider: { adapter: 'openai-transcriptions', remote: true }, transcript: { text: 'hello operator', present: true } }) } });
assert.equal(transcript.present, true);
assert.equal(transcript.text, 'hello operator');

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
