import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createSpeechTestRegistry(): Record<string, unknown> {
  const ttsVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((id) => ({ id }));
  return {
    schema: 'narada.provider_registry.v2',
    version: 2,
    defaults: {
      tts: { provider: 'sapi', model: 'default' },
      transcription: { provider: 'sapi', model: 'default' },
    },
    providers: {
      sapi: {
        id: 'sapi',
        credential_requirement: { kind: 'none' },
        models: {
          default: { id: 'default', status: 'active', capabilities: { tts: { adapter: 'sapi' }, transcription: { adapter: 'sapi' } } },
        },
        capabilities: { tts: { default_model: 'default' }, transcription: { default_model: 'default' } },
      },
      'openai-api': {
        id: 'openai-api',
        base_url: 'https://api.openai.com',
        credential_requirement: { kind: 'api_key_secret', secret_ref: 'narada/provider/openai-api/api-key', env_names: ['OPENAI_API_KEY'] },
        models: {
          'tts-1': { id: 'tts-1', status: 'active', capabilities: { tts: { adapter: 'openai-tts', voices: ttsVoices, default_voice: 'nova' } } },
          'gpt-4o-mini-tts': { id: 'gpt-4o-mini-tts', status: 'active', capabilities: { tts: { adapter: 'openai-tts', voices: ttsVoices, default_voice: 'nova' } } },
          'tts-1-hd': { id: 'tts-1-hd', status: 'active', capabilities: { tts: { adapter: 'openai-tts', voices: ttsVoices, default_voice: 'nova' } } },
          'gpt-4o-transcribe': { id: 'gpt-4o-transcribe', status: 'active', capabilities: { transcription: { adapter: 'openai-transcription' } } },
          'gpt-4o-mini-transcribe': { id: 'gpt-4o-mini-transcribe', status: 'active', capabilities: { transcription: { adapter: 'openai-transcription' } } },
          'whisper-1': { id: 'whisper-1', status: 'active', capabilities: { transcription: { adapter: 'openai-transcription' } } },
        },
        capabilities: {
          tts: { default_model: 'tts-1' },
          transcription: { default_model: 'gpt-4o-transcribe' },
        },
      },
    },
  };
}

export function writeSpeechTestRegistry(directory: string): string {
  const path = join(directory, 'provider-registry.v2.json');
  writeFileSync(path, JSON.stringify(createSpeechTestRegistry(), null, 2), 'utf8');
  return path;
}
