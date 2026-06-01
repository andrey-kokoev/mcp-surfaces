import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOutputRefToolContent,
  enforceInlinePayloadLimit,
  listOutputTools,
  outputShow,
  payloadCreate,
  payloadShow,
} from '../src/mcp-payload-file.mjs';

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
assert.deepEqual(outputShowTool.inputSchema.required, ['ref']);
assert.equal(outputShowTool.inputSchema.anyOf, undefined);
assert.equal(outputShowTool.inputSchema.oneOf, undefined);
assert.equal(outputShowTool.inputSchema.allOf, undefined);
assert.equal(outputShowTool.inputSchema.not, undefined);
assert.equal(outputShowTool.inputSchema.enum, undefined);

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

  const shown = outputShow({ siteRoot: tempRoot, args: { ref: envelope.ref } });
  assert.deepEqual(JSON.parse(shown.output_text), longValue);

  const shownByAlias = outputShow({ siteRoot: tempRoot, args: { output_ref: envelope.output_ref } });
  assert.deepEqual(JSON.parse(shownByAlias.output_text), longValue);

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
