import { DatabaseSync } from '@narada-core/sqlite';

type JsonRecord = Record<string, unknown>;
type DocumentRow = { doc: string };
type ResourceRow = { id: string; kind: string; doc: string };

export type CanonicalInvocationPlanBinding = {
  schema: 'narada.worker.canonical-invocation-plan-binding.v1';
  plan_ref: string;
  intent_ref: string;
  purpose: string;
  provider: string;
  provider_ref: string;
  model_ref: string;
  model_provider_ref: string;
  offering_ref: string;
  invocation_model_key: string;
  endpoint_ref: string;
  adapter_ref: string;
  credential_ref: string | null;
  options: JsonRecord;
  snapshot_digest: string;
  valid_until: string;
  governance_requirement_refs: string[];
};

export class CanonicalInvocationPlanError extends Error {
  readonly codeName: string;
  readonly details: JsonRecord;

  constructor(codeName: string, message: string, details: JsonRecord = {}) {
    super(message);
    this.name = 'CanonicalInvocationPlanError';
    this.codeName = codeName;
    this.details = details;
  }
}

export function readCanonicalInvocationPlan({
  databasePath,
  planRef,
  expectedPurpose,
  expectedTargetSite,
  now = new Date(),
}: {
  databasePath: string;
  planRef: string;
  expectedPurpose: string;
  expectedTargetSite: string;
  now?: Date;
}): CanonicalInvocationPlanBinding {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    throw new CanonicalInvocationPlanError(
      'worker_canonical_invocation_plan_store_unavailable',
      'The canonical invocation-plan store is unavailable.',
      { database_path: databasePath, cause: boundedError(error) },
    );
  }
  try {
    const plan = readRequiredDocument(
      database,
      'SELECT doc FROM invocation_plans WHERE id = ?',
      planRef,
      'worker_canonical_invocation_plan_not_found',
      'The requested canonical invocation plan does not exist.',
    );
    if (plan.schema !== 'narada.invokable-intelligence.invocation-plan.v2' || plan.id !== planRef) {
      throw invalidPlan(planRef, 'plan identity or schema is invalid');
    }
    const intentRef = requiredString(plan.intent_id, 'intent_id', planRef);
    const intent = readRequiredDocument(
      database,
      'SELECT doc FROM invocation_intents WHERE id = ?',
      intentRef,
      'worker_canonical_invocation_intent_not_found',
      'The canonical invocation plan has no durable intent.',
    );
    const purpose = requiredString(intent.purpose, 'intent.purpose', planRef);
    if (
      intent.schema !== 'narada.invokable-intelligence.invocation-intent.v1'
      || intent.id !== intentRef
      || purpose !== expectedPurpose
    ) {
      throw new CanonicalInvocationPlanError(
        'worker_canonical_invocation_plan_purpose_mismatch',
        'The canonical invocation plan is not admitted for this worker purpose.',
        { plan_ref: planRef, intent_ref: intentRef, expected_purpose: expectedPurpose, actual_purpose: purpose },
      );
    }

    const snapshot = requiredRecord(plan.snapshot, 'snapshot', planRef);
    if (snapshot.schema !== 'narada.invokable-intelligence.plan-decision-snapshot.v1') {
      throw invalidPlan(planRef, 'snapshot schema is invalid');
    }
    if (snapshot.plan_id !== planRef || snapshot.intent_id !== intentRef) {
      throw invalidPlan(planRef, 'snapshot identities do not match the plan');
    }
    const snapshotRow = readRequiredDocument(
      database,
      'SELECT doc FROM plan_decision_snapshots WHERE plan_id = ?',
      planRef,
      'worker_canonical_invocation_plan_snapshot_not_found',
      'The canonical invocation plan has no durable decision snapshot.',
    );
    if (canonicalJson(snapshotRow) !== canonicalJson(snapshot)) {
      throw invalidPlan(planRef, 'the plan and durable snapshot disagree');
    }
    const validUntil = requiredTimestamp(snapshot.valid_until, 'snapshot.valid_until', planRef);
    if (Date.parse(validUntil) <= now.getTime()) {
      throw new CanonicalInvocationPlanError(
        'worker_canonical_invocation_plan_expired',
        'The canonical invocation plan has expired and must be resolved again.',
        { plan_ref: planRef, valid_until: validUntil, evaluated_at: now.toISOString() },
      );
    }
    const snapshotDigest = requiredString(snapshot.snapshot_digest, 'snapshot.snapshot_digest', planRef);
    if (!/^sha256:[a-f0-9]{64}$/i.test(snapshotDigest)) throw invalidPlan(planRef, 'snapshot digest is invalid');

    const selected = requiredRecord(plan.selected, 'selected', planRef);
    const route = requiredRecord(plan.route, 'route', planRef);
    const providerRef = requiredReference(selected.inference_provider, 'inference-provider', 'selected.inference_provider', planRef);
    const modelRef = requiredReference(selected.model, 'model', 'selected.model', planRef);
    const modelProviderRef = requiredReference(selected.model_provider, 'model-provider', 'selected.model_provider', planRef);
    const endpointRef = requiredReference(selected.endpoint, 'inference-endpoint', 'selected.endpoint', planRef);
    const adapterRef = requiredReference(selected.adapter, 'adapter', 'selected.adapter', planRef);
    const offeringRef = requiredReference(route.offering, 'model-offering', 'route.offering', planRef);
    if (
      requiredReference(route.endpoint, 'inference-endpoint', 'route.endpoint', planRef) !== endpointRef
      || requiredReference(route.adapter, 'adapter', 'route.adapter', planRef) !== adapterRef
    ) {
      throw invalidPlan(planRef, 'selected and route endpoint or adapter differ');
    }
    const credentialRef = selected.credential === undefined
      ? null
      : requiredReference(selected.credential, 'credential-locator', 'selected.credential', planRef);
    const provider = providerRef.slice('inference-provider:'.length);

    const offering = readResource(database, offeringRef, 'model-offering', planRef);
    if (
      requiredReference(offering.inference_provider, 'inference-provider', 'offering.inference_provider', planRef) !== providerRef
      || requiredReference(offering.model, 'model', 'offering.model', planRef) !== modelRef
      || requiredReference(offering.model_provider, 'model-provider', 'offering.model_provider', planRef) !== modelProviderRef
      || requiredReference(offering.endpoint, 'inference-endpoint', 'offering.endpoint', planRef) !== endpointRef
    ) {
      throw invalidPlan(planRef, 'selected resources do not match the offering');
    }
    readResource(database, providerRef, 'inference-provider', planRef);
    readResource(database, modelRef, 'model', planRef);
    const invocationModelKey = requiredString(offering.invocation_model_key, 'offering.invocation_model_key', planRef);

    const access = requiredRecord(plan.access, 'access', planRef);
    const governanceRequirementRefs = requiredStringArray(
      access.governance_requirement_ids,
      'access.governance_requirement_ids',
      planRef,
    );
    const referencedRevisions = Array.isArray(snapshot.referenced_revisions)
      ? snapshot.referenced_revisions.map((value) => requiredRecord(value, 'snapshot.referenced_revisions[]', planRef))
      : [];
    const targetGovernance = governanceRequirementRefs.some((requirementRef) => {
      const revision = referencedRevisions.find((candidate) => candidate.record_id === requirementRef);
      const immutableRef = typeof revision?.immutable_ref === 'string' ? revision.immutable_ref : null;
      if (!immutableRef) return false;
      const catalogRecord = readOptionalDocument(database, 'SELECT doc FROM catalog_records WHERE id = ?', immutableRef);
      const document = catalogRecord ? asRecord(catalogRecord.document) : {};
      const purposes = Array.isArray(document.purposes) ? document.purposes : [];
      return document.schema === 'narada.invokable-intelligence.data-governance-requirement.v1'
        && document.id === requirementRef
        && document.target_site_id === expectedTargetSite
        && purposes.includes(expectedPurpose);
    });
    if (!targetGovernance) {
      throw new CanonicalInvocationPlanError(
        'worker_canonical_invocation_plan_target_mismatch',
        'The canonical invocation plan is not bound to this target Site and worker purpose.',
        {
          plan_ref: planRef,
          expected_target_site: expectedTargetSite,
          expected_purpose: expectedPurpose,
          governance_requirement_refs: governanceRequirementRefs,
        },
      );
    }

    return {
      schema: 'narada.worker.canonical-invocation-plan-binding.v1',
      plan_ref: planRef,
      intent_ref: intentRef,
      purpose,
      provider,
      provider_ref: providerRef,
      model_ref: modelRef,
      model_provider_ref: modelProviderRef,
      offering_ref: offeringRef,
      invocation_model_key: invocationModelKey,
      endpoint_ref: endpointRef,
      adapter_ref: adapterRef,
      credential_ref: credentialRef,
      options: requiredObjectRecord(plan.options, 'options', planRef),
      snapshot_digest: snapshotDigest,
      valid_until: validUntil,
      governance_requirement_refs: governanceRequirementRefs,
    };
  } finally {
    database.close();
  }
}

function readResource(database: DatabaseSync, id: string, kind: string, planRef: string): JsonRecord {
  const row = database.prepare('SELECT id, kind, doc FROM resources WHERE id = ?').get(id) as ResourceRow | undefined;
  if (!row || row.id !== id || row.kind !== kind) throw invalidPlan(planRef, `required ${kind} resource '${id}' is absent`);
  const document = parseDocument(row.doc, `resource:${id}`);
  if (document.id !== id) throw invalidPlan(planRef, `resource '${id}' identity disagrees with its row`);
  return document;
}

function readRequiredDocument(
  database: DatabaseSync,
  sql: string,
  id: string,
  codeName: string,
  message: string,
): JsonRecord {
  const document = readOptionalDocument(database, sql, id);
  if (!document) throw new CanonicalInvocationPlanError(codeName, message, { ref: id });
  return document;
}

function readOptionalDocument(database: DatabaseSync, sql: string, id: string): JsonRecord | null {
  const row = database.prepare(sql).get(id) as DocumentRow | undefined;
  return row ? parseDocument(row.doc, id) : null;
}

function parseDocument(value: string, label: string): JsonRecord {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as JsonRecord;
  } catch (error) {
    throw new CanonicalInvocationPlanError(
      'worker_canonical_invocation_plan_store_invalid',
      'The canonical invocation-plan store contains an invalid document.',
      { document: label, cause: boundedError(error) },
    );
  }
}

function requiredRecord(value: unknown, field: string, planRef: string): JsonRecord {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) throw invalidPlan(planRef, `${field} must be an object`);
  return record;
}

function requiredObjectRecord(value: unknown, field: string, planRef: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidPlan(planRef, `${field} must be an object`);
  }
  return value as JsonRecord;
}

function requiredReference(value: unknown, kind: string, field: string, planRef: string): string {
  const record = requiredRecord(value, field, planRef);
  const id = requiredString(record.id, `${field}.id`, planRef);
  if (record.kind !== kind || !id.startsWith(`${kind}:`)) throw invalidPlan(planRef, `${field} must be a ${kind} reference`);
  return id;
}

function requiredString(value: unknown, field: string, planRef: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidPlan(planRef, `${field} must be a non-empty string`);
  return value.trim();
}

function requiredStringArray(value: unknown, field: string, planRef: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw invalidPlan(planRef, `${field} must be a non-empty string array`);
  return value.map((entry) => requiredString(entry, `${field}[]`, planRef));
}

function requiredTimestamp(value: unknown, field: string, planRef: string): string {
  const timestamp = requiredString(value, field, planRef);
  if (!Number.isFinite(Date.parse(timestamp))) throw invalidPlan(planRef, `${field} must be a valid timestamp`);
  return timestamp;
}

function invalidPlan(planRef: string, reason: string): CanonicalInvocationPlanError {
  return new CanonicalInvocationPlanError(
    'worker_canonical_invocation_plan_invalid',
    'The canonical invocation plan is invalid.',
    { plan_ref: planRef, reason },
  );
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonRecord)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
