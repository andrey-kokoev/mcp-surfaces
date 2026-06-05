import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { diagnosticError } from './errors.js';
import type { WorkerPolicy } from './policy.js';

export function materializeOutput(policy: WorkerPolicy, toolName: string, text: string): Record<string, unknown> {
  const dir = resolve(policy.runRoot, 'outputs');
  mkdirSync(dir, { recursive: true });
  const id = `worker_output:${randomBytes(12).toString('hex')}`;
  const path = join(dir, `${id.replace(':', '_')}.txt`);
  writeFileSync(path, text, 'utf8');
  return {
    schema: 'narada.worker.output_ref.v1',
    status: 'ok',
    tool_name: toolName,
    output_ref: id,
    reader_tool: 'worker_output_show',
    full_output_byte_length: Buffer.byteLength(text, 'utf8'),
    path,
  };
}

export function showOutput(policy: WorkerPolicy, args: Record<string, unknown>): Record<string, unknown> {
  const outputRef = String(args.output_ref ?? '').trim();
  if (!outputRef.startsWith('worker_output:')) throw diagnosticError('worker_output_materialization_failed', 'worker_output_materialization_failed', { output_ref: outputRef });
  const path = resolve(policy.runRoot, 'outputs', `${outputRef.replace(':', '_')}.txt`);
  const text = readFileSync(path, 'utf8');
  const offset = strictInteger(args.offset, 0, text.length, 0, 'offset');
  const limit = strictInteger(args.limit, 1, 50 * 1024 * 1024, 10000, 'limit');
  const outputText = text.slice(offset, offset + limit);
  return {
    schema: 'narada.worker.output_show.v1',
    status: 'ok',
    output_ref: outputRef,
    offset,
    limit,
    output_text: outputText,
    full_output_byte_length: Buffer.byteLength(text, 'utf8'),
    output_truncated: offset + outputText.length < text.length,
  };
}

function strictInteger(value: unknown, min: number, max: number, defaultValue: number, field: string): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) throw diagnosticError('worker_invalid_config_value', 'worker_invalid_integer', { field, value });
  if (parsed < min || parsed > max) throw diagnosticError('worker_invalid_config_value', 'worker_integer_out_of_range', { field, value, min, max });
  return parsed;
}
