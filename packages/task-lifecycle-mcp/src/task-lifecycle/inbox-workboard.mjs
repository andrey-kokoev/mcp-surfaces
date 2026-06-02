/**
 * Inbox workboard — surface unprocessed envelopes as first-class work items.
 */

import { readIndexedInboxBacklog } from '../inbox/inbox-index.mjs';
import { hasEnvelopeCoverageEvidence } from '../inbox/inbox-policy.mjs';
import { evaluateEnvelopeSeverity } from './inbox-bridge.mjs';

function findExactLinkedTask(store, envelope) {
  if (!store || !envelope?.envelope_id) return null;
  const envelopeId = envelope.envelope_id;

  if (store.getTaskByEnvelopeId) {
    const mapping = store.getTaskByEnvelopeId(envelopeId);
    if (mapping) {
      const lifecycle = store.db.prepare('SELECT status FROM task_lifecycle WHERE task_id = ?').get(mapping.task_id);
      return {
        task_id: mapping.task_id,
        task_number: Number(mapping.task_number),
        status: lifecycle?.status ?? null,
        match_type: 'mapping_table',
      };
    }
  }

  if (envelopeId.length < 8) return null;

  const row = store.db.prepare(`
    SELECT s.task_id, s.task_number, s.context_markdown, s.goal_markdown,
           s.required_work_markdown, s.non_goals_markdown, l.status
    FROM task_specs s
    INNER JOIN task_lifecycle l ON s.task_id = l.task_id
    WHERE instr(COALESCE(s.context_markdown, ''), ?) > 0
    ORDER BY s.task_number ASC
  `).all(envelopeId).find((candidate) => hasEnvelopeCoverageEvidence(candidate, envelopeId));

  if (!row) return null;
  return {
    task_id: row.task_id,
    task_number: Number(row.task_number),
    status: row.status ?? null,
    match_type: 'envelope_id_in_context',
  };
}

export function buildInboxWorkboard(siteRoot, { store } = {}) {
  const index = readIndexedInboxBacklog(siteRoot, { evaluateEnvelopeSeverity });
  const rows = index.rows;
  const backlog = [];
  const linkedTaskSuppressed = [];
  let highSeverity = 0;

  for (const row of rows) {
    const envelope = row.envelope;
    const linkedTask = findExactLinkedTask(store, envelope);
    const item = {
      envelope_id: row.envelope_id,
      kind: row.kind,
      authority_level: row.authority_level,
      title: row.title,
      summary: row.summary,
      principal: row.principal,
      source_ref: row.source_ref,
      received_at: row.received_at,
      severity: row.severity ?? 0,
      severity_reason: row.severity_reason,
      target_role: row.target_role,
      action: row.action,
    };
    if (linkedTask) {
      linkedTaskSuppressed.push({
        ...item,
        linked_task: linkedTask,
      });
      continue;
    }
    backlog.push(item);
    if (item.severity >= 70) {
      highSeverity++;
    }
  }

  // Sort by severity descending, then by received_at ascending (oldest first)
  backlog.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    return (a.received_at ?? '').localeCompare(b.received_at ?? '');
  });

  return {
    backlog,
    highSeverity,
    index: {
      authority: 'sqlite_projection',
      db_path: index.db_path,
      indexed_count: index.indexed_count,
      invalid_count: index.invalid_count ?? 0,
      invalid_records: index.invalid_records ?? [],
      refreshed_at: index.refreshed_at,
      source_records: 'append_only_envelope_json_preserved',
      freshness_strategy: 'restart_mcp_after_projection_code_change',
    },
    counts: {
      total: backlog.length,
      high_severity: highSeverity,
      incidents: backlog.filter((e) => e.kind === 'incident').length,
      capa_requests: backlog.filter((e) => e.action === 'review_capa_request').length,
      observations: backlog.filter((e) => e.kind === 'observation').length,
      proposals: backlog.filter((e) => e.kind === 'proposal').length,
      linked_task_suppressed: linkedTaskSuppressed.length,
    },
    linked_task_suppressed: linkedTaskSuppressed,
  };
}
