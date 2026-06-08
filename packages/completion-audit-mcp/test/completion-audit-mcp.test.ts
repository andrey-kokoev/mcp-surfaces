import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completionAuditRecord, createServerState, handleRequest, listTools } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'completion-audit-mcp-'));
const state = createServerState({ auditRoot: root });

const tools = listTools();
assert.deepEqual(tools.map((tool) => tool.name), ['completion_audit_record']);

const record = completionAuditRecord({
  audit_id: 'audit-test',
  objective: 'finish requested ergonomics fixes',
  scope_label: 'ergonomics',
  items: [
    {
      requirement: 'filesystem write existing parent is allowed',
      evidence: 'pnpm test:local-filesystem',
      verdict: 'proved',
    },
    {
      requirement: 'completion audit surface exists',
      evidence: 'completion-audit-mcp unit test',
      verdict: 'proved',
      residual_risk: 'none',
    },
  ],
  summary: 'all proved',
}, state);

assert.equal(record.audit_id, 'audit-test');
assert.equal(record.item_count, 2);
assert.equal(record.completion_proved, true);
assert.equal(record.verdict_counts.proved, 2);
assert.equal(existsSync(record.audit_path), true);
assert.equal(JSON.parse(readFileSync(record.audit_path, 'utf8').trim()).audit_id, 'audit-test');

const rpcRecord = handleRequest({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'completion_audit_record',
    arguments: {
      objective: 'rpc audit',
      items: [
        { requirement: 'has evidence', evidence: 'test', verdict: 'incomplete' },
      ],
    },
  },
}, state) as any;
assert.equal(rpcRecord?.result.structuredContent.completion_proved, false);
assert.match(rpcRecord?.result.content[0].text, /completion_proved: false/);

const badVerdict = handleRequest({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'completion_audit_record',
    arguments: {
      objective: 'bad audit',
      items: [
        { requirement: 'bad verdict', evidence: 'test', verdict: 'maybe' },
      ],
    },
  },
}, state) as any;
assert.equal(badVerdict?.error.data.code, 'completion_audit_item_verdict_unsupported');

console.log('completion audit MCP tests passed');
