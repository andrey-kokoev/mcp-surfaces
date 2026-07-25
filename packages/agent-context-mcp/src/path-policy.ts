import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export function enforceAgentPathPolicy({ siteRoot, agentId = process.env.NARADA_AGENT_ID, absolutePath, operation }: any) {
  const policyResult: any = resolveAgentPathPolicy(siteRoot, agentId);
  if (!policyResult.configured) {
    return {
      status: 'not_configured',
      agent_id: agentId ?? null,
      roster_enforcement: policyResult.roster_enforcement ?? 'not_applicable',
      reason: policyResult.reason,
    };
  }
  if (!policyResult.allowed) {
    throw new Error(policyResult.error);
  }

  const normalizedPath: any = resolve(absolutePath);
  const allowedRoots: any = policyResult.allowed_roots ?? [];
  const allowed: any = allowedRoots.some((root: any) => isPathWithin(normalizedPath, root.absolute_path));
  if (!allowed) {
    const allowedList: any = allowedRoots.map((root: any) => root.display_path).join(', ');
    throw new Error(`path_policy_denied: agent=${agentId} operation=${operation} path=${normalizedPath} allowed_roots=[${allowedList}]`);
  }

  return {
    status: 'allowed',
    agent_id: agentId,
    operation,
    path: normalizedPath,
    matched_roots: allowedRoots
      .filter((root: any) => isPathWithin(normalizedPath, root.absolute_path))
      .map((root: any) => root.display_path),
  };
}

export function resolveAgentPathPolicy(siteRoot: any, agentId: any = process.env.NARADA_AGENT_ID) {
  if (!agentId) return { configured: false, allowed: true, roster_enforcement: 'not_applicable', reason: 'agent_unbound' };

  const rosterPath: any = resolve(siteRoot, '.ai', 'agents', 'roster.json');
  let roster: any;
  try {
    roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  } catch (err: any) {
    return { configured: false, allowed: true, roster_enforcement: 'not_applicable', reason: `roster_unavailable: ${err.message}` };
  }

  const rosterEnforced: any = siteEnforcesAgentPathRoster(roster);

  const agent: any = roster.agents?.find((candidate: any) => candidate.agent_id === agentId);
  if (!agent) {
    if (!rosterEnforced) {
      return {
        configured: false,
        allowed: true,
        agent_id: agentId,
        roster_enforcement: 'disabled',
        reason: 'identity_not_in_roster_but_site_path_roster_enforcement_not_enabled',
      };
    }
    return {
      configured: true,
      allowed: false,
      roster_enforcement: 'enabled',
      error: `path_policy_identity_not_in_roster: ${agentId}`,
    };
  }

  const policy: any = agent.capability_policy?.path_policy
    ?? agent.capability_policy?.filesystem_path_policy
    ?? null;
  if (!policy) return { configured: false, allowed: true, agent_id: agentId, roster_enforcement: rosterEnforced ? 'enabled' : 'disabled' };

  const mode: any = policy.mode ?? 'allowlist';
  if (mode !== 'allowlist') {
    return { configured: false, allowed: true, agent_id: agentId, roster_enforcement: rosterEnforced ? 'enabled' : 'disabled', reason: `path_policy_mode_${mode}` };
  }

  const roots: any = normalizePolicyRoots(siteRoot, policy);
  if (roots.length === 0) {
    return {
      configured: true,
      allowed: false,
      roster_enforcement: rosterEnforced ? 'enabled' : 'disabled',
      error: `path_policy_empty_allowlist: ${agentId}`,
    };
  }

  return {
    configured: true,
    allowed: true,
    agent_id: agentId,
    roster_enforcement: rosterEnforced ? 'enabled' : 'disabled',
    mode,
    allowed_roots: roots,
  };
}

function normalizePolicyRoots(siteRoot: any, policy: any) {
  const rawEntries: any = policy.allow
    ?? policy.allowlist
    ?? policy.allowed_paths
    ?? policy.allowed_roots
    ?? [];
  const entries: any = Array.isArray(rawEntries) ? rawEntries : [];
  const roots: any = [];

  for (const entry of entries) {
    const rawPath: any = typeof entry === 'string'
      ? entry
      : typeof entry?.path === 'string'
        ? entry.path
        : typeof entry?.root === 'string'
          ? entry.root
          : null;
    if (!rawPath) continue;

    const absolutePath: any = isAbsolute(rawPath) ? resolve(rawPath) : resolve(siteRoot, rawPath);
    if (!isPathWithin(absolutePath, siteRoot)) continue;
    roots.push({
      display_path: normalizeDisplayPath(relative(siteRoot, absolutePath)),
      absolute_path: absolutePath,
    });
  }

  return roots;
}

function siteEnforcesAgentPathRoster(roster: any) {
  return roster?.enforce_agent_path_policy === true
    || roster?.path_policy?.enforce_agent_roster === true
    || roster?.site_policy?.enforce_agent_path_policy === true;
}

function isPathWithin(candidatePath: any, rootPath: any) {
  const rel: any = relative(resolve(rootPath), resolve(candidatePath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function normalizeDisplayPath(pathValue: any) {
  const normalized: any = pathValue.replace(/\\/g, '/');
  return normalized === '' ? '.' : normalized;
}
