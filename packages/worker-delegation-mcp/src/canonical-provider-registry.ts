import { DatabaseSync } from 'node:sqlite';

type JsonRecord = Record<string, unknown>;

export type ProviderRegistrySource = 'legacy_json' | 'canonical_sqlite';

type ResourceRow = { id: string; kind: string; doc: string };
type PolicyRow = { doc: string };

type CanonicalOffering = {
  provider: string;
  model: string;
};

type CognitionDefault = {
  model: string;
  reasoning_effort: string;
};

const COGNITIONS = ['low', 'medium', 'high'] as const;

const PROVIDER_ENVIRONMENT = Object.freeze({
  'openai-api': { base: ['OPENAI_BASE_URL'], model: ['OPENAI_MODEL'], credential: ['OPENAI_API_KEY'] },
  'kimi-api': { base: ['KIMI_API_BASE_URL'], model: ['KIMI_MODEL'], credential: ['KIMI_API_KEY'] },
  'kimi-code-api': { base: ['KIMI_CODE_API_BASE_URL'], model: ['KIMI_CODE_MODEL'], credential: ['KIMI_CODE_API_KEY'] },
  'anthropic-api': { base: ['ANTHROPIC_BASE_URL'], model: ['ANTHROPIC_MODEL'], credential: ['ANTHROPIC_API_KEY'] },
  'deepseek-api': { base: ['DEEPSEEK_API_BASE_URL'], model: ['DEEPSEEK_MODEL'], credential: ['DEEPSEEK_API_KEY'] },
  'glm-api': { base: ['GLM_API_BASE_URL'], model: ['GLM_MODEL'], credential: ['GLM_API_KEY'] },
  'openrouter-api': { base: ['OPENROUTER_BASE_URL', 'OPENROUTER_API_BASE_URL'], model: ['OPENROUTER_MODEL'], credential: ['OPENROUTER_API_KEY'] },
  'codex-subscription': { base: [], model: ['CODEX_MODEL', 'NARADA_CODEX_MODEL'], credential: [] },
} as const);

/**
 * Read the canonical Site intelligence registry without mutating it and
 * project only the legacy provider-registry fields still required by the
 * worker surface. This is a compatibility read, not a second authority.
 */
export function readCanonicalProviderRegistry(databasePath: string): Record<string, unknown> {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const resources = db.prepare('SELECT id, kind, doc FROM resources ORDER BY kind, id').all() as unknown as ResourceRow[];
    const policies = db.prepare('SELECT doc FROM policies ORDER BY id LIMIT 1').all() as unknown as PolicyRow[];
    const documents = new Map<string, JsonRecord>();
    for (const row of resources) {
      const document = parseJsonRecord(row.doc, `resource:${row.id}`);
      documents.set(row.id, document);
    }

    const providerRows = resources.filter((row) => row.kind === 'inference-provider');
    if (providerRows.length === 0) throw new Error('canonical intelligence registry has no inference providers');

    const offerings = resources.flatMap((row): CanonicalOffering[] => {
      if (row.kind !== 'model-offering') return [];
      const document = documents.get(row.id) ?? {};
      const provider = suffixId(referenceId(document.inference_provider), 'inference-provider:');
      const model = stringValue(document.invocation_model_key);
      return provider && model ? [{ provider, model }] : [];
    });
    const endpoints = new Map<string, JsonRecord>();
    for (const row of resources.filter((candidate) => candidate.kind === 'inference-endpoint')) {
      const document = documents.get(row.id) ?? {};
      const provider = suffixId(referenceId(document.inference_provider), 'inference-provider:');
      if (provider) endpoints.set(provider, document);
    }

    const credentialLocators = new Map<string, JsonRecord>();
    for (const row of resources.filter((candidate) => candidate.kind === 'credential-locator')) {
      credentialLocators.set(row.id, documents.get(row.id) ?? {});
    }

    const cognitionDefaults = policyCognitionDefaults(policies, offerings);
    const providers: JsonRecord = {};
    for (const row of providerRows) {
      const provider = suffixId(row.id, 'inference-provider:');
      if (!provider) continue;
      const endpoint = endpoints.get(provider) ?? {};
      const endpointAddress = asRecord(endpoint.address);
      const adapter = suffixId(referenceId(endpoint.adapter), 'adapter:');
      const credentialId = referenceId(endpoint.credential);
      const credential = credentialId ? credentialLocators.get(credentialId) ?? {} : {};
      const models = uniqueStrings(offerings.filter((offering) => offering.provider === provider).map((offering) => offering.model));
      const defaults = cognitionDefaults[provider] ?? fallbackCognitionDefaults(models);
      const environment = PROVIDER_ENVIRONMENT[provider as keyof typeof PROVIDER_ENVIRONMENT] ?? { base: [], model: [], credential: [] };
      const credentialStore = stringValue(credential.store);
      const credentialReference = stringValue(credential.reference);
      const credentialRequirement = credentialStore === 'none'
        ? { kind: 'local_codex_subscription' }
        : credentialStore
          ? {
            kind: 'api_key_secret',
            ...(credentialReference ? { secret_ref: credentialReference } : {}),
            ...(environment.credential.length > 0 ? { env_names: [...environment.credential] } : {}),
          }
          : { kind: 'none' };
      const metadata = documents.get(row.id) ?? {};
      providers[provider] = {
        ...(asRecord(metadata.metadata).meaning ? { meaning: asRecord(metadata.metadata).meaning } : {}),
        base_url: canonicalBaseUrl(endpointAddress),
        default_model: defaults.low?.model ?? models[0] ?? null,
        default_thinking: defaults.low?.reasoning_effort ?? 'medium',
        available_models: models,
        cognition_defaults: defaults,
        adapter_kind: adapter ?? 'unknown',
        support_state: 'verified_supported',
        base_url_env_names: [...environment.base],
        model_env_names: [...environment.model],
        credential_env_names: [...environment.credential],
        ...(credentialReference ? { credential_secret_ref: credentialReference } : {}),
        credential_requirement: credentialRequirement,
      };
    }

    const defaultProvider = policyDefaultProvider(policies, Object.keys(providers));
    return {
      schema: 'narada.carrier.provider_registry.v1',
      ...(defaultProvider ? { default_provider: defaultProvider } : {}),
      providers,
    };
  } finally {
    db.close();
  }
}

function policyCognitionDefaults(policies: PolicyRow[], offerings: CanonicalOffering[]): Record<string, Record<string, CognitionDefault>> {
  const result: Record<string, Record<string, CognitionDefault>> = {};
  const providerIds = uniqueStrings(offerings.map((offering) => offering.provider));
  for (const provider of providerIds) {
    const models = offerings.filter((offering) => offering.provider === provider).map((offering) => offering.model);
    result[provider] = fallbackCognitionDefaults(models);
  }
  for (const policy of policies) {
    const document = parseJsonRecord(policy.doc, 'policy');
    const rules = Array.isArray(document.rules) ? document.rules : [];
    for (const cognition of COGNITIONS) {
      const routeRules = rules.filter((rule) => {
        const candidate = asRecord(rule);
        return candidate.option === `cognition.${cognition}.route` && typeof candidate.value === 'string';
      });
      const reasoningRules = rules.filter((rule) => {
        const candidate = asRecord(rule);
        return candidate.option === `cognition.${cognition}.reasoning_effort` && typeof candidate.value === 'string';
      });
      for (const [index, routeRule] of routeRules.entries()) {
        const route = stringValue(asRecord(routeRule).value);
        const reasoningEffort = stringValue(asRecord(reasoningRules[index]).value);
        if (!route || !reasoningEffort) continue;
        const parsedRoute = parseRoute(route, providerIds, offerings);
        if (!parsedRoute) continue;
        result[parsedRoute.provider] ??= {};
        result[parsedRoute.provider][cognition] = { model: parsedRoute.model, reasoning_effort: reasoningEffort };
      }
    }
  }
  return result;
}

function policyDefaultProvider(policies: PolicyRow[], providers: string[]): string | null {
  for (const policy of policies) {
    const document = parseJsonRecord(policy.doc, 'policy');
    const rules = Array.isArray(document.rules) ? document.rules : [];
    const route = rules.find((rule) => asRecord(rule).option === 'route');
    const value = stringValue(asRecord(route).value);
    if (!value) continue;
    const prefix = value.replace(/^route:/, '').replace(/-local$/, '');
    const provider = [...providers].sort((left, right) => right.length - left.length).find((candidate) => prefix.startsWith(`${candidate}-`));
    if (provider) return provider;
  }
  return providers[0] ?? null;
}

function parseRoute(route: string, providers: string[], offerings: CanonicalOffering[]): { provider: string; model: string } | null {
  const prefix = route.replace(/^route:/, '').replace(/-local$/, '');
  const provider = [...providers].sort((left, right) => right.length - left.length).find((candidate) => prefix.startsWith(`${candidate}-`));
  if (!provider) return null;
  const modelSlug = prefix.slice(provider.length + 1);
  const offering = offerings.find((candidate) => candidate.provider === provider && slug(candidate.model) === modelSlug);
  return offering ? { provider, model: offering.model } : null;
}

function fallbackCognitionDefaults(models: string[]): Record<string, CognitionDefault> {
  const model = models[0] ?? '';
  return Object.fromEntries(COGNITIONS.map((cognition) => [cognition, { model, reasoning_effort: cognition }])) as Record<string, CognitionDefault>;
}

function canonicalBaseUrl(address: JsonRecord): string {
  const url = stringValue(address.url);
  if (url) {
    try {
      const parsed = new URL(url);
      const suffixes = ['/v1/chat/completions', '/v1/messages', '/chat/completions', '/messages'];
      const suffix = suffixes.find((candidate) => parsed.pathname.endsWith(candidate));
      if (suffix) parsed.pathname = parsed.pathname.slice(0, -suffix.length) || '/';
      if (parsed.pathname !== '/' && !parsed.pathname.endsWith('/')) parsed.pathname += '/';
      return parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '' : '/');
    } catch {
      return url;
    }
  }
  const service = stringValue(address.service);
  return service ? 'codex://local-subscription' : '';
}

function parseJsonRecord(value: string, label: string): JsonRecord {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} document must be an object`);
  return parsed as JsonRecord;
}

function referenceId(value: unknown): string | null {
  const record = asRecord(value);
  return stringValue(record.id);
}

function suffixId(value: string | null, prefix: string): string | null {
  return value?.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
