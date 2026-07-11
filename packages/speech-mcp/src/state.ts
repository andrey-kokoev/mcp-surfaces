import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadProviderRegistrySync, type CapabilityPolicy, type ProviderRegistry } from '@narada2/provider-registry';
import { MAX_LISTEN_DURATION_SECONDS, MAX_TEXT_LENGTH } from './constants.js';
import { diagnosticError } from './diagnostics.js';
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
  options: JsonRecord;
  providerRegistryPath: string;
  providerRegistry: ProviderRegistry;
  capabilityPolicy: CapabilityPolicy;
};

export type ListenSession = {
  child: import('node:child_process').ChildProcess;
  durationSeconds: number;
  provider: string;
  sessionId: string;
  startedAt: string;
};

export function createServerState(options: JsonRecord = {}): SpeechState {
  if (options.provider !== undefined || options.openAiTranscriptionModel !== undefined) {
    throw diagnosticError('speech_legacy_configuration_rejected', 'speech_legacy_configuration_rejected: use providerRegistryPath and capabilityPolicy with selection objects');
  }
  const providerRegistryPath = optionalString(options.providerRegistryPath) ?? optionalString(process.env.NARADA_PROVIDER_REGISTRY_PATH);
  if (!providerRegistryPath) {
    throw diagnosticError('speech_provider_registry_path_required', 'speech_provider_registry_path_required: pass --provider-registry-path or NARADA_PROVIDER_REGISTRY_PATH');
  }
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
    options,
    providerRegistryPath: resolve(providerRegistryPath),
    providerRegistry: loadProviderRegistrySync(resolve(providerRegistryPath)),
    capabilityPolicy: (isRecord(options.capabilityPolicy) ? options.capabilityPolicy : {}) as CapabilityPolicy,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function booleanOption(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.trim()) return ['1', 'true', 'yes', 'on', 'admitted', 'allow'].includes(value.trim().toLowerCase());
  }
  return false;
}
