import assert from 'node:assert/strict';
import { buildWorkerPrompt } from '../src/prompt.js';

const basePrompt = buildWorkerPrompt({
  intent: { instruction: 'Inspect the target module.', mode: 'audit_only' },
  cwd: 'D:/code/example',
  mode: 'audit_only',
  runtime: 'codex',
  preflight: [
    { name: 'cwd_readable', status: 'ok', message: 'cwd exists' },
    { name: 'authority', status: 'ok', message: 'authority=read' },
  ],
  outputContract: { schema: 'test.contract' },
  exitInterview: false,
});

assert.match(basePrompt, /Inspect the target module\./);
assert.match(basePrompt, /Audit only: inspect and report/);
assert.match(basePrompt, /Do not call any worker_\* MCP tools\./);
assert.match(basePrompt, /Structured output contract\n\{"schema":"test\.contract"\}/);
assert.doesNotMatch(basePrompt, /Exit interview/);

const narsPrompt = buildWorkerPrompt({
  intent: { instruction: 'Make the requested edit.', mode: 'implement' },
  cwd: 'D:/code/example',
  mode: 'implement',
  runtime: 'narada-agent-runtime-server',
  preflight: [{ name: 'requested_mode', status: 'ok', message: 'requested_mode=implement' }],
  outputContract: { schema: 'test.contract' },
  exitInterview: true,
  requiredMcpTools: ['local-filesystem.fs_read_file'],
});

assert.match(narsPrompt, /NARS worker completion guard/);
assert.match(narsPrompt, /Complete this turn by returning the required JSON object/);
assert.match(narsPrompt, /Only the following exact MCP tool names are projected into this worker run/);
assert.match(narsPrompt, /- local-filesystem\.fs_read_file/);
assert.match(narsPrompt, /Exit interview/);
assert.match(narsPrompt, /observed_incoherencies/);
assert.match(basePrompt, /No MCP tools are projected into this worker run/);
