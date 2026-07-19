// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  materializeAgentSessionStart,
  validateIdentityAgainstRoster,
} from '../src/session-start.js';

const INFERRED_SOURCE = 'identity_inference_non_authoritative';
const INFERRED_SEMANTICS = 'Role was inferred from identity shape because the Site has not opted into session roster enforcement; this is a read-model hint, not activation authority or a capability grant.';
const ROSTER_SEMANTICS = 'Roster role binding is used for identity read models, routing, and eligibility; it is not activation authority or a capability grant.';

function makeSite(label) {
  const siteRoot = mkdtempSync(join(tmpdir(), `agent-context-roster-${label}-`));
  writeFileSync(join(siteRoot, 'AGENTS.md'), '# Fixture Site\n', 'utf8');
  return siteRoot;
}

function writeRoster(siteRoot, roster) {
  mkdirSync(join(siteRoot, '.ai', 'agents'), { recursive: true });
  writeFileSync(join(siteRoot, '.ai', 'agents', 'roster.json'), JSON.stringify(roster, null, 2), 'utf8');
}

function seedAgentContextDb(siteRoot) {
  const dbPath = join(siteRoot, '.ai', 'state', 'agent-context.sqlite');
  mkdirSync(join(siteRoot, '.ai', 'state'), { recursive: true });
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
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      task_number INTEGER,
      payload_json TEXT,
      emitted_at TEXT NOT NULL
    );
  `);
  db.close();
  return dbPath;
}

// (a) roster.json missing -> inferred fallback succeeds and session start materializes.
{
  const siteRoot = makeSite('missing');
  const dbPath = seedAgentContextDb(siteRoot);

  const check = validateIdentityAgainstRoster(siteRoot, 'fixture.resident');
  assert.equal(check.valid, true);
  assert.equal(check.roster_source, INFERRED_SOURCE);
  assert.equal(check.roster_enforcement, 'disabled');
  assert.equal(check.reason, 'roster_unavailable_but_site_session_roster_enforcement_not_enabled');
  assert.equal(check.prior_error, `task_lifecycle_roster_db_not_found: ${join(siteRoot, '.ai', 'task-lifecycle.db')}`);
  assert.equal(check.role, 'resident');
  assert.equal(check.agent.agent_id, 'fixture.resident');
  assert.equal(check.agent.roster_source, INFERRED_SOURCE);
  assert.deepEqual(check.capabilities, []);
  assert.equal(check.capability_policy.schema, 'narada.agent.capability_policy.v0');
  assert.equal(check.role_binding.binding_source, INFERRED_SOURCE);
  assert.equal(check.role_binding.binding_authority, INFERRED_SOURCE);
  assert.equal(check.role_binding.semantics, INFERRED_SEMANTICS);

  const started = materializeAgentSessionStart({ siteRoot, identity: 'fixture.resident', runtime: 'kimi' });
  assert.equal(started.status, 'materialized');
  assert.equal(started.role, 'resident');
  assert.equal(started.role_binding.binding_authority, INFERRED_SOURCE);
  assert.equal(started.resume_command, 'kimi -S fixture.resident');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const eventRow = db.prepare('SELECT event_id, identity_id, status FROM agent_start_events WHERE event_id = ?')
    .get(started.agent_start_event);
  db.close();
  assert.equal(eventRow.identity_id, 'fixture.resident');
  assert.equal(eventRow.status, 'materialized');
}

// (b) roster.json present, identity absent, no enforcement flag -> inferred fallback succeeds.
{
  const siteRoot = makeSite('not-in-roster');
  writeRoster(siteRoot, {
    agents: [{ agent_id: 'fixture.architect', role: 'architect', capabilities: [] }],
  });

  const check = validateIdentityAgainstRoster(siteRoot, 'fixture.builder');
  assert.equal(check.valid, true);
  assert.equal(check.roster_source, INFERRED_SOURCE);
  assert.equal(check.roster_enforcement, 'disabled');
  assert.equal(check.reason, 'identity_not_in_roster_but_site_session_roster_enforcement_not_enabled');
  assert.equal(check.prior_error, `task_lifecycle_roster_db_not_found: ${join(siteRoot, '.ai', 'task-lifecycle.db')}`);
  assert.equal(check.role, 'builder');
  assert.equal(check.role_binding.binding_authority, INFERRED_SOURCE);
  assert.equal(check.role_binding.semantics, INFERRED_SEMANTICS);

  const dryRun = materializeAgentSessionStart({ siteRoot, identity: 'fixture.builder', runtime: 'kimi', dryRun: true });
  assert.equal(dryRun.status, 'dry_run');
  assert.equal(dryRun.role, 'builder');
  assert.equal(dryRun.role_binding.binding_authority, INFERRED_SOURCE);
}

// (c) roster.json with enforce_session_roster: true, identity absent -> identity_not_in_roster.
{
  const siteRoot = makeSite('enforced');
  writeRoster(siteRoot, {
    enforce_session_roster: true,
    agents: [{ agent_id: 'fixture.architect', role: 'architect', capabilities: [] }],
  });

  const check = validateIdentityAgainstRoster(siteRoot, 'fixture.builder');
  assert.equal(check.valid, false);
  assert.equal(check.error, 'identity_not_in_roster: fixture.builder');

  assert.throws(
    () => materializeAgentSessionStart({ siteRoot, identity: 'fixture.builder', runtime: 'kimi', dryRun: true }),
    /identity_not_in_roster: fixture\.builder/,
  );
}

// (d) identity present in roster.json -> static roster path unchanged.
{
  const siteRoot = makeSite('static');
  writeRoster(siteRoot, {
    agents: [{ agent_id: 'fixture.architect', role: 'architect', capabilities: ['review', 'route'] }],
  });

  const check = validateIdentityAgainstRoster(siteRoot, 'fixture.architect');
  assert.equal(check.valid, true);
  assert.equal(check.roster_source, undefined);
  assert.equal(check.roster_enforcement, undefined);
  assert.equal(check.reason, undefined);
  assert.equal(check.role, 'architect');
  assert.deepEqual(check.agent, { agent_id: 'fixture.architect', role: 'architect', capabilities: ['review', 'route'] });
  assert.deepEqual(check.capabilities, ['review', 'route']);
  assert.equal(check.capability_policy.schema, 'narada.agent.capability_policy.v0');
  assert.equal(check.role_binding.binding_source, 'static_roster_config');
  assert.equal(check.role_binding.binding_authority, 'agent_roster');
  assert.equal(check.role_binding.semantics, ROSTER_SEMANTICS);

  const dryRun = materializeAgentSessionStart({ siteRoot, identity: 'fixture.architect', runtime: 'codex', dryRun: true });
  assert.equal(dryRun.status, 'dry_run');
  assert.equal(dryRun.role_binding.binding_authority, 'agent_roster');
}

// (e) sqlite task-lifecycle roster path unchanged and still takes precedence over roster.json.
{
  const siteRoot = makeSite('sqlite');
  mkdirSync(join(siteRoot, '.ai'), { recursive: true });
  const lifecycleDbPath = join(siteRoot, '.ai', 'task-lifecycle.db');
  const lifecycleDb = new DatabaseSync(lifecycleDbPath);
  lifecycleDb.exec(`
    CREATE TABLE agent_roster (
      agent_id TEXT PRIMARY KEY,
      role TEXT,
      capabilities_json TEXT,
      first_seen_at TEXT,
      last_active_at TEXT,
      status TEXT,
      task_number INTEGER,
      last_done TEXT,
      updated_at TEXT
    );
  `);
  lifecycleDb.prepare(`
    INSERT INTO agent_roster (
      agent_id, role, capabilities_json, first_seen_at, last_active_at, status, task_number, last_done, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('fixture.resident', 'resident', '["checkpoint","hydrate"]', '2026-07-01T00:00:00.000Z', null, 'active', 42, null, null);
  lifecycleDb.close();
  writeRoster(siteRoot, {
    agents: [{ agent_id: 'fixture.architect', role: 'architect', capabilities: [] }],
  });

  const sqlCheck = validateIdentityAgainstRoster(siteRoot, 'fixture.resident');
  assert.equal(sqlCheck.valid, true);
  assert.equal(sqlCheck.roster_source, 'task_lifecycle_sqlite_agent_roster');
  assert.equal(sqlCheck.role, 'resident');
  assert.deepEqual(sqlCheck.capabilities, ['checkpoint', 'hydrate']);
  assert.equal(sqlCheck.agent.roster_source, 'task_lifecycle_sqlite_agent_roster');
  assert.equal(sqlCheck.agent.first_seen_at, '2026-07-01T00:00:00.000Z');
  assert.equal(sqlCheck.agent.status, 'active');
  assert.equal(sqlCheck.agent.task, 42);
  assert.equal(sqlCheck.role_binding.binding_source, 'task_lifecycle_sqlite_agent_roster');
  assert.equal(sqlCheck.role_binding.binding_authority, 'agent_roster');
  assert.equal(sqlCheck.role_binding.semantics, ROSTER_SEMANTICS);

  // Identity absent from the sqlite roster still falls through to roster.json.
  const staticCheck = validateIdentityAgainstRoster(siteRoot, 'fixture.architect');
  assert.equal(staticCheck.valid, true);
  assert.equal(staticCheck.role_binding.binding_source, 'static_roster_config');

  // Identity in neither store falls through to the inferred fallback.
  const inferredCheck = validateIdentityAgainstRoster(siteRoot, 'fixture.builder');
  assert.equal(inferredCheck.valid, true);
  assert.equal(inferredCheck.roster_source, INFERRED_SOURCE);
  assert.equal(inferredCheck.reason, 'identity_not_in_roster_but_site_session_roster_enforcement_not_enabled');
  assert.equal(inferredCheck.prior_error, 'identity_not_in_task_lifecycle_roster: fixture.builder');
}

console.log('session-start roster tests passed');
