import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { diagnosticError } from './errors.js';

export const INTELLIGENCE_LAUNCH_CONTEXT_SCHEMA = 'narada.intelligence.launch_context.v1';
export const INTELLIGENCE_PRINCIPAL_BINDING_SCHEMA = 'narada.intelligence.principal_binding.v1';

const REQUIRED_CONTEXT_FIELDS = [
  'target_site_id',
  'user_site_id',
  'host_site_id',
  'principal_id',
  'principal_binding',
  'registry_db_file',
] as const;

export type IntelligenceLaunchContext = {
  schema: typeof INTELLIGENCE_LAUNCH_CONTEXT_SCHEMA;
  status: 'ready' | 'blocked';
  source: 'user_site_document' | 'explicit_environment_or_site_metadata';
  context_path: string;
  context_exists: boolean;
  registry_db_path: string;
  registry_db_exists: boolean;
  target_site: string | null;
  user_site: string | null;
  host_site: string | null;
  principal_id: string | null;
  principal_binding_present: boolean;
  missing: string[];
  required_fields: readonly string[];
  environment: Record<string, string>;
};

export class IntelligenceLaunchContextError extends Error {
  codeName: string;
  details: Record<string, unknown>;

  constructor(codeName: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'IntelligenceLaunchContextError';
    this.codeName = codeName;
    this.details = details;
  }
}

type PrincipalBinding = {
  schema: typeof INTELLIGENCE_PRINCIPAL_BINDING_SCHEMA;
  actor: { principal_id: string; auth_type: string };
  memberships: Array<{ registry: string; site_id: string; role: string; evidence_ref: string }>;
  evidence_refs?: string[];
};

function normalizeSiteId(value: unknown, field: string): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const canonical = raw.startsWith('site:') ? raw : `site:${raw}`;
  if (!/^site:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(canonical)) {
    throw new IntelligenceLaunchContextError('worker_intelligence_context_invalid', `${field} must be a canonical Site locus.`, { field, value: raw });
  }
  return canonical;
}

function normalizePrincipalId(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const canonical = raw.startsWith('principal:') ? raw : `principal:${raw}`;
  if (!/^principal:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(canonical)) {
    throw new IntelligenceLaunchContextError('worker_intelligence_context_invalid', 'principal_id must be a canonical principal.', { field: 'principal_id', value: raw });
  }
  return canonical;
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('document must be a JSON object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new IntelligenceLaunchContextError('worker_intelligence_context_invalid', `Cannot read intelligence launch context: ${path}`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function inferSiteId(siteRoot: string): string | null {
  const candidates = [
    join(siteRoot, '.narada', 'site.identity.json'),
    join(siteRoot, '.narada', 'site.json'),
    join(siteRoot, 'site.identity.json'),
    join(siteRoot, 'site.json'),
    join(siteRoot, 'config.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const document = readJsonObject(path);
      const candidate = document.site_id
        ?? (document.static_config && typeof document.static_config === 'object'
          ? (document.static_config as Record<string, unknown>).site_id
          : null);
      if (candidate) return String(candidate);
    } catch (error) {
      // Site metadata is an inference source. A malformed optional candidate
      // must not hide a later valid identity candidate.
      if (error instanceof IntelligenceLaunchContextError) continue;
      throw error;
    }
  }
  return null;
}

function resolveConfiguredPath(value: unknown, baseRoot: string): string | null {
  const raw = String(value ?? '').trim();
  return raw ? resolve(baseRoot, raw) : null;
}

function normalizePrincipalBinding(value: unknown, expectedPrincipal: string | null): PrincipalBinding | null {
  if (value === undefined || value === null || value === '') return null;
  let candidateValue = value;
  if (typeof value === 'string') {
    try {
      candidateValue = JSON.parse(value);
    } catch (error) {
      throw new IntelligenceLaunchContextError('worker_intelligence_context_invalid', 'principal binding is not valid JSON.', {
        field: 'principal_binding',
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!candidateValue || typeof candidateValue !== 'object' || Array.isArray(candidateValue)) {
    throw new IntelligenceLaunchContextError('worker_intelligence_context_invalid', 'principal_binding must be an object.', { field: 'principal_binding' });
  }
  const candidate = candidateValue as Record<string, unknown>;
  const actor = candidate.actor;
  const memberships = candidate.memberships;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || !Array.isArray(memberships)) {
    throw new IntelligenceLaunchContextError('worker_intelligence_context_invalid', 'principal_binding requires actor and memberships[].', { field: 'principal_binding' });
  }
  const actorRecord = actor as Record<string, unknown>;
  const actorPrincipal = normalizePrincipalId(actorRecord.principal_id);
  const authType = String(actorRecord.auth_type ?? '').trim();
  if (!actorPrincipal || !authType) {
    throw new IntelligenceLaunchContextError('worker_intelligence_context_invalid', 'principal_binding requires actor.principal_id and actor.auth_type.', { field: 'principal_binding.actor' });
  }
  if (expectedPrincipal && actorPrincipal !== expectedPrincipal) {
    throw new IntelligenceLaunchContextError('worker_intelligence_context_principal_binding_mismatch', 'principal binding actor does not match principal_id.', {
      actor_principal_id: actorPrincipal,
      principal_id: expectedPrincipal,
    });
  }
  const normalizedMemberships = memberships.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new IntelligenceLaunchContextError('worker_intelligence_context_invalid', `principal_binding.memberships[${index}] must be an object.`, { field: `principal_binding.memberships[${index}]` });
    }
    const membership = item as Record<string, unknown>;
    const registry = String(membership.registry ?? '').trim();
    const siteId = normalizeSiteId(membership.site_id, `principal_binding.memberships[${index}].site_id`);
    const role = String(membership.role ?? '').trim();
    const evidenceRef = String(membership.evidence_ref ?? '').trim();
    if (!registry || !siteId || !role || !evidenceRef) {
      throw new IntelligenceLaunchContextError('worker_intelligence_context_invalid', `principal_binding.memberships[${index}] is incomplete.`, { field: `principal_binding.memberships[${index}]` });
    }
    return { registry, site_id: siteId, role, evidence_ref: evidenceRef };
  });
  const evidenceRefs = candidate.evidence_refs;
  if (evidenceRefs !== undefined && (!Array.isArray(evidenceRefs) || !evidenceRefs.every((ref) => typeof ref === 'string' && ref.trim()))) {
    throw new IntelligenceLaunchContextError('worker_intelligence_context_invalid', 'principal_binding.evidence_refs is invalid.', { field: 'principal_binding.evidence_refs' });
  }
  return {
    schema: INTELLIGENCE_PRINCIPAL_BINDING_SCHEMA,
    actor: { principal_id: actorPrincipal, auth_type: authType },
    memberships: normalizedMemberships,
    ...(Array.isArray(evidenceRefs) ? { evidence_refs: evidenceRefs.map((ref) => ref.trim()) } : {}),
  };
}

function registryDbExists(path: string): boolean {
  if (path === ':memory:') return true;
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function loadIntelligenceLaunchContext({
  sessionSiteRoot,
  userSiteRoot,
  processEnv = process.env,
}: {
  sessionSiteRoot: string;
  userSiteRoot: string;
  processEnv?: NodeJS.ProcessEnv;
}): IntelligenceLaunchContext {
  const contextPath = resolve(processEnv.NARADA_INTELLIGENCE_CONTEXT_PATH?.trim() || join(userSiteRoot, '.narada', 'intelligence-launch-context.json'));
  const contextExists = existsSync(contextPath);
  const document = contextExists ? readJsonObject(contextPath) : {};
  if (contextExists && document.schema !== INTELLIGENCE_LAUNCH_CONTEXT_SCHEMA) {
    throw new IntelligenceLaunchContextError('worker_intelligence_context_invalid', 'Unsupported intelligence launch context schema.', {
      path: contextPath,
      expected_schema: INTELLIGENCE_LAUNCH_CONTEXT_SCHEMA,
      actual_schema: document.schema ?? null,
    });
  }

  const targetSite = normalizeSiteId(processEnv.NARADA_INTELLIGENCE_TARGET_SITE ?? inferSiteId(sessionSiteRoot) ?? inferSiteId(userSiteRoot), 'target_site_id');
  const userSite = normalizeSiteId(document.user_site_id ?? processEnv.NARADA_INTELLIGENCE_USER_SITE ?? inferSiteId(userSiteRoot), 'user_site_id');
  const hostSite = normalizeSiteId(document.host_site_id ?? processEnv.NARADA_INTELLIGENCE_HOST_SITE ?? processEnv.NARADA_HOST_SITE_ID ?? processEnv.NARADA_PC_SITE_ID, 'host_site_id');
  const principal = normalizePrincipalId(document.principal_id ?? processEnv.NARADA_INTELLIGENCE_PRINCIPAL_ID);
  const principalBinding = normalizePrincipalBinding(document.principal_binding ?? processEnv.NARADA_INTELLIGENCE_PRINCIPAL_BINDING, principal);
  const registryPath = resolveConfiguredPath(document.registry_db_path, userSiteRoot)
    ?? (processEnv.NARADA_INTELLIGENCE_REGISTRY_DB?.trim() || null)
    ?? resolve(userSiteRoot, '.ai', 'intelligence-registry.db');
  const registryExists = registryDbExists(registryPath);
  const missing = [
    ['target_site_id', targetSite],
    ['user_site_id', userSite],
    ['host_site_id', hostSite],
    ['principal_id', principal],
    ['principal_binding', principalBinding],
    ['registry_db_file', registryExists ? true : null],
  ].filter(([, value]) => !value).map(([field]) => String(field));
  const ready = missing.length === 0;
  const environment: Record<string, string> = {};
  if (registryPath) environment.NARADA_INTELLIGENCE_REGISTRY_DB = registryPath;
  if (targetSite) environment.NARADA_INTELLIGENCE_TARGET_SITE = targetSite;
  if (userSite) environment.NARADA_INTELLIGENCE_USER_SITE = userSite;
  if (hostSite) environment.NARADA_INTELLIGENCE_HOST_SITE = hostSite;
  if (principal) environment.NARADA_INTELLIGENCE_PRINCIPAL_ID = principal;
  if (principalBinding) environment.NARADA_INTELLIGENCE_PRINCIPAL_BINDING = JSON.stringify(principalBinding);
  return {
    schema: INTELLIGENCE_LAUNCH_CONTEXT_SCHEMA,
    status: ready ? 'ready' : 'blocked',
    source: contextExists ? 'user_site_document' : 'explicit_environment_or_site_metadata',
    context_path: contextPath,
    context_exists: contextExists,
    registry_db_path: registryPath,
    registry_db_exists: registryExists,
    target_site: targetSite,
    user_site: userSite,
    host_site: hostSite,
    principal_id: principal,
    principal_binding_present: Boolean(principalBinding),
    missing,
    required_fields: REQUIRED_CONTEXT_FIELDS,
    environment,
  };
}

export function projectIntelligenceLaunchContext(context: IntelligenceLaunchContext): Record<string, string> {
  if (context.status !== 'ready') {
    throw diagnosticError('worker_intelligence_context_required', 'worker_intelligence_context_required', {
      context_path: context.context_path,
      missing: context.missing,
      required_fields: context.required_fields,
      user_site: context.user_site,
      target_site: context.target_site,
    });
  }
  return { ...context.environment };
}

export function publicIntelligenceLaunchContext(context: IntelligenceLaunchContext): Record<string, unknown> {
  const { environment: _environment, ...publicContext } = context;
  return publicContext;
}
