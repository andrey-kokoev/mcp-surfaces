import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBoundedToolResult,
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

const exactly20000 = 'x'.repeat(20_000);
const over20000 = 'x'.repeat(20_001);

assert.doesNotThrow(() => enforceInlinePayloadLimit({
  toolName: 'representative_tool',
  args: { summary: exactly20000 },
}));

assert.throws(
  () => enforceInlinePayloadLimit({
    toolName: 'representative_tool',
    args: { summary: over20000 },
  }),
  /inline_payload_too_long: field=summary length=20001 threshold=20000 remediation=call mcp_payload_create then retry_with_payload_ref.*mcp_payload_create_args=.*"summary":"<move original summary here>".*retry_args=.*"payload_ref":"mcp_payload:<id>@v1"/
);

assert.throws(
  () => enforceInlinePayloadLimit({
    toolName: 'task_lifecycle_review',
    args: { findings: [{ severity: 'note', description: over20000 }] },
  }),
  /mcp_payload_create_args=.*"findings":\[\{"description":"<move original findings\.0\.description here>"\}\]/
);

assert.doesNotThrow(() => enforceInlinePayloadLimit({
  toolName: 'mcp_payload_create',
  args: { payload: { summary: over20000 } },
  allowPayloadCreation: true,
}));

assert.equal(listOutputTools()[0].name, 'mcp_output_show');

const tempRoot = mkdtempSync(join(tmpdir(), 'narada-mcp-transport-'));
try {
  const longValue = { status: 'ok', output: 'x'.repeat(5_000) };
  const longResult = buildOutputRefToolContent({
    siteRoot: tempRoot,
    toolName: 'representative_tool',
    value: longValue,
    createdBy: 'narada-test.agent',
  });
  const envelope = JSON.parse(longResult.content[0].text);
  const structuredEnvelope = (longResult as { structuredContent: Record<string, unknown> }).structuredContent;
  assert.equal(envelope.truncated, true);
  assert.match(String(envelope.output_ref), /^mcp_output:/);
  assert.equal(envelope.reader_tool, 'mcp_output_show');
  assert.equal(typeof envelope.output_text, 'string');
  assert.equal(envelope.output_text.length > 0, true);
  assert.match(String(structuredEnvelope.output_ref), /^mcp_output:/);
  assert.equal(structuredEnvelope.schema, 'narada.producer_output_page.v1');
  assert.equal(structuredEnvelope.offset, 0);
  assert.equal(typeof structuredEnvelope.next_offset, 'number');
  assert.equal(structuredEnvelope.transport_next_offset, structuredEnvelope.next_offset);
  assert.equal((structuredEnvelope.next_offset as number) <= 2_000, true);
  assert.equal((structuredEnvelope.output_text as string).length, structuredEnvelope.next_offset);
  assert.equal(typeof structuredEnvelope.site_root, 'string');
  assert.equal(structuredEnvelope.reader_tool, 'mcp_output_show');
  assert.match(String(structuredEnvelope.read_command), /mcp_output_show/);
  assert.equal(longResult.content.length, 1);
  assert.equal(longResult.content[0].type, 'text');

  const boundedSmall = buildBoundedToolResult({
    siteRoot: tempRoot,
    toolName: 'bounded_small_tool',
    value: { status: 'ok', compact: true },
  });
  assert.deepEqual((boundedSmall as { structuredContent: Record<string, unknown> }).structuredContent, { status: 'ok', compact: true });

  const boundedLarge = buildBoundedToolResult({
    siteRoot: tempRoot,
    toolName: 'bounded_large_tool',
    value: { status: 'ok', output: 'y'.repeat(5_000) },
    readerTool: 'surface_output_show',
  });
  const boundedLargeEnvelope = JSON.parse(boundedLarge.content[0].text);
  const boundedLargeStructured = (boundedLarge as { structuredContent: Record<string, unknown> }).structuredContent;
  assert.equal(boundedLargeEnvelope.schema, 'narada.producer_output_page.v1');
  assert.equal(boundedLargeStructured.schema, 'narada.producer_output_page.v1');
  assert.equal(boundedLargeStructured.reader_tool, 'surface_output_show');
  assert.equal(JSON.stringify(boundedLargeStructured).includes('y'.repeat(5_000)), false);
  assert.equal((boundedLarge.content[0].text as string).length <= 2_000, true);
  assert.match(String(boundedLargeStructured.output_ref), /^mcp_output:/);
  assert.equal(typeof boundedLargeStructured.output_text, 'string');
  assert.equal((boundedLargeStructured.output_text as string).length <= 2_000, true);

  const shownLongResult = outputShow({ siteRoot: tempRoot, args: { ref: structuredEnvelope.output_ref, limit: 10 } });
  assert.equal(shownLongResult.schema, 'narada.mcp_output_page.v1');
  assert.equal(shownLongResult.output_text.length, 10);
  assert.equal(shownLongResult.next_offset, 10);

  const bulkyResult = buildOutputRefToolContent({
    siteRoot: tempRoot,
    toolName: 'bulky_tool',
    value: { status: 'ok', payload: 'x'.repeat(5_000), ref: `mcp_payload:${'p'.repeat(30)}@v1` },
  });
  const bulkyEnvelope = JSON.parse(bulkyResult.content[0].text);
  const bulkyStructuredEnvelope = (bulkyResult as { structuredContent: Record<string, unknown> }).structuredContent;
  assert.match(String(bulkyStructuredEnvelope.output_ref), /^mcp_output:/);
  assert.match(String(bulkyStructuredEnvelope.payload_ref), /^mcp_payload:/);
  assert.equal(bulkyEnvelope.truncated, true);

  const resources = listOutputResources({ siteRoot: tempRoot }).resources;
  assert.equal(resources.length >= 2, true);

  const wrappedFirstPage = buildOutputRefToolContent({
    siteRoot: tempRoot,
    toolName: 'representative_paged_tool',
    value: structuredEnvelope,
  });
  const wrappedFirstPageStructuredContent = (wrappedFirstPage as { structuredContent: Record<string, unknown> }).structuredContent;
  assert.equal(wrappedFirstPageStructuredContent.next_offset, 2000);
  assert.equal(wrappedFirstPageStructuredContent.output_truncated, true);

  assert.throws(
    () => readOutputResource({ siteRoot: tempRoot, uri: 'mcp-output:mcp_output%3Amissing' }),
    /output_ref_not_found/
  );

  assert.throws(
    () => payloadCreate({ siteRoot: tempRoot, args: { payload: {} } }),
    /payload_create_empty_payload_requires_allow_empty.*Use either.*payload_json.*payload:\{\}/
  );
  const emptyPayload = payloadCreate({ siteRoot: tempRoot, args: { payload: {}, allow_empty: true, payload_id: 'empty_payload_ok' } });
  assert.equal(emptyPayload.status, 'created');

  const createdPayload = payloadCreate({ siteRoot: tempRoot, args: { payload: { summary: 'x'.repeat(5_000) } } });
  const createdPayloadResult = buildOutputRefToolContent({
    siteRoot: tempRoot,
    toolName: 'mcp_payload_create',
    value: createdPayload,
  });
  const createdPayloadEnvelope = JSON.parse(createdPayloadResult.content[0].text);
  assert.match(String(createdPayloadEnvelope.ref), /^mcp_payload:/);

  const jsonPayload = payloadCreate({ siteRoot: tempRoot, args: { payload_json: '{"x":"y"}', payload_id: 'json_payload_ok' } });
  assert.equal(jsonPayload.status, 'created');
  const jsonPayloadShown = payloadShow({ siteRoot: tempRoot, args: { ref: jsonPayload.ref } });
  assert.deepEqual(jsonPayloadShown.payload, { x: 'y' });

  const jsonPayloadWithEmptyObjectPlaceholder = payloadCreate({ siteRoot: tempRoot, args: { payload: {}, payload_json: '{"x":"z"}', payload_id: 'json_payload_with_placeholder_ok' } });
  assert.equal(jsonPayloadWithEmptyObjectPlaceholder.status, 'created');
  const jsonPlaceholderShown = payloadShow({ siteRoot: tempRoot, args: { ref: jsonPayloadWithEmptyObjectPlaceholder.ref } });
  assert.deepEqual(jsonPlaceholderShown.payload, { x: 'z' });

  assert.throws(
    () => payloadCreate({ siteRoot: tempRoot, args: { payload: { x: 'object' }, payload_json: '{"x":"json"}' } }),
    /payload_create_must_choose_one_of_payload_or_payload_json/
  );

  assert.throws(
    () => payloadCreate({ siteRoot: tempRoot, args: { payload_json: '[]' } }),
    /payload_create_payload_json_must_be_object/
  );

  const mergePayload = payloadCreate({ siteRoot: tempRoot, args: { payload: { task_number: 1, agent_id: 'payload.agent', summary: 'from payload' } } });
  const merged = resolveToolPayloadArgs({
    siteRoot: tempRoot,
    toolName: 'representative_tool',
    args: { payload_ref: mergePayload.ref, task_number: 2, agent_id: 'top.agent' },
    allowedTools: ['representative_tool'],
    payloadRefMode: 'merge_args',
  });
  assert.deepEqual(merged.args, { task_number: 2, agent_id: 'top.agent', summary: 'from payload' });

  const placeholderMergePayload = payloadCreate({ siteRoot: tempRoot, args: { payload: { task_number: 1, agent_id: 'payload.agent', execution_notes: 'real notes', verification: 'real verification' } } });
  const placeholderMerged = resolveToolPayloadArgs({
    siteRoot: tempRoot,
    toolName: 'representative_tool',
    args: { payload_ref: placeholderMergePayload.ref, task_number: 2, agent_id: 'top.agent', execution_notes: '<!-- placeholder notes -->', verification: '<move original verification here>' },
    allowedTools: ['representative_tool'],
    payloadRefMode: 'merge_args_prefer_payload_placeholders',
  });
  assert.deepEqual(placeholderMerged.args, { task_number: 2, agent_id: 'top.agent', execution_notes: 'real notes', verification: 'real verification' });

  const outputId = 'o_alias_test';
  const outputRef = `mcp_output:${outputId}`;
  const fullOutput = { status: 'ok', nested: { value: 42 } };
  const fullText = JSON.stringify(fullOutput, null, 2);
  const outputRecord = {
    schema: 'narada.mcp_output_ref.v1',
    ref: outputRef,
    output_id: outputId,
    tool_name: 'alias_fixture',
    created_at: new Date().toISOString(),
    created_by: 'test',
    content_type: 'application/json',
    inline_char_limit: 1,
    full_output_char_length: fullText.length,
    truncated: true,
    sha256: createHash('sha256').update(fullText).digest('hex'),
    max_bytes: 10_000,
    full_output: fullOutput,
  };
  mkdirSync(join(tempRoot, '.ai/tmp/mcp-outputs/workspace'), { recursive: true });
  writeFileSync(join(tempRoot, '.ai/tmp/mcp-outputs/workspace', `${outputId}.json`), `${JSON.stringify(outputRecord)}\n`, 'utf8');
  assert.equal(outputShow({ siteRoot: tempRoot, args: { ref: outputRef } }).ref, outputRef);
  assert.equal(outputShow({ siteRoot: tempRoot, args: { output_ref: outputRef } }).ref, outputRef);
  assert.throws(
    () => outputShow({ siteRoot: tempRoot, args: { ref: outputRef, output_ref: 'mcp_output:o_other_alias' } }),
    /output_show_ref_alias_conflict/
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('mcp transport contract tests passed');
