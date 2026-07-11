import { listCapabilityCatalog, type Capability } from '@narada2/provider-registry';
import { guidanceToolDefinition } from './guidance.js';
import { MAX_LISTEN_DURATION_SECONDS } from './constants.js';
import type { SpeechState } from './state.js';

export function listTools(state?: SpeechState) {
  return [
    guidanceToolDefinition(),
    {
      name: 'speech_speak',
      description: 'Speak text through the registry-resolved TTS provider. Selection is provider-rooted and defaults come from site policy or the loaded registry.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to speak. Max 1000 characters.' },
          selection: selectionSchema('tts', state, true),
          rate: { type: 'integer', minimum: -10, maximum: 10, description: 'Speech rate for SAPI. -10 slow to 10 fast. Default 0.' },
          speed: { type: 'number', minimum: 0.25, maximum: 4.0, description: 'Provider-specific speech speed when supported. Default 1.0.' },
          speaker_agent_id: { type: 'string', description: 'Agent identity to announce before the spoken text. Defaults to NARADA_AGENT_ID when speaker announcements are enabled.' },
          announce_speaker: { type: 'boolean', description: 'Override server speaker announcement policy for this call.' },
          output_path: { type: 'string', description: 'Optional admitted local WAV path to retain generated speech audio.' },
          retain_audio: { type: 'boolean', default: false, description: 'Retain generated speech audio as a WAV file.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { title: 'speech_speak', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'speech_voices',
      description: 'List available voices for the registry-resolved TTS provider. Local providers return installed voices; remote providers return registry voices.',
      inputSchema: {
        type: 'object',
        properties: { selection: selectionSchema('tts', state, false) },
        additionalProperties: false,
      },
      annotations: { title: 'speech_voices', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'speech_listen_status',
      description: 'Report readiness for governed microphone listening and show active bounded listening sessions.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'speech_listen_status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'speech_capture_transcribe',
      description: 'Capture bounded microphone audio and return a transcript using the registry-resolved transcription provider. Remote egress remains policy-gated.',
      inputSchema: {
        type: 'object',
        properties: {
          duration_seconds: { type: 'integer', minimum: 1, maximum: MAX_LISTEN_DURATION_SECONDS, description: 'Maximum capture duration. Defaults to 30 seconds and is capped by server policy.' },
          selection: selectionSchema('transcription', state, false),
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
      description: 'Speak a prompt, wait for a bounded spoken response, and return transcript or no_response. TTS and transcription selections resolve independently.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Prompt to speak to the operator. Max 1000 characters.' },
          tts_selection: selectionSchema('tts', state, true),
          transcription_selection: selectionSchema('transcription', state, false),
          rate: { type: 'integer', minimum: -10, maximum: 10, description: 'Speech rate for SAPI. -10 slow to 10 fast. Default 0.' },
          speed: { type: 'number', minimum: 0.25, maximum: 4.0, description: 'Provider-specific speech speed when supported. Default 1.0.' },
          duration_seconds: { type: 'integer', minimum: 1, maximum: MAX_LISTEN_DURATION_SECONDS, description: 'Maximum response capture duration. Defaults to 30 seconds.' },
          device: { type: 'string', description: 'Optional microphone device id/name passed to the local capture adapter.' },
          retain_audio: { type: 'boolean', default: false, description: 'Retain bounded utterance WAV in adapter runtime storage when true.' },
          no_response_min_speech_ms: { type: 'integer', minimum: 0, description: 'Treat shorter detected speech segments as no_response. Defaults to 300 ms.' },
          speaker_agent_id: { type: 'string', description: 'Agent identity to announce before the prompt.' },
          announce_speaker: { type: 'boolean', description: 'Override server speaker announcement policy for this prompt.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { title: 'speech_prompt_capture_response', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'speech_listen_start',
      description: 'Start a bounded microphone listening session through the registry-resolved transcription provider. Remote audio egress requires explicit policy admission.',
      inputSchema: {
        type: 'object',
        properties: {
          duration_seconds: { type: 'integer', minimum: 1, maximum: MAX_LISTEN_DURATION_SECONDS, description: 'Maximum capture duration. Defaults to 30 seconds and is capped by server policy.' },
          selection: selectionSchema('transcription', state, false),
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
        properties: { session_id: { type: 'string', description: 'Listening session id to stop. Omit to stop all active sessions.' } },
        additionalProperties: false,
      },
      annotations: { title: 'speech_listen_stop', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

function selectionSchema(capability: Capability, state: SpeechState | undefined, includeVoice: boolean): Record<string, unknown> {
  return {
    type: 'object',
    description: `Optional provider-rooted ${capability} selection. Omit fields to use site policy, then registry defaults.`,
    properties: {
      provider: { type: 'string', description: 'Canonical provider id from the loaded registry.' },
      model: { type: 'string', description: 'Model id within the selected provider.' },
      ...(includeVoice ? { voice: { type: 'string', description: 'Voice id from the selected provider/model registry record.' } } : {}),
    },
    additionalProperties: false,
    'x-narada-capability': capability,
    'x-narada-registry-catalog': state ? listCapabilityCatalog(state.providerRegistry, capability) : [],
  };
}
