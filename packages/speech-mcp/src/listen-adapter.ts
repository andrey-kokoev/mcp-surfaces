import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JsonRecord } from './protocol.js';

export function buildListenAdapterArgs(adapterPath: string, provider: string, durationSeconds: number, _sessionId: string, calibrate: boolean): string[] {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', adapterPath, '-DurationSeconds', String(durationSeconds)];
  if (provider === 'remote_transcription') args.push('-RecognitionAdapter', 'openai-transcriptions');
  if (calibrate) args.push('-Calibrate');
  args.push('-DisableDebugAudioCues');
  return args;
}

export function buildCaptureTranscribeAdapterArgs(adapterPath: string, args: JsonRecord, durationSeconds: number, calibrate: boolean): string[] {
  const commandArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', adapterPath, '-DurationSeconds', String(durationSeconds), '-RetainAudio', '-DispatchDryRun', '-PassThru'];
  const inputWav = optionalString(args.input_wav);
  const device = optionalString(args.device) ?? (!inputWav && args.self_test_synthetic !== true ? 'auto' : null);
  if (device) commandArgs.push('-Device', device);
  if (inputWav) commandArgs.push('-InputWav', inputWav);
  if (args.self_test_synthetic === true) commandArgs.push('-SelfTestSynthetic');
  if (calibrate) commandArgs.push('-Calibrate');
  if (args.retain_audio !== true) commandArgs.push('-DisableDebugAudioCues');
  return commandArgs;
}

export function resolveListenAdapterPath(options: JsonRecord): string | null {
  const explicit = firstString(options.listenAdapterPath, process.env.NARADA_SPEECH_LISTEN_ADAPTER_PATH);
  if (explicit) return resolve(explicit);
  const siteRoot = firstString(process.env.NARADA_SITE_ROOT, process.env.NARADA_WORKSPACE_ROOT);
  const siteCandidate = siteRoot ? resolve(siteRoot, 'tools/operator-surface-carriers/Start-VoiceIntentLocalMonitor.ps1') : null;
  const naradaCandidate = 'D:\\code\\narada\\packages\\operator-surface-carriers\\src\\Start-VoiceIntentLocalMonitor.ps1';
  return [siteCandidate, naradaCandidate].filter((value): value is string => Boolean(value)).find((candidate) => existsSync(candidate)) ?? siteCandidate ?? naradaCandidate;
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
