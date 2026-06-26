import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DEFAULT_LISTEN_DURATION_SECONDS, LISTEN_PROVIDERS } from './constants.js';
import { diagnosticError } from './diagnostics.js';
import { buildListenAdapterArgs } from './listen-adapter.js';
import type { JsonRecord } from './protocol.js';
import type { ListenSession, SpeechState } from './state.js';
import { integer, optionalString } from './values.js';

export type ListenCue = (state: SpeechState, phase: 'start' | 'end') => void;

export function speechListenStatus(state: SpeechState): JsonRecord {
  const adapter = listenAdapterReadiness(state);
  return {
    status: adapter.ready ? 'ready' : 'blocked',
    adapter,
    policy: listenPolicy(state),
    active_sessions: Array.from(state.activeListenSessions.values()).map((session) => ({
      session_id: session.sessionId,
      provider: session.provider,
      duration_seconds: session.durationSeconds,
      started_at: session.startedAt,
    })),
  };
}

export function speechListenStart(args: JsonRecord, state: SpeechState, playListenCue: ListenCue): JsonRecord {
  const provider = optionalString(args.provider) ?? 'local_sapi';
  if (!LISTEN_PROVIDERS.includes(provider as typeof LISTEN_PROVIDERS[number])) {
    throw diagnosticError('speech_listen_invalid_provider', `speech_listen_invalid_provider:${provider}`, { allowed: LISTEN_PROVIDERS });
  }
  if (provider === 'remote_transcription' && !state.allowRemoteAudioEgress) {
    throw diagnosticError('speech_remote_audio_egress_not_admitted', 'speech_remote_audio_egress_not_admitted', {
      remediation: 'Set speech MCP policy allowRemoteAudioEgress/NARADA_SPEECH_ALLOW_REMOTE_AUDIO_EGRESS only after explicit operator admission for remote microphone audio egress.',
      policy: listenPolicy(state),
    });
  }
  const adapter = listenAdapterReadiness(state);
  if (!adapter.ready) {
    throw diagnosticError('speech_listen_adapter_missing', 'speech_listen_adapter_missing', { adapter, remediation: adapter.remediation });
  }
  const durationSeconds = integer(args.duration_seconds, DEFAULT_LISTEN_DURATION_SECONDS, 1, state.maxListenDurationSeconds);
  const sessionId = optionalString(args.session_id) ?? `listen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (state.activeListenSessions.has(sessionId)) throw diagnosticError('speech_listen_session_exists', `speech_listen_session_exists:${sessionId}`, { session_id: sessionId });
  playListenCue(state, 'start');
  const child = spawn('powershell.exe', buildListenAdapterArgs(state.listenAdapterPath as string, provider, durationSeconds, sessionId, Boolean(args.calibrate)), {
    stdio: 'ignore',
    windowsHide: true,
  });
  const session: ListenSession = { child, durationSeconds, provider, sessionId, startedAt: new Date().toISOString() };
  state.activeListenSessions.set(sessionId, session);
  const timeout = setTimeout(() => stopListenSession(state, sessionId, playListenCue), durationSeconds * 1000 + 1000);
  child.once('error', () => { clearTimeout(timeout); finishListenSession(state, sessionId, playListenCue); });
  child.once('close', () => { clearTimeout(timeout); finishListenSession(state, sessionId, playListenCue); });
  return { status: 'started', session_id: sessionId, provider, duration_seconds: durationSeconds, calibrate: Boolean(args.calibrate), bounded: true, audio_cues: state.listenAudioCues, stop_tool: 'speech_listen_stop' };
}

export function speechListenStop(args: JsonRecord, state: SpeechState, playListenCue: ListenCue): JsonRecord {
  const sessionId = optionalString(args.session_id);
  const ids = sessionId ? [sessionId] : Array.from(state.activeListenSessions.keys());
  const stopped = ids.filter((id) => stopListenSession(state, id, playListenCue));
  return { status: 'stopped', requested_session_id: sessionId, stopped_session_ids: stopped, active_count: state.activeListenSessions.size };
}

export function listenAdapterReadiness(state: SpeechState): JsonRecord {
  const path = state.listenAdapterPath;
  const exists = Boolean(path && existsSync(path));
  return {
    ready: exists,
    path,
    required: true,
    remediation: exists ? null : 'Install or configure Start-VoiceIntentLocalMonitor.ps1, or pass --listen-adapter-path / NARADA_SPEECH_LISTEN_ADAPTER_PATH for this site.',
  };
}

export function listenPolicy(state: SpeechState): JsonRecord {
  return {
    default_provider: 'local_sapi',
    allowed_providers: state.allowRemoteAudioEgress ? LISTEN_PROVIDERS.slice() : ['local_sapi'],
    audio_cues: state.listenAudioCues,
    announce_speaker_default: state.announceSpeaker,
    remote_audio_egress: state.allowRemoteAudioEgress ? 'admitted' : 'forbidden_without_explicit_policy',
    openai_transcription_model: state.openAiTranscriptionModel,
    max_duration_seconds: state.maxListenDurationSeconds,
  };
}

function stopListenSession(state: SpeechState, sessionId: string, playListenCue: ListenCue): boolean {
  const session = state.activeListenSessions.get(sessionId);
  if (!session) return false;
  try { session.child.kill(); } catch { /* already stopped */ }
  finishListenSession(state, sessionId, playListenCue);
  return true;
}

function finishListenSession(state: SpeechState, sessionId: string, playListenCue: ListenCue): void {
  if (!state.activeListenSessions.delete(sessionId)) return;
  playListenCue(state, 'end');
}
