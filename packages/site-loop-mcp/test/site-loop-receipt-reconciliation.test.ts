import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SITE_LOOP_CONFIG } from '../src/site-loop/site-loop-config.js';
import { reconcileCarrierReceipts } from '../src/task-lifecycle/dispatch-directives.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-receipt-reconciliation-'));
const configRoot = join(siteRoot, '.narada', 'capabilities');
const sessionId = 'carrier_receipt_test_1';
const unrelatedSessionId = 'carrier_receipt_unrelated';
mkdirSync(configRoot, { recursive: true });
writeFileSync(join(configRoot, 'site-loop-config.json'), JSON.stringify({
  ...DEFAULT_SITE_LOOP_CONFIG,
  site_id: 'receipt-test',
  loop_id: 'receipt-test.loop',
  resident_runtime: {
    ...DEFAULT_SITE_LOOP_CONFIG.resident_runtime,
    session_root: '.narada/crew/nars-sessions',
    external_session_roots: [],
  },
}, null, 2));

const sessionRoot = join(siteRoot, '.narada', 'crew', 'nars-sessions');
const sessionDir = join(sessionRoot, sessionId);
const unrelatedSessionDir = join(sessionRoot, unrelatedSessionId);
mkdirSync(sessionDir, { recursive: true });
mkdirSync(unrelatedSessionDir, { recursive: true });

const directives = new Map([
  ['dir_receipt_1', { target: { kind: 'agent', id: 'resident' }, delivery: {} }],
  ['dir_receipt_2', { target: { kind: 'agent', id: 'resident' }, delivery: {} }],
  ['dir_unrelated', { target: { kind: 'agent', id: 'resident' }, delivery: {} }],
]);
const receipts = [];
const triages = [];
const db = new DatabaseSync(':memory:');
const store = {
  db,
  getDirective(directiveId) {
    return directives.get(directiveId);
  },
  recordReceipt(directiveId, receipt) {
    const receiptRecord = { receipt_id: `receipt_${directiveId}`, directive_id: directiveId, ...receipt };
    receipts.push(receiptRecord);
    const directive = directives.get(directiveId);
    directives.set(directiveId, { ...directive, delivery: { ...(directive?.delivery ?? {}), receipt_id: receiptRecord.receipt_id } });
    return receiptRecord;
  },
  recordTriage(directiveId, triage) {
    const triageRecord = { triage_id: `triage_${directiveId}`, directive_id: directiveId, ...triage };
    triages.push(triageRecord);
    return triageRecord;
  },
};

function receiptEvent(directiveId) {
  return JSON.stringify({
    event: 'directive_receipt_recorded',
    directive_id: directiveId,
    received_at: '2026-07-21T23:00:00.000Z',
    carrier_session_id: sessionId,
    agent_id: 'resident',
    transport: 'jsonl_stdio',
  });
}

writeFileSync(join(sessionDir, 'events.jsonl'), `${receiptEvent('dir_receipt_1')}\n`);
writeFileSync(join(unrelatedSessionDir, 'events.jsonl'), `${JSON.stringify({
  event: 'directive_receipt_recorded',
  directive_id: 'dir_unrelated',
  carrier_session_id: unrelatedSessionId,
  agent_id: 'resident',
  transport: 'jsonl_stdio',
})}\n`);

const first = reconcileCarrierReceipts(siteRoot, store, { carrierSessionIds: [sessionId] });
assert.equal(first.status, 'ok');
assert.equal(first.scanned, 1);
assert.equal(first.events_scanned, 1);
assert.equal(first.recorded.length, 1);
assert.equal(first.recorded[0].directive_id, 'dir_receipt_1');
assert.equal(receipts.length, 1);

appendFileSync(join(sessionDir, 'events.jsonl'), `${receiptEvent('dir_receipt_2')}\n`);
const second = reconcileCarrierReceipts(siteRoot, store, { carrierSessionIds: [sessionId] });
assert.equal(second.status, 'ok');
assert.equal(second.scanned, 1);
assert.equal(second.events_scanned, 1);
assert.equal(second.recorded.length, 1);
assert.equal(second.recorded[0].directive_id, 'dir_receipt_2');
assert.equal(receipts.length, 2);
assert.equal(triages.length, 0);

const unscoped = reconcileCarrierReceipts(siteRoot, store);
assert.equal(unscoped.status, 'ok');
assert.equal(unscoped.scanned, 0);
assert.equal(unscoped.reason, 'no_targeted_session_ids');
assert.equal(receipts.length, 2);

db.close();
console.log('site-loop receipt reconciliation bounded cursor e2e ok');
