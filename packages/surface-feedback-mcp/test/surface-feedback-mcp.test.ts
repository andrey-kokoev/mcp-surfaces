import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'surface-feedback-mcp-behavior-'));
let state: any;

try {
  state = createServerState({ feedbackRoot: root });

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as Promise<Record<string, any>>;
  }
  function view(res: Record<string, any>): Record<string, any> {
    return res.result.structuredContent as Record<string, any>;
  }

  const sub = await call('surface_feedback_submit', {
    surface_id: 'sop',
    submitter_site_id: 'narada-sonar',
    submitter_principal: 'narada-andrey.Kevin',
    kind: 'improvement',
    summary: 'Add agent step kind',
    details: 'SOP should support agent executor with blocking for agent-performed steps.',
  });
  const subData = view(sub);
  assert.equal(subData.status, 'submitted');
  assert.ok(subData.feedback_id);
  assert.equal(subData.surface_id, 'sop');

  await call('surface_feedback_submit', {
    surface_id: 'scheduler',
    submitter_site_id: 'narada-proper',
    submitter_principal: 'test-agent',
    kind: 'bug',
    summary: 'Task create fails when arguments contain spaces',
    details: 'The space in arguments is not properly quoted when passing to schtasks.exe.',
  });

  const list = await call('surface_feedback_list', { surface_id: 'sop' });
  const listData = view(list);
  assert.equal(listData.count, 1);

  const listAll = await call('surface_feedback_list', {});
  assert.equal(view(listAll).count, 2);

  const listBySite = await call('surface_feedback_list', { submitter_site_id: 'narada-proper' });
  assert.equal(view(listBySite).count, 1);

  const show = await call('surface_feedback_show', { feedback_id: subData.feedback_id });
  assert.equal(view(show).summary, 'Add agent step kind');
  assert.equal(view(show).details, 'SOP should support agent executor with blocking for agent-performed steps.');

  console.log('surface-feedback-mcp behavior ok');
} finally {
  if (state) state.db.close();
  rmSync(root, { recursive: true, force: true });
}
