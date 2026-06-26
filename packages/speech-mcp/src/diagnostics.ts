import type { JsonRecord } from './protocol.js';

export function diagnosticError(code: string, message: string = code, details: JsonRecord = {}): Error {
  const error = new Error(message);
  Object.assign(error, { codeName: code, details });
  return error;
}

export function errorDiagnostic(error: unknown): JsonRecord {
  const record = asRecord(error);
  return { schema: 'narada.speech.error.v1', code: String(record.codeName ?? 'speech_error'), message: error instanceof Error ? error.message : String(error), details: asRecord(record.details) };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
