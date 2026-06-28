import { spawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { withAudibleOutput } from './audible-output.js';
import { OPENAI_TTS_URL, OPENAI_VOICES, PROVIDERS } from './constants.js';
import { diagnosticError } from './diagnostics.js';
import type { JsonRecord } from './protocol.js';
import { resolveOpenAiApiKey } from './secrets.js';
import type { SpeechState } from './state.js';
import { clamp, firstString, integer, optionalString, requiredString } from './values.js';

export async function speechSpeak(args: JsonRecord, state: SpeechState): Promise<JsonRecord> {
  const text = requiredString(args.text, 'speech_requires_text').slice(0, state.maxTextLength);
  const provider = optionalString(args.provider) ?? state.provider;
  if (!PROVIDERS.includes(provider as typeof PROVIDERS[number])) throw diagnosticError('speech_invalid_provider', `speech_invalid_provider:${provider}`, { allowed: PROVIDERS });
  const speakerAnnouncement = resolveSpeakerAnnouncement(args, state);
  const spokenText = speakerAnnouncement.announced ? `${speakerAnnouncement.prefix_text} ${text}` : text;
  return await withAudibleOutput(state, { kind: 'speech_speak', provider, text_length: text.length, spoken_text_length: spokenText.length, speaker_announcement: speakerAnnouncement }, async () => {
    const spoken = state.audibleOutputForTest
      ? await state.audibleOutputForTest({ kind: 'speech_speak', provider, text: spokenText, requested_text: text, speaker_announcement: speakerAnnouncement })
      : await speechSpeakUnqueued(args, state, text, provider, speakerAnnouncement);
    return { ...spoken, requested_text_length: text.length, spoken_text_length: spokenText.length, speaker_announcement: speakerAnnouncement };
  });
}

function resolveSpeakerAnnouncement(args: JsonRecord, state: SpeechState): JsonRecord {
  const enabled = typeof args.announce_speaker === 'boolean' ? args.announce_speaker : state.announceSpeaker;
  const agentId = firstString(args.speaker_agent_id, process.env.NARADA_AGENT_ID, process.env.NARADA_AGENT_NAME);
  return {
    enabled,
    announced: Boolean(enabled && agentId),
    agent_id: agentId,
    prefix_text: agentId ? `${agentId} here:` : null,
    source: agentId ? (optionalString(args.speaker_agent_id) ? 'argument' : 'environment') : null,
  };
}

async function speechSpeakUnqueued(args: JsonRecord, state: SpeechState, text: string, provider: string, speakerAnnouncement: JsonRecord): Promise<JsonRecord> {
  const speakerAnnouncementAudio = speakerAnnouncement.announced ? await playSpeakerAnnouncement(args, state, provider, speakerAnnouncement) : null;
  if (provider === 'sapi') {
    const voice = optionalString(args.voice);
    const rate = clamp(integer(args.rate, 0, -10, 10), -10, 10);
    return { ...sapiSpeak(text, voice, rate), speaker_announcement_audio: speakerAnnouncementAudio };
  }
  if (provider === 'openai_api') {
    const apiKey = resolveOpenAiApiKey(args, state);
    if (!apiKey) throw diagnosticError('speech_openai_no_key', 'speech_openai_no_key: provide api_key or set OPENAI_API_KEY');
    const voice = optionalString(args.voice) ?? 'nova';
    const model = optionalString(args.model) ?? 'tts-1';
    const speed = typeof args.speed === 'number' && Number.isFinite(args.speed) ? args.speed : 1.0;
    return { ...await openaiSpeak(apiKey, text, voice, model, speed), speaker_announcement_audio: speakerAnnouncementAudio };
  }
  throw diagnosticError('speech_provider_not_implemented', `speech_provider_not_implemented:${provider}`);
}

async function playSpeakerAnnouncement(args: JsonRecord, state: SpeechState, provider: string, speakerAnnouncement: JsonRecord): Promise<JsonRecord> {
  const prefixText = requiredString(speakerAnnouncement.prefix_text, 'speech_speaker_announcement_prefix_missing');
  mkdirSync(state.announcementCacheDir, { recursive: true });
  if (provider === 'sapi') {
    const voice = optionalString(args.voice);
    const rate = clamp(integer(args.rate, 0, -10, 10), -10, 10);
    const cache = announcementCachePath(state, { provider, voice: voice ?? 'default', rate, prefix_text: prefixText });
    const cacheHit = existsSync(cache.path);
    if (!cacheHit) sapiWriteSpeechWav(prefixText, voice, rate, cache.path);
    await playWavFile(cache.path);
    return { status: 'played', provider, cache_status: cacheHit ? 'hit' : 'miss', cache_key: cache.key, path: cache.path, voice: voice ?? 'default', rate, prefix_text: prefixText };
  }
  if (provider === 'openai_api') {
    const apiKey = resolveOpenAiApiKey(args, state);
    if (!apiKey) throw diagnosticError('speech_openai_no_key', 'speech_openai_no_key: provide api_key or set OPENAI_API_KEY');
    const voice = optionalString(args.voice) ?? 'nova';
    const model = optionalString(args.model) ?? 'tts-1';
    const speed = typeof args.speed === 'number' && Number.isFinite(args.speed) ? args.speed : 1.0;
    const cache = announcementCachePath(state, { provider, voice, model, speed, prefix_text: prefixText });
    const cacheHit = existsSync(cache.path);
    if (!cacheHit) await openaiWriteSpeechWav(apiKey, prefixText, voice, model, speed, cache.path);
    await playWavFile(cache.path);
    return { status: 'played', provider, cache_status: cacheHit ? 'hit' : 'miss', cache_key: cache.key, path: cache.path, voice, model, speed, prefix_text: prefixText };
  }
  throw diagnosticError('speech_provider_not_implemented', `speech_provider_not_implemented:${provider}`);
}

function announcementCachePath(state: SpeechState, parts: JsonRecord): { key: string; path: string } {
  const key = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
  return { key, path: join(state.announcementCacheDir, `${key}.wav`) };
}

function sapiSpeak(text: string, voice: string | null, rate: number): JsonRecord {
  const escapedText = powerShellSingleQuotedString(text.replace(/\n/g, ' '));
  const voiceParam = voice ? `$synthesizer.SelectVoice(${powerShellSingleQuotedString(voice)})` : '';
  const rateParam = rate !== 0 ? `$synthesizer.Rate = ${rate}` : '';
  const setup = [voiceParam, rateParam].filter(Boolean).join('; ');
  const psScript = `Add-Type -AssemblyName System.Speech; $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${setup ? `${setup};` : ''} $synthesizer.Speak(${escapedText}); $synthesizer.Dispose()`;
  const result = execPowershell(psScript);
  if (result.exitCode !== 0) throw diagnosticError('speech_sapi_failed', `speech_sapi_failed:${result.exitCode}`, { stderr: result.stderr });
  return { status: 'spoken', provider: 'sapi', text_length: text.length, voice: voice || 'default', rate };
}

function sapiWriteSpeechWav(text: string, voice: string | null, rate: number, wavPath: string): void {
  const escapedText = powerShellSingleQuotedString(text.replace(/\n/g, ' '));
  const escapedPath = powerShellSingleQuotedString(wavPath);
  const voiceParam = voice ? `$synthesizer.SelectVoice(${powerShellSingleQuotedString(voice)})` : '';
  const rateParam = rate !== 0 ? `$synthesizer.Rate = ${rate}` : '';
  const setup = [voiceParam, rateParam].filter(Boolean).join('; ');
  const psScript = `Add-Type -AssemblyName System.Speech; $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${setup ? `${setup};` : ''} $synthesizer.SetOutputToWaveFile(${escapedPath}); $synthesizer.Speak(${escapedText}); $synthesizer.Dispose()`;
  const result = execPowershell(psScript);
  if (result.exitCode !== 0) throw diagnosticError('speech_sapi_cache_failed', `speech_sapi_cache_failed:${result.exitCode}`, { stderr: result.stderr, path: wavPath });
}

function powerShellSingleQuotedString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function openaiSpeak(apiKey: string, text: string, voice: string, model: string, speed: number): Promise<JsonRecord> {
  const tmpDir = join(tmpdir(), 'speech-mcp');
  mkdirSync(tmpDir, { recursive: true });
  const wavPath = join(tmpDir, `speech_openai_${Date.now()}.wav`);
  return openaiWriteSpeechWav(apiKey, text, voice, model, speed, wavPath).then(async () => {
    try {
      await playWavFile(wavPath);
      return { status: 'spoken', provider: 'openai_api', text_length: text.length, voice, model, speed };
    } finally {
      try { unlinkSync(wavPath); } catch { /* stale */ }
    }
  });
}

async function openaiWriteSpeechWav(apiKey: string, text: string, voice: string, model: string, speed: number, wavPath: string): Promise<void> {
  const body = JSON.stringify({ model, input: text, voice, speed, response_format: 'wav' });
  const res = await fetch(OPENAI_TTS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw diagnosticError('speech_openai_api_error', `speech_openai_api_error:${res.status}`, { status: res.status, detail: detail.slice(0, 500) });
  }
  if (!res.body) throw diagnosticError('speech_openai_no_body', 'speech_openai_no_body');
  await writeWavStreamToPath(res.body as unknown as Readable, wavPath);
}

async function writeWavStreamToPath(body: Readable, wavPath: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  if (buf.length >= 44 && buf.readUInt32BE(0) === 0x52494646) {
    buf.writeUInt32LE(buf.length - 8, 4);
    let i = 36;
    for (; i < buf.length - 4; i++) {
      if (buf.readUInt32BE(i) === 0x64617461) { buf.writeUInt32LE(buf.length - i - 8, i + 4); break; }
    }
  }
  writeFileSync(wavPath, buf);
}

function playWavFile(wavPath: string): Promise<void> {
  const escapedPath = wavPath.replace(/'/g, "''");
  const psScript = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport("winmm.dll")] public static extern bool PlaySound(string s, IntPtr h, uint f); }'; [W]::PlaySound('${escapedPath}', [IntPtr]::Zero, 0x00020000)`;
  const tmpDir = join(tmpdir(), 'speech-mcp');
  mkdirSync(tmpDir, { recursive: true });
  const scriptPath = join(tmpDir, `speech_play_${Date.now()}.ps1`);
  writeFileSync(scriptPath, psScript, 'utf8');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { unlinkSync(scriptPath); } catch { /* stale temp file */ }
      resolve();
    };
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      cleanup();
    }, 60000);
    child.once('error', cleanup);
    child.once('close', cleanup);
  });
}

export function speechVoices(args: JsonRecord, _state: SpeechState): JsonRecord {
  const provider = optionalString(args.provider) ?? 'openai_api';
  if (provider === 'openai_api') {
    return { status: 'ok', provider: 'openai_api', voices: OPENAI_VOICES.slice(), count: OPENAI_VOICES.length };
  }
  const result = execPowershell('Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }');
  if (result.exitCode !== 0) throw diagnosticError('speech_sapi_failed', `speech_sapi_failed:${result.exitCode}`, { stderr: result.stderr });
  const voices = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return { status: 'ok', provider: 'sapi', voices, count: voices.length };
}

export function playListenCue(state: SpeechState, phase: 'start' | 'end'): void {
  if (!state.listenAudioCues) return;
  const sound = phase === 'start' ? 'Asterisk' : 'Beep';
  void withAudibleOutput(state, { kind: 'listen_cue', phase }, () => {
    execPowershell(`[System.Media.SystemSounds]::${sound}.Play(); Start-Sleep -Milliseconds 220`);
    return { status: 'played', provider: 'sapi_system_sound', phase };
  }).catch(() => {
    // Audio cues are advisory; they must not block recording control.
  });
}

function execPowershell(script: string): { stdout: string; stderr: string; exitCode: number } {
  const tmpDir = join(tmpdir(), 'speech-mcp');
  mkdirSync(tmpDir, { recursive: true });
  const scriptPath = join(tmpDir, `speech_${Date.now()}.ps1`);
  writeFileSync(scriptPath, script, 'utf8');
  try {
    const result = nodeSpawnSync('powershell', ['-NoProfile', '-File', scriptPath], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return { stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '', exitCode: result.status ?? -1 };
  } finally {
    try { unlinkSync(scriptPath); } catch { /* stale temp file */ }
  }
}
