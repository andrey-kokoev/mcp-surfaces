import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runArtifacts, withArtifactReadback } from '../src/run-store.js';

const root = mkdtempSync(join(tmpdir(), 'worker-run-store-'));
const runDir = join(root, 'run-20260626T160000Z-test');
mkdirSync(runDir, { recursive: true });

const runRecord = {
  runId: 'run-20260626T160000Z-test',
  runDir,
  requestPath: join(runDir, 'request.json'),
  executorRequestPath: join(runDir, 'executor_request.json'),
  resolvedConfigPath: join(runDir, 'resolved_worker_config.json'),
  promptPath: join(runDir, 'worker_prompt.txt'),
  invocationPath: join(runDir, 'worker_invocation.json'),
  eventsPath: join(runDir, 'events.jsonl'),
  diagnosticPath: join(runDir, 'diagnostic.log'),
  lastMessagePath: join(runDir, 'last_message.json'),
  resultPath: join(runDir, 'result.json'),
  schemaPath: join(runDir, 'worker_output.schema.json'),
};

const artifacts = runArtifacts(runRecord);
assert.deepEqual(artifacts.map((artifact) => artifact.name), [
  'request.json',
  'executor_request.json',
  'resolved_worker_config.json',
  'worker_prompt.txt',
  'worker_invocation.json',
  'events.jsonl',
  'diagnostic.log',
  'last_message.json',
  'result.json',
  'worker_output.schema.json',
]);

writeFileSync(runRecord.diagnosticPath, 'diagnostic tail');
writeFileSync(runRecord.eventsPath, 'event tail');
writeFileSync(runRecord.invocationPath, JSON.stringify({ command: 'codex', argv: ['exec'] }));
writeFileSync(runRecord.resolvedConfigPath, JSON.stringify({ runtime: 'codex', authority: 'write' }));

const withReadback = withArtifactReadback({ status: 'running' }, { runRoot: root, runDir, primary: false });
assert.equal(withReadback.status, 'running');
assert.deepEqual(withReadback.artifact_readback, {
  readable_via_worker_delegation: true,
  local_filesystem_access_required: false,
  run_root: root,
  run_root_source: 'rediscovered_run_root',
  rediscovered: true,
  resources_available: false,
  diagnostic_tail: 'diagnostic tail',
  events_tail: 'event tail',
  worker_invocation_preview: { command: 'codex', argv: ['exec'] },
  resolved_worker_config_preview: { runtime: 'codex', authority: 'write' },
});
