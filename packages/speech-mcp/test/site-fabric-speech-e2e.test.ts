import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  createTemporaryE2eRoot,
  installE2eArtifactRecorder,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';
import { writeSpeechTestRegistry } from './test-registry.js';

const siteRoot = createTemporaryE2eRoot('speech-site-fabric-e2e');
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', 'speech.site-fabric.remote-tts-transcription.json');
const evidence = installE2eArtifactRecorder(resultPath, { test_id: 'speech.site-fabric.remote-tts-transcription', authority: 'A1' });
const registryPath = writeSpeechTestRegistry(siteRoot);
const liveRequested = process.env.NARADA_E2E_SPEECH_REMOTE_LIVE === '1';
const apiKey = process.env.NARADA_E2E_SPEECH_OPENAI_API_KEY;
const inputWav = process.env.NARADA_E2E_SPEECH_INPUT_WAV;
const listenAdapterPath = process.env.NARADA_E2E_SPEECH_LISTEN_ADAPTER_PATH;
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENAI_API_KEY: liveRequested ? apiKey : undefined,
  NARADA_SPEECH_ALLOW_REMOTE_AUDIO_EGRESS: liveRequested ? '1' : undefined,
  NARADA_PROVIDER_REGISTRY_PATH: undefined,
};
const serverArgs = [
  serverPath,
  '--provider-registry-path', registryPath,
  '--no-announce-speaker',
  '--no-listen-audio-cues',
  ...(listenAdapterPath ? ['--listen-adapter-path', listenAdapterPath] : []),
];
const server = spawnJsonlMcpServer(process.execPath, serverArgs, {
  cwd: siteRoot,
  env: childEnv,
  label: 'speech Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'speech-mcp',
    requiredTools: [
      'speech_guidance',
      'speech_speak',
      'speech_voices',
      'speech_listen_status',
      'speech_capture_transcribe',
      'speech_prompt_capture_response',
    ],
  });

  const status = structured(await server.client.request(3, 'tools/call', {
    name: 'speech_listen_status',
    arguments: {},
  }));
  assert.ok(status.status === 'blocked' || status.status === 'ready', JSON.stringify(status));

  const missingPrerequisites = [
    ['remote_authority_not_enabled', liveRequested],
    ['controlled_openai_api_key_missing', Boolean(apiKey)],
    ['controlled_input_wav_missing', Boolean(inputWav)],
    ['controlled_capture_adapter_missing', Boolean(listenAdapterPath)],
  ].filter(([, present]) => !present).map(([reason]) => reason);
  if (missingPrerequisites.length > 0) {
    evidence.update({ status: 'not_run', reason_code: 'controlled_remote_speech_authority_not_configured', missing_prerequisites: missingPrerequisites });
    console.log(JSON.stringify({
      status: 'not_run',
      test_id: 'speech.site-fabric.remote-tts-transcription',
      authority: 'A1',
      reason_code: 'controlled_remote_speech_authority_not_configured',
      missing_prerequisites: missingPrerequisites,
      local_listen_status: status.status,
      cleanup: 'completed_after_finally',
    }));
  } else {
    const spoken = structured(await server.client.request(4, 'tools/call', {
      name: 'speech_speak',
      arguments: {
        text: 'Narada remote speech E2E test.',
        announce_speaker: false,
        retain_audio: true,
        output_path: join(siteRoot, 'speech-e2e-tts.wav'),
        selection: { provider: 'openai-api', model: 'tts-1', voice: 'nova' },
      },
    }));
    assert.equal(spoken.status, 'spoken', JSON.stringify(spoken));

    const transcribed = structured(await server.client.request(5, 'tools/call', {
      name: 'speech_capture_transcribe',
      arguments: {
        duration_seconds: 1,
        input_wav: inputWav,
        selection: { provider: 'openai-api', model: 'gpt-4o-transcribe' },
        retain_audio: false,
      },
    }));
    assert.equal(transcribed.status, 'transcribed', JSON.stringify(transcribed));
    assert.equal((transcribed.privacy as JsonRecord).remote_audio_egress, 'admitted', JSON.stringify(transcribed));

    console.log(JSON.stringify({
      status: 'passed',
      test_id: 'speech.site-fabric.remote-tts-transcription',
      authority: 'A1',
      coverage: ['tts-1-nova', 'gpt-4o-transcribe'],
      cleanup: 'completed_after_finally',
    }));
    evidence.update({ status: 'passed' });
  }
} finally {
  await server.close();
  const cleanupOk = removeTemporaryE2eRoot(siteRoot);
  evidence.finalize({ ...(cleanupOk ? {} : { status: 'failed' }), cleanup: { status: cleanupOk ? 'completed_after_finally' : 'failed' } });
  assert.equal(cleanupOk, true);
}
