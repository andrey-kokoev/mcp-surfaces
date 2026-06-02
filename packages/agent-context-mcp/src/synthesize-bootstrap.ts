// @ts-nocheck
/**
 * synthesize-bootstrap.mjs
 *
 * Fold agent_events into a bootstrap residue (L1 layer).
 *
 * Usage:
 *   import { synthesizeBootstrap } from './synthesize-bootstrap.mjs';
 *   const bootstrap = synthesizeBootstrap(db, agentId, { limit: 10 });
 */

export function synthesizeBootstrap(db, agentId, options = {}) {
  const limit = options.limit ?? 10;

  if (!db) {
    return {
      schema: 'narada.bootstrap.l1.v0',
      agent_id: agentId,
      checkpoint_count: 0,
      checkpoints: [],
      summary: 'No agent context DB available; bootstrap is cold.',
    };
  }

  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_events'"
  ).get();

  if (!hasTable) {
    return {
      schema: 'narada.bootstrap.l1.v0',
      agent_id: agentId,
      checkpoint_count: 0,
      checkpoints: [],
      summary: 'Agent event log not yet initialized; bootstrap is cold.',
    };
  }

  const rows = db.prepare(
    `SELECT event_id, event_type, task_number, payload_json, emitted_at
     FROM agent_events
     WHERE agent_id = ? AND event_type = 'checkpoint'
     ORDER BY emitted_at DESC
     LIMIT ?`
  ).all(agentId, limit);

  const checkpoints = rows.map((row) => {
    let payload = null;
    try {
      if (row.payload_json) payload = JSON.parse(row.payload_json);
    } catch {
      payload = { parse_error: true, raw: row.payload_json };
    }
    return {
      event_id: row.event_id,
      task_number: row.task_number,
      emitted_at: row.emitted_at,
      boundary_type: payload?.boundary_type ?? 'unknown',
      decisions: payload?.decisions ?? [],
      files_changed: payload?.files_changed ?? [],
      tests_run: payload?.tests_run ?? [],
      friction: payload?.friction ?? [],
    };
  });

  const summary = buildSummary(checkpoints);

  return {
    schema: 'narada.bootstrap.l1.v0',
    agent_id: agentId,
    checkpoint_count: checkpoints.length,
    checkpoints,
    summary,
  };
}

function buildSummary(checkpoints) {
  if (checkpoints.length === 0) {
    return 'No prior checkpoints found. Starting fresh session.';
  }

  const parts = [];
  parts.push(`Found ${checkpoints.length} recent checkpoint(s).`);

  const recentTasks = checkpoints
    .filter((c) => c.task_number)
    .map((c) => `Task ${c.task_number} (${c.boundary_type})`);
  if (recentTasks.length > 0) {
    parts.push(`Recent work: ${recentTasks.join(', ')}.`);
  }

  const allFiles = checkpoints.flatMap((c) => c.files_changed ?? []);
  const uniqueFiles = [...new Set(allFiles)].slice(0, 10);
  if (uniqueFiles.length > 0) {
    parts.push(`Files touched: ${uniqueFiles.join(', ')}.`);
  }

  const allDecisions = checkpoints.flatMap((c) => c.decisions ?? []);
  if (allDecisions.length > 0) {
    const recentDecisions = allDecisions.slice(0, 3);
    parts.push(`Key decisions: ${recentDecisions.map((d) => d.what).join('; ')}.`);
  }

  const allFriction = checkpoints.flatMap((c) => c.friction ?? []);
  const highFriction = allFriction.filter((f) => (f.severity ?? 0) >= 7);
  if (highFriction.length > 0) {
    parts.push(`Outstanding friction: ${highFriction.map((f) => f.what).join('; ')}.`);
  }

  return parts.join(' ');
}

