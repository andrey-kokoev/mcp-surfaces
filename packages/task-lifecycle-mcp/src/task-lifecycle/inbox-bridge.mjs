/**
 * Inbox-to-Task-Lifecycle Bridge
 *
 * Evaluates unprocessed inbox envelopes and materializes high-severity items
 * as claimable tasks. Implements Phase 2 of the inbox-visibility-bridge
 * architecture.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { allocateTaskNumbers } from '@narada2/task-governance-core/task-governance';
import { renderTaskBodyFromSpec } from '@narada2/task-governance-core/task-spec';
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import { readAdmissionLog, getLatestEventsByEnvelope, appendAdmissionEvent, acknowledgeEnvelope, dismissEnvelope } from '../inbox/admission-log.mjs';
import {
  evaluateEnvelopeSeverity,
  findDuplicateTaskRows,
  hasEnvelopeCoverageEvidence,
  levenshteinDistance,
} from '../inbox/inbox-policy.mjs';

const INBOX_DIR = '.ai/inbox-envelopes';
const TASKS_DIR = '.ai/do-not-open/tasks';

const AUTO_MATERIALIZE_THRESHOLD = 50;

export { evaluateEnvelopeSeverity, levenshteinDistance };

const OWNERSHIP_FIELD_PRECEDENCE = [
  'preferred_agent_id',
  'assigned_agent_id',
  'responsible_agent_id',
  'owner',
];
const ROLE_FIELD_PRECEDENCE = ['target_role', 'requested_role'];

function normalizedNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function looksLikeAgentId(value) {
  return Boolean(normalizedNonEmptyString(value)?.includes('.'));
}

function firstPayloadString(payload, fields, { requireAgentId = false } = {}) {
  for (const field of fields) {
    const value = normalizedNonEmptyString(payload?.[field]);
    if (!value) continue;
    if (requireAgentId && !looksLikeAgentId(value)) continue;
    return { field, value };
  }
  return null;
}

function resolveAgentRoleFromStore(store, agentId) {
  if (!store || !agentId) return null;
  try {
    const row = store.db.prepare('SELECT role FROM agent_roster WHERE agent_id = ?').get(agentId);
    return normalizedNonEmptyString(row?.role);
  } catch {
    return null;
  }
}

function ensureTaskRolePreferencesTable(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS narada_andrey_task_role_preferences (
      task_id TEXT PRIMARY KEY,
      preferred_role TEXT,
      target_role TEXT,
      preferred_agent_id TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  try {
    store.db.exec('ALTER TABLE narada_andrey_task_role_preferences ADD COLUMN target_role TEXT');
  } catch {
    // column already exists
  }
  try {
    store.db.exec('ALTER TABLE narada_andrey_task_role_preferences ADD COLUMN preferred_agent_id TEXT');
  } catch {
    // column already exists
  }
}

export function deriveRoutingFromEnvelopePayload(envelope, severityResult = {}, store = null) {
  const payload = envelope?.payload ?? {};
  const ownership = firstPayloadString(payload, OWNERSHIP_FIELD_PRECEDENCE, { requireAgentId: true });
  const explicitRole = firstPayloadString(payload, ROLE_FIELD_PRECEDENCE);
  const preferredAgentId = ownership?.value ?? null;
  const agentRole = resolveAgentRoleFromStore(store, preferredAgentId);
  let targetRole = explicitRole?.value ?? agentRole ?? severityResult.targetRole ?? null;
  const warnings = [];

  const ownershipValues = new Map();
  for (const field of OWNERSHIP_FIELD_PRECEDENCE) {
    const value = normalizedNonEmptyString(payload[field]);
    if (value && looksLikeAgentId(value)) ownershipValues.set(field, value);
  }
  const uniqueOwners = new Set(ownershipValues.values());
  if (uniqueOwners.size > 1) {
    warnings.push({
      kind: 'ambiguous_payload_ownership',
      selected_field: ownership?.field ?? null,
      selected_agent_id: preferredAgentId,
      fields: Object.fromEntries(ownershipValues),
    });
  }

  if (explicitRole?.value && agentRole && explicitRole.value !== agentRole) {
    warnings.push({
      kind: 'payload_role_agent_role_mismatch',
      target_role_field: explicitRole.field,
      target_role: explicitRole.value,
      preferred_agent_id: preferredAgentId,
      resolved_agent_role: agentRole,
    });
    targetRole = explicitRole.value;
  }

  return {
    targetRole,
    preferredAgentId,
    source: {
      targetRoleField: explicitRole?.field ?? (agentRole ? 'agent_roster' : 'severity_result'),
      preferredAgentField: ownership?.field ?? null,
      resolvedAgentRole: agentRole,
    },
    warnings,
  };
}

/**
 * Check whether an envelope already has a corresponding open task.
 * Returns { isDuplicate, duplicateTaskId, duplicateTaskNumber, matchType }.
 */
export function checkDuplicateTask(store, envelope) {
  const envelopeId = envelope.envelope_id;
  const title = String(envelope.payload?.title ?? envelope.title ?? '').trim();

  // 1. Fast path: check durable envelope_task_mappings table
  if (envelopeId && store.getTaskByEnvelopeId) {
    const mapping = store.getTaskByEnvelopeId(envelopeId);
    if (mapping) {
      return {
        isDuplicate: true,
        duplicateTaskId: mapping.task_id,
        duplicateTaskNumber: mapping.task_number,
        matchType: 'mapping_table',
      };
    }
  }

  // 2. Scan ALL tasks (including closed and in_review) to prevent re-materialization
  // of envelopes that were already processed, regardless of final disposition.
  const sql = `
    SELECT s.task_id, s.task_number, s.title, s.context_markdown, s.goal_markdown,
           s.required_work_markdown, s.non_goals_markdown, l.status
    FROM task_specs s
    INNER JOIN task_lifecycle l ON s.task_id = l.task_id
  `;

  const rows = store.db.prepare(sql).all();

  for (const row of rows) {
    if (hasEnvelopeCoverageEvidence(row, envelopeId)) {
      return {
        isDuplicate: true,
        duplicateTaskId: row.task_id,
        duplicateTaskNumber: Number(row.task_number),
        matchType: 'envelope_id_in_context',
      };
    }
  }

  return findDuplicateTaskRows(rows, envelope);
}

/**
 * Build a task spec from an inbox envelope and severity evaluation.
 */
export function buildTaskSpecFromEnvelope(envelope, severityResult, options = {}) {
  const payload = envelope.payload ?? {};
  const title = `[From Inbox] ${payload.title ?? envelope.title ?? 'Untitled'}`;
  const goal = payload.summary ?? payload.description ?? '';
  const routing = options.routing ?? deriveRoutingFromEnvelopePayload(envelope, severityResult, options.store ?? null);

  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const proposals = Array.isArray(payload.proposal) ? payload.proposal : [];

  const contextLines = [
    `**Envelope ID:** ${envelope.envelope_id}`,
    `**Received:** ${envelope.received_at}`,
    `**Kind:** ${envelope.kind}`,
    `**Authority:** ${envelope.authority?.level ?? 'unknown'} (${envelope.authority?.principal ?? 'unknown'})`,
    `**Source:** ${envelope.source?.ref ?? 'unknown'}`,
  ];
  if (routing.preferredAgentId || routing.targetRole || routing.warnings.length > 0) {
    contextLines.push(
      '',
      '**Lifecycle Routing:**',
      JSON.stringify({
        target_role: routing.targetRole,
        preferred_agent_id: routing.preferredAgentId,
        source: routing.source,
        warnings: routing.warnings,
      }, null, 2)
    );
  }
  contextLines.push(
    '',
    '**Payload:**',
    JSON.stringify(payload, null, 2),
  );
  const context = contextLines.join('\n');

  const workItems = [];
  if (proposals.length > 0) {
    for (let i = 0; i < proposals.length; i++) {
      workItems.push(`${i + 1}. ${proposals[i]}`);
    }
  } else {
    workItems.push('1. Review envelope content and determine disposition');
  }
  const requiredWork = workItems.join('\n');

  const acceptanceCriteria = [];
  if (evidence.length > 0) {
    acceptanceCriteria.push('Review and acknowledge evidence');
  }
  if (proposals.length > 0) {
    for (const p of proposals) {
      acceptanceCriteria.push(`Address proposal: ${p}`);
    }
  }
  acceptanceCriteria.push('Submit disposition to inbox (acknowledge / dismiss / escalate)');

  const nonGoals = 'Do not leave envelope in unprocessed state';

  return {
    title,
    goal,
    context,
    requiredWork,
    nonGoals,
    acceptanceCriteria,
    preferredRole: routing.targetRole,
    targetRole: routing.targetRole,
    preferredAgentId: routing.preferredAgentId,
    routingWarnings: routing.warnings,
    routingSource: routing.source,
    relativePriority: severityResult.relativePriority ?? severityResult.severity ?? 0,
    priorityReason: severityResult.reason,
  };
}

/**
 * Build the read-side bridge decision before any write-side effects run.
 * Outcome statuses are intentionally effect-free:
 * - ignored: severity/action says not to materialize
 * - duplicate: an existing task/mapping already covers the envelope
 * - materializable: write-side handler may create a task and mark the envelope
 */
export function decideEnvelopeBridgeOutcome({ store, envelope, severityResult, dryRun = false }) {
  const routing = deriveRoutingFromEnvelopePayload(envelope, severityResult, store);
  const base = {
    schema: 'narada.bridge.outcome.v0',
    envelopeId: envelope.envelope_id,
    kind: envelope.kind,
    severity: severityResult.severity,
    action: severityResult.action,
    targetRole: routing.targetRole,
    preferredAgentId: routing.preferredAgentId,
    routingSource: routing.source,
    routingWarnings: routing.warnings,
    reason: severityResult.reason ?? null,
  };

  if (severityResult.action !== 'materialize') {
    return {
      ...base,
      status: 'ignored',
      outcome: 'ignored',
    };
  }

  const dupCheck = checkDuplicateTask(store, envelope);
  if (dupCheck.isDuplicate) {
    return {
      ...base,
      status: 'duplicate',
      outcome: 'duplicate',
      duplicateTaskId: dupCheck.duplicateTaskId,
      duplicateTaskNumber: dupCheck.duplicateTaskNumber,
      matchType: dupCheck.matchType,
    };
  }

  return {
    ...base,
    status: 'materializable',
    outcome: dryRun ? 'dry_run_materializable' : 'materializable',
    dryRun,
    wouldCreate: true,
  };
}

export function summarizeBridgeOutcome(outcome) {
  return {
    envelopeId: outcome.envelopeId,
    kind: outcome.kind,
    severity: outcome.severity,
    action: outcome.action,
    targetRole: outcome.targetRole,
    preferredAgentId: outcome.preferredAgentId,
    routingWarnings: outcome.routingWarnings,
    outcome: outcome.outcome,
    status: outcome.status,
  };
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Materialize a single inbox envelope as a task.
 * Returns { status, taskNumber?, taskId?, filePath?, error?, envelopeId? }.
 */
export async function materializeEnvelopeAsTask(cwd, envelope) {
  const severityResult = evaluateEnvelopeSeverity(envelope);
  if (severityResult.action !== 'materialize') {
    return {
      status: 'skipped_not_materializable',
      envelopeId: envelope.envelope_id,
      severity: severityResult.severity,
      action: severityResult.action,
    };
  }

  const store = openTaskLifecycleStore(cwd);
  const routing = deriveRoutingFromEnvelopePayload(envelope, severityResult, store);
  const spec = buildTaskSpecFromEnvelope(envelope, severityResult, { routing });
  const taskNumber = (await allocateTaskNumbers(cwd, 1))[0];
  const slug = slugify(spec.title);
  const taskId = `${todayYmd()}-${taskNumber}-${slug}`;
  const tasksDir = join(resolve(cwd), TASKS_DIR);
  const filePath = join(tasksDir, `${taskId}.md`);

  // Extract proposal content from envelope payload to seed Execution Notes
  const payload = envelope.payload ?? {};
  const proposals = Array.isArray(payload.proposal) ? payload.proposal : [];
  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  let executionNotes = null;
  if (proposals.length > 0 || evidence.length > 0) {
    const parts = [];
    if (evidence.length > 0) {
      parts.push('Evidence:', ...evidence.map((e) => `- ${e}`));
    }
    if (proposals.length > 0) {
      parts.push('Proposals:', ...proposals.map((p) => `- ${p}`));
    }
    executionNotes = parts.join('\n');
  }

  const body = renderTaskBodyFromSpec({
    spec: {
      title: spec.title,
      goal: spec.goal,
      context: spec.context,
      required_work: spec.requiredWork,
      non_goals: spec.nonGoals,
      acceptance_criteria: spec.acceptanceCriteria,
    },
    executionNotes,
    verification: null,
  });

  const frontMatterLines = [
    '---',
    `number: ${taskNumber}`,
    `governed_by: ${spec.preferredRole || 'unknown'}`,
    'status: opened',
  ];
  if (spec.preferredRole) {
    frontMatterLines.push(`preferred_role: ${spec.preferredRole}`);
    frontMatterLines.push(`target_role: ${spec.targetRole}`);
  }
  if (spec.preferredAgentId) {
    frontMatterLines.push(`preferred_agent_id: ${spec.preferredAgentId}`);
  }
  if (typeof spec.relativePriority === 'number') {
    frontMatterLines.push(`relative_priority: ${spec.relativePriority}`);
  }
  if (spec.priorityReason) {
    frontMatterLines.push(`priority_reason: ${spec.priorityReason}`);
  }
  frontMatterLines.push('---');

  const fileContent = `${frontMatterLines.join('\n')}\n${body}`;
  writeFileSync(filePath, fileContent, 'utf8');

  const now = new Date().toISOString();
  try {
    store.upsertLifecycle({
      task_id: taskId,
      task_number: taskNumber,
      status: 'opened',
      governed_by: spec.preferredRole || null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: now,
      relative_priority: spec.relativePriority ?? 0,
      priority_reason: spec.priorityReason ?? null,
    });
    store.upsertTaskSpec({
      task_id: taskId,
      task_number: taskNumber,
      title: spec.title,
      chapter_markdown: null,
      goal_markdown: spec.goal,
      context_markdown: spec.context,
      required_work_markdown: spec.requiredWork,
      non_goals_markdown: spec.nonGoals,
      acceptance_criteria_json: JSON.stringify(spec.acceptanceCriteria),
      dependencies_json: '[]',
      updated_at: now,
    });
    if (spec.preferredRole || spec.preferredAgentId) {
      ensureTaskRolePreferencesTable(store);
      store.db.prepare(`
        INSERT INTO narada_andrey_task_role_preferences (task_id, preferred_role, target_role, preferred_agent_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          preferred_role = excluded.preferred_role,
          target_role = excluded.target_role,
          preferred_agent_id = excluded.preferred_agent_id,
          updated_at = excluded.updated_at
      `).run(taskId, spec.preferredRole, spec.targetRole ?? spec.preferredRole, spec.preferredAgentId, now);
    }
  } finally {
    store.db.close();
  }

  return {
    status: 'materialized',
    envelopeId: envelope.envelope_id,
    taskNumber,
    taskId,
    filePath,
    severity: severityResult.severity,
    targetRole: spec.targetRole,
    preferredAgentId: spec.preferredAgentId,
    routingWarnings: spec.routingWarnings,
  };
}

/**
 * Update an envelope's status after materialization.
 *
 * Primary: append envelope_promoted event to admission log.
 * Fallback: rewrite filesystem JSON for backward compatibility.
 */
export function markEnvelopeMaterialized(cwd, envelope, taskNumber, taskId) {
  // Primary: append promotion event to admission log
  let logEvent = null;
  try {
    logEvent = appendAdmissionEvent(cwd, {
      event_kind: 'envelope_promoted',
      envelope_id: envelope.envelope_id,
      principal: 'inbox-bridge',
      authority_level: 'system_generated',
      payload_hash: null,
      payload_uri: null,
      promotion: {
        target_kind: 'task',
        target_ref: `task:${taskNumber}`,
        task_id: taskId,
        promoted_at: new Date().toISOString(),
        promoted_by: 'inbox-bridge',
      },
    });
  } catch {
    // Log append failed; continue with filesystem fallback
  }

  // Fallback: rewrite filesystem JSON for backward compatibility
  const envelopeDir = join(resolve(cwd), INBOX_DIR);
  const fileName = `${envelope.envelope_id}.json`;
  const filePath = join(envelopeDir, fileName);
  const altFilePath = join(envelopeDir, envelope.received_at
    ? `${envelope.received_at.replace(/[:.]/g, '-').replace('Z', 'Z')}-${fileName}`
    : fileName);

  let pathToUpdate = null;
  if (existsSync(filePath)) {
    pathToUpdate = filePath;
  } else if (existsSync(altFilePath)) {
    pathToUpdate = altFilePath;
  } else {
    const files = readdirSync(envelopeDir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      if (f.endsWith(fileName)) {
        pathToUpdate = join(envelopeDir, f);
        break;
      }
    }
  }

  if (pathToUpdate) {
    const updated = {
      ...envelope,
      status: 'promoted',
      promotion: {
        target_kind: 'task',
        target_ref: `task:${taskNumber}`,
        task_id: taskId,
        promoted_at: new Date().toISOString(),
        promoted_by: 'inbox-bridge',
      },
    };
    writeFileSync(pathToUpdate, JSON.stringify(updated, null, 2), 'utf8');
  }

  return {
    status: 'marked',
    envelopeId: envelope.envelope_id,
    path: pathToUpdate,
    log_event_id: logEvent?.event_id ?? null,
  };
}

export async function applyMaterializableBridgeOutcome({ cwd, store, envelope, outcome }) {
  if (outcome.status !== 'materializable') {
    return { status: 'not_materializable', outcome };
  }
  if (outcome.dryRun) {
    return {
      status: 'dry_run',
      envelopeId: envelope.envelope_id,
      severity: outcome.severity,
      targetRole: outcome.targetRole,
      preferredAgentId: outcome.preferredAgentId,
      routingWarnings: outcome.routingWarnings,
      wouldCreate: true,
      outcome,
    };
  }

  const result = await materializeEnvelopeAsTask(cwd, envelope);
  if (result.status !== 'materialized') {
    return {
      status: result.status,
      envelopeId: envelope.envelope_id,
      severity: result.severity,
      reason: result.status,
      outcome,
    };
  }

  const markResult = markEnvelopeMaterialized(cwd, envelope, result.taskNumber, result.taskId);
  let materializationEventId = null;
  try {
    const event = appendAdmissionEvent(cwd, {
      event_kind: 'bridge_materialized',
      envelope_id: envelope.envelope_id,
      principal: 'inbox-bridge',
      authority_level: 'system_generated',
      payload_hash: null,
      payload_uri: null,
      materialization: {
        task_number: result.taskNumber,
        task_id: result.taskId,
        severity: result.severity,
        target_role: result.targetRole,
        preferred_agent_id: result.preferredAgentId ?? null,
        routing_warnings: result.routingWarnings ?? [],
      },
    });
    materializationEventId = event?.event_id ?? null;
  } catch {
    // Non-blocking: log emission failure should not prevent materialization
  }

  let mappingWritten = false;
  let mappingError = null;
  try {
    store.upsertEnvelopeTaskMapping(
      envelope.envelope_id,
      result.taskId,
      result.taskNumber,
      new Date().toISOString()
    );
    mappingWritten = true;
  } catch (err) {
    mappingError = err instanceof Error ? err.message : String(err);
  }

  const committablePathSet = buildBridgeCommittablePathSet(cwd, result, markResult);
  return {
    status: 'materialized',
    envelopeId: envelope.envelope_id,
    taskNumber: result.taskNumber,
    taskId: result.taskId,
    severity: result.severity,
    targetRole: result.targetRole,
    preferredAgentId: result.preferredAgentId,
    routingWarnings: result.routingWarnings,
    markResult,
    materialization_event_id: materializationEventId,
    mapping_written: mappingWritten,
    mapping_error: mappingError,
    committable_path_set: committablePathSet,
    commit_ready: committablePathSet,
    outcome,
  };
}

function buildBridgeCommittablePathSet(cwd, materializeResult, markResult) {
  const taskPath = relativeSitePath(cwd, materializeResult.filePath);
  const envelopePath = markResult?.path ? relativeSitePath(cwd, markResult.path) : null;
  const ignoredEnvelopeProjectionPaths = envelopePath && envelopePath.startsWith(`${INBOX_DIR}/`) ? [envelopePath] : [];
  return {
    schema: 'narada.inbox_bridge.committable_path_set.v0',
    task_owned_paths: [taskPath],
    ordinary_task_closeout_paths: [taskPath],
    ignored_envelope_projection_paths: ignoredEnvelopeProjectionPaths,
    envelope_handoff_tool: 'git_handoff_inbox_envelope_export',
    guidance: ignoredEnvelopeProjectionPaths.length > 0
      ? 'Use ordinary task closeout commits for ordinary_task_closeout_paths only. If the ignored envelope projection must be exported, use git_handoff_inbox_envelope_export for that exact .ai/inbox-envelopes JSON path.'
      : 'Use ordinary task closeout commits for ordinary_task_closeout_paths.',
  };
}

function relativeSitePath(cwd, path) {
  return relative(resolve(cwd), path).replace(/\\/g, '/');
}

/**
 * Read all unprocessed inbox envelopes.
 *
 * Hybrid approach: uses admission log as primary source of truth for
 * processed/unprocessed status, but falls back to filesystem scan for
 * envelopes that predate the log.
 */
function readEnvelopeFiles(cwd) {
  const envelopeDir = join(resolve(cwd), INBOX_DIR);
  if (!existsSync(envelopeDir)) {
    return [];
  }
  return readdirSync(envelopeDir)
    .filter((f) => f.endsWith('.json'))
    .map((fileName) => {
      const filePath = join(envelopeDir, fileName);
      try {
        return { envelope: JSON.parse(readFileSync(filePath, 'utf8')), fileName, filePath };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.envelope);
}

export function readEnvelopeById(cwd, envelopeId) {
  return readEnvelopeFiles(cwd).find((entry) => entry.envelope?.envelope_id === envelopeId) ?? null;
}

function updateEnvelopeDispositionFile(entry, status, resolution) {
  if (!entry?.filePath) return false;
  const updated = { ...entry.envelope, status, resolution };
  writeFileSync(entry.filePath, JSON.stringify(updated, null, 2), 'utf8');
  entry.envelope = updated;
  return true;
}

export function readUnprocessedEnvelopes(cwd) {
  const fileEnvelopes = readEnvelopeFiles(cwd).map((entry) => entry.envelope);

  // Try admission log first
  try {
    const latestEvents = getLatestEventsByEnvelope(cwd);
    const processedKinds = new Set(['envelope_promoted', 'envelope_dismissed', 'envelope_acknowledged']);
    const logEnvelopes = [];

    for (const envelope of fileEnvelopes) {
      const latest = latestEvents.get(envelope.envelope_id);
      if (latest) {
        if (!processedKinds.has(latest.event_kind)) {
          logEnvelopes.push(envelope);
        }
      } else {
        // Envelope has no log event yet (predates log) — fall back to filesystem status
        if ((envelope.status ?? 'received') === 'received') {
          logEnvelopes.push(envelope);
        }
      }
    }
    return logEnvelopes;
  } catch {
    // Admission log unavailable — fall back to pure filesystem scan
    return fileEnvelopes.filter((e) => (e.status ?? 'received') === 'received');
  }
}

export async function targetInboxEnvelope(cwd, options = {}) {
  const envelopeId = options.envelopeId ?? options.envelope_id;
  if (!envelopeId) throw new Error('envelope_id_required');

  const dryRun = options.dryRun ?? options.dry_run ?? false;
  const disposition = options.disposition ?? 'materialize';
  const principal = options.principal ?? 'task-lifecycle-targeted-inbox';
  const reason = options.reason ?? null;

  const entry = readEnvelopeById(cwd, envelopeId);
  if (!entry) {
    return {
      schema: 'narada.bridge.target_envelope.v0',
      status: 'not_found',
      envelope_id: envelopeId,
      dry_run: dryRun,
    };
  }

  const envelope = entry.envelope;
  const severityResult = evaluateEnvelopeSeverity(envelope);
  let store = null;
  try {
    store = openTaskLifecycleStore(cwd);
    const outcome = decideEnvelopeBridgeOutcome({ store, envelope, severityResult, dryRun });
    const base = {
      schema: 'narada.bridge.target_envelope.v0',
      status: 'ok',
      envelope_id: envelopeId,
      disposition,
      dry_run: dryRun,
      envelope: {
        kind: envelope.kind,
        status: envelope.status ?? 'received',
        received_at: envelope.received_at ?? null,
        title: envelope.payload?.title ?? envelope.title ?? null,
        source_ref: envelope.source?.ref ?? null,
      },
      severity: severityResult,
      bridge_outcome: outcome,
      evidence: [],
    };

    if (dryRun) {
      return {
        ...base,
        preview: true,
        would_mutate: disposition !== 'preview',
        mutation: disposition === 'materialize'
          ? (outcome.status === 'materializable' ? 'materialize_task' : outcome.status)
          : `append_${disposition}_disposition`,
      };
    }

    if (disposition === 'preview') {
      return { ...base, preview: true, would_mutate: false };
    }

    if (disposition === 'materialize') {
      if (outcome.status !== 'materializable') {
        return { ...base, status: outcome.status, result: { status: outcome.status, outcome } };
      }
      const result = await applyMaterializableBridgeOutcome({ cwd, store, envelope, outcome });
      return { ...base, status: result.status, result };
    }

    if (disposition === 'acknowledge' || disposition === 'already_routed') {
      const eventReason = reason ?? (disposition === 'already_routed' ? 'Envelope already routed outside broad bridge polling.' : 'Envelope acknowledged through targeted disposition.');
      const event = acknowledgeEnvelope(cwd, envelopeId, principal, eventReason);
      const filesystemUpdated = updateEnvelopeDispositionFile(entry, 'acknowledged', {
        action: disposition,
        resolved_at: event.timestamp,
        resolved_by: principal,
        reason: eventReason,
      });
      return {
        ...base,
        status: disposition === 'already_routed' ? 'already_routed' : 'acknowledged',
        event_id: event.event_id,
        event_sequence: event.event_sequence,
        filesystem_updated: filesystemUpdated,
        evidence: [{ kind: 'admission_log', event_id: event.event_id, event_kind: event.event_kind }],
      };
    }

    if (disposition === 'dismiss') {
      if (!reason) throw new Error('reason_required_for_dismiss');
      const event = dismissEnvelope(cwd, envelopeId, principal, reason);
      const filesystemUpdated = updateEnvelopeDispositionFile(entry, 'dismissed', {
        action: 'dismissed',
        resolved_at: event.timestamp,
        resolved_by: principal,
        reason,
      });
      return {
        ...base,
        status: 'dismissed',
        event_id: event.event_id,
        event_sequence: event.event_sequence,
        filesystem_updated: filesystemUpdated,
        evidence: [{ kind: 'admission_log', event_id: event.event_id, event_kind: event.event_kind }],
      };
    }

    if (disposition === 'defer') {
      const event = appendAdmissionEvent(cwd, {
        envelope_id: envelopeId,
        event_kind: 'envelope_deferred',
        principal,
        authority_level: 'agent_reported',
        payload_hash: null,
        payload_uri: entry.fileName ? `${INBOX_DIR}/${entry.fileName}` : null,
        event_payload: { reason },
      });
      return {
        ...base,
        status: 'deferred',
        event_id: event.event_id,
        event_sequence: event.event_sequence,
        evidence: [{ kind: 'admission_log', event_id: event.event_id, event_kind: event.event_kind }],
      };
    }

    throw new Error(`unsupported_disposition: ${disposition}`);
  } finally {
    if (store) store.db.close();
  }
}

/**
 * Poll the inbox bridge: evaluate all unprocessed envelopes,
 * check deduplication, and materialize high-severity items.
 *
 * Options:
 *   - dryRun: boolean (default false)
 *   - threshold: number (default 50)
 *   - limit: number (default 20)
 *
 * Returns { evaluated, materialized, skipped, duplicates, errors }.
 */
export async function pollInboxBridge(cwd, options = {}) {
  const dryRun = options.dryRun ?? false;
  const threshold = options.threshold ?? AUTO_MATERIALIZE_THRESHOLD;
  const limit = options.limit ?? 20;

  let envelopes = readUnprocessedEnvelopes(cwd);
  // Sort by severity descending so highest-priority items are processed first
  envelopes = envelopes
    .map((e) => ({ envelope: e, severityResult: evaluateEnvelopeSeverity(e) }))
    .sort((a, b) => b.severityResult.severity - a.severityResult.severity)
    .map((item) => item.envelope);

  const evaluated = [];
  const materialized = [];
  const skipped = [];
  const duplicates = [];
  const errors = [];

  let store = null;
  try {
    store = openTaskLifecycleStore(cwd);
  } catch (e) {
    return {
      status: 'error',
      error: `failed_to_open_store: ${e.message}`,
      evaluated,
      materialized,
      skipped,
      duplicates,
      errors,
    };
  }

  try {
    let processed = 0;
    for (const envelope of envelopes) {
      if (processed >= limit) break;
      processed++;

      const severityResult = evaluateEnvelopeSeverity(envelope);
      const outcome = decideEnvelopeBridgeOutcome({ store, envelope, severityResult, dryRun });
      evaluated.push(summarizeBridgeOutcome(outcome));

      if (outcome.status === 'ignored') {
        skipped.push({
          envelopeId: outcome.envelopeId,
          severity: outcome.severity,
          action: outcome.action,
          reason: outcome.reason,
          outcome: outcome.outcome,
        });
        continue;
      }

      if (outcome.status === 'duplicate') {
        duplicates.push({
          envelopeId: outcome.envelopeId,
          duplicateTaskId: outcome.duplicateTaskId,
          duplicateTaskNumber: outcome.duplicateTaskNumber,
          matchType: outcome.matchType,
          outcome: outcome.outcome,
        });
        continue;
      }

      if (outcome.dryRun) {
        materialized.push({
          envelopeId: outcome.envelopeId,
          status: 'dry_run',
          severity: outcome.severity,
          targetRole: outcome.targetRole,
          preferredAgentId: outcome.preferredAgentId,
          routingWarnings: outcome.routingWarnings,
          wouldCreate: true,
          outcome: outcome.outcome,
        });
        continue;
      }

      try {
        const result = await applyMaterializableBridgeOutcome({ cwd, store, envelope, outcome });
        if (result.status === 'materialized') {
          materialized.push({
            envelopeId: envelope.envelope_id,
            taskNumber: result.taskNumber,
            taskId: result.taskId,
            severity: result.severity,
            targetRole: result.targetRole,
            preferredAgentId: result.preferredAgentId,
            routingWarnings: result.routingWarnings,
            marked: result.markResult?.status === 'marked',
            mapping_written: result.mapping_written,
            outcome: 'materialized',
          });
        } else {
          skipped.push({
            envelopeId: envelope.envelope_id,
            severity: result.severity,
            reason: result.status,
            outcome: result.outcome?.outcome ?? result.status,
          });
        }
      } catch (err) {
        errors.push({
          envelopeId: envelope.envelope_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    store.db.close();
  }

  return {
    schema: 'narada.bridge.poll.v0',
    status: 'ok',
    evaluated: evaluated.length,
    materialized: materialized.length,
    skipped: skipped.length,
    duplicates: duplicates.length,
    errors: errors.length,
    dry_run: dryRun,
    threshold,
    details: { evaluated, materialized, skipped, duplicates, errors },
  };
}
