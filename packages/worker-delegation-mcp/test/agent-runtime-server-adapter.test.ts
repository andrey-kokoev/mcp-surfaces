import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentRuntimeServerInvocation, type Invocation } from '../src/agent-runtime-server-adapter.js';

const root = mkdtempSync(join(tmpdir(), 'worker-agent-runtime-adapter-'));
const sessionId = 'resume-session-current-turn';
const sessionDir = join(root, '.narada', 'crew', 'nars-sessions', sessionId);
mkdirSync(sessionDir, { recursive: true });
const durableEventsPath = join(sessionDir, 'events.jsonl');
const oldEvents = [
  { event: 'assistant_message', session_id: sessionId, event_sequence: 1, content: 'historical assistant result' },
  { event: 'carrier_turn_completed', session_id: sessionId, event_sequence: 2 },
];
writeFileSync(durableEventsPath, `${oldEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

const runtimeScript = join(root, 'fake-nars.cjs');
writeFileSync(runtimeScript, [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const sessionId = process.argv[process.argv.indexOf('--session') + 1];",
  "const eventsPath = path.join(process.env.NARADA_SITE_ROOT, '.narada', 'crew', 'nars-sessions', sessionId, 'events.jsonl');",
  "let buffer = '';",
  "let submitted = false;",
  "function append(event) { fs.appendFileSync(eventsPath, JSON.stringify(event) + '\\n', 'utf8'); }",
  "function handle(line) {",
  "  if (!line.trim()) return;",
  "  const request = JSON.parse(line);",
  "  if (request.method === 'session.submit') {",
  "    submitted = true;",
  "    append({ event: 'assistant_message', session_id: sessionId, event_sequence: 3, content: 'current assistant result' });",
  "    append({ event: 'carrier_turn_completed', session_id: sessionId, event_sequence: 4 });",
  "  } else if (request.method === 'session.close') {",
  "    process.exit(submitted ? 0 : 17);",
  "  }",
  "}",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let index; while ((index = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); handle(line); } });",
  "process.stdin.on('end', () => { if (!submitted) process.exit(18); });",
].join('\n'), 'utf8');

const workerEventsPath = join(root, 'worker-events.jsonl');
const diagnosticPath = join(root, 'diagnostic.log');
const lastMessagePath = join(root, 'last_message.json');
const invocation: Invocation = {
  command: process.execPath,
  argv: [runtimeScript, '--raw-jsonl', '--authority', 'read', '--session', sessionId],
  cwd: root,
  environment: {
    ...process.env,
    NARADA_SITE_ROOT: root,
  } as Record<string, string>,
};

try {
  const result = await runAgentRuntimeServerInvocation({
    invocation,
    prompt: 'continue the current turn',
    eventsPath: workerEventsPath,
    diagnosticPath,
    lastMessagePath,
    maxRunMs: 10_000,
  });

  assert.equal(result.exit_code, 0, JSON.stringify(result));
  assert.equal(result.error, null, JSON.stringify(result));
  assert.equal(result.worker_session_id, sessionId, JSON.stringify(result));
  const output = JSON.parse(readFileSync(lastMessagePath, 'utf8')) as Record<string, unknown>;
  assert.equal(output.summary, 'current assistant result');
  assert.doesNotMatch(String(output.summary), /historical/);
  const observedEvents = readFileSync(workerEventsPath, 'utf8');
  assert.doesNotMatch(observedEvents, /historical assistant result/);
  assert.match(observedEvents, /current assistant result/);
  assert.match(readFileSync(diagnosticPath, 'utf8'), /baseline_bytes=/);
  console.log('agent runtime server adapter tests passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
