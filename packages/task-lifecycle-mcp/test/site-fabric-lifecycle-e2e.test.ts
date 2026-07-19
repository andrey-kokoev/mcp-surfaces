import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('task-lifecycle-site-fabric-e2e');
const serverPath = fileURLToPath(new URL('../src/task-lifecycle/task-mcp-server.js', import.meta.url));

mkdirSync(`${siteRoot}/.narada`, { recursive: true });
writeFileSync(`${siteRoot}/.narada/task-lifecycle.toml`, '[roster]\nroles_are_obligation_targets = true\n', 'utf8');
mkdirSync(`${siteRoot}/.ai/agents`, { recursive: true });
writeFileSync(`${siteRoot}/.ai/agents/roster.json`, JSON.stringify({
  schema: 'narada.agent_roster.v1',
  agents: [
    { agent_id: 'fixture.builder', role: 'builder', status: 'active', capabilities: [] },
    { agent_id: 'fixture.architect', role: 'architect', status: 'active', capabilities: ['architect_as_reviewer'] },
  ],
}, null, 2), 'utf8');

const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', siteRoot], {
  cwd: siteRoot,
  env: siteFabricChildEnv(siteRoot, { NARADA_AGENT_ID: 'fixture.builder', NARADA_SITE_ID: 'fixture-site' }),
  label: 'task-lifecycle site-fabric e2e',
});
let reviewerServer: ReturnType<typeof spawnJsonlMcpServer> | null = null;

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  return (response.result as JsonRecord)?.structuredContent as JsonRecord ?? response.result as JsonRecord;
}

async function resolveStructured(response: JsonRecord, client: any): Promise<JsonRecord> {
  const value = structured(response);
  if (!value.output_ref) return value;
  let offset = 0;
  let outputText = '';
  while (true) {
    const page = structured(await client.request(1300, 'tools/call', {
      name: 'mcp_output_show',
      arguments: { ref: value.output_ref, offset, limit: 20000 },
    }));
    if (!page.output_text) throw new Error('output_ref_page_missing_output_text');
    outputText += String(page.output_text);
    if (page.next_offset === null || page.next_offset === undefined) break;
    offset = Number(page.next_offset);
  }
  return JSON.parse(outputText) as JsonRecord;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'narada-task-lifecycle-mcp',
    requiredTools: ['task_lifecycle_create', 'task_lifecycle_claim', 'task_lifecycle_disposition_closeout', 'task_lifecycle_submit_report'],
  });

  const payload = structured(await server.client.request(1, 'tools/call', {
    name: 'mcp_payload_create',
    arguments: {
      payload_id: 'task-lifecycle-site-fabric-e2e-task',
      payload: {
        title: 'Site fabric lifecycle fixture',
        goal: 'Prove the task lifecycle child owns a real Site-bound task.',
        required_work: ['Inspect the controlled task.', 'Record a truthful closeout.'],
        acceptance_criteria: ['The task is claimed and closed with durable evidence.'],
        target_role: 'builder',
      },
    },
  }));
  const payloadRef = String(payload.ref ?? payload.payload_ref ?? '');
  assert.match(payloadRef, /^mcp_payload:/);

  const created = structured(await server.client.request(2, 'tools/call', {
    name: 'task_lifecycle_create',
    arguments: { payload_ref: payloadRef },
  }));
  const taskNumber = Number(created.task_number);
  assert.ok(Number.isInteger(taskNumber) && taskNumber > 0, JSON.stringify(created));

  const claimed = structured(await server.client.request(3, 'tools/call', {
    name: 'task_lifecycle_claim',
    arguments: { task_number: taskNumber, agent_id: 'fixture.builder' },
  }));
  assert.equal(claimed.status, 'claimed', JSON.stringify(claimed));

  const closeout = structured(await server.client.request(4, 'tools/call', {
    name: 'task_lifecycle_disposition_closeout',
    arguments: {
      task_number: taskNumber,
      agent_id: 'fixture.builder',
      disposition: 'acknowledged',
      summary: 'Controlled Site-bound lifecycle closeout.',
      no_files_changed: true,
    },
  }));
  assert.equal(closeout.status, 'prepared', JSON.stringify(closeout));
  assert.equal(closeout.notes_written, true);
  assert.ok(Array.isArray(closeout.changed_files));

  const criteria = structured(await server.client.request(5, 'tools/call', {
    name: 'task_lifecycle_prove_criteria',
    arguments: { task_number: taskNumber, agent_id: 'fixture.builder' },
  }));
  assert.ok(['proved', 'ok', 'passed'].includes(String(criteria.status)), JSON.stringify(criteria));

  const reviewerAdmission = structured(await server.client.request(6, 'tools/call', {
    name: 'task_lifecycle_roster_admit',
    arguments: {
      agent_id: 'fixture.architect',
      role: 'architect',
      actor_agent_id: 'fixture.builder',
      capabilities: ['architect_as_reviewer'],
      authority_basis: { kind: 'task_owner_handoff', summary: 'Controlled reviewer roster for Site-fabric E2E.' },
      reason: 'Admit the distinct controlled reviewer before evidence submission.',
    },
  }));
  assert.ok(['admitted', 'updated', 'already_present'].includes(String(reviewerAdmission.status)), JSON.stringify(reviewerAdmission));

  const report = await resolveStructured(await server.client.request(7, 'tools/call', {
    name: 'task_lifecycle_finish',
    arguments: {
      task_number: taskNumber,
      agent_id: 'fixture.builder',
      summary: 'Closed controlled Site-bound lifecycle fixture.',
      no_files_changed: true,
      reviewer: 'fixture.architect',
    },
  }), server.client);
  assert.ok(['success', 'finished', 'closed', 'review_required', 'submitted'].includes(String(report.status)), JSON.stringify(report));

  const reviewTask = (report.review_task ?? report.review_dependency ?? report.review_contract) as JsonRecord | undefined;
  const reviewTaskNumber = Number(reviewTask?.task_number ?? reviewTask?.required_task_number ?? 0);
  if (Number.isInteger(reviewTaskNumber) && reviewTaskNumber > 0) {
    reviewerServer = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', siteRoot], {
      cwd: siteRoot,
      env: siteFabricChildEnv(siteRoot, { NARADA_AGENT_ID: 'fixture.architect', NARADA_SITE_ID: 'fixture-site' }),
      label: 'task-lifecycle reviewer site-fabric e2e',
    });
    await runMcpProtocolSmoke(reviewerServer.client, {
      expectedServerName: 'narada-task-lifecycle-mcp',
      requiredTools: ['task_lifecycle_claim', 'task_lifecycle_finish'],
    });
    const reviewClaim = structured(await reviewerServer.client.request(8, 'tools/call', {
      name: 'task_lifecycle_claim',
      arguments: { task_number: reviewTaskNumber, agent_id: 'fixture.architect' },
    }));
    assert.equal(reviewClaim.status, 'claimed', JSON.stringify(reviewClaim));
    const reviewFinish = await resolveStructured(await reviewerServer.client.request(9, 'tools/call', {
      name: 'task_lifecycle_finish',
      arguments: {
        task_number: reviewTaskNumber,
        agent_id: 'fixture.architect',
        summary: 'Accepted the controlled lifecycle evidence.',
        outcome: 'accepted',
        findings: [],
        no_files_changed: true,
      },
    }), reviewerServer.client);
    assert.ok(['success', 'finished', 'closed', 'submitted'].includes(String(reviewFinish.status)), JSON.stringify(reviewFinish));

    const admitted = structured(await server.client.request(10, 'tools/call', {
      name: 'task_lifecycle_admit_evidence',
      arguments: { task_number: taskNumber, agent_id: 'fixture.builder' },
    }));
    assert.equal(admitted.verdict, 'admitted', JSON.stringify(admitted));

    const dependencyPreflight = await resolveStructured(await server.client.request(11, 'tools/call', {
      name: 'task_lifecycle_evidence_preflight',
      arguments: { task_number: taskNumber },
    }), server.client);
    const dependencySatisfaction = dependencyPreflight.dependency_satisfaction as JsonRecord;
    assert.equal(dependencySatisfaction.all_satisfied, true, JSON.stringify(dependencyPreflight));

    const closed = await resolveStructured(await server.client.request(12, 'tools/call', {
      name: 'task_lifecycle_close',
      arguments: { task_number: taskNumber, agent_id: 'fixture.builder', mode: 'peer_reviewed' },
    }), server.client);
    assert.equal(closed.status, 'success', JSON.stringify(closed));
    assert.equal(closed.new_status, 'closed', JSON.stringify(closed));
  }

  const shown = await resolveStructured(await server.client.request(13, 'tools/call', {
    name: 'task_lifecycle_show',
    arguments: { task_number: taskNumber },
  }), server.client);
  const task = shown.lifecycle as JsonRecord;
  assert.equal(task.task_number, taskNumber);
  assert.equal(task.status, 'closed');

  const taskPath = `${siteRoot}/.ai/do-not-open/tasks/${String(task.task_id)}.md`;
  assert.ok(existsSync(taskPath), JSON.stringify(shown));
  const taskBody = readFileSync(taskPath, 'utf8');
  assert.match(taskBody, /Controlled Site-bound lifecycle closeout/);
  assert.match(String(shown.body ?? ''), /Controlled Site-bound lifecycle closeout/);

  console.log(JSON.stringify({
    status: 'passed',
    test_id: 'task-lifecycle.site-fabric.lifecycle',
    site_root: siteRoot,
    task_number: taskNumber,
    cleanup: 'pending_until_finally',
  }));
} finally {
  if (reviewerServer) await reviewerServer.close();
  await server.close();
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}

console.log('task-lifecycle site-fabric lifecycle e2e ok');
