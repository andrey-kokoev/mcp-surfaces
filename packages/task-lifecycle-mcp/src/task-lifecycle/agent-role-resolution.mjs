import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function resolveAgentRole(store, siteRoot, agentId) {
  return resolveAgentRoleWithDiagnostics(store, siteRoot, agentId).role;
}

export function buildAgentRoleBindingProjection({ agentId, role, source }) {
  return {
    schema: 'narada.agent.role_binding.v0',
    agent_id: agentId,
    role_name: role ?? null,
    binding_source: source ?? 'unknown',
    binding_authority: 'agent_roster',
    semantics: 'Roster role binding is used for task routing and eligibility; it is not activation authority or a capability grant.',
    capability_policy_ref: 'capability_policy',
  };
}

export function resolveAgentRoleWithDiagnostics(store, siteRoot, agentId) {
  const diagnostics = {
    schema: 'narada.task.agent_role_resolution.v0',
    agent_id: agentId,
    role: null,
    role_binding: null,
    source: null,
    sql_agent_roster: { status: 'not_checked' },
    static_roster_config: { status: 'not_checked', path: rosterPath(siteRoot) },
    remediation: null,
  };

  if (!agentId) {
    diagnostics.sql_agent_roster.status = 'not_checked';
    diagnostics.static_roster_config.status = 'not_checked';
    diagnostics.remediation = 'Provide agent_id before role-gated task lifecycle operations.';
    return diagnostics;
  }

  let sqlRole = null;
  try {
    const row = store.db.prepare('SELECT role FROM agent_roster WHERE agent_id = ?').get(agentId);
    if (row && typeof row.role === 'string' && row.role.trim().length > 0) {
      sqlRole = row.role;
      diagnostics.sql_agent_roster = { status: 'found', role: sqlRole };
    } else if (row) {
      diagnostics.sql_agent_roster = { status: 'found_without_role', role: row.role ?? null };
    } else {
      diagnostics.sql_agent_roster = { status: 'missing_agent' };
    }
  } catch (error) {
    diagnostics.sql_agent_roster = { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }

  if (sqlRole) {
    diagnostics.role = sqlRole;
    diagnostics.role_binding = buildAgentRoleBindingProjection({
      agentId,
      role: sqlRole,
      source: 'sql_agent_roster',
    });
    diagnostics.source = 'sql_agent_roster';
    return diagnostics;
  }

  const staticRole = readStaticRosterRole(siteRoot, agentId, diagnostics);
  if (staticRole) {
    diagnostics.role = staticRole;
    diagnostics.role_binding = buildAgentRoleBindingProjection({
      agentId,
      role: staticRole,
      source: 'static_roster_config_fallback',
    });
    diagnostics.source = 'static_roster_config_fallback';
    diagnostics.remediation = 'Run task lifecycle roster sync or restart stale lifecycle surfaces so SQL agent_roster imports authored roster identity config.';
    return diagnostics;
  }

  diagnostics.remediation = 'Agent role not found in SQL agent_roster or authored .ai/agents/roster.json; sync or repair roster identity config before claiming role-targeted work.';
  return diagnostics;
}

export function checkTaskRoleEligibilityLocal({ store, siteRoot, taskId, taskNumber = null, agentId }) {
  const routing = resolveTaskRouting(store, taskId, taskNumber);
  const roleResolution = resolveAgentRoleWithDiagnostics(store, siteRoot, agentId);
  const targetRole = routing.targetRole;
  if (targetRole && roleResolution.role !== targetRole) {
    return {
      eligible: false,
      warning: `Task${taskNumber ? ` ${taskNumber}` : ''} targets role '${targetRole}'. Agent '${agentId}' has role '${roleResolution.role ?? 'null'}'.`,
      targetRole,
      preferredAgentId: routing.preferredAgentId,
      agentRole: roleResolution.role,
      roleBinding: roleResolution.role_binding,
      roleResolution,
    };
  }
  if (routing.preferredAgentId && routing.preferredAgentId !== agentId) {
    return {
      eligible: true,
      warning: `Task${taskNumber ? ` ${taskNumber}` : ''} prefers agent '${routing.preferredAgentId}'. Claiming as '${agentId}'.`,
      targetRole,
      preferredAgentId: routing.preferredAgentId,
      agentRole: roleResolution.role,
      roleBinding: roleResolution.role_binding,
      roleResolution,
    };
  }
  return {
    eligible: true,
    warning: null,
    targetRole,
    preferredAgentId: routing.preferredAgentId,
    agentRole: roleResolution.role,
    roleBinding: roleResolution.role_binding,
    roleResolution,
  };
}

export function roleExistsInRoster(store, siteRoot, role) {
  if (!role) return false;
  try {
    const sql = store.db.prepare('SELECT 1 FROM agent_roster WHERE role = ? LIMIT 1').get(role);
    if (sql) return true;
  } catch {
    // Fall back to authored roster below.
  }
  return readStaticRoster(siteRoot).agents.some((agent) => agent.role === role);
}

export function agentExistsWithRole(store, siteRoot, agentId) {
  const resolution = resolveAgentRoleWithDiagnostics(store, siteRoot, agentId);
  return resolution.role ? { exists: true, role: resolution.role, role_resolution: resolution } : { exists: false, role: null, role_resolution: resolution };
}

function resolveTaskRouting(store, taskId, taskNumber) {
  let targetRole = null;
  let preferredAgentId = null;
  try {
    const rolePref = store.db.prepare(
      'SELECT target_role, preferred_role, preferred_agent_id FROM narada_andrey_task_role_preferences WHERE task_id = ?'
    ).get(taskId);
    targetRole = rolePref?.target_role || rolePref?.preferred_role || null;
    preferredAgentId = rolePref?.preferred_agent_id || null;
  } catch {
    // Table may not exist in fresh/minimal stores.
  }

  const spec = taskNumber ? store.getTaskSpecByNumber(taskNumber) : null;
  targetRole = targetRole || spec?.target_role || spec?.preferred_role || null;
  preferredAgentId = preferredAgentId || spec?.preferred_agent_id || null;
  return { targetRole, preferredAgentId };
}

function readStaticRosterRole(siteRoot, agentId, diagnostics) {
  const path = rosterPath(siteRoot);
  if (!existsSync(path)) {
    diagnostics.static_roster_config = { status: 'missing', path };
    return null;
  }
  try {
    const roster = JSON.parse(readFileSync(path, 'utf8'));
    const agent = Array.isArray(roster.agents) ? roster.agents.find((entry) => entry?.agent_id === agentId) : null;
    if (!agent) {
      diagnostics.static_roster_config = { status: 'missing_agent', path };
      return null;
    }
    if (typeof agent.role !== 'string' || agent.role.trim().length === 0) {
      diagnostics.static_roster_config = { status: 'found_without_role', path, role: agent.role ?? null };
      return null;
    }
    diagnostics.static_roster_config = { status: 'found', path, role: agent.role };
    return agent.role;
  } catch (error) {
    diagnostics.static_roster_config = { status: 'error', path, error: error instanceof Error ? error.message : String(error) };
    return null;
  }
}

function readStaticRoster(siteRoot) {
  const path = rosterPath(siteRoot);
  if (!existsSync(path)) return { agents: [] };
  try {
    const roster = JSON.parse(readFileSync(path, 'utf8'));
    return { agents: Array.isArray(roster.agents) ? roster.agents : [] };
  } catch {
    return { agents: [] };
  }
}

function rosterPath(siteRoot) {
  return join(resolve(siteRoot), '.ai', 'agents', 'roster.json');
}
