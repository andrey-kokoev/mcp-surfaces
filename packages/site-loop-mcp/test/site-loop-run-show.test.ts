import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { showSiteLoopRun } from '../src/site-loop/site-loop-engine.js';
import { beginLoopRun, finishLoopRun, openSiteLoopStore, recordLoopStep } from '../src/site-loop/site-loop-store.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-run-show-'));
mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
mkdirSync(join(siteRoot, '.ai', 'state'), { recursive: true });

writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  schema: 'narada.site_loop.config.v1',
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

const store = openSiteLoopStore(siteRoot, { write: true });
const runId = 'site_loop_run_show_test_001';
const oversizedEvidence = {
  status: 'ok',
  evaluated: 25,
  materialized: 0,
  raw_transcript: 'x'.repeat(80_000),
};

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
  evidence: oversizedEvidence,
});
finishLoopRun(store, runId, {
  status: 'ok',
  finished_at: '2026-07-08T00:00:03.000Z',
  summary: { step_count: 1 },
});
store.close();

const defaultResult = showSiteLoopRun(siteRoot, { run_id: runId });
const defaultRun = defaultResult.run as Record<string, any>;
assert.equal(defaultResult.status, 'ok');
assert.equal(defaultResult.detail, 'summary');
assert.equal(defaultRun.compacted, true);
assert.equal(defaultRun.steps.length, 1);
assert.equal(defaultRun.steps[0].evidence, undefined);
assert.equal(defaultRun.steps[0].evidence_summary.fields.evaluated, 25);
assert.equal(JSON.stringify(defaultResult).includes(oversizedEvidence.raw_transcript), false);

const fullResult = showSiteLoopRun(siteRoot, { run_id: runId, detail: 'full' });
const fullRun = fullResult.run as Record<string, any>;
assert.equal(fullResult.status, 'ok');
assert.equal(fullResult.detail, 'full');
assert.equal(fullRun.steps[0].evidence.raw_transcript, oversizedEvidence.raw_transcript);

console.log('site-loop run show compaction ok');
