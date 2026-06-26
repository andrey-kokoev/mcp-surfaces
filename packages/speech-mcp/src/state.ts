import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_LISTEN_DURATION_SECONDS, MAX_TEXT_LENGTH } from './constants.js';
import { resolveListenAdapterPath } from './listen-adapter.js';
import type { JsonRecord } from './protocol.js';
import { integer, optionalString } from './values.js';

export type AudibleOutputForTest = (event: JsonRecord) => Promise<JsonRecord> | JsonRecord;

export type SpeechState = {
  activeListenSessions: Map<string, ListenSession>;
  announceSpeaker: boolean;
  announcementCacheDir: string;
  audibleOutputForTest: AudibleOutputForTest | undefined;
  audibleOutputLockDir: string;
  audibleOutputLockStaleMs: number;
  audibleOutputQueue: Promise<void>;
  allowRemoteAudioEgress: boolean;
  listenAdapterPath: string | null;
  listenAudioCues: boolean;
  maxListenDurationSeconds: number;
  maxTextLength: number;
  openAiTranscriptionModel: string;
  options: JsonRecord;
  provider: string;
};

export type ListenSession = {
  child: import('node:child_process').ChildProcess;
  durationSeconds: number;
  provider: string;
  sessionId: string;
  startedAt: string;
};

export function createServerState(options: JsonRecord = {}): SpeechState {
  return {
    activeListenSessions: new Map(),
    announceSpeaker: booleanOption(options.announceSpeaker, process.env.NARADA_SPEECH_ANNOUNCE_SPEAKER, true),
    announcementCacheDir: resolve(optionalString(options.announcementCacheDir) ?? optionalString(process.env.NARADA_SPEECH_ANNOUNCEMENT_CACHE_DIR) ?? join(tmpdir(), 'speech-mcp', 'announcement-cache')),
    audibleOutputForTest: typeof options.audibleOutputForTest === 'function' ? options.audibleOutputForTest as AudibleOutputForTest : undefined,
    audibleOutputLockDir: optionalString(options.audibleOutputLockDir) ?? join(tmpdir(), 'speech-mcp-audible-output.lock'),
    audibleOutputLockStaleMs: integer(options.audibleOutputLockStaleMs, 120000, 1000, 24 * 60 * 60 * 1000),
    audibleOutputQueue: Promise.resolve(),
    allowRemoteAudioEgress: booleanOption(options.allowRemoteAudioEgress, process.env.NARADA_SPEECH_ALLOW_REMOTE_AUDIO_EGRESS),
    listenAdapterPath: resolveListenAdapterPath(options),
    listenAudioCues: booleanOption(options.listenAudioCues, process.env.NARADA_SPEECH_LISTEN_AUDIO_CUES, true),
    maxListenDurationSeconds: integer(options.maxListenDurationSeconds, MAX_LISTEN_DURATION_SECONDS, 1, MAX_LISTEN_DURATION_SECONDS),
    maxTextLength: Number(options.maxTextLength ?? MAX_TEXT_LENGTH),
    openAiTranscriptionModel: optionalString(options.openAiTranscriptionModel) ?? optionalString(process.env.NARADA_SPEECH_OPENAI_TRANSCRIPTION_MODEL) ?? 'gpt-4o-transcribe',
    options,
    provider: String(options.provider ?? 'sapi'),
  };
}

function booleanOption(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.trim()) return ['1', 'true', 'yes', 'on', 'admitted', 'allow'].includes(value.trim().toLowerCase());
  }
  return false;
}
