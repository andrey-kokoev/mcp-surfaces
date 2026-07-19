-- Migration: agent event log substrate
-- Date: 2026-05-05
-- Author: narada-andrey.Bob
--
-- Invariants:
-- 1. Append-only. No updates or deletes.
-- 2. All agent memory is a projection folded from this log.
-- 3. Checkpoints are events, not a separate table.

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
