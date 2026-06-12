#!/usr/bin/env node
import { spawn, spawnSync as nodeSpawnSync, exec } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';

const SERVER_NAME = 'speech-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
const OPENAI_MODELS = ['tts-1', 'tts-1-hd'] as const;
const PROVIDERS = ['sapi', 'openai_api'] as const;
const MAX_TEXT_LENGTH = 1000;

type JsonRecord = Record<string, unknown>;

type SpeechState = {
  maxTextLength: number;
  provider: string;
};

export function createServerState(options: JsonRecord = {}): SpeechState {
  return {
    maxTextLength: Number(options.maxTextLength ?? MAX_TEXT_LENGTH),
    provider: String(options.provider ?? 'sapi'),
  };
}

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
  let buffer = '';
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const drained = buffer.includes('Content-Length:') ? drainJsonRpcFrames(buffer) : drainJsonLines(buffer);
    sawFramedInput ||= drained.framed;
    buffer = drained.remaining;
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

export function listTools() {
  return [
    {
      name: 'speech_speak',
      description: 'Speak text through the configured TTS provider (SAPI or OpenAI TTS).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to speak. Max 1000 characters.' },
          provider: { type: 'string', enum: PROVIDERS, description: 'TTS provider. Defaults to sapi.' },
          voice: { type: 'string', description: 'Optional voice name for SAPI, e.g. Microsoft Zira.' },
          rate: { type: 'integer', minimum: -10, maximum: 10, description: 'Speech rate for SAPI. -10 slow to 10 fast. Default 0.' },
          api_key: { type: 'string', description: 'OpenAI API key. Falls back to OPENAI_API_KEY env var.' },
          model: { type: 'string', enum: OPENAI_MODELS, description: 'OpenAI TTS model. Defaults to tts-1.' },
          speed: { type: 'number', minimum: 0.25, maximum: 4.0, description: 'OpenAI speech speed. 0.25 to 4.0. Default 1.0.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { title: 'speech_speak', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'speech_voices',
      description: 'List available voices for a TTS provider. SAPI returns installed Windows voices; openai_api returns known OpenAI voices.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: PROVIDERS, description: 'TTS provider. Defaults to sapi.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'speech_voices', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

async function callTool(params: JsonRecord, state: SpeechState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'speech_speak': result = await speechSpeak(args, state); break;
    case 'speech_voices': result = speechVoices(args, state); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

async function speechSpeak(args: JsonRecord, state: SpeechState): Promise<JsonRecord> {
  const text = requiredString(args.text, 'speech_requires_text').slice(0, state.maxTextLength);
  const provider = optionalString(args.provider) ?? state.provider;
  if (!PROVIDERS.includes(provider as typeof PROVIDERS[number])) throw diagnosticError('speech_invalid_provider', `speech_invalid_provider:${provider}`, { allowed: PROVIDERS });
  if (provider === 'sapi') {
    const voice = optionalString(args.voice);
    const rate = clamp(integer(args.rate, 0, -10, 10), -10, 10);
    return sapiSpeak(text, voice, rate);
  }
  if (provider === 'openai_api') {
    const apiKey = optionalString(args.api_key) ?? process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) throw diagnosticError('speech_openai_no_key', 'speech_openai_no_key: provide api_key or set OPENAI_API_KEY');
    const voice = optionalString(args.voice) ?? 'alloy';
    const model = optionalString(args.model) ?? 'tts-1';
    const speed = typeof args.speed === 'number' && Number.isFinite(args.speed) ? args.speed : 1.0;
    return await openaiSpeak(apiKey, text, voice, model, speed);
  }
  throw diagnosticError('speech_provider_not_implemented', `speech_provider_not_implemented:${provider}`);
}

function sapiSpeak(text: string, voice: string | null, rate: number): JsonRecord {
  const escapedText = text.replace(/"/g, '`"').replace(/\n/g, ' ');
  const voiceParam = voice ? `$synthesizer.SelectVoice('${voice}')` : '';
  const rateParam = rate !== 0 ? `$synthesizer.Rate = ${rate}` : '';
  const setup = [voiceParam, rateParam].filter(Boolean).join('; ');
  const psScript = `Add-Type -AssemblyName System.Speech; $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${setup ? `${setup};` : ''} $synthesizer.Speak('${escapedText}'); $synthesizer.Dispose()`;
  const result = execPowershell(psScript);
  if (result.exitCode !== 0) throw diagnosticError('speech_sapi_failed', `speech_sapi_failed:${result.exitCode}`, { stderr: result.stderr });
  return { status: 'spoken', provider: 'sapi', text_length: text.length, voice: voice || 'default', rate };
}

function openaiSpeak(apiKey: string, text: string, voice: string, model: string, speed: number): Promise<JsonRecord> {
  const body = JSON.stringify({ model, input: text, voice, speed, response_format: 'wav' });
  return fetch(OPENAI_TTS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body,
  }).then(async (res) => {
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch { /* ignore */ }
      throw diagnosticError('speech_openai_api_error', `speech_openai_api_error:${res.status}`, { status: res.status, detail: detail.slice(0, 500) });
    }
    if (!res.body) throw diagnosticError('speech_openai_no_body', 'speech_openai_no_body');
    const wavPath = await writeWavStream(res.body as unknown as Readable);
    try {
      await playWavFile(wavPath);
      return { status: 'spoken', provider: 'openai_api', text_length: text.length, voice, model, speed };
    } finally {
      try { unlinkSync(wavPath); } catch { /* stale */ }
    }
  });
}

async function writeWavStream(body: Readable): Promise<string> {
  const tmpDir = join(tmpdir(), 'speech-mcp');
  mkdirSync(tmpDir, { recursive: true });
  const wavPath = join(tmpDir, `speech_openai_${Date.now()}.wav`);
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
  return wavPath;
}

function playWavFile(wavPath: string): Promise<void> {
  const escapedPath = wavPath.replace(/'/g, "''");
  const psScript = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport("winmm.dll")] public static extern bool PlaySound(string s, IntPtr h, uint f); }'; [W]::PlaySound('${escapedPath}', [IntPtr]::Zero, 0x00020000)`;
  const tmpDir = join(tmpdir(), 'speech-mcp');
  mkdirSync(tmpDir, { recursive: true });
  const scriptPath = join(tmpDir, `speech_play_${Date.now()}.ps1`);
  writeFileSync(scriptPath, psScript, 'utf8');
  return new Promise((resolve) => {
    exec(`start /min "" powershell -NoProfile -File "${scriptPath}"`, { timeout: 5000 }, () => resolve());
  });
}

function speechVoices(args: JsonRecord, _state: SpeechState): JsonRecord {
  const provider = optionalString(args.provider) ?? 'sapi';
  if (provider === 'openai_api') {
    return { status: 'ok', provider: 'openai_api', voices: OPENAI_VOICES.slice(), count: OPENAI_VOICES.length };
  }
  const result = execPowershell('Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }');
  if (result.exitCode !== 0) throw diagnosticError('speech_sapi_failed', `speech_sapi_failed:${result.exitCode}`, { stderr: result.stderr });
  const voices = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return { status: 'ok', provider: 'sapi', voices, count: voices.length };
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

function renderResult(result: JsonRecord): string {
  if (result.voices) return `voices: ${(result.voices as string[]).join(', ')}`;
  if (result.status === 'spoken') return `spoken: ${result.text_length ?? 0} chars (${result.provider ?? 'sapi'}, ${result.voice ?? 'default'})`;
  return `speech: ${result.status ?? 'ok'}`;
}

function requiredString(value: unknown, code: string, details: JsonRecord = {}): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code, code, details);
  return text;
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.trunc(value))); }

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function diagnosticError(code: string, message: string = code, details: JsonRecord = {}) {
  const error = new Error(message);
  Object.assign(error, { codeName: code, details });
  return error;
}

function errorDiagnostic(error: unknown) {
  const record = asRecord(error);
  return { schema: 'narada.speech.error.v1', code: String(record.codeName ?? 'speech_error'), message: error instanceof Error ? error.message : String(error), details: asRecord(record.details) };
}

function drainJsonLines(buffer: string) {
  const lines = buffer.split(/\r?\n/);
  return { framed: false, remaining: lines.pop() ?? '', requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))) };
}

function drainJsonRpcFrames(buffer: string) {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = remaining.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    requests.push(asRecord(JSON.parse(remaining.slice(bodyStart, bodyEnd))));
    remaining = remaining.slice(bodyEnd);
  }
  return { framed: true, remaining, requests };
}

function writeJsonRpcResponse(response: JsonRecord, { framed }: { framed: boolean }) {
  const body = JSON.stringify(response);
  if (framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  else process.stdout.write(`${body}\n`);
}

function parseArgs(argv: string[]) {
  const options: JsonRecord = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max-text-length') options.maxTextLength = Number(argv[++i]);
    else if (arg === '--provider') options.provider = argv[++i];
  }
  return options;
}

export { parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
