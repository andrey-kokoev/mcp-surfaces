import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_SITE_OPERATING_LOOP_ID = 'site.operating-loop';
export const DEFAULT_SITE_OPERATING_LOOP_OWNER_ID = 'site-operating-loop';

export function ensureSiteLoopTables(db) {
  const repairs = [];
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_loop_runs (
      run_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      status TEXT NOT NULL,
      dry_run INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      summary_json TEXT,
      error_json TEXT
    );

    CREATE TABLE IF NOT EXISTS site_loop_step_runs (
      step_run_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      input_refs_json TEXT,
      output_refs_json TEXT,
      evidence_json TEXT,
      error_json TEXT,
      FOREIGN KEY (run_id) REFERENCES site_loop_runs(run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_site_loop_runs_loop_started
      ON site_loop_runs(loop_id, started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_site_loop_step_runs_run
      ON site_loop_step_runs(run_id, step_id);

    CREATE TABLE IF NOT EXISTS site_loop_locks (
      loop_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      stale_recovery_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_loop_health (
      loop_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_successful_run_id TEXT,
      last_success_at TEXT,
      last_run_id TEXT,
      last_run_at TEXT,
      failing_step TEXT,
      last_error_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_loop_control (
      loop_id TEXT PRIMARY KEY,
      paused INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'running',
      reason TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_loop_classification_observations (
      observation_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      classification TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      observation_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_site_loop_classification_directive
      ON site_loop_classification_observations(loop_id, directive_id, classification, observed_at DESC);

    CREATE TABLE IF NOT EXISTS site_loop_escalations (
      escalation_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      classification TEXT NOT NULL,
      status TEXT NOT NULL,
      envelope_id TEXT,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      ack_reason TEXT,
      escalation_json TEXT NOT NULL,
      UNIQUE(loop_id, directive_id, classification)
    );

    CREATE TABLE IF NOT EXISTS directive_outcomes (
      outcome_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      agent_id TEXT,
      task_id TEXT,
      report_id TEXT,
      receipt_id TEXT,
      reason TEXT,
      event_at TEXT,
      observed_at TEXT,
      recorded_at TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS directive_outcome_latest (
      loop_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      outcome_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      agent_id TEXT,
      task_id TEXT,
      report_id TEXT,
      receipt_id TEXT,
      reason TEXT,
      event_at TEXT,
      observed_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      PRIMARY KEY (loop_id, directive_id)
    );

    CREATE INDEX IF NOT EXISTS idx_directive_outcome_latest_outcome
      ON directive_outcome_latest(loop_id, outcome, observed_at DESC, recorded_at DESC);
  `);
  ensureColumn(db, 'site_loop_escalations', 'acknowledged_at', 'TEXT', repairs);
  ensureColumn(db, 'site_loop_escalations', 'acknowledged_by', 'TEXT', repairs);
  ensureColumn(db, 'site_loop_escalations', 'ack_reason', 'TEXT', repairs);
  if (tableExists(db, 'task_reports')) {
    ensureColumn(db, 'task_reports', 'directive_id', 'TEXT', repairs);
    db.prepare('CREATE INDEX IF NOT EXISTS idx_task_reports_directive_id ON task_reports(directive_id)').run();
  }
  ensureColumn(db, 'directive_outcomes', 'event_at', 'TEXT', repairs);
  ensureColumn(db, 'directive_outcomes', 'observed_at', 'TEXT', repairs);
  db.prepare('UPDATE directive_outcomes SET event_at = recorded_at WHERE event_at IS NULL').run();
  db.prepare('UPDATE directive_outcomes SET observed_at = recorded_at WHERE observed_at IS NULL').run();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_directive_outcomes_latest
      ON directive_outcomes(loop_id, directive_id, observed_at DESC, recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_directive_outcomes_outcome
      ON directive_outcomes(loop_id, outcome, observed_at DESC, recorded_at DESC);
  `);
  backfillDirectiveOutcomeLatest(db);
  return {
    schema: 'narada.site_operating_loop.schema_repair.v1',
    status: 'ok',
    repairs,
  };
}

export function recordDirectiveOutcome(store, {
  loopId = DEFAULT_SITE_OPERATING_LOOP_ID,
  directiveId,
  outcome,
  agentId = null,
  taskId = null,
  reportId = null,
  receiptId = null,
  reason = null,
  evidence = null,
  at = null,
  eventAt = null,
  observedAt = null,
  recordedAt = null,
} = {}) {
  const finalRecordedAt = recordedAt ?? at ?? new Date().toISOString();
  const finalObservedAt = observedAt ?? finalRecordedAt;
  const finalEventAt = eventAt ?? finalObservedAt;
  const outcomeId = `dirout_${hashStable({ loopId, directiveId, outcome, finalRecordedAt, finalObservedAt, nonce: randomUUID() }).slice(0, 32)}`;
  store.db.prepare(`
    INSERT INTO directive_outcomes (
      outcome_id, loop_id, directive_id, outcome, agent_id, task_id, report_id,
      receipt_id, reason, event_at, observed_at, recorded_at, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    outcomeId,
    loopId,
    directiveId,
    outcome,
    agentId,
    taskId,
    reportId,
    receiptId,
    reason,
    finalEventAt,
    finalObservedAt,
    finalRecordedAt,
    stringifyJson(evidence ?? {}),
  );
  upsertDirectiveOutcomeLatest(store.db, {
    outcome_id: outcomeId,
    loop_id: loopId,
    directive_id: directiveId,
    outcome,
    agent_id: agentId,
    task_id: taskId,
    report_id: reportId,
    receipt_id: receiptId,
    reason,
    event_at: finalEventAt,
    observed_at: finalObservedAt,
    recorded_at: finalRecordedAt,
    evidence_json: stringifyJson(evidence ?? {}),
  });
  return getDirectiveOutcome(store, { outcomeId });
}

export function getDirectiveOutcome(store, { outcomeId } = {}) {
  const row = store.db.prepare('SELECT * FROM directive_outcomes WHERE outcome_id = ?').get(outcomeId);
  return row ? parseDirectiveOutcomeRow(row) : null;
}

export function getLatestDirectiveOutcome(store, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID, directiveId } = {}) {
  const row = store.db.prepare(`
    SELECT * FROM directive_outcome_latest
    WHERE loop_id = ? AND directive_id = ?
    LIMIT 1
  `).get(loopId, directiveId);
  return row ? parseDirectiveOutcomeRow(row) : null;
}

export function listDirectiveOutcomes(store, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID, outcome = null, limit = 50 } = {}) {
  const max = Math.max(1, Math.min(500, Number(limit ?? 50)));
  const rows = outcome
    ? store.db.prepare(`
        SELECT * FROM directive_outcomes
        WHERE loop_id = ? AND outcome = ?
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT ?
      `).all(loopId, outcome, max)
    : store.db.prepare(`
        SELECT * FROM directive_outcomes
        WHERE loop_id = ?
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT ?
      `).all(loopId, max);
  return rows.map(parseDirectiveOutcomeRow);
}

export function getDirectiveOutcomeSummary(store, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID } = {}) {
  const rows = store.db.prepare(`
    SELECT directive_id, outcome, recorded_at
    FROM directive_outcome_latest
    WHERE loop_id = ?
    ORDER BY observed_at DESC, recorded_at DESC
  `).all(loopId);
  const counts = {};
  for (const row of rows) counts[String(row.outcome)] = (counts[String(row.outcome)] ?? 0) + 1;
  return {
    schema: 'narada.site_operating_loop.directive_outcome_summary.v1',
    loop_id: loopId,
    counts,
    latest_count: rows.length,
  };
}

export function acquireLoopLock(store, {
  loopId,
  runId,
  ownerId = DEFAULT_SITE_OPERATING_LOOP_OWNER_ID,
  ttlMs = 5 * 60 * 1000,
  now = new Date(),
} = {}) {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const existing = store.db.prepare('SELECT * FROM site_loop_locks WHERE loop_id = ?').get(loopId);
    if (!existing) {
      store.db.prepare(`
        INSERT INTO site_loop_locks (loop_id, run_id, owner_id, acquired_at, expires_at, stale_recovery_count, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(loopId, runId, ownerId, nowIso, expiresAt, nowIso);
      store.db.exec('COMMIT');
      return { status: 'acquired', schema: 'narada.site_operating_loop.lock.v1', loop_id: loopId, run_id: runId, expires_at: expiresAt };
    }

    if (String(existing.expires_at) > nowIso) {
      store.db.exec('COMMIT');
      return {
        status: 'contended',
        schema: 'narada.site_operating_loop.lock.v1',
        loop_id: loopId,
        run_id: runId,
        active_run_id: String(existing.run_id),
        owner_id: String(existing.owner_id),
        expires_at: String(existing.expires_at),
      };
    }

    const staleRecoveryCount = Number(existing.stale_recovery_count ?? 0) + 1;
    store.db.prepare(`
      UPDATE site_loop_locks
      SET run_id = ?, owner_id = ?, acquired_at = ?, expires_at = ?, stale_recovery_count = ?, updated_at = ?
      WHERE loop_id = ?
    `).run(runId, ownerId, nowIso, expiresAt, staleRecoveryCount, nowIso, loopId);
    store.db.exec('COMMIT');
    return {
      status: 'stale_recovered',
      schema: 'narada.site_operating_loop.lock.v1',
      loop_id: loopId,
      run_id: runId,
      previous_run_id: String(existing.run_id),
      previous_expires_at: String(existing.expires_at),
      expires_at: expiresAt,
      stale_recovery_count: staleRecoveryCount,
    };
  } catch (error) {
    try {
      store.db.exec('ROLLBACK');
    } catch {
      // Preserve original lock acquisition error.
    }
    throw error;
  }
}

export function releaseLoopLock(store, { loopId, runId } = {}) {
  const row = store.db.prepare('SELECT run_id FROM site_loop_locks WHERE loop_id = ?').get(loopId);
  if (!row) return { status: 'not_held', loop_id: loopId, run_id: runId };
  if (String(row.run_id) !== runId) {
    return { status: 'not_owner', loop_id: loopId, run_id: runId, active_run_id: String(row.run_id) };
  }
  store.db.prepare('DELETE FROM site_loop_locks WHERE loop_id = ? AND run_id = ?').run(loopId, runId);
  return { status: 'released', loop_id: loopId, run_id: runId };
}

export function getLoopLock(store, loopId) {
  const row = store.db.prepare('SELECT * FROM site_loop_locks WHERE loop_id = ?').get(loopId);
  if (!row) return null;
  return {
    schema: 'narada.site_operating_loop.lock.v1',
    loop_id: String(row.loop_id),
    run_id: String(row.run_id),
    owner_id: String(row.owner_id),
    acquired_at: String(row.acquired_at),
    expires_at: String(row.expires_at),
    stale_recovery_count: Number(row.stale_recovery_count ?? 0),
    updated_at: String(row.updated_at),
  };
}

export function recordLoopHealthSuccess(store, { loopId, runId, at = new Date().toISOString() } = {}) {
  store.db.prepare(`
    INSERT INTO site_loop_health (
      loop_id, status, consecutive_failures, last_successful_run_id, last_success_at,
      last_run_id, last_run_at, failing_step, last_error_json, updated_at
    ) VALUES (?, 'healthy', 0, ?, ?, ?, ?, NULL, NULL, ?)
    ON CONFLICT(loop_id) DO UPDATE SET
      status = 'healthy',
      consecutive_failures = 0,
      last_successful_run_id = excluded.last_successful_run_id,
      last_success_at = excluded.last_success_at,
      last_run_id = excluded.last_run_id,
      last_run_at = excluded.last_run_at,
      failing_step = NULL,
      last_error_json = NULL,
      updated_at = excluded.updated_at
  `).run(loopId, runId, at, runId, at, at);
  return getLoopHealth(store, loopId);
}

export function recordLoopHealthFailure(store, {
  loopId,
  runId,
  failingStep = null,
  error = null,
  forcedStatus = null,
  at = new Date().toISOString(),
} = {}) {
  const previous = getLoopHealth(store, loopId);
  const consecutiveFailures = Number(previous?.consecutive_failures ?? 0) + 1;
  const status = forcedStatus ?? (consecutiveFailures >= 3 ? 'critical' : 'degraded');
  store.db.prepare(`
    INSERT INTO site_loop_health (
      loop_id, status, consecutive_failures, last_successful_run_id, last_success_at,
      last_run_id, last_run_at, failing_step, last_error_json, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(loop_id) DO UPDATE SET
      status = excluded.status,
      consecutive_failures = excluded.consecutive_failures,
      last_run_id = excluded.last_run_id,
      last_run_at = excluded.last_run_at,
      failing_step = excluded.failing_step,
      last_error_json = excluded.last_error_json,
      updated_at = excluded.updated_at
  `).run(loopId, status, consecutiveFailures, runId, at, failingStep, stringifyJson(error), at);
  return getLoopHealth(store, loopId);
}

export function getLoopHealth(store, loopId) {
  const row = store.db.prepare('SELECT * FROM site_loop_health WHERE loop_id = ?').get(loopId);
  const attention = getLoopAttentionSummary(store, { loopId });
  const unresolvedBacklog = getLoopUnresolvedBacklogSummary(store, { loopId });
  const directiveOutcomes = getDirectiveOutcomeSummary(store, { loopId });
  if (!row) {
    return {
      schema: 'narada.site_operating_loop.health.v1',
      loop_id: loopId,
      status: 'unknown',
      consecutive_failures: 0,
      attention,
      unresolved_backlog: unresolvedBacklog,
      directive_outcomes: directiveOutcomes,
    };
  }
  const storedStatus = String(row.status);
  const effectiveStatus = storedStatus === 'healthy' && (attention.open_count > 0 || unresolvedBacklog.unresolved_count > 0) ? 'degraded' : storedStatus;
  return {
    schema: 'narada.site_operating_loop.health.v1',
    loop_id: String(row.loop_id),
    status: effectiveStatus,
    stored_status: storedStatus,
    consecutive_failures: Number(row.consecutive_failures ?? 0),
    last_successful_run_id: row.last_successful_run_id ? String(row.last_successful_run_id) : null,
    last_success_at: row.last_success_at ? String(row.last_success_at) : null,
    last_run_id: row.last_run_id ? String(row.last_run_id) : null,
    last_run_at: row.last_run_at ? String(row.last_run_at) : null,
    failing_step: row.failing_step ? String(row.failing_step) : null,
    last_error: parseJson(row.last_error_json),
    updated_at: String(row.updated_at),
    attention,
    unresolved_backlog: unresolvedBacklog,
    directive_outcomes: directiveOutcomes,
  };
}

export function beginLoopRun(store, run) {
  store.db.prepare(`
    INSERT INTO site_loop_runs (run_id, loop_id, status, dry_run, started_at, summary_json, error_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.run_id,
    run.loop_id,
    run.status,
    run.dry_run ? 1 : 0,
    run.started_at,
    stringifyJson(run.summary ?? null),
    stringifyJson(run.error ?? null),
  );
}

export function finishLoopRun(store, runId, { status, finished_at, summary = null, error = null }) {
  store.db.prepare(`
    UPDATE site_loop_runs
    SET status = ?, finished_at = ?, summary_json = ?, error_json = ?
    WHERE run_id = ?
  `).run(status, finished_at, stringifyJson(summary), stringifyJson(error), runId);
}

export function recordLoopStep(store, step) {
  store.db.prepare(`
    INSERT INTO site_loop_step_runs (
      step_run_id, run_id, step_id, status, started_at, finished_at,
      input_refs_json, output_refs_json, evidence_json, error_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    step.step_run_id,
    step.run_id,
    step.step_id,
    step.status,
    step.started_at,
    step.finished_at,
    stringifyJson(step.input_refs ?? []),
    stringifyJson(step.output_refs ?? []),
    stringifyJson(step.evidence ?? null),
    stringifyJson(step.error ?? null),
  );
}

export function listLoopRuns(store, { limit = 10, loopId = null } = {}) {
  const rows = loopId
    ? store.db.prepare(`
        SELECT * FROM site_loop_runs
        WHERE loop_id = ?
        ORDER BY started_at DESC
        LIMIT ?
      `).all(loopId, limit)
    : store.db.prepare(`
        SELECT * FROM site_loop_runs
        ORDER BY started_at DESC
        LIMIT ?
      `).all(limit);
  return rows.map(parseRunRow);
}

export function getLoopRun(store, runId) {
  const run = store.db.prepare('SELECT * FROM site_loop_runs WHERE run_id = ?').get(runId);
  if (!run) return null;
  const steps = store.db.prepare(`
    SELECT * FROM site_loop_step_runs
    WHERE run_id = ?
    ORDER BY rowid ASC
  `).all(runId).map(parseStepRow);
  return { ...parseRunRow(run), steps };
}

export function getLoopStatus(store, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID } = {}) {
  const latest = store.db.prepare(`
    SELECT * FROM site_loop_runs
    WHERE loop_id = ?
    ORDER BY started_at DESC
    LIMIT 1
  `).get(loopId);
  const counts = store.db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM site_loop_runs
    WHERE loop_id = ?
    GROUP BY status
  `).all(loopId);
  return {
    schema: 'narada.site_operating_loop.status.v1',
    loop_id: loopId,
    latest: latest ? parseRunRow(latest) : null,
    counts: Object.fromEntries(counts.map((row) => [row.status, row.count])),
    health: getLoopHealth(store, loopId),
    lock: getLoopLock(store, loopId),
    control: getLoopControl(store, loopId),
    attention: getLoopAttentionSummary(store, { loopId }),
    directive_outcomes: getDirectiveOutcomeSummary(store, { loopId }),
  };
}

export function getLoopControl(store, loopId) {
  const row = store.db.prepare('SELECT * FROM site_loop_control WHERE loop_id = ?').get(loopId);
  if (!row) {
    return {
      schema: 'narada.site_operating_loop.control.v1',
      loop_id: loopId,
      paused: false,
      mode: 'running',
      reason: null,
      updated_at: null,
    };
  }
  return {
    schema: 'narada.site_operating_loop.control.v1',
    loop_id: String(row.loop_id),
    paused: Boolean(row.paused),
    mode: String(row.mode),
    reason: row.reason ? String(row.reason) : null,
    updated_at: String(row.updated_at),
  };
}

export function setLoopControl(store, { loopId, paused = false, mode = paused ? 'paused' : 'running', reason = null, at = new Date().toISOString() } = {}) {
  store.db.prepare(`
    INSERT INTO site_loop_control (loop_id, paused, mode, reason, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(loop_id) DO UPDATE SET
      paused = excluded.paused,
      mode = excluded.mode,
      reason = excluded.reason,
      updated_at = excluded.updated_at
  `).run(loopId, paused ? 1 : 0, mode, reason, at);
  return getLoopControl(store, loopId);
}

export function recordLoopClassificationObservation(store, { loopId, directiveId, classification, observation, at = new Date().toISOString() } = {}) {
  const observationId = `loopobs_${hashStable({ loopId, directiveId, classification, at }).slice(0, 32)}`;
  store.db.prepare(`
    INSERT OR IGNORE INTO site_loop_classification_observations (
      observation_id, loop_id, directive_id, classification, observed_at, observation_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(observationId, loopId, directiveId, classification, at, stringifyJson(observation));
  return { observation_id: observationId, loop_id: loopId, directive_id: directiveId, classification, observed_at: at };
}

export function countRecentLoopClassificationObservations(store, { loopId, directiveId, classification, limit = 3 } = {}) {
  const rows = store.db.prepare(`
    SELECT observation_id
    FROM site_loop_classification_observations
    WHERE loop_id = ? AND directive_id = ? AND classification = ?
    ORDER BY observed_at DESC
    LIMIT ?
  `).all(loopId, directiveId, classification, limit);
  return rows.length;
}

export function countRecentConsecutiveLoopClassificationObservations(store, { loopId, directiveId, classification, limit = 3 } = {}) {
  const rows = store.db.prepare(`
    SELECT classification
    FROM site_loop_classification_observations
    WHERE loop_id = ? AND directive_id = ?
    ORDER BY observed_at DESC
    LIMIT ?
  `).all(loopId, directiveId, limit);
  let count = 0;
  for (const row of rows) {
    if (String(row.classification) !== classification) break;
    count += 1;
  }
  return count;
}

export function getLoopEscalation(store, { loopId, directiveId, classification } = {}) {
  const row = store.db.prepare(`
    SELECT * FROM site_loop_escalations
    WHERE loop_id = ? AND directive_id = ? AND classification = ?
  `).get(loopId, directiveId, classification);
  if (!row) return null;
  return {
    escalation_id: String(row.escalation_id),
    loop_id: String(row.loop_id),
    directive_id: String(row.directive_id),
    classification: String(row.classification),
    status: String(row.status),
    envelope_id: row.envelope_id ? String(row.envelope_id) : null,
    created_at: String(row.created_at),
    acknowledged_at: row.acknowledged_at ? String(row.acknowledged_at) : null,
    acknowledged_by: row.acknowledged_by ? String(row.acknowledged_by) : null,
    ack_reason: row.ack_reason ? String(row.ack_reason) : null,
    escalation: parseJson(row.escalation_json),
  };
}

export function recordLoopEscalation(store, { loopId, directiveId, classification, envelopeId, escalation, at = new Date().toISOString() } = {}) {
  const escalationId = `loopesc_${hashStable({ loopId, directiveId, classification }).slice(0, 32)}`;
  const escalationJson = stringifyJson(escalation);
  store.db.prepare(`
    INSERT OR IGNORE INTO site_loop_escalations (
      escalation_id, loop_id, directive_id, classification, status, envelope_id, created_at, escalation_json
    ) VALUES (?, ?, ?, ?, 'opened', ?, ?, ?)
  `).run(escalationId, loopId, directiveId, classification, envelopeId ?? null, at, escalationJson);
  store.db.prepare(`
    UPDATE site_loop_escalations
    SET envelope_id = COALESCE(envelope_id, ?),
        escalation_json = ?
    WHERE escalation_id = ? AND status = 'opened'
  `).run(envelopeId ?? null, escalationJson, escalationId);
  store.db.prepare(`
    UPDATE site_loop_escalations
    SET status = 'opened',
        envelope_id = COALESCE(envelope_id, ?),
        escalation_json = ?,
        acknowledged_at = NULL,
        acknowledged_by = NULL,
        ack_reason = NULL
    WHERE escalation_id = ? AND status = 'acknowledged'
  `).run(envelopeId ?? null, escalationJson, escalationId);
  return getLoopEscalation(store, { loopId, directiveId, classification });
}

export function listLoopAttention(store, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID, status = null, limit = 50 } = {}) {
  const max = Math.max(1, Math.min(500, Number(limit ?? 50)));
  const clauses = ['loop_id = ?'];
  const params = [loopId];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  params.push(max);
  const rows = store.db.prepare(`
    SELECT * FROM site_loop_escalations
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, escalation_id DESC
    LIMIT ?
  `).all(...params);
  return rows.map(parseEscalationRow);
}

export function getLoopAttention(store, { attentionId } = {}) {
  const row = store.db.prepare(`
    SELECT * FROM site_loop_escalations
    WHERE envelope_id = ? OR escalation_id = ?
    LIMIT 1
  `).get(attentionId, attentionId);
  return row ? parseEscalationRow(row) : null;
}

export function acknowledgeLoopAttention(store, {
  attentionId,
  reason,
  acknowledgedBy = 'operator',
  at = new Date().toISOString(),
} = {}) {
  const existing = getLoopAttention(store, { attentionId });
  if (!existing) return { status: 'not_found', attention_id: attentionId };
  store.db.prepare(`
    UPDATE site_loop_escalations
    SET status = 'acknowledged',
        acknowledged_at = ?,
        acknowledged_by = ?,
        ack_reason = ?
    WHERE escalation_id = ?
  `).run(at, acknowledgedBy, reason ?? null, existing.escalation_id);
  return { status: 'acknowledged', attention: getLoopAttention(store, { attentionId }) };
}

export function getLoopAttentionSummary(store, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID } = {}) {
  const rows = store.db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM site_loop_escalations
    WHERE loop_id = ?
    GROUP BY status
  `).all(loopId);
  const counts = Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count ?? 0)]));
  const severityRows = store.db.prepare(`
    SELECT escalation_json
    FROM site_loop_escalations
    WHERE loop_id = ? AND status = 'opened'
  `).all(loopId);
  const openBySeverity = {};
  for (const row of severityRows) {
    const escalation = parseJson(row.escalation_json);
    const severity = String(escalation?.severity ?? 'warning');
    openBySeverity[severity] = (openBySeverity[severity] ?? 0) + 1;
  }
  return {
    schema: 'narada.site_operating_loop.attention_summary.v1',
    loop_id: loopId,
    counts,
    open_count: Number(counts.opened ?? 0),
    acknowledged_count: Number(counts.acknowledged ?? 0),
    open_by_severity: openBySeverity,
  };
}

export function getLoopUnresolvedBacklogSummary(store, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID } = {}) {
  const unresolvedStatuses = new Set(['received', 'carrier_accepted', 'delivery_stale', 'action_stale', 'blocked_no_carrier']);
  const rows = store.db.prepare(`
    SELECT directive_id, outcome, observed_at, recorded_at
    FROM directive_outcome_latest
    WHERE loop_id = ?
    ORDER BY observed_at DESC, recorded_at DESC
  `).all(loopId);
  const unresolved = rows
    .map((row) => ({
      directive_id: String(row.directive_id),
      status: String(row.outcome),
      observed_at: String(row.observed_at ?? row.recorded_at),
    }))
    .filter((item) => unresolvedStatuses.has(item.status));
  const counts = {};
  for (const item of unresolved) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return {
    schema: 'narada.site_operating_loop.unresolved_backlog_summary.v1',
    loop_id: loopId,
    unresolved_count: unresolved.length,
    counts,
    directives: unresolved,
  };
}

export function resolveDirectiveOutcome(store, {
  loopId = DEFAULT_SITE_OPERATING_LOOP_ID,
  directiveId,
  reason = 'operator_cleanup',
  resolvedBy = 'operator',
  at = new Date().toISOString(),
} = {}) {
  if (!directiveId) {
    return { schema: 'narada.site_operating_loop.directive_outcome_resolve.v1', status: 'refused', reason: 'directive_id_required' };
  }
  const existing = getLatestDirectiveOutcome(store, { loopId, directiveId });
  if (!existing) {
    return { schema: 'narada.site_operating_loop.directive_outcome_resolve.v1', status: 'not_found', loop_id: loopId, directive_id: directiveId };
  }
  const outcome = recordDirectiveOutcome(store, {
    loopId,
    directiveId,
    outcome: 'superseded',
    agentId: existing.agent_id ?? null,
    taskId: existing.task_id ?? null,
    reportId: existing.report_id ?? null,
    receiptId: existing.receipt_id ?? null,
    reason,
    evidence: {
      schema: 'narada.site_operating_loop.directive_outcome_resolution.v1',
      previous_outcome: existing,
      resolved_by: resolvedBy,
      reason,
    },
    eventAt: at,
    observedAt: at,
    recordedAt: at,
  });
  return {
    schema: 'narada.site_operating_loop.directive_outcome_resolve.v1',
    status: 'resolved',
    loop_id: loopId,
    directive_id: directiveId,
    previous_outcome: existing.outcome,
    outcome,
  };
}

function parseDirectiveOutcomeRow(row) {
  return {
    schema: 'narada.site_operating_loop.directive_outcome.v1',
    outcome_id: String(row.outcome_id),
    loop_id: String(row.loop_id),
    directive_id: String(row.directive_id),
    outcome: String(row.outcome),
    agent_id: row.agent_id ? String(row.agent_id) : null,
    task_id: row.task_id ? String(row.task_id) : null,
    report_id: row.report_id ? String(row.report_id) : null,
    receipt_id: row.receipt_id ? String(row.receipt_id) : null,
    reason: row.reason ? String(row.reason) : null,
    event_at: row.event_at ? String(row.event_at) : null,
    observed_at: row.observed_at ? String(row.observed_at) : String(row.recorded_at),
    recorded_at: String(row.recorded_at),
    evidence: parseJson(row.evidence_json),
  };
}

function backfillDirectiveOutcomeLatest(db) {
  const rows = db.prepare(`
    SELECT * FROM directive_outcomes
    ORDER BY COALESCE(observed_at, recorded_at) ASC, recorded_at ASC, rowid ASC
  `).all();
  for (const row of rows) {
    upsertDirectiveOutcomeLatest(db, {
      ...row,
      event_at: row.event_at ?? row.recorded_at,
      observed_at: row.observed_at ?? row.recorded_at,
    });
  }
}

function upsertDirectiveOutcomeLatest(db, row) {
  const existing = db.prepare(`
    SELECT outcome, observed_at, recorded_at
    FROM directive_outcome_latest
    WHERE loop_id = ? AND directive_id = ?
  `).get(row.loop_id, row.directive_id);
  if (existing && compareOutcomeLatest(row, existing) < 0) return;
  db.prepare(`
    INSERT INTO directive_outcome_latest (
      loop_id, directive_id, outcome_id, outcome, agent_id, task_id, report_id,
      receipt_id, reason, event_at, observed_at, recorded_at, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(loop_id, directive_id) DO UPDATE SET
      outcome_id = excluded.outcome_id,
      outcome = excluded.outcome,
      agent_id = excluded.agent_id,
      task_id = excluded.task_id,
      report_id = excluded.report_id,
      receipt_id = excluded.receipt_id,
      reason = excluded.reason,
      event_at = excluded.event_at,
      observed_at = excluded.observed_at,
      recorded_at = excluded.recorded_at,
      evidence_json = excluded.evidence_json
  `).run(
    row.loop_id,
    row.directive_id,
    row.outcome_id,
    row.outcome,
    row.agent_id ?? null,
    row.task_id ?? null,
    row.report_id ?? null,
    row.receipt_id ?? null,
    row.reason ?? null,
    row.event_at ?? row.recorded_at,
    row.observed_at ?? row.recorded_at,
    row.recorded_at,
    row.evidence_json,
  );
}

function compareOutcomeLatest(next, existing) {
  const nextObserved = Date.parse(next.observed_at ?? next.recorded_at ?? '');
  const existingObserved = Date.parse(existing.observed_at ?? existing.recorded_at ?? '');
  if (Number.isFinite(nextObserved) && Number.isFinite(existingObserved) && nextObserved !== existingObserved) {
    return nextObserved > existingObserved ? 1 : -1;
  }
  const nextRank = outcomePrecedence(next.outcome);
  const existingRank = outcomePrecedence(existing.outcome);
  if (nextRank !== existingRank) return nextRank > existingRank ? 1 : -1;
  const nextRecorded = Date.parse(next.recorded_at ?? '');
  const existingRecorded = Date.parse(existing.recorded_at ?? '');
  if (Number.isFinite(nextRecorded) && Number.isFinite(existingRecorded) && nextRecorded !== existingRecorded) {
    return nextRecorded > existingRecorded ? 1 : -1;
  }
  return 0;
}

function outcomePrecedence(outcome) {
  return {
    pending: 10,
    leased: 20,
    delivery_stale: 30,
    blocked_no_carrier: 35,
    received: 40,
    carrier_accepted: 45,
    action_stale: 50,
    accepted: 60,
    refused: 80,
    reported: 90,
    superseded: 100,
  }[String(outcome)] ?? 0;
}

function parseEscalationRow(row) {
  const escalation = parseJson(row.escalation_json);
  return {
    schema: 'narada.site_operating_loop.attention.v1',
    attention_id: row.envelope_id ? String(row.envelope_id) : String(row.escalation_id),
    escalation_id: String(row.escalation_id),
    loop_id: String(row.loop_id),
    directive_id: String(row.directive_id),
    classification: String(row.classification),
    status: String(row.status),
    envelope_id: row.envelope_id ? String(row.envelope_id) : null,
    created_at: String(row.created_at),
    acknowledged_at: row.acknowledged_at ? String(row.acknowledged_at) : null,
    acknowledged_by: row.acknowledged_by ? String(row.acknowledged_by) : null,
    ack_reason: row.ack_reason ? String(row.ack_reason) : null,
    severity: escalation?.severity ?? 'warning',
    escalation,
  };
}

function ensureColumn(db, table, column, type, repairs = null) {
  if (!tableExists(db, table)) return;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (columns.includes(column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  repairs?.push({ kind: 'column_added', table, column, type });
}

function tableExists(db, table) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table);
  return Boolean(row);
}

function parseRunRow(row) {
  return {
    run_id: row.run_id,
    loop_id: row.loop_id,
    status: row.status,
    dry_run: Boolean(row.dry_run),
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    summary: parseJson(row.summary_json),
    error: parseJson(row.error_json),
  };
}

function parseStepRow(row) {
  return {
    step_run_id: row.step_run_id,
    run_id: row.run_id,
    step_id: row.step_id,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    input_refs: parseJson(row.input_refs_json) ?? [],
    output_refs: parseJson(row.output_refs_json) ?? [],
    evidence: parseJson(row.evidence_json),
    error: parseJson(row.error_json),
  };
}

function stringifyJson(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hashStable(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
