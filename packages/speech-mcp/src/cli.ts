import type { JsonRecord } from './protocol.js';
import { diagnosticError } from './diagnostics.js';

export function parseArgs(argv: string[]): JsonRecord {
  const options: JsonRecord = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max-text-length') options.maxTextLength = Number(argv[++i]);
    else if (arg === '--provider') throw diagnosticError('speech_legacy_configuration_rejected', 'speech_legacy_configuration_rejected: --provider was replaced by provider-rooted selection objects and registry policy');
    else if (arg === '--provider-registry-path') options.providerRegistryPath = argv[++i];
    else if (arg === '--provider-secret-store') options.providerSecretStore = argv[++i];
    else if (arg === '--listen-adapter-path') options.listenAdapterPath = argv[++i];
    else if (arg === '--listen-audio-cues') options.listenAudioCues = argv[++i];
    else if (arg === '--no-listen-audio-cues') options.listenAudioCues = false;
    else if (arg === '--announce-speaker') options.announceSpeaker = true;
    else if (arg === '--no-announce-speaker') options.announceSpeaker = false;
    else if (arg === '--announcement-cache-dir') options.announcementCacheDir = argv[++i];
    else if (arg === '--allow-remote-audio-egress') options.allowRemoteAudioEgress = true;
    else if (arg === '--max-listen-duration-seconds') options.maxListenDurationSeconds = Number(argv[++i]);
    else if (arg === '--openai-transcription-model') throw diagnosticError('speech_legacy_configuration_rejected', 'speech_legacy_configuration_rejected: --openai-transcription-model was replaced by the provider registry');
  }
  return options;
}
