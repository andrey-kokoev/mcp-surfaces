import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import { handleTaskLifecycleMcpRequest } from '../src/task-lifecycle/task-mcp-server.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-tags-'));
const runtime = {
  argv: ['--site-root', siteRoot],
  cwd: siteRoot,
  env: { ...process.env, NARADA_AGENT_ID: 'tags.architect' },
  stdout: { write: () => true },
  stderr: { write: () => true },
};

function payload(response: any): any {
  if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
  if (response.result?.tools) return response.result;
  return response.result?.structuredContent ?? JSON.parse(response.result?.content?.[0]?.text ?? '{}');
}

async function call(id: number, name: string, arguments_: Record<string, unknown> = {}) {
  return payload(await handleTaskLifecycleMcpRequest({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: arguments_ },
  }, runtime));
}

mkdirSync(join(siteRoot, '.ai', 'agents'), { recursive: true });
mkdirSync(join(siteRoot, '.ai', 'do-not-open', 'tasks'), { recursive: true });
writeFileSync(join(siteRoot, '.ai', 'agents', 'roster.json'), JSON.stringify({
  version: 1,
  updated_at: '2026-07-18T00:00:00.000Z',
  agents: [{
    agent_id: 'tags.architect',
    role: 'architect',
    capabilities: ['review'],
    first_seen_at: '2026-07-18T00:00:00.000Z',
    last_active_at: '2026-07-18T00:00:00.000Z',
  }],
}), 'utf8');
writeFileSync(join(siteRoot, '.ai', 'do-not-open', 'tasks', '20260718-1-task-one.md'), `---
task_number: 1
status: opened
---

# Task one

## Goal

Improve MCP surface discovery.

## Acceptance Criteria

- [ ] The task is discoverable.
`, 'utf8');

writeFileSync(join(siteRoot, '.ai', 'do-not-open', 'tasks', '20260718-4-unrelated.md'), `---\nnumber: 4\nstatus: opened\ntags: mcp-surface\n---\n\n# Unrelated delta\n\n## Goal\n\nDelta only.\n`, 'utf8');
writeFileSync(join(siteRoot, '.ai', 'do-not-open', 'tasks', '20260718-5-yaml-tags.md'), `---\nnumber: 5\nstatus: opened\ntags: [yaml-tag, mcp-surface]\n---\n\n# YAML tags\n\n## Goal\n\nYAML array parsing.\n`, 'utf8');
writeFileSync(join(siteRoot, '.ai', 'do-not-open', 'tasks', '20260718-6-legacy-file.md'), `---\nnumber: 6\nstatus: opened\ntags: [legacy-label, old-surface]\n---\n\n# Task 6 - Legacy file\n\n## Goal\n\nRecover a legacy task specification.\n\n## Acceptance Criteria\n\n- [ ] The legacy task is taggable.\n`, 'utf8');

const store = openTaskLifecycleStore(siteRoot);
try {
  for (const [taskId, taskNumber, title, goal, tags] of [
    ['20260718-1-task-one', 1, 'Task one', 'Improve MCP surface discovery.', JSON.stringify([])],
    ['20260718-2-task-two', 2, 'Task two', 'Review MCP surface behavior.', JSON.stringify(['mcp-surface', 'review'])],
  ] as const) {
    store.upsertLifecycle({
      task_id: taskId,
      task_number: taskNumber,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-07-18T00:00:00.000Z',
    });
    store.upsertTaskSpec({
      task_id: taskId,
      task_number: taskNumber,
      title,
      goal_markdown: goal,
      acceptance_criteria_json: '[]',
      dependencies_json: '[]',
      tags_json: tags,
    });
  }
  store.upsertLifecycle({
    task_id: 'legacy-only',
    task_number: 42,
    status: 'opened',
    governed_by: null,
    closed_at: null,
    closed_by: null,
    reopened_at: null,
    reopened_by: null,
    continuation_packet_json: null,
    updated_at: '2026-07-18T00:00:00.000Z',
  });
  store.upsertLifecycle({
    task_id: '20260718-6-legacy-file',
    task_number: 6,
    status: 'opened',
    governed_by: null,
    closed_at: null,
    closed_by: null,
    reopened_at: null,
    reopened_by: null,
    continuation_packet_json: null,
    updated_at: '2026-07-18T00:00:00.000Z',
  });
  store.ensureTaskNumberFloor(42);
} finally {
  store.db.close();
}

try {
  const toolList = payload(await handleTaskLifecycleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, runtime));
  const tagsTool = toolList.tools.find((tool: any) => tool.name === 'task_lifecycle_tags_update');
  assert.ok(tagsTool);
  assert.deepEqual(tagsTool.inputSchema.required, ['task_number', 'agent_id', 'tags', 'reason']);

  const updated = await call(2, 'task_lifecycle_tags_update', {
    task_number: 1,
    agent_id: 'tags.architect',
    tags: ['MCP Surface', 'review', 'mcp_surface'],
    reason: 'Classify the task for site-local discovery.',
  });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.projection_status, 'projected');
  assert.deepEqual(updated.tags, ['mcp-surface', 'review']);
  assert.match(readFileSync(join(siteRoot, '.ai', 'do-not-open', 'tasks', '20260718-1-task-one.md'), 'utf8'), /tags: mcp-surface, review/);

  const shown = await call(3, 'task_lifecycle_show', { task_number: 1 });
  assert.deepEqual(shown.spec.tags, ['mcp-surface', 'review']);
  assert.equal(shown.tag_updates[0].actor_agent_id, 'tags.architect');
  assert.equal(shown.tag_updates[0].reason, 'Classify the task for site-local discovery.');
  assert.deepEqual(shown.tag_updates[0].previous_tags, []);
  assert.deepEqual(shown.tag_updates[0].tags, ['mcp-surface', 'review']);
  assert.equal('previous_tags_json' in shown.tag_updates[0], false);

  const legacyFile = await call(4, 'task_lifecycle_show', { task_number: 6 });
  assert.deepEqual(legacyFile.spec.tags, ['legacy-label', 'old-surface']);
  const legacyOnly = await call(5, 'task_lifecycle_tags_update', {
    task_number: 42,
    agent_id: 'tags.architect',
    tags: ['Legacy Only'],
    reason: 'Make a lifecycle-only legacy task discoverable.',
  });
  assert.equal(legacyOnly.status, 'updated');
  assert.equal(legacyOnly.projection_status, 'not_found');
  assert.deepEqual((await call(6, 'task_lifecycle_show', { task_number: 42 })).spec.tags, ['legacy-only']);

  const listed = await call(7, 'task_lifecycle_list', { tags: ['mcp-surface', 'review'], tag_match: 'all' });
  assert.deepEqual(listed.tasks.map((task: any) => task.task_number), [2, 1]);
  const anyListed = await call(8, 'task_lifecycle_list', { tags: ['review', 'missing'], tag_match: 'any' });
  assert.deepEqual(anyListed.tasks.map((task: any) => task.task_number), [2, 1]);

  const related = await call(9, 'task_lifecycle_related', { task_number: 1 });
  assert.equal(related.related[0].task_number, 2);
  assert.equal(related.related[0].match_basis, 'explicit_tags');

  const yamlRelated = await call(10, 'task_lifecycle_related', { task_number: 5 });
  assert.deepEqual(yamlRelated.target_explicit_tags, ['mcp-surface', 'yaml-tag']);
  assert.equal(yamlRelated.related.some((item: any) => item.task_number === 4), true);

  await call(11, 'task_lifecycle_tags_update', {
    task_number: 1,
    agent_id: 'tags.architect',
    tags: [],
    reason: 'Clear the labels to test SQLite authority after projection drift.',
  });
  writeFileSync(join(siteRoot, '.ai', 'do-not-open', 'tasks', '20260718-1-task-one.md'), `---\ntask_number: 1\nstatus: opened\ntags: mcp-surface\n---\n\n# Task one\n\n## Goal\n\nImprove MCP surface discovery.\n`, 'utf8');
  const afterProjectionDrift = await call(12, 'task_lifecycle_related', { task_number: 1 });
  assert.deepEqual(afterProjectionDrift.target_explicit_tags, []);
  assert.equal(afterProjectionDrift.related.some((item: any) => item.task_number === 4), false);
  const driftShow = await call(25, 'task_lifecycle_show', { task_number: 1 });
  assert.equal(driftShow.tag_projection.status, 'stale');
  assert.equal(driftShow.tag_projection.repair_required, true);
  const repaired = await call(26, 'task_lifecycle_tags_update', {
    task_number: 1,
    agent_id: 'tags.architect',
    tags: [],
    reason: 'Repair the stale Markdown tag projection.',
  });
  assert.equal(repaired.projection_status, 'projected');

  const audit = await call(13, 'task_lifecycle_audit', {
    since: '2026-07-17T00:00:00.000Z',
    until: '2026-07-19T00:00:00.000Z',
  });
  assert.equal(audit.events.some((event: any) => event.event_type === 'tag_update' && event.task === '1'), true);

  const createPayload = await call(14, 'mcp_payload_create', {
    payload: {
      title: 'Created tagged task',
      goal: 'Create a task with labels.',
      acceptance_criteria: ['The labels are persisted.'],
      tags: ['New Label', 'mcp_surface'],
    },
  });
  const created = await call(15, 'task_lifecycle_create', { payload_ref: createPayload.ref });
  assert.equal(created.status, 'created');
  assert.deepEqual(created.tags, ['mcp-surface', 'new-label']);
  const createdShow = await call(16, 'task_lifecycle_show', { task_number: created.task_number });
  assert.deepEqual(createdShow.spec.tags, ['mcp-surface', 'new-label']);

  const invalidCreatePayload = await call(17, 'mcp_payload_create', {
    payload: {
      title: 'Invalid tagged task',
      tags: null,
    },
  });
  await assert.rejects(
    () => call(18, 'task_lifecycle_create', { payload_ref: invalidCreatePayload.ref }),
    /task_lifecycle_create_payload_tags_invalid:task_tags_must_be_array/,
  );

  const recurring = await call(19, 'task_lifecycle_recurring_create', {
    title: 'Tagged recurring task',
    actor_agent_id: 'tags.architect',
    authority_basis: { kind: 'architect_review', summary: 'Create the recurring tag propagation test.' },
    tags: ['Recurring Label', 'mcp_surface'],
    initial_status: 'active',
  });
  assert.equal(recurring.status, 'created');
  assert.deepEqual(recurring.definition.tags, ['mcp-surface', 'recurring-label']);
  const triggered = await call(20, 'task_lifecycle_recurring_trigger', {
    recurrence_id: recurring.recurrence_id,
    actor_agent_id: 'tags.architect',
    authority_basis: { kind: 'manual_trigger', summary: 'Run the recurring tag propagation test.' },
    run_reason: 'Verify recurring labels reach generated task instances.',
  });
  assert.equal(triggered.status, 'triggered');
  const recurringShow = await call(21, 'task_lifecycle_show', { task_number: triggered.task_number });
  assert.deepEqual(recurringShow.spec.tags, ['mcp-surface', 'recurring-label']);

  const scheduled = await call(22, 'task_lifecycle_recurring_create', {
    title: 'Scheduled tagged task',
    actor_agent_id: 'tags.architect',
    authority_basis: { kind: 'architect_review', summary: 'Create the scheduled tag propagation test.' },
    tags: ['Scheduled Label'],
    trigger_mode: 'schedule',
    schedule_kind: 'daily',
    schedule_timezone: 'UTC',
    initial_status: 'active',
  });
  const due = await call(23, 'task_lifecycle_recurring_run_due', {
    actor_agent_id: 'tags.architect',
    authority_basis: { kind: 'scheduled_trigger', summary: 'Run the scheduled tag propagation test.' },
    current_time: '2026-07-18T12:00:00.000Z',
  });
  const scheduledRun = due.created.find((run: any) => run.recurrence_id === scheduled.recurrence_id);
  assert.ok(scheduledRun);
  const scheduledShow = await call(24, 'task_lifecycle_show', { task_number: scheduledRun.task_number });
  assert.deepEqual(scheduledShow.spec.tags, ['scheduled-label']);
} finally {
  try {
    rmSync(siteRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EBUSY') throw error;
  }
}

console.log('task-lifecycle-mcp task tags ok');
