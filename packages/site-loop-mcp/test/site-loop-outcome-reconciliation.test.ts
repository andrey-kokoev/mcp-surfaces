import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDirectiveRuntimeStore } from '@narada2/task-governance-core/directive-runtime-store';
import { runAgentOutcomeReconciliation } from '../src/site-loop/site-loop-engine.js';
import { openTaskLifecycleStoreWithDiscipline } from '../src/task-lifecycle/sqlite-discipline.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-outcome-reconciliation-'));
mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
mkdirSync(join(siteRoot, '.ai', 'state'), { recursive: true });

writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  schema: 'narada.site_loop.config.v1',
  loop_id: 'outcome.test.loop',
  site_id: 'narada-outcome-test',
  display_name: 'Outcome reconciliation test loop',
  resident: {
    agent_id: 'resident',
    role: 'resident',
  },
  refs: {
    ticket_projection: { kind: 'ticket_projection', ref: 'outcome-test' },
  },
}, null, 2), 'utf8');

const store = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: true });
const directiveStore = new SqliteDirectiveRuntimeStore({ db: store.db });
directiveStore.initSchema();

const emitted = directiveStore.emitResidentDirectiveForAdmittedWork({
  siteId: 'narada-outcome-test',
  authorityLocus: 'client_service',
  systemEmitterId: 'narada-outcome-test.system.resident_e2e',
  residentAgentId: 'resident',
  residentRole: 'resident',
  taskId: '20260707-470-from-inbox-resident-e2e-fixture',
  taskNumber: 470,
  sourceId: 'env_resident-e2e-test',
  transitionId: 'resident_e2e_fixture:env_resident-e2e-test',
  title: 'Resident E2E fixture: env_resident-e2e-test',
  admittedAt: '2026-07-08T00:00:00.000Z',
});

store.db.close();

const result = runAgentOutcomeReconciliation(siteRoot, {
  directiveIds: [emitted.directive.directive_id],
  includeBacklog: false,
  nowIso: '2026-07-08T00:01:00.000Z',
  resident: { status: 'available' },
});

assert.equal(result.status, 'ok');
assert.equal(result.classifications.length, 1);
assert.equal(result.classifications[0].status, 'pending');
assert.equal(result.classifications[0].reason, 'awaiting_receipt');
assert.equal(result.outcome_records.length, 1);
assert.equal(result.outcome_records[0].outcome, 'pending');

console.log('site-loop outcome reconciliation ok');
