export const SERVER_NAME = 'speech-mcp';
export const SERVER_VERSION = '0.1.0';
export const PROTOCOL_VERSION = '2024-11-05';

export const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
export const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
export const MAX_REMOTE_TRANSCRIPTION_AUDIO_BYTES = 25 * 1024 * 1024;
export const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
export const OPENAI_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] as const;
export const OPENAI_TRANSCRIPTION_MODELS = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'] as const;
export const PROVIDERS = ['sapi', 'openai_api'] as const;
export const LISTEN_PROVIDERS = ['local_sapi', 'remote_transcription'] as const;
export const CAPTURE_TRANSCRIPTION_PROVIDERS = ['remote_transcription'] as const;
export const MAX_TEXT_LENGTH = 1000;
export const DEFAULT_LISTEN_DURATION_SECONDS = 30;
export const MAX_LISTEN_DURATION_SECONDS = 300;
