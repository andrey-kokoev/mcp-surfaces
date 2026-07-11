import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputContractForMode, outputContractForRequest, parseLastMessage, parseWorkerOutputJson, workerOutputFromAgentMessage } from '../src/output-contract.js';

const root = mkdtempSync(join(tmpdir(), 'worker-output-contract-'));

const invalidMessagePath = join(root, 'invalid-last-message.json');
writeFileSync(invalidMessagePath, JSON.stringify({ summary: 'bad', deliverables: [{ path: 'x' }], open_questions: [], next_actions: [], edits_performed: false, target_state_changed: false, changes: [], verification: [] }), 'utf8');
const invalidMessage = parseLastMessage(invalidMessagePath);
assert.equal(invalidMessage.ok, false);
assert.equal(invalidMessage.ok ? '' : invalidMessage.reason, 'invalid_shape');

const nullableVerificationMessagePath = join(root, 'nullable-verification-last-message.json');
writeFileSync(nullableVerificationMessagePath, JSON.stringify({ summary: 'ok', deliverables: [], open_questions: [], next_actions: [], edits_performed: false, target_state_changed: false, changes: [], verification: [{ tool: null, command: null, status: 'passed', summary: 'nullable accepted' }] }), 'utf8');
const nullableVerificationMessage = parseLastMessage(nullableVerificationMessagePath);
assert.equal(nullableVerificationMessage.ok, true);
if (nullableVerificationMessage.ok) assert.deepEqual(nullableVerificationMessage.data.verification[0], { tool: null, command: null, status: 'passed', summary: 'nullable accepted', command_classification: 'not_applicable' });
if (nullableVerificationMessage.ok) assert.equal(nullableVerificationMessage.data.exit_interview, null);

const missingVerificationCommandPath = join(root, 'missing-verification-command-last-message.json');
writeFileSync(missingVerificationCommandPath, JSON.stringify({ summary: 'bad', deliverables: [], open_questions: [], next_actions: [], edits_performed: false, target_state_changed: false, changes: [], verification: [{ tool: 'test', status: 'passed', summary: 'missing command rejected' }] }), 'utf8');
const missingVerificationCommand = parseLastMessage(missingVerificationCommandPath);
assert.equal(missingVerificationCommand.ok, false);
assert.match(missingVerificationCommand.ok ? '' : missingVerificationCommand.message, /nullable string tool and command/);

const fencedWorkerOutput = parseWorkerOutputJson(`\`\`\`json
${JSON.stringify({
  summary: 'fenced output accepted',
  deliverables: [],
  open_questions: [],
  next_actions: [],
  edits_performed: false,
  target_state_changed: false,
  changes: [],
  verification: [{ tool: null, command: null, status: 'passed', summary: 'fenced JSON parsed' }],
  verification_budget_respected: true,
  broad_unrelated_failures: [],
  exit_interview: null,
})}
\`\`\``);
assert.equal(fencedWorkerOutput?.summary, 'fenced output accepted');
assert.equal(fencedWorkerOutput?.verification[0].summary, 'fenced JSON parsed');

const looseWorkerOutput = parseWorkerOutputJson(JSON.stringify({
  summary: 'loose output accepted',
  verification: { tool: 'fake-agent-runtime-server', status: 'passed', summary: 'loose verification object accepted' },
}));
assert.equal(looseWorkerOutput?.verification[0].command, null);
assert.equal(looseWorkerOutput?.verification[0].summary, 'loose verification object accepted');
assert.equal(looseWorkerOutput?.verification[0].command_classification, 'not_applicable');

const structuredVerificationWorkerOutput = parseWorkerOutputJson(JSON.stringify({
  summary: 'structured verification output accepted',
  verification: {
    checks: [{ name: 'fs_stat existence proof', status: 'passed', command_classification: 'focused' }],
    summary: 'One bounded read-only fs_stat call.',
  },
  verification_budget_respected: true,
}));
assert.equal(structuredVerificationWorkerOutput?.verification_budget_respected, true);
assert.deepEqual(structuredVerificationWorkerOutput?.verification, [{
  tool: null,
  command: null,
  status: 'passed',
  summary: 'fs_stat existence proof',
  command_classification: 'focused',
}]);

const plainWorkerOutput = workerOutputFromAgentMessage('plain assistant fallback');
assert.equal(plainWorkerOutput.summary, 'plain assistant fallback');
assert.equal(plainWorkerOutput.edits_performed, false);
assert.equal(plainWorkerOutput.verification[0].command_classification, 'not_applicable');

const auditContract = outputContractForMode('audit_only');
assert.equal(auditContract.schema, 'narada.worker.output_contract.v1');
assert.equal(auditContract.requested_mode, 'audit_only');
assert.deepEqual(auditContract.verification_command_classification, {
  required: true,
  allowed_values: ['focused', 'broad', 'not_applicable'],
  meaning: 'focused commands directly validate the touched package/task; broad commands scan larger or unrelated surfaces and must be justified.',
});
assert.equal(typeof auditContract.focused_readback, 'object');

const requestContract = outputContractForRequest({
  intent: { instruction: 'inspect', mode: 'audit_only' },
  constraints: {
    cwd: root,
    authority: 'read',
    preflight_paths: [{ path: join(root, 'target.txt'), access: 'read' }],
    verification_budget: { max_commands: 1, focus: 'focused' },
    test_budget: { max_commands: 0 },
  },
}, 'audit_only');
assert.equal(requestContract.effective_authority, 'read');
assert.equal(requestContract.tool_capability_note, 'If a raw MCP surface advertises write-capable roots or mutation tools, treat them as unavailable for this delegation unless the requested authority is escalated by the caller.');
assert.deepEqual(requestContract.verification_budget, { max_commands: 1, focus: 'focused' });
assert.deepEqual(requestContract.test_budget, { max_commands: 0 });
assert.equal(Array.isArray(requestContract.target_paths), true);
