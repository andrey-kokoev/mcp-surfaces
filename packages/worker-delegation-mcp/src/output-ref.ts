import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
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

function resolveOutputRefPath(policy: WorkerPolicy, outputRef: string): string {
  if (!outputRef.startsWith('worker_output:')) throw diagnosticError('worker_output_materialization_failed', 'worker_output_ref_invalid', { output_ref: outputRef });
  return resolve(policy.runRoot, 'outputs', `${outputRef.replace(':', '_')}.txt`);
}

function resolveArtifactPath(policy: WorkerPolicy, inputPath: string): string {
  const path = resolve(inputPath);
  const runRoot = resolve(policy.runRoot);
  if (path !== runRoot && !isPathInside(path, runRoot)) throw diagnosticError('worker_output_materialization_failed', 'worker_artifact_path_outside_run_root', { path, run_root: runRoot });
  return path;
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function showOutput(policy: WorkerPolicy, args: Record<string, unknown>): Record<string, unknown> {
  const outputRef = String(args.output_ref ?? '').trim();
  const artifactPath = String(args.path ?? '').trim();
  if (!outputRef && !artifactPath) throw diagnosticError('worker_output_materialization_failed', 'worker_output_show_requires_output_ref_or_path');
  if (outputRef && artifactPath) throw diagnosticError('worker_output_materialization_failed', 'worker_output_show_accepts_one_source');
  const path = artifactPath ? resolveArtifactPath(policy, artifactPath) : resolveOutputRefPath(policy, outputRef);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw diagnosticError('worker_output_materialization_failed', 'worker_output_read_failed', { output_ref: outputRef || null, path, error: message });
  }
  const offset = strictInteger(args.offset, 0, text.length, 0, 'offset');
  const limit = strictInteger(args.limit, 1, 50 * 1024 * 1024, 10000, 'limit');
  const outputText = text.slice(offset, offset + limit);
  return {
    schema: 'narada.worker.output_show.v1',
    status: 'ok',
    output_ref: outputRef || null,
    path,
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
