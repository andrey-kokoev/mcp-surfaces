/**
 * Checkpoint Event Emitter
 *
 * Emits checkpoint events to the agent-context DB when tasks cross boundaries.
 * Minimal v0: boundary_type, summary, task_number, task_id.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveBetterSqlite3() {
  // Try standard resolution first, then fallbacks
  try {
    return require('better-sqlite3');
  } catch {
    try {
      return require(resolve(process.cwd(), 'node_modules', 'better-sqlite3'));
    } catch {
      try {
        return require(resolve(process.cwd(), 'node_modules', '.pnpm', 'node_modules', 'better-sqlite3'));
      } catch {
        try {
          return require(resolve(process.cwd(), 'tools', 'agent-context', 'node_modules', 'better-sqlite3'));
        } catch {
          return require(resolve(process.cwd(), 'tools', 'incubation', 'node_modules', 'better-sqlite3'));
        }
      }
    }
  }
}

const AGENT_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS agent_events (
  event_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  task_number INTEGER,
  payload_json TEXT,
  emitted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_id, emitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_task ON agent_events(task_number, emitted_at DESC);
`;

function openAgentContextDb(cwd) {
  const siteRoot = resolve(cwd);
  const dbDir = join(siteRoot, '.ai', 'state');
  const dbPath = join(dbDir, 'agent-context.sqlite');
  try {
    const Database = resolveBetterSqlite3();
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    const db = new Database(dbPath);
    db.exec(AGENT_EVENTS_DDL);
    return db;
  } catch {
    return null;
  }
}

export function emitCheckpoint(options) {
  const {
    cwd,
    agentId,
    sessionId,
    taskNumber,
    taskId,
    boundaryType,
    summary,
    decisions,
    filesChanged,
    testsRun,
    friction,
  } = options;

  const db = openAgentContextDb(cwd);
  if (!db) {
    return { status: 'skipped', reason: 'agent_context_db_not_found' };
  }

  try {
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_events'").get();
    if (!hasTable) {
      db.close();
      return { status: 'skipped', reason: 'agent_events_table_not_found' };
    }

    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
    const payload = {
      schema: 'narada.intelligence_context.checkpoint.v0',
      boundary_type: boundaryType || 'finish',
      summary: summary || null,
      task_id: taskId || null,
      decisions: decisions || [],
      files_changed: filesChanged || [],
      tests_run: testsRun || [],
      friction: friction || [],
    };

    db.prepare(
      `INSERT INTO agent_events (event_id, agent_id, session_id, event_type, task_number, payload_json, emitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventId,
      agentId || 'unknown',
      sessionId || 'unknown',
      'checkpoint',
      taskNumber ?? null,
      JSON.stringify(payload),
      new Date().toISOString()
    );

    db.close();
    return { status: 'emitted', event_id: eventId };
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}
