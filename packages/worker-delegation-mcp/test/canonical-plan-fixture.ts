import { DatabaseSync } from 'node:sqlite';

export function writeCanonicalPlanRegistry({
  databasePath,
  planRef,
  targetSite,
  principal = 'principal:test',
  provider = 'kimi-code-api',
  model = 'fixture-model',
  purpose = 'local-agent-runtime',
  validUntil = '2099-01-01T00:00:00.000Z',
  planOptions = { thinking: 'high' },
}: {
  databasePath: string;
  planRef: string;
  targetSite: string;
  principal?: string;
  provider?: string;
  model?: string;
  purpose?: string;
  validUntil?: string;
  planOptions?: Record<string, unknown>;
}): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE invocation_intents (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE invocation_plans (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE plan_decision_snapshots (plan_id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE resources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE catalog_records (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE policies (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
    `);
    const intentRef = `intent:${planRef.slice('plan:'.length)}`;
    const providerRef = `inference-provider:${provider}`;
    const modelRef = `model:${model}`;
    const modelProviderRef = 'model-provider:fixture';
    const offeringRef = `model-offering:${provider}-${model}`;
    const endpointRef = `inference-endpoint:${provider}`;
    const adapterRef = 'adapter:fixture';
    const governanceRef = `governance:${targetSite.slice('site:'.length)}:${provider}`;
    const governanceRevisionRef = `catalog-record:${governanceRef}:1`;
    const createdAt = '2026-07-31T00:00:00.000Z';
    const snapshot = {
      schema: 'narada.invokable-intelligence.plan-decision-snapshot.v1',
      plan_id: planRef,
      intent_id: intentRef,
      resolved_at: createdAt,
      clock: {
        source: 'execution-site-clock',
        authority_ref: 'test:worker-plan',
        instant: createdAt,
        timezone: 'UTC',
        local: { date: '2026-07-31', time: '00:00:00', weekday: 5 },
      },
      resolver_version: 'test',
      digests: {},
      snapshot_digest: `sha256:${'1'.repeat(64)}`,
      valid_until: validUntil,
      revalidation_triggers: ['at-scheduled-window'],
      referenced_revisions: [{
        kind: 'access',
        record_id: governanceRef,
        revision: '1:test',
        digest: `sha256:${'2'.repeat(64)}`,
        immutable_ref: governanceRevisionRef,
      }],
      lineage: { relation: 'initial' },
    };
    const intent = {
      schema: 'narada.invokable-intelligence.invocation-intent.v1',
      id: intentRef,
      created_at: createdAt,
      principal,
      purpose,
    };
    const plan = {
      schema: 'narada.invokable-intelligence.invocation-plan.v2',
      id: planRef,
      intent_id: intentRef,
      created_at: createdAt,
      resolver_version: 'test',
      selected: {
        model: { kind: 'model', id: modelRef },
        model_provider: { kind: 'model-provider', id: modelProviderRef },
        inference_provider: { kind: 'inference-provider', id: providerRef },
        endpoint: { kind: 'inference-endpoint', id: endpointRef },
        adapter: { kind: 'adapter', id: adapterRef },
      },
      route: {
        offering: { kind: 'model-offering', id: offeringRef },
        route_id: `route:${provider}-${model}`,
        composition_digest: `sha256:${'3'.repeat(64)}`,
        topology_id: 'topology:fixture',
        endpoint: { kind: 'inference-endpoint', id: endpointRef },
        adapter: { kind: 'adapter', id: adapterRef },
        execution_loci: [{ kind: 'execution-locus', id: 'execution-locus:fixture' }],
        account_ref: `account:${provider}`,
        grant_refs: [`grant:${provider}`],
      },
      access: {
        account_id: `account:${provider}`,
        grant_id: `grant:${provider}`,
        entitlement_id: `entitlement:${provider}-${model}`,
        quota_id: `quota:${provider}-${model}`,
        budget_id: `budget:${targetSite.slice('site:'.length)}:${provider}`,
        governance_requirement_ids: [governanceRef],
      },
      authority_provenance: { schema: 'narada.invokable-intelligence.authority-resolution-provenance.v1', decisions: [] },
      snapshot,
      options: planOptions,
      provenance: { applied_constraints: [], applied_preferences: [], applied_defaults: [], rejected_candidates: [] },
    };
    const resources = [
      { id: providerRef, kind: 'inference-provider', schema: 'narada.invokable-intelligence.inference-provider.v1' },
      { id: modelRef, kind: 'model', schema: 'narada.invokable-intelligence.model.v1', provider: { kind: 'model-provider', id: modelProviderRef } },
      {
        id: offeringRef,
        kind: 'model-offering',
        schema: 'narada.invokable-intelligence.model-offering.v1',
        model: { kind: 'model', id: modelRef },
        model_provider: { kind: 'model-provider', id: modelProviderRef },
        inference_provider: { kind: 'inference-provider', id: providerRef },
        endpoint: { kind: 'inference-endpoint', id: endpointRef },
        invocation_model_key: model,
      },
      {
        id: endpointRef,
        kind: 'inference-endpoint',
        schema: 'narada.invokable-intelligence.inference-endpoint.v1',
        inference_provider: { kind: 'inference-provider', id: providerRef },
        adapter: { kind: 'adapter', id: adapterRef },
        address: { kind: 'runtime-service', service: 'fixture' },
      },
    ];
    const insertDocument = (table: string, idColumn: string, id: string, document: object) => {
      database.prepare(`INSERT INTO ${table} (${idColumn}, doc) VALUES (?, ?)`).run(id, JSON.stringify(document));
    };
    insertDocument('invocation_intents', 'id', intentRef, intent);
    insertDocument('invocation_plans', 'id', planRef, plan);
    insertDocument('plan_decision_snapshots', 'plan_id', planRef, snapshot);
    const insertResource = database.prepare('INSERT INTO resources (id, kind, doc) VALUES (?, ?, ?)');
    for (const resource of resources) insertResource.run(resource.id, resource.kind, JSON.stringify(resource));
    database.prepare('INSERT INTO policies (id, doc) VALUES (?, ?)').run(
      `policy:${targetSite}:${provider}`,
      JSON.stringify({
        schema: 'narada.invokable-intelligence.policy.v1',
        id: `policy:${targetSite}:${provider}`,
        rules: [
          { option: 'route', value: `route:${provider}-${model}-local` },
          { option: 'cognition.low.route', value: `route:${provider}-${model}-local` },
          { option: 'cognition.low.reasoning_effort', value: 'low' },
          { option: 'cognition.medium.route', value: `route:${provider}-${model}-local` },
          { option: 'cognition.medium.reasoning_effort', value: 'medium' },
          { option: 'cognition.high.route', value: `route:${provider}-${model}-local` },
          { option: 'cognition.high.reasoning_effort', value: 'high' },
        ],
      }),
    );
    const governance = {
      schema: 'narada.invokable-intelligence.data-governance-requirement.v1',
      id: governanceRef,
      target_site_id: targetSite,
      purposes: [purpose],
    };
    database.prepare('INSERT INTO catalog_records (id, record_id, doc) VALUES (?, ?, ?)').run(
      governanceRevisionRef,
      governanceRef,
      JSON.stringify({ id: governanceRevisionRef, record_id: governanceRef, document: governance }),
    );
  } finally {
    database.close();
  }
}
