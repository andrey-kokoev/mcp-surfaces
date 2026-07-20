import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGuidanceResult } from '../src/guidance.js';
import { renderToolResultText } from '../src/result-rendering.js';

test('doctor text exposes effective policy posture', () => {
  const text = renderToolResultText({
    schema: 'local.filesystem.doctor.v1',
    status: 'ok',
    mode: 'write',
    output_root: 'D:\\output',
    allowed_roots: ['D:\\repo'],
    effective_permissions: { can_read: true, can_write: true },
  });

  assert.match(text, /fs_doctor: ok/);
  assert.match(text, /mode: write/);
  assert.match(text, /can_write: true/);
  assert.match(text, /D:\\repo/);
});

test('guidance text contains purpose and actionable first-use guidance', () => {
  const text = renderToolResultText(buildGuidanceResult());

  assert.match(text, /fs_guidance: ok/);
  assert.match(text, /purpose: Governed filesystem inspection and mutation/);
  assert.match(text, /first_use:/);
  assert.match(text, /Inspect policy\/doctor\/status tools before mutation/);
});
