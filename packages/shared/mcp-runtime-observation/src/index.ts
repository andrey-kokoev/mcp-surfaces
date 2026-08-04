import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type {
  RuntimeLifecycleEventV1,
  RuntimeResourceOwnerV1,
} from '@narada-core/mcp-fabric-contracts';

export const DEFAULT_RUNTIME_OBSERVATION_SEGMENT_BYTES = 8 * 1024 * 1024;

export type RuntimeObservationRecord = RuntimeResourceOwnerV1 | RuntimeLifecycleEventV1;

export type RuntimeObservationSink = {
  readonly source_id: string;
  readonly path: string;
  emit(record: RuntimeObservationRecord): Promise<boolean>;
};

export function runtimeObservationSourceRoot(siteRoot: string): string {
  return join(resolve(siteRoot), '.narada', 'runtime', 'mcp-runtime-observer', 'sources');
}

export function createRuntimeObservationSink(input: {
  site_root: string;
  source_id: string;
  segment_bytes?: number;
  on_error?: (error: Error) => void;
}): RuntimeObservationSink {
  const sourceId = normalizeSourceId(input.source_id);
  const root = runtimeObservationSourceRoot(input.site_root);
  const path = join(root, `${sourceId}.current.jsonl`);
  const limit = normalizeSegmentBytes(input.segment_bytes);
  let sequence = Promise.resolve(true);
  return {
    source_id: sourceId,
    path,
    emit(record) {
      sequence = sequence.then(async () => {
        try {
          await mkdir(root, { recursive: true });
          const line = `${JSON.stringify(record)}\n`;
          const currentSize = await stat(path).then((value) => value.size, () => 0);
          if (currentSize > 0 && currentSize + Buffer.byteLength(line) > limit) {
            const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
            await rename(path, join(root, `${sourceId}.${stamp}.${process.pid}.${randomUUID()}.jsonl`));
          }
          await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
          return true;
        } catch (error) {
          input.on_error?.(error instanceof Error ? error : new Error(String(error)));
          return false;
        }
      }, async () => false);
      return sequence;
    },
  };
}

function normalizeSourceId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('mcp_runtime_observation_source_id_invalid');
  return normalized;
}

function normalizeSegmentBytes(value: number | undefined): number {
  const result = value ?? DEFAULT_RUNTIME_OBSERVATION_SEGMENT_BYTES;
  if (!Number.isSafeInteger(result) || result < 4_096 || result > 128 * 1024 * 1024) {
    throw new Error('mcp_runtime_observation_segment_bytes_invalid');
  }
  return result;
}
