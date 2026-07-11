import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeServerState, createServerState, handleRequest } from '../src/main.js';

const parent = mkdtempSync(join(tmpdir(), 'surface-feedback-isolation-'));
const states: any[] = [];

function view(response: Record<string, any>): Record<string, any> {
  if (response.error) throw new Error(JSON.stringify(response.error));
  return response.result.structuredContent;
}

async function call(state: any, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return handleRequest({ jsonrpc: '2.0', id: `${name}-${Math.random()}`, method: 'tools/call', params: { name, arguments: args } }, state) as Promise<Record<string, any>>;
}

try {
  for (const siteId of ['isolation-a', 'isolation-b']) {
    const siteRoot = join(parent, siteId);
    mkdirSync(join(siteRoot, '.ai', 'do-not-open', 'tasks'), { recursive: true });
    mkdirSync(join(siteRoot, '.narada'), { recursive: true });
    states.push(createServerState({
      feedbackRoot: siteRoot,
      canonicalFeedbackRoot: siteRoot,
      taskLifecycleRoot: siteRoot,
      authoritySiteId: siteId,
      authorityOwnedSurfaceIds: ['surface-feedback'],
    }));
  }

  const submissions = await Promise.all(states.map((state, index) => call(state, 'surface_feedback_submit', {
    surface_id: 'surface-feedback',
    submitter_site_id: `isolation-${index === 0 ? 'a' : 'b'}`,
    submitter_principal: 'integration-test',
    kind: 'bug',
    summary: `Isolated conversion ${index}`,
    details: 'Each feedback server must use only its configured task lifecycle Site root.',
  })));

  const conversions = await Promise.all(states.map((state, index) => call(state, 'surface_feedback_convert_to_task', {
    feedback_id: view(submissions[index]).feedback_id,
    resolved_by: 'integration-test',
  })));
  assert.deepEqual(conversions.map((response) => view(response).task_number), [1, 1]);
  assert.deepEqual(conversions.map((response) => view(response).status), ['converted', 'converted']);
  const doctors = await Promise.all(states.map((state) => call(state, 'surface_feedback_doctor', {})));
  assert.deepEqual(doctors.map((response) => view(response).task_lifecycle_health), ['healthy', 'healthy']);

  const duplicates = await Promise.all(states.map((state, index) => call(state, 'surface_feedback_convert_to_task', {
    feedback_id: view(submissions[index]).feedback_id,
    resolved_by: 'integration-test',
  })));
  assert.deepEqual(duplicates.map((response) => view(response).status), ['already_linked', 'already_linked']);
  assert.deepEqual(duplicates.map((response) => view(response).task_number), [1, 1]);

  console.log('surface-feedback isolated task-lifecycle integration ok');
} finally {
  await Promise.all(states.map((state) => closeServerState(state)));
  rmSync(parent, { recursive: true, force: true });
}
