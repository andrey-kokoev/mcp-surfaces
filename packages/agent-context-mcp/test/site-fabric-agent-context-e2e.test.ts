// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('agent-context-site-fabric-e2e');
const dbPath = `${siteRoot}/.ai/state/agent-context.sqlite`;
mkdirSync(`${siteRoot}/.ai/state`, { recursive: true });
writeFileSync(`${siteRoot}/AGENTS.md`, '# Controlled fixture Site\n', 'utf8');
mkdirSync(`${siteRoot}/.ai/agents`, { recursive: true });
writeFileSync(`${siteRoot}/.ai/agents/roster.json`, JSON.stringify({
  agents: [{ agent_id: 'fixture.resident', role: 'resident', status: 'active', capabilities: [] }],
}, null, 2), 'utf8');
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE agent_start_events (
    event_id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    runtime TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    resume_command TEXT,
    bootstrap_artifact_uri TEXT
  );
  CREATE TABLE agent_events (
    event_id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
  );
`);
db.close();

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', siteRoot, '--site-id', 'fixture-site'], {
  cwd: siteRoot,
  env: siteFabricChildEnv(siteRoot, {
    NARADA_AGENT_ID: 'fixture.resident',
    NARADA_SITE_ROOT: siteRoot,
    NARADA_AGENT_CONTEXT_DB: dbPath,
  }),
  label: 'agent-context Site-fabric e2e',
});

function structured(response: Record<string, unknown>): Record<string, unknown> {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as Record<string, unknown>;
  return (result.structuredContent as Record<string, unknown>) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'fixture-site-agent-context-mcp',
    requiredTools: ['agent_context_doctor', 'agent_context_startup_sequence', 'agent_context_checkpoint', 'agent_context_rehydrate', 'agent_context_output_show'],
  });

  const doctor = structured(await server.client.request(1, 'tools/call', { name: 'agent_context_doctor', arguments: {} }));
  assert.equal(doctor.status, 'ok', JSON.stringify(doctor));
  assert.equal(doctor.site_root, siteRoot);

  const whoami = structured(await server.client.request(2, 'tools/call', { name: 'agent_context_whoami', arguments: {} }));
  assert.equal(whoami.identity, 'fixture.resident', JSON.stringify(whoami));
  assert.equal(whoami.role, 'resident');

  const startup = structured(await server.client.request(3, 'tools/call', {
    name: 'agent_context_startup_sequence',
    arguments: { checkpoint_startup: true },
  }));
  assert.equal(startup.status, 'ok', JSON.stringify(startup));
  assert.equal((startup.startup_checkpoint as Record<string, unknown>).status, 'checkpointed');

  const checkpoint = structured(await server.client.request(4, 'tools/call', {
    name: 'agent_context_checkpoint',
    arguments: {
      agent_id: 'fixture.resident',
      key_decisions: Array.from({ length: 300 }, (_, index) => `bounded-decision-${index}`),
      authority_basis: { kind: 'site-fabric-e2e', summary: 'Controlled checkpoint persistence.' },
      next_intended_action: { kind: 'verify', summary: 'Read the persisted checkpoint.' },
    },
  }));
  assert.equal(checkpoint.status, 'checkpointed', JSON.stringify(checkpoint));

  const rehydrated = structured(await server.client.request(5, 'tools/call', {
    name: 'agent_context_rehydrate',
    arguments: { agent_id: 'fixture.resident' },
  }));
  assert.match(String(rehydrated.output_ref), /^mcp_output:/, JSON.stringify(rehydrated));

  const outputPage = structured(await server.client.request(6, 'tools/call', {
    name: 'agent_context_output_show',
    arguments: { ref: rehydrated.output_ref, offset: 0, limit: 1000 },
  }));
  assert.equal(outputPage.schema, 'narada.mcp_output_page.v1', JSON.stringify(outputPage));
  assert.ok(String(outputPage.output_text).includes('fixture.resident'), JSON.stringify(outputPage));

  console.log(JSON.stringify({ status: 'passed', test_id: 'agent-context.site-fabric.startup-checkpoint-rehydrate', site_root: siteRoot, cleanup: 'pending_until_finally' }));
} finally {
  await server.close();
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}

console.log('agent-context Site fabric e2e ok');
