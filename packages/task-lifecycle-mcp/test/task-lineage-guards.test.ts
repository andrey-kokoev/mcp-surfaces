import assert from 'node:assert/strict';
import { inspectSupersededTaskGuard } from '../src/task-lifecycle/task-lineage-guards.js';

const lifecycle = { task_id: 'task-1', task_number: 2186, status: 'claimed' };

const supersededStore = {
  getTaskSpec: () => ({ tags_json: JSON.stringify(['superseded/replacement-narada-2219', 'canonical-cutover']) }),
};
const blocked = inspectSupersededTaskGuard({ store: supersededStore, lifecycle });
assert.equal(blocked.status, 'blocked');
assert.equal(blocked.error, 'superseded_task_requires_lineage_override');
assert.deepEqual(blocked.lineage_tags, ['superseded/replacement-narada-2219']);

const overridden = inspectSupersededTaskGuard({
  store: supersededStore,
  lifecycle,
  authorityBasis: { kind: 'operator_direct_instruction', summary: 'Operator explicitly authorized lineage repair.' },
});
assert.equal(overridden.status, 'overridden');
assert.equal(overridden.authority_basis?.kind, 'operator_direct_instruction');

const ordinary = inspectSupersededTaskGuard({
  store: { getTaskSpec: () => ({ tags_json: JSON.stringify(['mcp-surfaces']) }) },
  lifecycle,
});
assert.equal(ordinary.status, 'not_applicable');
