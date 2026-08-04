import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeObservationSink, runtimeObservationSourceRoot } from '../src/index.js';

test('writes sanitized records to the canonical Site source spool and rotates bounded segments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-runtime-observation-'));
  try {
    const sink = createRuntimeObservationSink({ site_root: root, source_id: 'Factory Service', segment_bytes: 4_096 });
    const record = {
      schema: 'narada.mcp_runtime.lifecycle_event.v1' as const,
      event_id: 'event-1', occurred_at: new Date().toISOString(), site_id: 'site-1', authority_ref: 'site:site-1',
      owner_id: 'owner-1', event_type: 'process_started' as const, surface_id: null, instance_id: null,
      generation_id: null, request_id: null, status: null, inflight: 0,
    };
    for (let index = 0; index < 24; index += 1) {
      assert.equal(await sink.emit({ ...record, event_id: `event-${index}` }), true);
    }
    const sourceRoot = runtimeObservationSourceRoot(root);
    const files = await readdir(sourceRoot);
    assert.equal(files.includes('factory-service.current.jsonl'), true);
    assert.equal(files.some((name) => /^factory-service\.\d+\.\d+\.[0-9a-f-]+\.jsonl$/.test(name)), true);
    const text = await readFile(join(sourceRoot, 'factory-service.current.jsonl'), 'utf8');
    const lastLine = text.trim().split('\n').at(-1);
    assert.equal(JSON.parse(lastLine!).event_id, 'event-23');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sink failure is reported as false rather than entering the control path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-runtime-observation-failure-'));
  const file = join(root, 'not-a-directory');
  try {
    await writeFile(file, 'fixture');
    const sink = createRuntimeObservationSink({ site_root: file, source_id: 'fixture' });
    const emitted = await sink.emit({
      schema: 'narada.mcp_runtime.lifecycle_event.v1', event_id: 'event-2', occurred_at: new Date().toISOString(),
      site_id: 'site-1', authority_ref: 'site:site-1', owner_id: 'owner-1', event_type: 'process_started',
      surface_id: null, instance_id: null, generation_id: null, request_id: null, status: null, inflight: 0,
    });
    assert.equal(emitted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
