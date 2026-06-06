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
  /inline_payload_too_long: field=summary length=201 threshold=200 remediation=call mcp_payload_create/
);

assert.doesNotThrow(() => enforceInlinePayloadLimit({
  toolName: 'mcp_payload_create',
  args: { payload: { summary: over200 } },
  allowPayloadCreation: true,
}));

const outputShowTool = listOutputTools().find((tool) => tool.name === 'mcp_output_show');
assert.ok(outputShowTool);
const outputShowSchema = outputShowTool.inputSchema as Record<string, unknown>;
assert.deepEqual(outputShowSchema.required, []);
const outputShowProperties = outputShowSchema.properties as Record<string, unknown>;
assert.equal(Boolean(outputShowProperties.output_ref), true);
assert.equal(Boolean(outputShowProperties.limit), true);
assert.equal(Boolean(outputShowProperties.offset), true);
assert.equal(outputShowSchema.anyOf, undefined);
assert.equal(outputShowSchema.oneOf, undefined);
assert.equal(outputShowSchema.allOf, undefined);
assert.equal(outputShowSchema.not, undefined);
assert.equal(outputShowSchema.enum, undefined);

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
  assert.equal(envelope.truncated, true);
  assert.match(envelope.ref, /^mcp_output:/);
  assert.match(envelope.output_ref, /^mcp_output:/);
  assert.equal(envelope.ref, envelope.output_ref);
  assert.equal(envelope.reader_tool, 'mcp_output_show');
  assert.equal(envelope.inline_limit, 200);
  assert.equal(longResult.content[1].type, 'resource_link');
  assert.equal(longResult.content[1].uri, `mcp-output:${encodeURIComponent(envelope.output_ref)}`);

  const resources = listOutputResources({ siteRoot: tempRoot }).resources;
  assert.equal(resources.length, 1);
  assert.equal(resources[0].uri, longResult.content[1].uri);
  const resource = readOutputResource({ siteRoot: tempRoot, uri: resources[0].uri });
  assert.deepEqual(JSON.parse(resource.contents[0].text), longValue);

  const shown = outputShow({ siteRoot: tempRoot, args: { ref: envelope.ref } });
  assert.deepEqual(JSON.parse(shown.output_text), longValue);

  const shownByAlias = outputShow({ siteRoot: tempRoot, args: { output_ref: envelope.output_ref } });
  assert.deepEqual(JSON.parse(shownByAlias.output_text), longValue);

  const firstPage = outputShow({ siteRoot: tempRoot, args: { output_ref: envelope.output_ref, output_limit: 100 } });
  assert.equal(firstPage.offset, 0);
  assert.equal(firstPage.limit, 100);
  assert.equal(firstPage.output_limit, 100);
  assert.equal(firstPage.output_text.length, 100);
  assert.equal(firstPage.next_offset, 100);
  assert.equal(firstPage.output_truncated, true);

  const secondPage = outputShow({ siteRoot: tempRoot, args: { ref: envelope.ref, offset: firstPage.next_offset, output_limit: 100 } });
  assert.equal(secondPage.offset, 100);
  assert.equal(secondPage.output_text.length, 100);
  assert.equal(secondPage.next_offset, 200);
  assert.equal(secondPage.next_offset > firstPage.next_offset, true);
  assert.equal(secondPage.output_truncated, true);

  const finalPage = outputShow({ siteRoot: tempRoot, args: { output_ref: envelope.output_ref, offset: secondPage.next_offset, limit: 10000 } });
  assert.equal(finalPage.output_truncated, false);
  assert.equal(finalPage.next_offset, null);
  assert.equal(finalPage.output_text.length > 0, true);

  const wrappedFirstPage = buildOutputRefToolContent({
    siteRoot: tempRoot,
    toolName: 'mcp_output_show',
    value: firstPage,
  });
  const wrappedFirstPageStructuredContent = (wrappedFirstPage as { structuredContent: Record<string, unknown> }).structuredContent;
  assert.equal(wrappedFirstPageStructuredContent.next_offset, 100);
  assert.equal(wrappedFirstPageStructuredContent.output_truncated, true);

  const emptyPage = outputShow({ siteRoot: tempRoot, args: { output_ref: envelope.output_ref, limit: 0 } });
  assert.equal(emptyPage.output_text, '');
  assert.equal(emptyPage.output_truncated, false);
  assert.equal(emptyPage.next_offset, null);

  assert.throws(
    () => payloadShow({ siteRoot: tempRoot, args: { ref: envelope.output_ref } }),
    /wrong_ref_family: got=mcp_output expected=mcp_payload reader_tool=mcp_output_show/
  );

  const createdPayload = payloadCreate({ siteRoot: tempRoot, args: { payload: { summary: 'x'.repeat(500) } } });
  const createdPayloadResult = buildOutputRefToolContent({
    siteRoot: tempRoot,
    toolName: 'mcp_payload_create',
    value: createdPayload,
  });
  const createdPayloadEnvelope = JSON.parse(createdPayloadResult.content[0].text);
  assert.match(createdPayloadEnvelope.payload_ref, /^mcp_payload:/);
  assert.ok(createdPayloadResult.content[0].text.length <= 200);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('mcp transport contract tests passed');
