import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntimeEventTracker, extractSessionEventEvidence } from '../src/runtime-events.js';

const root = mkdtempSync(join(tmpdir(), 'worker-runtime-events-'));

const runtimeEventTracker = new AgentRuntimeEventTracker();
runtimeEventTracker.handleEvent({ event: 'assistant_message', session_id: 'session-runtime-events', content: [{ text: 'assistant text from parts' }] });
runtimeEventTracker.handleEvent({ event: 'turn_complete' });
assert.equal(runtimeEventTracker.workerSessionId, 'session-runtime-events');
assert.equal(runtimeEventTracker.finalAssistantMessage, 'assistant text from parts');
assert.equal(runtimeEventTracker.turnCompleted, true);
assert.deepEqual(runtimeEventTracker.evidence().terminal_events, ['turn_complete']);

const nestedMessageTracker = new AgentRuntimeEventTracker();
nestedMessageTracker.handleEvent({ event: 'assistant_message', message: { content: 'assistant text from nested message' } });
assert.equal(nestedMessageTracker.finalAssistantMessage, 'assistant text from nested message');

const runtimeEventsPath = join(root, 'runtime-events.jsonl');
writeFileSync(runtimeEventsPath, [
  JSON.stringify({ method: 'conversation.send', request_id: 'req-1' }),
  JSON.stringify({ event: 'assistant_message', request_id: 'req-1', turn_id: 'turn-1', content: 'ok' }),
  JSON.stringify({ event: 'turn_complete', request_id: 'req-1', turn_id: 'turn-1', nested: { delegated_mutation_admitted: true }, carrier_mutation_admitted: false }),
].join('\n'));
const runtimeEventEvidence = extractSessionEventEvidence(runtimeEventsPath);
assert.equal(runtimeEventEvidence.prompt_admission, 'conversation_send_frame_seen');
assert.equal(runtimeEventEvidence.assistant_message_seen, true);
assert.deepEqual(runtimeEventEvidence.terminal_events, ['turn_complete']);
assert.deepEqual(runtimeEventEvidence.mutation_admission, { carrier_mutation_admitted: false, delegated_mutation_admitted: true });
