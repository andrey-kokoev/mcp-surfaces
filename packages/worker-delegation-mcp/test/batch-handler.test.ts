import assert from 'node:assert/strict';
import { normalizeBatchRequests, normalizeOptionalRunIds, normalizeRunIds } from '../src/tool-handlers/batch.js';

assert.deepEqual(normalizeBatchRequests([{ cwd: 'D:/code/example' }, null, 'ignored-shape']), [
  { cwd: 'D:/code/example' },
  {},
  {},
]);

assert.throws(() => normalizeBatchRequests([]), /worker_run_batch_requests_required/);
assert.throws(() => normalizeBatchRequests(Array.from({ length: 51 }, () => ({}))), /worker_run_batch_too_large/);

assert.deepEqual(normalizeRunIds(['run-a', 'run-a', ' run-b ']), ['run-a', 'run-b']);
assert.throws(() => normalizeRunIds([]), /worker_run_ids_required/);
assert.throws(() => normalizeRunIds(['']), /worker_run_id_required/);

assert.deepEqual(normalizeOptionalRunIds(undefined), []);
assert.deepEqual(normalizeOptionalRunIds(null), []);
assert.deepEqual(normalizeOptionalRunIds(['run-c']), ['run-c']);
