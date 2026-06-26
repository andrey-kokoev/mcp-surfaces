import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MAX_REMOTE_TRANSCRIPTION_AUDIO_BYTES, OPENAI_TRANSCRIPTIONS_URL } from './constants.js';
import { diagnosticError } from './diagnostics.js';
import type { JsonRecord } from './protocol.js';
import { optionalString } from './values.js';

export async function openaiTranscribeAudio(apiKey: string, audioPath: string, model: string): Promise<{ transcript: JsonRecord; audio: JsonRecord }> {
  const audioBytes = readFileSync(audioPath);
  if (audioBytes.length <= 0) throw diagnosticError('speech_capture_audio_empty', 'speech_capture_audio_empty', { audio_path: audioPath });
  if (audioBytes.length > MAX_REMOTE_TRANSCRIPTION_AUDIO_BYTES) {
    throw diagnosticError('speech_capture_audio_too_large', 'speech_capture_audio_too_large', { audio_path: audioPath, size: audioBytes.length, max_size: MAX_REMOTE_TRANSCRIPTION_AUDIO_BYTES });
  }
  const form = new FormData();
  form.set('model', model);
  form.set('file', new Blob([audioBytes], { type: 'audio/wav' }), 'utterance.wav');
  const response = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw diagnosticError('speech_openai_transcription_api_error', `speech_openai_transcription_api_error:${response.status}`, { status: response.status, detail: responseText.slice(0, 500) });
  }
  let payload: JsonRecord;
  try {
    payload = asRecord(JSON.parse(responseText));
  } catch {
    throw diagnosticError('speech_openai_transcription_invalid_json', 'speech_openai_transcription_invalid_json', { text: responseText.slice(0, 500) });
  }
  const text = optionalString(payload.text);
  if (!text) throw diagnosticError('speech_openai_transcription_empty', 'speech_openai_transcription_empty', { payload });
  return {
    transcript: { present: true, text, raw: payload },
    audio: {
      path: audioPath,
      size: audioBytes.length,
      sha256: createHash('sha256').update(audioBytes).digest('hex'),
    },
  };
}

export function transcriptFromMonitorResult(monitor: JsonRecord): JsonRecord {
  const downstream = asRecord(monitor.downstream);
  const stdout = optionalString(downstream.stdout);
  if (!stdout) return { present: false, text: null };
  try {
    const adapterResult = asRecord(JSON.parse(stdout));
    const transcript = asRecord(adapterResult.transcript);
    const text = optionalString(transcript.text);
    return {
      present: Boolean(text),
      text,
      adapter_result: {
        schema: adapterResult.schema ?? null,
        status: adapterResult.status ?? null,
        provider: adapterResult.provider ?? null,
        closed: adapterResult.closed ?? null,
        downstream: adapterResult.downstream ?? null,
      },
    };
  } catch {
    return { present: false, text: null, parse_error: 'downstream_stdout_not_json', stdout: stdout.slice(0, 1000) };
  }
}

export function compactMonitorResult(monitor: JsonRecord): JsonRecord {
  const source = asRecord(monitor.source);
  return {
    schema: monitor.schema ?? null,
    status: monitor.status ?? null,
    reason: monitor.reason ?? null,
    observed_at: monitor.observed_at ?? null,
    created_at: monitor.created_at ?? null,
    run_id: monitor.run_id ?? null,
    runtime_path: monitor.runtime_path ?? null,
    source_mode: monitor.source_mode ?? source.mode ?? null,
    source_device: monitor.source_device ?? source.device ?? null,
    source_sample_rate: monitor.source_sample_rate ?? source.sample_rate ?? null,
    capture_selection: monitor.capture_selection ?? null,
    speech_detected: monitor.speech_detected ?? null,
    segment_count: monitor.segment_count ?? null,
    selected_segment_duration_ms: monitor.selected_segment_duration_ms ?? null,
    retained_audio_path: monitor.retained_audio_path ?? null,
    recognition_adapter: monitor.recognition_adapter ?? null,
    downstream: monitor.downstream ?? null,
  };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
