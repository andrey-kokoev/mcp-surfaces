import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { showSiteLoopRun } from '../src/site-loop/site-loop-engine.js';
import { beginLoopRun, finishLoopRun, openSiteLoopStore, recordLoopStep } from '../src/site-loop/site-loop-store.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-run-show-'));
mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
mkdirSync(join(siteRoot, '.ai', 'state'), { recursive: true });

writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  schema: 'narada.site_loop.config.v2',
  loop_id: 'run-show.test.loop',
  site_id: 'narada-run-show-test',
  display_name: 'Run show test loop',
  resident: {
    agent_id: 'resident',
    role: 'resident',
  },
  refs: {
    ticket_projection: { kind: 'ticket_projection', ref: 'run-show-test' },
  },
}, null, 2), 'utf8');

const store = openSiteLoopStore(siteRoot, { write: true, storeMode: 'prepare' });
const runId = 'site_loop_run_show_test_001';
const oversizedEvidence = {
  status: 'ok',
  evaluated: 25,
  materialized: 0,
  raw_transcript: 'x'.repeat(80_000),
};
const oversizedRunSummary = {
  step_count: 1,
  raw_transcript: 'y'.repeat(80_000),
};
const inputRefs = [{ kind: 'mailbox', ref: 'input-1' }];
const outputRefs = [{ kind: 'receipt', ref: 'output-1' }];

beginLoopRun(store, {
  run_id: runId,
  loop_id: 'run-show.test.loop',
  status: 'running',
  dry_run: false,
  started_at: '2026-07-08T00:00:00.000Z',
});
recordLoopStep(store, {
  step_run_id: 'step_run_show_test_001',
  run_id: runId,
  step_id: 'oversized_evidence_step',
  status: 'ok',
  started_at: '2026-07-08T00:00:01.000Z',
  finished_at: '2026-07-08T00:00:02.000Z',
  input_refs: inputRefs,
  output_refs: outputRefs,
  evidence: oversizedEvidence,
});
finishLoopRun(store, runId, {
  status: 'ok',
  finished_at: '2026-07-08T00:00:03.000Z',
  summary: oversizedRunSummary,
});
store.close();

const defaultResult = showSiteLoopRun(siteRoot, { run_id: runId });
const defaultRun = defaultResult.run as Record<string, any>;
assert.equal(defaultResult.status, 'ok');
assert.equal(defaultResult.detail, 'summary');
assert.equal(defaultRun.compacted, true);
assert.equal(defaultRun.steps.length, 1);
assert.equal(defaultRun.summary.schema, 'narada.site_loop.evidence_summary.v1');
assert.equal(defaultRun.summary.keys.includes('step_count'), true);
assert.equal(defaultRun.summary.byte_length > 16_384, true);
assert.equal(defaultRun.steps[0].evidence, undefined);
assert.equal(defaultRun.steps[0].evidence_summary.fields.evaluated, 25);
assert.equal(typeof defaultRun.steps[0].input_refs_digest, 'string');
assert.equal(typeof defaultRun.steps[0].output_refs_digest, 'string');
assert.equal(JSON.stringify(defaultResult).includes(oversizedEvidence.raw_transcript), false);
assert.equal(JSON.stringify(defaultResult).includes(oversizedRunSummary.raw_transcript), false);

const fullResult = showSiteLoopRun(siteRoot, { run_id: runId, detail: 'full' });
const fullRun = fullResult.run as Record<string, any>;
assert.equal(fullResult.status, 'ok');
assert.equal(fullResult.detail, 'full');
assert.equal(fullRun.summary.raw_transcript, oversizedRunSummary.raw_transcript);
assert.deepEqual(fullRun.steps[0].input_refs, inputRefs);
assert.deepEqual(fullRun.steps[0].output_refs, outputRefs);
assert.equal(fullRun.steps[0].evidence.raw_transcript, oversizedEvidence.raw_transcript);

function evidenceArtifactPath(ref: string): string {
  const sha256 = ref.replace('site_loop_evidence:', '');
  return join(siteRoot, '.ai', 'site-loop-evidence', sha256.slice(0, 2), `${sha256}.json.gz`);
}

const corruptionStore = openSiteLoopStore(siteRoot, { write: true });
const corruptionRunId = 'site_loop_run_show_corruption_001';
beginLoopRun(corruptionStore, {
  run_id: corruptionRunId,
  loop_id: 'run-show.test.loop',
  status: 'running',
  dry_run: false,
  started_at: '2026-07-08T00:01:00.000Z',
});
finishLoopRun(corruptionStore, corruptionRunId, {
  status: 'ok',
  finished_at: '2026-07-08T00:01:01.000Z',
  summary: { raw_transcript: 'z'.repeat(80_000) },
});
corruptionStore.close();
const corruptionResult = showSiteLoopRun(siteRoot, { run_id: corruptionRunId, detail: 'full' });
writeFileSync(evidenceArtifactPath(String((corruptionResult.run as Record<string, any>).evidence_ref)), 'corrupt', 'utf8');
assert.throws(
  () => showSiteLoopRun(siteRoot, { run_id: corruptionRunId, detail: 'full' }),
  /site_loop_evidence_/,
);

rmSync(evidenceArtifactPath(String(fullRun.steps[0].evidence_ref)));
assert.throws(
  () => showSiteLoopRun(siteRoot, { run_id: runId, detail: 'full' }),
  /site_loop_evidence_unavailable/,
);

writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  schema: 'narada.site_loop.config.v2',
  loop_id: 'run-show.test.loop',
  site_id: 'narada-run-show-test',
  display_name: 'Run show test loop',
  resident: { agent_id: 'resident', role: 'resident' },
  refs: { ticket_projection: { kind: 'ticket_projection', ref: 'run-show-test' } },
  persistence: { evidence_root: '.ai/other-site-loop-evidence' },
}, null, 2), 'utf8');
assert.throws(
  () => showSiteLoopRun(siteRoot, { run_id: runId }),
  /evidence_root_mismatch/,
);

console.log('site-loop run show compaction ok');
