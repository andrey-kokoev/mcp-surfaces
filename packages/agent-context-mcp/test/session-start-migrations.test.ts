// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  materializeAgentSessionStart,
  openAgentContextDb,
} from '../src/session-start.js';

function makeSite(label) {
  const siteRoot = mkdtempSync(join(tmpdir(), `agent-context-migrations-${label}-`));
  writeFileSync(join(siteRoot, 'AGENTS.md'), '# Fixture Site\n', 'utf8');
  return siteRoot;
}

function tableNames(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  db.close();
  return names;
}

function columnNames(dbPath, table) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const names = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  db.close();
  return names;
}

// Fresh site without .ai/db/migrations: the package-bundled migrations provision the schema.
{
  const siteRoot = makeSite('bundled');
  const started = materializeAgentSessionStart({ siteRoot, identity: 'fixture.resident', runtime: 'kimi' });
  assert.equal(started.status, 'materialized');

  const dbPath = join(siteRoot, '.ai', 'state', 'agent-context.sqlite');
  const tables = tableNames(dbPath);
  for (const table of [
    'agent_start_events',
    'execution_context_materializations',
    'intelligence_context_materializations',
    'proposal_records',
    'residual_records',
    'artifact_refs',
    'agent_events',
    'codex_session_admissions',
  ]) {
    assert.equal(tables.has(table), true, `missing table: ${table}`);
  }

  // agent_events carries the canonical agent_id/event_type shape the module queries.
  const eventColumns = columnNames(dbPath, 'agent_events');
  for (const column of ['event_id', 'agent_id', 'session_id', 'event_type', 'task_number', 'payload_json', 'emitted_at']) {
    assert.equal(eventColumns.has(column), true, `missing agent_events column: ${column}`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const eventRow = db.prepare('SELECT event_id, identity_id, status FROM agent_start_events WHERE event_id = ?')
    .get(started.agent_start_event);
  const proposalRow = db.prepare('SELECT proposal_id FROM proposal_records WHERE event_id = ?')
    .get(started.agent_start_event);
  db.close();
  assert.equal(eventRow.identity_id, 'fixture.resident');
  assert.equal(eventRow.status, 'materialized');
  assert.equal(proposalRow.proposal_id, started.proposal_id);
}

// A site-root migration file still wins over the bundled one; other files fall back per-migration.
{
  const siteRoot = makeSite('site-override');
  mkdirSync(join(siteRoot, '.ai', 'db', 'migrations'), { recursive: true });
  writeFileSync(join(siteRoot, '.ai', 'db', 'migrations', '001-agent-context-materializations.sql'), `
CREATE TABLE IF NOT EXISTS agent_start_events (
  event_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  resume_command TEXT,
  bootstrap_artifact_uri TEXT,
  site_marker TEXT
);
`, 'utf8');

  const started = materializeAgentSessionStart({ siteRoot, identity: 'fixture.resident', runtime: 'kimi' });
  assert.equal(started.status, 'materialized');

  const dbPath = join(siteRoot, '.ai', 'state', 'agent-context.sqlite');
  const startColumns = columnNames(dbPath, 'agent_start_events');
  assert.equal(startColumns.has('site_marker'), true, 'site-root 001 migration did not win');

  // The site provided no 002 file, so agent_events came from the bundled fallback.
  const tables = tableNames(dbPath);
  assert.equal(tables.has('agent_events'), true, 'bundled 002 migration was not applied');
  const eventColumns = columnNames(dbPath, 'agent_events');
  assert.equal(eventColumns.has('agent_id'), true);
  assert.equal(eventColumns.has('event_type'), true);
}

// openAgentContextDb applies the busy timeout pragma so concurrent launches wait instead of failing with SQLITE_BUSY.
{
  const siteRoot = makeSite('busy-timeout');
  const db = openAgentContextDb(siteRoot);
  try {
    const timeout = db.prepare('PRAGMA busy_timeout').get().timeout;
    assert.equal(timeout, 5000);
    assert.equal(timeout, DEFAULT_BUSY_TIMEOUT_MS);
  } finally {
    db.close();
  }
}

console.log('session-start migrations tests passed');
