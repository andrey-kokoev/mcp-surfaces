import { spawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { listCapabilityCatalog, resolveCapabilitySelection, type ResolvedCapabilitySelection } from '@narada2/provider-registry';
import { withAudibleOutput } from './audible-output.js';
import { OPENAI_TTS_URL } from './constants.js';
import { diagnosticError } from './diagnostics.js';
import type { JsonRecord } from './protocol.js';
import { resolveOpenAiApiKey } from './secrets.js';
import type { SpeechState } from './state.js';
import { clamp, firstString, integer, optionalString, requiredString } from './values.js';

export async function speechSpeak(args: JsonRecord, state: SpeechState): Promise<JsonRecord> {
  const text = requiredString(args.text, 'speech_requires_text').slice(0, state.maxTextLength);
  rejectLegacySelectionArgs(args, 'speech_speak');
  const selection = resolveCapabilitySelection({ registry: state.providerRegistry, capability: 'tts', selection: args.selection, sitePolicy: state.capabilityPolicy });
  const provider = selection.provider;
  const speakerAnnouncement = resolveSpeakerAnnouncement(args, state);
  const spokenText = speakerAnnouncement.announced ? `${speakerAnnouncement.prefix_text} ${text}` : text;
  return await withAudibleOutput(state, { kind: 'speech_speak', provider, resolved_selection: publicSelection(selection), text_length: text.length, spoken_text_length: spokenText.length, speaker_announcement: speakerAnnouncement }, async () => {
    const spoken = state.audibleOutputForTest
      ? await state.audibleOutputForTest({ kind: 'speech_speak', provider, text: spokenText, requested_text: text, resolved_selection: publicSelection(selection), speaker_announcement: speakerAnnouncement })
      : await speechSpeakUnqueued(args, state, text, selection, speakerAnnouncement);
    return { ...spoken, resolved_selection: publicSelection(selection), selection_source: selection.source, selection_warnings: selection.warnings, requested_text_length: text.length, spoken_text_length: spokenText.length, speaker_announcement: speakerAnnouncement };
  });
}

function rejectLegacySelectionArgs(args: JsonRecord, tool: string): void {
  const legacy = ['provider', 'model', 'voice', 'api_key'].find((name) => args[name] !== undefined);
  if (legacy) throw diagnosticError('speech_legacy_selection_argument', `speech_legacy_selection_argument:${legacy}`, { tool, argument: legacy, remediation: 'Use selection:{provider,model,voice}; credentials are resolved by policy.' });
}

function publicSelection(selection: ResolvedCapabilitySelection): JsonRecord {
  return {
    provider: selection.provider,
    model: selection.model,
    capability: selection.capability,
    adapter: selection.adapter,
    ...(selection.voice ? { voice: selection.voice } : {}),
    status: selection.status,
  };
}

function retainedSpeechAudioPath(args: JsonRecord): string | null {
  const explicitPath = optionalString(args.output_path);
  if (explicitPath) return admittedRetainedAudioPath(explicitPath);
  if (args.retain_audio === true) return join(tmpdir(), 'speech-mcp', `speech_retained_${Date.now()}.wav`);
  return null;
}

function admittedRetainedAudioPath(path: string): string {
  const resolvedPath = resolve(path);
  const admittedRoots = [tmpdir(), process.env.NARADA_SITE_ROOT, process.env.NARADA_WORKSPACE_ROOT, process.env.NARADA_SPEECH_OUTPUT_ROOT]
    .filter((value): value is string => Boolean(value))
    .map((value) => resolve(value));
  if (!pathIsWithinAnyRoot(resolvedPath, admittedRoots)) {
    throw diagnosticError('speech_output_path_not_admitted', 'speech_output_path_not_admitted: output_path must be under temp, NARADA_SITE_ROOT, NARADA_WORKSPACE_ROOT, or NARADA_SPEECH_OUTPUT_ROOT', { admitted_roots: admittedRoots });
  }
  return resolvedPath;
}

function pathIsWithinAnyRoot(path: string, roots: string[]): boolean {
  const normalizedPath = resolve(path).toLowerCase();
  return roots.some((root) => {
    const normalizedRoot = resolve(root).toLowerCase();
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`) || normalizedPath.startsWith(`${normalizedRoot}/`);
  });
}

async function sapiSpeakWithRetainedAudio(text: string, voice: string | null, rate: number, wavPath: string): Promise<JsonRecord> {
  sapiWriteSpeechWav(text, voice, rate, wavPath);
  await playWavFile(wavPath);
  return { status: 'spoken', provider: 'sapi', text_length: text.length, voice: voice || 'default', rate, retained_audio: { path: wavPath, content_type: 'audio/wav' } };
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

async function speechSpeakUnqueued(args: JsonRecord, state: SpeechState, text: string, selection: ResolvedCapabilitySelection, speakerAnnouncement: JsonRecord): Promise<JsonRecord> {
  const speakerAnnouncementAudio = speakerAnnouncement.announced ? await playSpeakerAnnouncement(args, state, selection, speakerAnnouncement) : null;
  if (selection.adapter === 'sapi') {
    const voice = selection.voice ?? null;
    const rate = clamp(integer(args.rate, 0, -10, 10), -10, 10);
    const retainedAudioPath = retainedSpeechAudioPath(args);
    const spoken = retainedAudioPath
      ? await sapiSpeakWithRetainedAudio(text, voice, rate, retainedAudioPath)
      : sapiSpeak(text, voice, rate);
    return { ...spoken, speaker_announcement_audio: speakerAnnouncementAudio };
  }
  if (selection.adapter === 'openai-tts') {
    const apiKey = resolveOpenAiApiKey(state, selection.provider);
    if (!apiKey) throw diagnosticError('speech_provider_no_key', `speech_provider_no_key:${selection.provider}`, { provider: selection.provider, remediation: 'Configure the provider secret through the governed secret store or an admitted provider environment variable.' });
    const voice = selection.voice;
    if (!voice) throw diagnosticError('speech_provider_voice_required', `speech_provider_voice_required:${selection.provider}/${selection.model}`);
    const model = selection.model;
    const speed = typeof args.speed === 'number' && Number.isFinite(args.speed) ? args.speed : 1.0;
    return { ...await openaiSpeak(apiKey, text, voice, model, speed, retainedSpeechAudioPath(args)), speaker_announcement_audio: speakerAnnouncementAudio };
  }
  throw diagnosticError('speech_provider_not_implemented', `speech_provider_not_implemented:${selection.provider}`, { adapter: selection.adapter });
}

async function playSpeakerAnnouncement(args: JsonRecord, state: SpeechState, selection: ResolvedCapabilitySelection, speakerAnnouncement: JsonRecord): Promise<JsonRecord> {
  const prefixText = requiredString(speakerAnnouncement.prefix_text, 'speech_speaker_announcement_prefix_missing');
  mkdirSync(state.announcementCacheDir, { recursive: true });
  if (selection.adapter === 'sapi') {
    const voice = selection.voice ?? null;
    const rate = clamp(integer(args.rate, 0, -10, 10), -10, 10);
    const cache = announcementCachePath(state, { provider: selection.provider, model: selection.model, voice: voice ?? 'default', rate, prefix_text: prefixText });
    const cacheHit = existsSync(cache.path);
    if (!cacheHit) sapiWriteSpeechWav(prefixText, voice, rate, cache.path);
    await playWavFile(cache.path);
    return { status: 'played', provider: selection.provider, model: selection.model, cache_status: cacheHit ? 'hit' : 'miss', cache_key: cache.key, path: cache.path, voice: voice ?? 'default', rate, prefix_text: prefixText };
  }
  if (selection.adapter === 'openai-tts') {
    const apiKey = resolveOpenAiApiKey(state, selection.provider);
    if (!apiKey) throw diagnosticError('speech_provider_no_key', `speech_provider_no_key:${selection.provider}`, { provider: selection.provider });
    const voice = selection.voice;
    if (!voice) throw diagnosticError('speech_provider_voice_required', `speech_provider_voice_required:${selection.provider}/${selection.model}`);
    const model = selection.model;
    const speed = typeof args.speed === 'number' && Number.isFinite(args.speed) ? args.speed : 1.0;
    const cache = announcementCachePath(state, { provider: selection.provider, voice, model, speed, prefix_text: prefixText });
    const cacheHit = existsSync(cache.path);
    if (!cacheHit) await openaiWriteSpeechWav(apiKey, prefixText, voice, model, speed, cache.path);
    await playWavFile(cache.path);
    return { status: 'played', provider: selection.provider, cache_status: cacheHit ? 'hit' : 'miss', cache_key: cache.key, path: cache.path, voice, model, speed, prefix_text: prefixText };
  }
  throw diagnosticError('speech_provider_not_implemented', `speech_provider_not_implemented:${selection.provider}`, { adapter: selection.adapter });
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
  mkdirSync(dirname(wavPath), { recursive: true });
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

function openaiSpeak(apiKey: string, text: string, voice: string, model: string, speed: number, retainedAudioPath: string | null): Promise<JsonRecord> {
  const tmpDir = join(tmpdir(), 'speech-mcp');
  mkdirSync(tmpDir, { recursive: true });
  const wavPath = retainedAudioPath ?? join(tmpDir, `speech_openai_${Date.now()}.wav`);
  return openaiWriteSpeechWav(apiKey, text, voice, model, speed, wavPath).then(async () => {
    try {
      await playWavFile(wavPath);
      return { status: 'spoken', provider: 'openai-api', text_length: text.length, voice, model, speed, ...(retainedAudioPath ? { retained_audio: { path: retainedAudioPath, content_type: 'audio/wav' } } : {}) };
    } finally {
      if (!retainedAudioPath) try { unlinkSync(wavPath); } catch { /* stale */ }
    }
  });
}

async function openaiWriteSpeechWav(apiKey: string, text: string, voice: string, model: string, speed: number, wavPath: string): Promise<void> {
  mkdirSync(dirname(wavPath), { recursive: true });
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

export function speechVoices(args: JsonRecord, state: SpeechState): JsonRecord {
  rejectLegacySelectionArgs(args, 'speech_voices');
  const selection = resolveCapabilitySelection({ registry: state.providerRegistry, capability: 'tts', selection: args.selection, sitePolicy: state.capabilityPolicy });
  if (selection.adapter === 'openai-tts') {
    const catalog = listCapabilityCatalog(state.providerRegistry, 'tts').find((item) => item.provider === selection.provider && item.model === selection.model);
    const voices = Array.isArray(catalog?.voices) ? catalog.voices : [];
    return { status: 'ok', provider: selection.provider, model: selection.model, resolved_selection: publicSelection(selection), selection_source: selection.source, voices, count: voices.length };
  }
  const result = execPowershell('Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }');
  if (result.exitCode !== 0) throw diagnosticError('speech_sapi_failed', `speech_sapi_failed:${result.exitCode}`, { stderr: result.stderr });
  const voices = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return { status: 'ok', provider: selection.provider, model: selection.model, resolved_selection: publicSelection(selection), selection_source: selection.source, voices, count: voices.length };
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
