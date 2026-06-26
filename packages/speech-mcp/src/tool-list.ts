import { CAPTURE_TRANSCRIPTION_PROVIDERS, LISTEN_PROVIDERS, MAX_LISTEN_DURATION_SECONDS, OPENAI_MODELS, OPENAI_TRANSCRIPTION_MODELS, PROVIDERS } from './constants.js';

export function listTools() {
  return [
    {
      name: 'speech_speak',
      description: 'Speak text through the configured TTS provider (SAPI or OpenAI TTS).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to speak. Max 1000 characters.' },
          provider: { type: 'string', enum: PROVIDERS, description: 'TTS provider. Defaults to sapi.' },
          voice: { type: 'string', description: 'Optional voice name for SAPI, e.g. Microsoft Zira.' },
          rate: { type: 'integer', minimum: -10, maximum: 10, description: 'Speech rate for SAPI. -10 slow to 10 fast. Default 0.' },
          api_key: { type: 'string', description: 'OpenAI API key. Falls back to OPENAI_API_KEY env var.' },
          model: { type: 'string', enum: OPENAI_MODELS, description: 'OpenAI TTS model. Defaults to gpt-4o-mini-tts.' },
          speed: { type: 'number', minimum: 0.25, maximum: 4.0, description: 'OpenAI speech speed. 0.25 to 4.0. Default 1.0.' },
          speaker_agent_id: { type: 'string', description: 'Agent identity to announce before the spoken text. Defaults to NARADA_AGENT_ID when speaker announcements are enabled.' },
          announce_speaker: { type: 'boolean', description: 'Override server speaker announcement policy for this call. Defaults to true at the server level.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { title: 'speech_speak', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'speech_voices',
      description: 'List available voices for a TTS provider. SAPI returns installed Windows voices; openai_api returns known OpenAI voices.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: PROVIDERS, description: 'TTS provider. Defaults to sapi.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'speech_voices', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'speech_listen_status',
      description: 'Report readiness for governed microphone listening / voice command recognition and show active bounded listening sessions.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'speech_listen_status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'speech_capture_transcribe',
      description: 'Capture bounded microphone audio and return a first-class transcript result. Remote transcription requires explicit policy admission.',
      inputSchema: {
        type: 'object',
        properties: {
          duration_seconds: { type: 'integer', minimum: 1, maximum: MAX_LISTEN_DURATION_SECONDS, description: 'Maximum capture duration. Defaults to 30 seconds and is capped by server policy.' },
          provider: { type: 'string', enum: CAPTURE_TRANSCRIPTION_PROVIDERS, description: 'Transcript-returning capture provider. Defaults to remote_transcription; local_sapi is only valid for speech_listen_start voice-intent sessions.' },
          model: { type: 'string', enum: OPENAI_TRANSCRIPTION_MODELS, description: 'OpenAI transcription model. Defaults to policy value.' },
          api_key: { type: 'string', description: 'OpenAI API key. Falls back to OPENAI_API_KEY env var or admitted secret lookup.' },
          device: { type: 'string', description: 'Optional microphone device id/name passed to the local capture adapter.' },
          input_wav: { type: 'string', description: 'Optional local WAV path for deterministic transcription tests instead of live microphone capture.' },
          self_test_synthetic: { type: 'boolean', description: 'Use the adapter synthetic VAD fixture instead of live microphone capture.' },
          calibrate: { type: 'boolean', description: 'Ask the adapter to perform calibration/readiness checks before capture when supported.' },
          retain_audio: { type: 'boolean', default: false, description: 'Retain bounded utterance WAV in adapter runtime storage when true.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'speech_capture_transcribe', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'speech_prompt_capture_response',
      description: 'Speak a prompt, wait for a bounded spoken response, and return transcript or no_response.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Prompt to speak to the operator. Max 1000 characters.' },
          tts_provider: { type: 'string', enum: PROVIDERS, description: 'TTS provider for the prompt. Defaults to openai_api.' },
          tts_model: { type: 'string', enum: OPENAI_MODELS, description: 'OpenAI TTS model. Defaults to tts-1.' },
          voice: { type: 'string', description: 'TTS voice. Defaults to shimmer for OpenAI TTS.' },
          rate: { type: 'integer', minimum: -10, maximum: 10, description: 'Speech rate for SAPI. -10 slow to 10 fast. Default 0.' },
          speed: { type: 'number', minimum: 0.25, maximum: 4.0, description: 'OpenAI speech speed. 0.25 to 4.0. Default 1.0.' },
          duration_seconds: { type: 'integer', minimum: 1, maximum: MAX_LISTEN_DURATION_SECONDS, description: 'Maximum response capture duration. Defaults to 30 seconds.' },
          model: { type: 'string', enum: OPENAI_TRANSCRIPTION_MODELS, description: 'OpenAI transcription model. Defaults to policy value.' },
          api_key: { type: 'string', description: 'OpenAI API key. Falls back to OPENAI_API_KEY env var or admitted secret lookup.' },
          device: { type: 'string', description: 'Optional microphone device id/name passed to the local capture adapter. Defaults to auto for live capture.' },
          retain_audio: { type: 'boolean', default: false, description: 'Retain bounded utterance WAV in adapter runtime storage when true.' },
          no_response_min_speech_ms: { type: 'integer', minimum: 0, description: 'Treat shorter detected speech segments as no_response. Defaults to 300 ms.' },
          speaker_agent_id: { type: 'string', description: 'Agent identity to announce before the prompt. Defaults to NARADA_AGENT_ID when speaker announcements are enabled.' },
          announce_speaker: { type: 'boolean', description: 'Override server speaker announcement policy for this prompt. Defaults to true at the server level.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { title: 'speech_prompt_capture_response', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'speech_listen_start',
      description: 'Start a bounded microphone listening session through the configured local voice-intent adapter. Remote transcription requires explicit policy admission.',
      inputSchema: {
        type: 'object',
        properties: {
          duration_seconds: { type: 'integer', minimum: 1, maximum: MAX_LISTEN_DURATION_SECONDS, description: 'Maximum capture duration. Defaults to 30 seconds and is capped by server policy.' },
          provider: { type: 'string', enum: LISTEN_PROVIDERS, description: 'Recognition provider. Defaults to local_sapi. remote_transcription requires policy admission.' },
          calibrate: { type: 'boolean', description: 'Ask the adapter to perform calibration/readiness checks before capture when supported.' },
          session_id: { type: 'string', description: 'Optional caller-provided session id. Generated when omitted.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'speech_listen_start', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'speech_listen_stop',
      description: 'Stop one active microphone listening session, or all sessions when session_id is omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Listening session id to stop. Omit to stop all active sessions.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'speech_listen_stop', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}
