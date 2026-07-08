import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAdmissionEvent } from '../src/inbox/admission-log.js';
import { readUnprocessedEnvelopes } from '../src/task-lifecycle/inbox-bridge.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-inbox-bridge-'));
mkdirSync(join(siteRoot, '.ai', 'inbox-envelopes'), { recursive: true });

const envelope = {
  schema: 'narada.inbox.envelope.v1',
  envelope_id: 'env-bridge-materialized-latest',
  received_at: '2026-07-08T00:00:00.000Z',
  kind: 'incident',
  authority: {
    level: 'system_generated',
    principal: 'test',
  },
  source: {
    kind: 'synthetic_fixture',
    ref: 'bridge-materialized-latest',
  },
  payload: {
    title: 'Already materialized envelope',
    summary: 'Regression fixture.',
    target_role: 'resident',
  },
  status: 'promoted',
};

writeFileSync(
  join(siteRoot, '.ai', 'inbox-envelopes', 'fixture-env-bridge-materialized-latest.json'),
  JSON.stringify(envelope, null, 2),
  'utf8',
);

appendAdmissionEvent(siteRoot, {
  envelope_id: envelope.envelope_id,
  event_kind: 'envelope_promoted',
  principal: 'inbox-bridge',
  authority_level: 'system_generated',
  payload_hash: null,
});

appendAdmissionEvent(siteRoot, {
  envelope_id: envelope.envelope_id,
  event_kind: 'bridge_materialized',
  principal: 'inbox-bridge',
  authority_level: 'system_generated',
  payload_hash: null,
});

const unprocessed = readUnprocessedEnvelopes(siteRoot);
assert.equal(
  unprocessed.some((item) => item.envelope_id === envelope.envelope_id),
  false,
  'bridge_materialized as latest admission event must keep an envelope out of unprocessed polling',
);
