import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOutputRefToolContent,
  enforceInlinePayloadLimit,
  listOutputResources,
  listOutputTools,
  outputShow,
  payloadCreate,
  payloadShow,
  readOutputResource,
  resolveToolPayloadArgs,
} from '../src/mcp-payload-file.js';

const exactly200 = 'x'.repeat(200);
const over200 = 'x'.repeat(201);

assert.doesNotThrow(() => enforceInlinePayloadLimit({
  toolName: 'representative_tool',
  args: { summary: exactly200 },
}));

assert.throws(
  () => enforceInlinePayloadLimit({
    toolName: 'representative_tool',
    args: { summary: over200 },
  }),
  /inline_payload_too_long: field=summary length=201 threshold=200 remediation=call mcp_payload_create then retry_with_payload_ref.*mcp_payload_create_args=.*"summary":"<move original summary here>".*retry_args=.*"payload_ref":"mcp_payload:<id>@v1"/
);

assert.doesNotThrow(() => enforceInlinePayloadLimit({
  toolName: 'mcp_payload_create',
  args: { payload: { summary: over200 } },
  allowPayloadCreation: true,
}));

assert.deepEqual(listOutputTools(), []);

const tempRoot = mkdtempSync(join(tmpdir(), 'narada-mcp-transport-'));
try {
  const longValue = { status: 'ok', output: 'x'.repeat(500) };
  const longResult = buildOutputRefToolContent({
    siteRoot: tempRoot,
    toolName: 'representative_tool',
    value: longValue,
    createdBy: 'narada-test.agent',
  });
  const envelope = JSON.parse(longResult.content[0].text);
  const structuredEnvelope = (longResult as { structuredContent: Record<string, unknown> }).structuredContent;
  assert.equal(envelope.truncated, true);
  assert.equal(envelope.output_ref, undefined);
  assert.equal(structuredEnvelope.schema, 'narada.producer_output_page.v1');
  assert.equal(structuredEnvelope.offset, 0);
  assert.equal(structuredEnvelope.next_offset, 200);
  assert.equal(typeof structuredEnvelope.site_root, 'string');
  assert.equal(envelope.reader_tool, null);
  assert.equal(longResult.content.length, 1);
  assert.equal(longResult.content[0].type, 'text');

  const bulkyResult = buildOutputRefToolContent({
    siteRoot: tempRoot,
    toolName: 'bulky_tool',
    value: { status: 'ok', payload: 'x'.repeat(1200), ref: `mcp_payload:${'p'.repeat(30)}@v1` },
  });
  const bulkyEnvelope = JSON.parse(bulkyResult.content[0].text);
  const bulkyStructuredEnvelope = (bulkyResult as { structuredContent: Record<string, unknown> }).structuredContent;
  assert.equal(bulkyEnvelope.output_ref, undefined);
  assert.match(String(bulkyStructuredEnvelope.payload_ref), /^mcp_payload:/);
  assert.equal(bulkyEnvelope.truncated, true);

  const resources = listOutputResources({ siteRoot: tempRoot }).resources;
  assert.equal(resources.length, 0);

  const wrappedFirstPage = buildOutputRefToolContent({
    siteRoot: tempRoot,
    toolName: 'representative_paged_tool',
    value: structuredEnvelope,
  });
  const wrappedFirstPageStructuredContent = (wrappedFirstPage as { structuredContent: Record<string, unknown> }).structuredContent;
  assert.equal(wrappedFirstPageStructuredContent.next_offset, 200);
  assert.equal(wrappedFirstPageStructuredContent.output_truncated, true);

  assert.throws(
    () => readOutputResource({ siteRoot: tempRoot, uri: 'mcp-output:mcp_output%3Amissing' }),
    /output_ref_not_found/
  );

  const createdPayload = payloadCreate({ siteRoot: tempRoot, args: { payload: { summary: 'x'.repeat(500) } } });
  const createdPayloadResult = buildOutputRefToolContent({
    siteRoot: tempRoot,
    toolName: 'mcp_payload_create',
    value: createdPayload,
  });
  const createdPayloadEnvelope = (createdPayloadResult as { structuredContent: Record<string, unknown> }).structuredContent;
  assert.match(String(createdPayloadEnvelope.payload_ref), /^mcp_payload:/);

  const mergePayload = payloadCreate({ siteRoot: tempRoot, args: { payload: { task_number: 1, agent_id: 'payload.agent', summary: 'from payload' } } });
  const merged = resolveToolPayloadArgs({
    siteRoot: tempRoot,
    toolName: 'representative_tool',
    args: { payload_ref: mergePayload.ref, task_number: 2, agent_id: 'top.agent' },
    allowedTools: ['representative_tool'],
    payloadRefMode: 'merge_args',
  });
  assert.deepEqual(merged.args, { task_number: 2, agent_id: 'top.agent', summary: 'from payload' });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('mcp transport contract tests passed');
