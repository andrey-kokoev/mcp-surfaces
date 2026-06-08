// @ts-nocheck
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { synthesizeBootstrap } from './synthesize-bootstrap.js';
import { isCodexSessionId } from './codex-session-evidence.js';

const MIGRATIONS = [
  { table: 'agent_start_events', path: ['.ai', 'db', 'migrations', '001-agent-context-materializations.sql'] },
  { table: 'agent_events', path: ['.ai', 'db', 'migrations', '002-agent-events.sql'] },
  {
    table: 'codex_session_admissions',
    ddl: `
      CREATE TABLE IF NOT EXISTS codex_session_admissions (
        admission_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        runtime TEXT NOT NULL DEFAULT 'codex',
        cwd TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('creating', 'admitted', 'suspect', 'retired')),
        agent_start_event_id TEXT,
        codex_session_id TEXT,
        codex_session_file TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        verified_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_codex_session_admissions_agent
        ON codex_session_admissions(agent_id, cwd, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_codex_session_admissions_session
        ON codex_session_admissions(codex_session_id);
    `,
  },
];

export function validateIdentityAgainstRoster(siteRoot, identity) {
  const sqlRosterCheck = validateIdentityAgainstTaskLifecycleRoster(siteRoot, identity);
  if (sqlRosterCheck.valid) {
    return sqlRosterCheck;
  }

  const rosterPath = join(siteRoot, '.ai', 'agents', 'roster.json');
  if (!existsSync(rosterPath)) {
    return { valid: false, error: sqlRosterCheck.error ?? `roster_not_found: ${rosterPath}` };
  }

  let roster;
  try {
    roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  } catch (err) {
    return { valid: false, error: `roster_parse_error: ${err.message}` };
  }

  const agent = roster.agents?.find((candidate) => candidate.agent_id === identity);
  if (!agent) {
    return { valid: false, error: `identity_not_in_roster: ${identity}` };
  }

  const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : [];
  return {
    valid: true,
    agent,
    role: agent.role,
    role_binding: buildRoleBindingProjection({
      agentId: identity,
      role: agent.role,
      source: 'static_roster_config',
    }),
    capabilities,
    capability_policy: agent.capability_policy ?? defaultCapabilityPolicy(agent.role),
  };
}

function validateIdentityAgainstTaskLifecycleRoster(siteRoot, identity) {
  const dbPath = join(siteRoot, '.ai', 'task-lifecycle.db');
  if (!existsSync(dbPath)) {
    return { valid: false, error: `task_lifecycle_roster_db_not_found: ${dbPath}` };
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const hasRoster = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_roster'").get();
    if (!hasRoster) return { valid: false, error: 'task_lifecycle_roster_table_not_found' };
    const row = db.prepare('SELECT * FROM agent_roster WHERE agent_id = ?').get(identity);
    if (!row) return { valid: false, error: `identity_not_in_task_lifecycle_roster: ${identity}` };
    const capabilities = parseCapabilitiesJson(row.capabilities_json);
    const agent = {
      agent_id: row.agent_id,
      role: row.role,
      capabilities,
      first_seen_at: row.first_seen_at ?? null,
      last_active_at: row.last_active_at ?? null,
      status: row.status ?? null,
      task: row.task_number ?? null,
      last_done: row.last_done ?? null,
      updated_at: row.updated_at ?? null,
      roster_source: 'task_lifecycle_sqlite_agent_roster',
    };
    return {
      valid: true,
      agent,
      role: row.role,
      role_binding: buildRoleBindingProjection({
        agentId: identity,
        role: row.role,
        source: 'task_lifecycle_sqlite_agent_roster',
      }),
      capabilities,
      capability_policy: defaultCapabilityPolicy(row.role),
      roster_source: 'task_lifecycle_sqlite_agent_roster',
    };
  } catch (err) {
    return { valid: false, error: `task_lifecycle_roster_read_error: ${err.message}` };
  } finally {
    if (db) db.close();
  }
}

function parseCapabilitiesJson(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export function buildRoleBindingProjection({ agentId, role, source }) {
  return {
    schema: 'narada.agent.role_binding.v0',
    agent_id: agentId,
    role_name: role ?? null,
    binding_source: source ?? 'unknown',
    binding_authority: 'agent_roster',
    semantics: 'Roster role binding is used for identity read models, routing, and eligibility; it is not activation authority or a capability grant.',
    capability_policy_ref: 'capability_policy',
  };
}

export function defaultCapabilityPolicy(role) {
  return {
    schema: 'narada.agent.capability_policy.v0',
    direct_substrate_script_execution: 'forbidden',
    script_execution_surface: 'mcp_only',
    direct_substrate_shell_access: 'forbidden',
    mcp_shell_execution: 'allowed',
    shell_access: 'mcp_only',
    filesystem_discovery: 'mcp_only',
    lifecycle_mutations: 'mcp_only',
    exception_authority: 'operator_explicit_break_glass_only',
    rules: [
      'Do not run shell commands, scripts, rg, node, PowerShell, Python, or raw SQL directly.',
      'Use declared MCP surfaces for task lifecycle, filesystem discovery, inbox, operator surface, and approved shell-like operations.',
      'If no MCP capability exists, stop and report missing MCP capability instead of using direct script execution.',
      'Task lifecycle mutations are MCP-only.',
      'No role has standing direct terminal authority; break-glass requires explicit operator authorization.',
    ],
  };
}

export function openAgentContextDb(siteRoot, dbPath = join(siteRoot, '.ai', 'state', 'agent-context.sqlite')) {
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  applyAgentContextMigrations(db, siteRoot);
  ensureAgentStartEventCompatibility(db);
  ensureCodexAdmissionColumns(db);
  return db;
}

export function listAgentStartSessions({
  db,
  identity = null,
  dateFrom = null,
  dateTo = null,
  substrate = null,
  now = new Date(),
  limit = 100,
} = {}) {
  if (!db) throw new Error('agent_context_db_not_available');

  const filters = [];
  const params = {};
  const normalizedLimit = Math.min(Math.max(parseInt(limit ?? '100', 10) || 100, 1), 500);

  if (identity) {
    filters.push('identity_id = @identity');
    params.identity = String(identity);
  }
  if (substrate) {
    filters.push('runtime = @substrate');
    params.substrate = String(substrate);
  }
  if (dateFrom) {
    params.dateFrom = normalizeIsoDateFilter(dateFrom, 'date_from');
    filters.push('created_at >= @dateFrom');
  }
  if (dateTo) {
    params.dateTo = normalizeIsoDateFilter(dateTo, 'date_to');
    filters.push('created_at <= @dateTo');
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT event_id, identity_id, runtime, created_at, status, resume_command, bootstrap_artifact_uri
    FROM agent_start_events
    ${where}
    ORDER BY created_at DESC, event_id DESC
    LIMIT @limit
  `).all({ ...params, limit: normalizedLimit });

  const asOf = now instanceof Date ? now : new Date(now);
  const asOfIso = Number.isNaN(asOf.getTime()) ? new Date().toISOString() : asOf.toISOString();
  const sessions = rows.map((row) => sessionRowToProjection(row, asOf));
  const latestByIdentity = new Map();
  for (const session of sessions) {
    if (!latestByIdentity.has(session.identity)) latestByIdentity.set(session.identity, session);
  }

  return {
    status: 'ok',
    schema: 'narada.agent_context.sessions.v0',
    authority: 'agent_context_sqlite',
    generated_at: asOfIso,
    filters: {
      identity: identity ?? null,
      date_from: dateFrom ?? null,
      date_to: dateTo ?? null,
      substrate: substrate ?? null,
      limit: normalizedLimit,
    },
    session_count: sessions.length,
    sessions,
    latest_session_per_identity: Object.fromEntries(latestByIdentity.entries()),
    duration_estimate_note: 'agent_start_events has no end timestamp; duration is elapsed time from created_at to generated_at.',
  };
}

function normalizeIsoDateFilter(value, fieldName) {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`invalid_${fieldName}: ${value}`);
  return date.toISOString();
}

function sessionRowToProjection(row, asOf) {
  const startedAt = new Date(row.created_at);
  const seconds = Number.isNaN(startedAt.getTime())
    ? null
    : Math.max(0, Math.floor((asOf.getTime() - startedAt.getTime()) / 1000));
  return {
    event_id: row.event_id,
    identity: row.identity_id,
    substrate: row.runtime,
    runtime: row.runtime,
    status: row.status,
    created_at: row.created_at,
    resume_command: row.resume_command ?? null,
    bootstrap_artifact_uri: row.bootstrap_artifact_uri ?? null,
    duration_estimate: {
      seconds,
      basis: 'elapsed_since_start_no_end_event',
      as_of: asOf.toISOString(),
    },
  };
}

export function beginCodexSessionAdmission({
  siteRoot,
  identity,
  runtime = 'codex',
  dbPath = join(siteRoot, '.ai', 'state', 'agent-context.sqlite'),
  cwd = siteRoot,
  dryRun = false,
  evidence = {},
} = {}) {
  if (runtime !== 'codex') throw new Error(`codex_session_admission_requires_codex_runtime: ${runtime}`);
  if (!siteRoot) throw new Error('siteRoot is required');
  if (!identity) throw new Error('identity is required');

  const rosterCheck = validateIdentityAgainstRoster(siteRoot, identity);
  if (!rosterCheck.valid) throw new Error(rosterCheck.error);

  const admissionId = `codexadm_${randomUUID().replace(/-/g, '')}`;
  const now = new Date().toISOString();
  const payload = {
    schema: 'narada.codex.session_admission.v0',
    admission_id: admissionId,
    identity,
    agent_id: identity,
    runtime,
    cwd,
    status: dryRun ? 'planned' : 'creating',
    agent_start_event_id: null,
    codex_session_id: null,
    codex_session_file: null,
    evidence_json: {
      ...evidence,
      authority_note: 'Narada admission UUID is authority; Codex session id/file is carrier evidence.',
      start_event_status: 'not_materialized_admission_intent_only',
      codex_mcp_registration: 'Stable global MCP registration is a prerequisite; launcher-bound identity is supplied through inherited carrier process environment.',
    },
    created_at: now,
    verified_at: null,
  };

  if (!dryRun) {
    const db = openAgentContextDb(siteRoot, dbPath);
    try {
      db.prepare(`
        INSERT INTO codex_session_admissions (
          admission_id,
          agent_id,
          runtime,
          cwd,
          status,
          agent_start_event_id,
          codex_session_id,
          codex_session_file,
          evidence_json,
          created_at,
          verified_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        payload.admission_id,
        payload.agent_id,
        payload.runtime,
        payload.cwd,
        payload.status,
        payload.agent_start_event_id,
        payload.codex_session_id,
        payload.codex_session_file,
        JSON.stringify(payload.evidence_json),
        payload.created_at,
        payload.verified_at
      );
    } finally {
      db.close();
    }
  }

  return {
    ...payload,
    role: rosterCheck.role,
    role_binding: rosterCheck.role_binding,
    capabilities: rosterCheck.capabilities,
    capability_policy: rosterCheck.capability_policy,
    db_path: dbPath,
    required_environment: {
      NARADA_AGENT_ID: identity,
      NARADA_CODEX_ADMISSION_ID: admissionId,
    },
  };
}

export function getCodexSessionAdmission({
  siteRoot,
  admissionId,
  dbPath = join(siteRoot, '.ai', 'state', 'agent-context.sqlite'),
} = {}) {
  if (!siteRoot) throw new Error('siteRoot is required');
  if (!admissionId) throw new Error('admissionId is required');

  const db = openAgentContextDb(siteRoot, dbPath);
  try {
    const row = db.prepare('SELECT * FROM codex_session_admissions WHERE admission_id = ?').get(admissionId);
    if (!row) return { status: 'not_found', admission_id: admissionId };
    return {
      status: 'ok',
      admission: {
        ...row,
        evidence_json: parseJsonObject(row.evidence_json),
      },
    };
  } finally {
    db.close();
  }
}

export function completeCodexSessionAdmission({
  siteRoot,
  admissionId,
  identity,
  codexSessionId,
  codexSessionFile = null,
  runtime = 'codex',
  dbPath = join(siteRoot, '.ai', 'state', 'agent-context.sqlite'),
  cwd = siteRoot,
  evidence = {},
} = {}) {
  if (!siteRoot) throw new Error('siteRoot is required');
  if (!admissionId) throw new Error('admissionId is required');
  if (!identity) throw new Error('identity is required');
  if (!codexSessionId) throw new Error('codex_session_id is required');
  if (!isCodexSessionId(codexSessionId)) throw new Error(`codex_session_id_invalid: ${codexSessionId}`);
  if (runtime !== 'codex') throw new Error(`codex_session_completion_requires_codex_runtime: ${runtime}`);

  const rosterCheck = validateIdentityAgainstRoster(siteRoot, identity);
  if (!rosterCheck.valid) throw new Error(rosterCheck.error);

  const db = openAgentContextDb(siteRoot, dbPath);
  try {
    const row = db.prepare('SELECT * FROM codex_session_admissions WHERE admission_id = ?').get(admissionId);
    if (!row) throw new Error(`codex_session_admission_not_found: ${admissionId}`);
    if (row.runtime !== 'codex') throw new Error(`codex_session_admission_wrong_runtime: ${row.runtime}`);
    if (row.agent_id !== identity) throw new Error(`codex_session_admission_identity_mismatch: expected ${row.agent_id}, got ${identity}`);
    if (row.status !== 'creating') throw new Error(`codex_session_admission_not_creating: ${row.status}`);

    const completedAt = new Date().toISOString();
    let startResult;
    runTransaction(db, () => {
      startResult = writeSessionMaterialization(db, { siteRoot, identity, runtime, dbPath, cwd, rosterCheck });
      const mergedEvidence = {
        ...parseJsonObject(row.evidence_json),
        ...evidence,
        start_event_status: 'materialized',
        agent_start_event_id: startResult.agent_start_event,
        codex_session_id: codexSessionId,
        codex_session_file: codexSessionFile,
        completed_by: 'agent_context_complete_codex_admission',
        completed_at: completedAt,
      };
      db.prepare(`
        UPDATE codex_session_admissions
        SET status = 'admitted',
            agent_start_event_id = ?,
            codex_session_id = ?,
            codex_session_file = ?,
            evidence_json = ?,
            verified_at = ?
        WHERE admission_id = ?
      `).run(
        startResult.agent_start_event,
        codexSessionId,
        codexSessionFile,
        JSON.stringify(mergedEvidence),
        completedAt,
        admissionId
      );
    });

    const updated = db.prepare('SELECT * FROM codex_session_admissions WHERE admission_id = ?').get(admissionId);
    return {
      schema: 'narada.codex.session_admission.completion.v0',
      status: 'admitted',
      admission_id: admissionId,
      agent_id: identity,
      agent_start_event_id: startResult.agent_start_event,
      codex_session_id: codexSessionId,
      codex_session_file: codexSessionFile,
      verified_at: completedAt,
      start_session: startResult,
      required_environment: {
        ...startResult.required_environment,
        NARADA_CODEX_ADMISSION_ID: admissionId,
      },
      admission: {
        ...updated,
        evidence_json: parseJsonObject(updated.evidence_json),
      },
    };
  } finally {
    db.close();
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function applyAgentContextMigrations(db, siteRoot) {
  for (const migration of MIGRATIONS) {
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(migration.table);
    if (hasTable) continue;

    if (migration.ddl) {
      db.exec(migration.ddl);
      continue;
    }

    const migrationPath = join(siteRoot, ...migration.path);
    if (!existsSync(migrationPath)) {
      throw new Error(`agent_context_migration_not_found: ${migrationPath}`);
    }
    db.exec(readFileSync(migrationPath, 'utf8'));
  }
}

export function ensureAgentStartEventCompatibility(db) {
  const hasEvents = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_start_events'").get();
  if (!hasEvents) return;

  const columns = new Set(db.prepare('PRAGMA table_info(agent_start_events)').all().map((column) => column.name));
  const addColumn = (name, type) => {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE agent_start_events ADD COLUMN ${name} ${type}`);
      columns.add(name);
    }
  };

  addColumn('identity_id', 'TEXT');
  addColumn('runtime', 'TEXT');
  addColumn('created_at', 'TEXT');
  addColumn('status', 'TEXT');
  addColumn('resume_command', 'TEXT');
  addColumn('bootstrap_artifact_uri', 'TEXT');

  if (columns.has('identity')) {
    db.prepare("UPDATE agent_start_events SET identity_id = identity WHERE identity_id IS NULL AND identity IS NOT NULL").run();
  }
  if (columns.has('agent_id')) {
    db.prepare("UPDATE agent_start_events SET identity_id = agent_id WHERE identity_id IS NULL AND agent_id IS NOT NULL").run();
  }
  if (columns.has('substrate')) {
    db.prepare("UPDATE agent_start_events SET runtime = substrate WHERE runtime IS NULL AND substrate IS NOT NULL").run();
  }
  if (columns.has('materialized_at')) {
    db.prepare("UPDATE agent_start_events SET created_at = materialized_at WHERE created_at IS NULL AND materialized_at IS NOT NULL").run();
  }
  db.prepare("UPDATE agent_start_events SET status = 'materialized' WHERE status IS NULL").run();

  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_context_materializations (
      materialization_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      runtime TEXT NOT NULL,
      cwd TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS intelligence_context_materializations (
      materialization_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      schema_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proposal_records (
      proposal_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      materialization_id TEXT,
      proposal_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      verdict TEXT NOT NULL DEFAULT 'pending',
      verdict_at TEXT,
      verdict_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS residual_records (
      residual_id TEXT PRIMARY KEY,
      event_id TEXT,
      materialization_id TEXT,
      label TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'noted',
      promoted_task_id TEXT,
      created_at TEXT NOT NULL,
      status_at TEXT
    );

    CREATE TABLE IF NOT EXISTS artifact_refs (
      artifact_id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      sha256 TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      created_at TEXT NOT NULL
    );
  `);
}

function ensureCodexAdmissionColumns(db) {
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_session_admissions'").get();
  if (!hasTable) return;

  const columns = new Set(db.prepare('PRAGMA table_info(codex_session_admissions)').all().map((column) => column.name));
  if (!columns.has('agent_start_event_id')) {
    db.exec('ALTER TABLE codex_session_admissions ADD COLUMN agent_start_event_id TEXT');
  }
}

export function materializeAgentSessionStart({
  siteRoot,
  identity,
  runtime = 'kimi',
  dbPath = join(siteRoot, '.ai', 'state', 'agent-context.sqlite'),
  cwd = siteRoot,
  dryRun = false,
} = {}) {
  if (!siteRoot) {
    throw new Error('siteRoot is required');
  }
  if (!identity) {
    throw new Error('identity is required');
  }

  const rosterCheck = validateIdentityAgainstRoster(siteRoot, identity);
  if (!rosterCheck.valid) {
    throw new Error(rosterCheck.error);
  }

  if (dryRun) {
    return buildDryRunResult({ siteRoot, identity, runtime, dbPath, cwd, rosterCheck });
  }

  const db = openAgentContextDb(siteRoot, dbPath);
  try {
    return writeSessionMaterialization(db, { siteRoot, identity, runtime, dbPath, cwd, rosterCheck });
  } finally {
    db.close();
  }
}

export function writeSessionMaterialization(db, { siteRoot, identity, runtime, dbPath, cwd, rosterCheck }) {
  const now = new Date().toISOString();
  const eventId = `evt-${now.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}_${randomUUID().slice(0, 8)}`;
  const materializationId = `mat-${randomUUID().slice(0, 8)}`;
  const ecMaterializationId = `ec-${randomUUID().slice(0, 8)}`;
  const proposalId = `prop-${randomUUID().slice(0, 8)}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const resumeCommand = buildCarrierCommand(runtime, identity);

  const executionContextPayload = buildExecutionContextPayload({
    siteRoot,
    runtime,
    cwd,
    identity,
    eventId,
    roleBinding: rosterCheck.role_binding,
    capabilityPolicy: rosterCheck.capability_policy,
  });
  const intelligenceContextPayload = buildIntelligenceContextPayload();
  const proposalPayload = {
    proposal_type: 'evaluation',
    description: 'Agent session start materialized by agent-context MCP authority.',
  };

  const insertEvent = db.prepare(`
    INSERT INTO agent_start_events (event_id, identity_id, runtime, created_at, status, resume_command, bootstrap_artifact_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEC = db.prepare(`
    INSERT INTO execution_context_materializations (materialization_id, event_id, runtime, cwd, payload_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertIC = db.prepare(`
    INSERT INTO intelligence_context_materializations (materialization_id, event_id, schema_id, payload_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertProposal = db.prepare(`
    INSERT INTO proposal_records (proposal_id, event_id, materialization_id, proposal_type, payload_json, verdict, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  runTransaction(db, () => {
    insertEvent.run(eventId, identity, runtime, now, 'materialized', resumeCommand, null);
    insertEC.run(ecMaterializationId, eventId, runtime, cwd, JSON.stringify(executionContextPayload), now, expiresAt);
    insertIC.run(materializationId, eventId, 'narada.intelligence_context.v0', JSON.stringify(intelligenceContextPayload), now, expiresAt);
    insertProposal.run(proposalId, eventId, materializationId, proposalPayload.proposal_type, JSON.stringify(proposalPayload), 'pending', now);
  });

  const l1Bootstrap = synthesizeBootstrap(db, identity, { limit: 10 });

  return {
    schema: 'narada.agent_context.session_start.v0',
    status: 'materialized',
    agent_start_event: eventId,
    identity,
    role: rosterCheck.role,
    role_binding: rosterCheck.role_binding,
    capabilities: rosterCheck.capabilities,
    capability_policy: rosterCheck.capability_policy,
    runtime,
    cwd,
    db_path: dbPath,
    resume_command: resumeCommand,
    required_environment: {
      NARADA_AGENT_ID: identity,
      NARADA_AGENT_START_EVENT_ID: eventId,
    },
    startup_sequence: buildStartupSequence(identity, eventId),
    execution_context_materialization: ecMaterializationId,
    intelligence_context_materialization: materializationId,
    proposal_id: proposalId,
    expires_at: expiresAt,
    l1_bootstrap_summary: l1Bootstrap.summary,
  };
}

function runTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}

export function buildCarrierCommand(runtime, identity) {
  if (runtime === 'kimi') {
    return `kimi -S ${identity}`;
  }
  return runtime;
}

function buildDryRunResult({ siteRoot, identity, runtime, dbPath, cwd, rosterCheck }) {
  return {
    schema: 'narada.agent_context.session_start.v0',
    status: 'dry_run',
    identity,
    role: rosterCheck.role,
    role_binding: rosterCheck.role_binding,
    capabilities: rosterCheck.capabilities,
    capability_policy: rosterCheck.capability_policy,
    runtime,
    root_dir: siteRoot,
    cwd,
    db_path: dbPath,
    would_materialize_agent_context: true,
    would_set_environment: {
      NARADA_AGENT_ID: identity,
      NARADA_AGENT_START_EVENT_ID: '<new event id>',
    },
    startup_sequence: buildStartupSequence(identity, '<new event id>'),
  };
}

function buildStartupSequence(identity, eventId) {
  return [
    { tool: 'agent_context_startup_sequence', arguments: {} },
  ];
}

function buildExecutionContextPayload({ siteRoot, runtime, cwd, identity, eventId, roleBinding, capabilityPolicy }) {
  return {
    runtime,
    cwd,
    identity,
    agent_start_event: eventId,
    role_binding: roleBinding,
    mcp_servers: deriveMcpServersFromFabric(siteRoot),
    identity_boundary: 'NARADA_AGENT_ID and NARADA_AGENT_START_EVENT_ID are launcher carrier environment inherited by MCP servers, not substrate memory or global config.',
    hydration_boundary: 'Hydration is performed through MCP tools; substrate prompt injection is not authoritative.',
    capability_policy: capabilityPolicy,
  };
}

function deriveMcpServersFromFabric(siteRoot) {
  const mcpFabricDir = join(siteRoot, '.ai', 'mcp');
  if (!existsSync(mcpFabricDir)) {
    return [];
  }

  const servers = [];
  for (const entry of readdirSync(mcpFabricDir).sort()) {
    if (!entry.endsWith('.json')) continue;

    const configPath = join(mcpFabricDir, entry);
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      continue;
    }

    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      servers.push({
        name,
        transport: typeof server?.transport === 'string' ? server.transport : 'stdio',
      });
    }
  }

  return servers;
}

function buildIntelligenceContextPayload() {
  return {
    $schema: 'narada/schemas/intelligence_context.v0.schema.json',
    materialized_context: {
      facts: [
        {
          claim: 'Agent session start was materialized by agent-context authority.',
          source: 'agent_context_start_session',
          authority: 'high',
          volatility: 'low',
          provenance: 'observed_present',
        },
      ],
      observations: [],
      session_residue: [],
      source_provenance: [
        { source: 'agent-context MCP', authority: 'high', volatility: 'low' },
        { source: 'roster.json', authority: 'high', volatility: 'medium' },
      ],
    },
    work_frame: {
      principal_intent_as_understood: 'Start an agent session and materialize event-scoped context through MCP.',
      active_question: null,
      known_constraints: [
        'Agent identity is durable and separate from substrate runtime.',
        'Substrate prompt injection is not an authority boundary.',
        'Session hydration must be reconstructible from MCP.',
      ],
      open_arbitrariness: [],
      residuals_seen: [],
    },
    arbitrariness_partition: {
      forced_structure: ['roster validation', 'event-scoped materialization', 'carrier environment', 'MCP hydration sequence'],
      contingent_policy: ['runtime executable name', 'session title rendering'],
      decision_inert: ['substrate branding'],
      residual: [],
    },
    evaluation_state: {
      candidate_distinctions: [],
      candidate_hypotheses: [],
      candidate_next_moves: [],
      confidence_annotations: [],
      collapse_risks: [],
    },
    coherence_diagnosis: {
      semantic_resolution: 'Agent-context owns session materialization; launchers are carriers.',
      invariant_preservation: 'Identity, session, and substrate remain mechanically separate.',
      constructive_executability: 'The startup sequence is expressed as MCP calls.',
      grounded_universalization: 'Works across Kimi, Codex, and future substrates that inherit environment and MCP config.',
      authority_reviewability: 'SQLite start events and materializations are the reviewable record.',
      teleological_pressure: 'Prevent prompt text from becoming hidden authority.',
    },
    proposal_output: {
      recommended_evaluation: 'Agent session start materialized successfully.',
      recommended_decision_request: null,
      recommended_intent_request: null,
      recommended_residuals: [],
    },
    residuals: {
      unresolved: [],
      deferred: [],
      dropped: [],
    },
  };
}


