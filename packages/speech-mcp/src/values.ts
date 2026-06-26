import { diagnosticError } from './diagnostics.js';
import type { JsonRecord } from './protocol.js';

export function renderResult(result: JsonRecord): string {
  if (result.voices) return `voices: ${(result.voices as string[]).join(', ')}`;
  if (result.status === 'spoken') return `spoken: ${result.text_length ?? 0} chars (${result.provider ?? 'sapi'}, ${result.voice ?? 'default'})`;
  return `speech: ${result.status ?? 'ok'}`;
}

export function requiredString(value: unknown, code: string, details: JsonRecord = {}): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code, code, details);
  return text;
}

export function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return null;
}

export function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
