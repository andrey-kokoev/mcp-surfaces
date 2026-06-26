#!/usr/bin/env node
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './cli.js';
import { CAPTURE_TRANSCRIPTION_PROVIDERS, DEFAULT_LISTEN_DURATION_SECONDS, LISTEN_PROVIDERS, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from './constants.js';
import { diagnosticError, errorDiagnostic } from './diagnostics.js';
import { buildCaptureTranscribeAdapterArgs } from './listen-adapter.js';
import { listenAdapterReadiness, listenPolicy, speechListenStart, speechListenStatus, speechListenStop } from './listen-sessions.js';
import { drainJsonLines, drainJsonRpcFrames, writeJsonRpcResponse, type JsonRecord } from './protocol.js';
import { resolveOpenAiApiKey } from './secrets.js';
import { createServerState, type SpeechState } from './state.js';
import { listTools } from './tool-list.js';
import { compactMonitorResult, openaiTranscribeAudio, transcriptFromMonitorResult } from './transcription.js';
import { playListenCue, speechSpeak, speechVoices } from './tts.js';
import { integer, optionalString, renderResult, requiredString } from './values.js';

export { parseArgs } from './cli.js';
export { buildCaptureTranscribeAdapterArgs, buildListenAdapterArgs } from './listen-adapter.js';
export { listTools } from './tool-list.js';
export { resolveOpenAiApiKey } from './secrets.js';
export { createServerState } from './state.js';
export { compactMonitorResult, transcriptFromMonitorResult } from './transcription.js';

export async function handleRequest(request: JsonRecord, state: SpeechState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

export async function runStdioServer(options: JsonRecord = {}): Promise<void> {
  const state = createServerState(options);
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let sawFramedInput = false;
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')]);
    const framed = buffer.includes(Buffer.from('Content-Length:'));
    const drained = framed ? drainJsonRpcFrames(buffer) : drainJsonLines(buffer.toString('utf8'));
    sawFramedInput ||= drained.framed;
    buffer = Buffer.isBuffer(drained.remaining) ? drained.remaining : Buffer.from(drained.remaining, 'utf8');
    for (const request of drained.requests) {
      const response = await handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

function dispatchMethod(method: string, params: JsonRecord, state: SpeechState) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return callTool(params, state);
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}


async function callTool(params: JsonRecord, state: SpeechState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'speech_speak': result = await speechSpeak(args, state); break;
    case 'speech_voices': result = speechVoices(args, state); break;
    case 'speech_listen_status': result = speechListenStatus(state); break;
    case 'speech_capture_transcribe': result = await speechCaptureTranscribe(args, state); break;
    case 'speech_prompt_capture_response': result = await speechPromptCaptureResponse(args, state); break;
    case 'speech_listen_start': result = speechListenStart(args, state, playListenCue); break;
    case 'speech_listen_stop': result = speechListenStop(args, state, playListenCue); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

async function speechCaptureTranscribe(args: JsonRecord, state: SpeechState): Promise<JsonRecord> {
  const provider = optionalString(args.provider) ?? 'remote_transcription';
  if (!CAPTURE_TRANSCRIPTION_PROVIDERS.includes(provider as typeof CAPTURE_TRANSCRIPTION_PROVIDERS[number])) {
    throw diagnosticError('speech_capture_invalid_provider', `speech_capture_invalid_provider:${provider}`, {
      allowed: CAPTURE_TRANSCRIPTION_PROVIDERS,
      listen_session_providers: LISTEN_PROVIDERS,
      remediation: 'Use provider=remote_transcription for transcript-returning capture, or speech_listen_start with provider=local_sapi for local voice-intent monitoring.',
    });
  }
  if (!state.allowRemoteAudioEgress) {
    throw diagnosticError('speech_remote_audio_egress_not_admitted', 'speech_remote_audio_egress_not_admitted', {
      remediation: 'Set speech MCP policy allowRemoteAudioEgress/NARADA_SPEECH_ALLOW_REMOTE_AUDIO_EGRESS only after explicit operator admission for remote microphone audio egress.',
      policy: listenPolicy(state),
    });
  }
  const adapter = listenAdapterReadiness(state);
  if (!adapter.ready) {
    throw diagnosticError('speech_listen_adapter_missing', 'speech_listen_adapter_missing', { adapter, remediation: adapter.remediation });
  }
  const model = optionalString(args.model) ?? state.openAiTranscriptionModel;
  const durationSeconds = integer(args.duration_seconds, DEFAULT_LISTEN_DURATION_SECONDS, 1, state.maxListenDurationSeconds);
  playListenCue(state, 'start');
  const commandArgs = buildCaptureTranscribeAdapterArgs(state.listenAdapterPath as string, args, durationSeconds, Boolean(args.calibrate));
  const result = nodeSpawnSync('powershell.exe', commandArgs, {
    env: { ...process.env, NARADA_SPEECH_OPENAI_TRANSCRIPTION_MODEL: model },
    encoding: 'utf8',
    timeout: (durationSeconds + 90) * 1000,
    windowsHide: true,
  });
  playListenCue(state, 'end');
  const stdout = String(result.stdout ?? '').trim();
  const stderr = String(result.stderr ?? '').trim();
  let monitor: JsonRecord;
  try {
    monitor = asRecord(JSON.parse(stdout));
  } catch {
    throw diagnosticError('speech_capture_output_invalid_json', 'speech_capture_output_invalid_json', { exit_code: result.status ?? -1, stdout: stdout.slice(0, 1000), stderr: stderr.slice(0, 1000) });
  }
  if ((result.status ?? -1) !== 0) {
    throw diagnosticError('speech_capture_failed', 'speech_capture_failed', { exit_code: result.status ?? -1, stderr: stderr.slice(0, 1000), monitor: compactMonitorResult(monitor) });
  }
  if (monitor.schema === 'narada.voice.local_audio_calibration.v0') {
    return {
      schema: 'narada.speech.capture_calibration.v1',
      status: 'calibrated',
      provider: 'local_audio',
      duration_seconds: durationSeconds,
      calibration: monitor,
      monitor: compactMonitorResult(monitor),
      privacy: {
        remote_audio_egress: 'not_used',
        raw_audio_retained: false,
      },
    };
  }
  const audioPath = optionalString(monitor.retained_audio_path);
  if (!audioPath) {
    throw diagnosticError('speech_capture_no_audio', 'speech_capture_no_audio', { monitor: compactMonitorResult(monitor) });
  }
  const apiKey = resolveOpenAiApiKey(args, state);
  if (!apiKey) throw diagnosticError('speech_openai_no_key', 'speech_openai_no_key: provide api_key or set OPENAI_API_KEY');
  const inputWav = optionalString(args.input_wav);
  try {
    const transcription = await openaiTranscribeAudio(apiKey, audioPath, model);
    return {
      schema: 'narada.speech.capture_transcribe.v1',
      status: 'transcribed',
      provider: 'openai',
      adapter: 'openai-transcriptions',
      model,
      duration_seconds: durationSeconds,
      transcript: transcription.transcript,
      audio: transcription.audio,
      monitor: compactMonitorResult(monitor),
      privacy: {
        remote_audio_egress: 'admitted',
        remote_audio_provider: 'openai',
        raw_audio_retained: Boolean(args.retain_audio),
      },
    };
  } finally {
    if (args.retain_audio !== true && audioPath !== inputWav) {
      try { unlinkSync(audioPath); } catch { /* best-effort privacy cleanup */ }
    }
  }
}

async function speechPromptCaptureResponse(args: JsonRecord, state: SpeechState): Promise<JsonRecord> {
  const text = requiredString(args.text, 'speech_requires_text');
  const spoken = await speechSpeak({
    text,
    provider: optionalString(args.tts_provider) ?? 'openai_api',
    model: optionalString(args.tts_model) ?? 'tts-1',
    voice: optionalString(args.voice) ?? 'shimmer',
    rate: args.rate,
    speed: args.speed,
    api_key: args.api_key,
    speaker_agent_id: args.speaker_agent_id,
    announce_speaker: args.announce_speaker,
  }, state);

  let capture: JsonRecord | null = null;
  try {
    capture = await speechCaptureTranscribe({
      provider: 'remote_transcription',
      duration_seconds: args.duration_seconds,
      model: args.model,
      api_key: args.api_key,
      device: args.device,
      retain_audio: args.retain_audio,
    }, state);
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    const code = String(diagnostic.code ?? 'speech_error');
    if (code !== 'speech_capture_no_audio' && code !== 'speech_openai_transcription_empty') throw error;
    return {
      schema: 'narada.speech.prompt_capture_response.v1',
      status: 'no_response',
      reason: code,
      prompt: spoken,
      capture_error: diagnostic,
      response: { present: false, text: null },
    };
  }

  const transcript = asRecord(capture.transcript);
  const textValue = optionalString(transcript.text);
  const monitor = asRecord(capture.monitor);
  const minSpeechMs = integer(args.no_response_min_speech_ms, 300, 0, 300000);
  const selectedDurationMs = Number(monitor.selected_segment_duration_ms ?? 0);
  if (!textValue || selectedDurationMs < minSpeechMs) {
    return {
      schema: 'narada.speech.prompt_capture_response.v1',
      status: 'no_response',
      reason: !textValue ? 'empty_transcript' : 'speech_segment_too_short',
      prompt: spoken,
      capture,
      response: { present: false, text: null },
      transcript: { present: false, text: null },
      no_response_min_speech_ms: minSpeechMs,
    };
  }

  return {
    schema: 'narada.speech.prompt_capture_response.v1',
    status: 'responded',
    prompt: spoken,
    capture,
    response: { present: true, text: textValue, transcript: { raw: transcript.raw ?? null } },
    transcript: { present: true, text: textValue, raw: transcript.raw ?? null },
    no_response_min_speech_ms: minSpeechMs,
  };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
