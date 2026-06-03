type InboxRecord = Record<string, unknown>;

function asRecord(value: unknown): InboxRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as InboxRecord : {};
}

export function normalizeTitle(title: unknown): string {
  return String(title ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function classifyEnvelope(envelope: unknown): { categories: string[]; recommendation: string } {
  const envelopeRecord = asRecord(envelope);
  const payload = asRecord(envelopeRecord.payload);
  const title = normalizeTitle(payload.title ?? envelopeRecord.title ?? '');
  const summary = normalizeTitle(payload.summary ?? '');
  const text = `${title} ${summary}`;
  const kind = envelopeRecord.kind ?? 'unknown';
  const recommendation = String(payload.recommendation ?? '').toLowerCase();
  const hasCapaRequest = payload.capa_request && typeof payload.capa_request === 'object';
  const keywordMap: Record<string, RegExp> = {
    review_request: /\breview\b.*\btask\b|\breview\b.*\brequest\b/,
    mcp_gap: /\bmcp gap\b|\bmcp.*missing\b|\bmcp.*lack\b/,
    capa: /\bcapa\b.*\b(recurrence|recurring|regression|incident|failure|failed|broken|blocked|missing|risk|error|violation|drift|gap|cannot|can't|stale)\b|\b(recurrence|recurring|regression|incident|failure|failed|broken|blocked|missing|risk|error|violation|drift|gap|cannot|can't|stale)\b.*\bcapa\b/,
    doctrinal_drift: /\bdoctrinal drift\b|\bdoctrine\b.*\bdrift\b/,
    ergonomics: /\bergonomics\b|\bergonomic\b/,
    operator_surface: /\boperator surface\b|\bkomorebi\b|\byasb\b/,
    git_hygiene: /\bgit\b.*\bdirty\b|\bunpushed\b|\bdivergence\b/,
    inbox_pipeline: /\binbox\b.*\btriage\b|\binbox\b.*\bpipeline\b|\binbox backlog\b/,
    task_lifecycle: /\btask lifecycle\b|\btask governance\b/,
    builder_idle: /\bbuilder idle\b|\bno claimable\b|\bno tasks\b/,
  };
  const categories: string[] = [];
  for (const [category, pattern] of Object.entries(keywordMap)) {
    if (pattern.test(text)) categories.push(category);
  }
  if (hasCapaRequest && !categories.includes('capa_request')) categories.push('capa_request');
  if (kind === 'incident' && !categories.includes('incident')) categories.push('incident');
  if (categories.length === 0) {
    if (kind === 'proposal') categories.push('proposal');
    else if (kind === 'incident') categories.push('incident');
    else if (kind === 'command_request') categories.push('command_request');
    else categories.push('general');
  }
  return { categories, recommendation };
}

export function evaluateEnvelopeSeverity(envelope: unknown): unknown {
  const envelopeRecord = asRecord(envelope);
  if (envelopeRecord.target_role) {
    const explicitSeverity = typeof envelopeRecord.severity === 'number' ? envelopeRecord.severity : 50;
    return {
      severity: explicitSeverity,
      action: 'materialize',
      targetRole: envelopeRecord.target_role,
      relativePriority: explicitSeverity,
      reason: 'explicit_target_role',
    };
  }

  const kind = envelopeRecord.kind ?? 'observation';
  const authority = asRecord(envelopeRecord.authority).level ?? 'agent_reported';
  const payload = asRecord(envelopeRecord.payload);
  const recommendation = String(payload.recommendation ?? '');
  const proposals = Array.isArray(payload.proposal) ? payload.proposal : [];

  if (kind === 'incident') {
    return { severity: 90, action: 'materialize', targetRole: 'architect', relativePriority: 90, reason: 'incident_always_materializes' };
  }
  if (payload.capa_request && typeof payload.capa_request === 'object') {
    const severity = authority === 'operator_confirmed' || authority === 'operator_directed' ? 75 : 60;
    return { severity, action: 'review_capa_request', targetRole: 'architect', relativePriority: severity, reason: 'capa_request_requires_promotion_review' };
  }
  if (kind === 'observation') {
    if (recommendation.toLowerCase().includes('address before next operational cycle')) {
      return { severity: 70, action: 'materialize', targetRole: 'architect', relativePriority: 70, reason: 'observation_urgent_recommendation' };
    }
    if (proposals.length >= 3) return { severity: 50, action: 'materialize', targetRole: 'architect', relativePriority: 50, reason: 'observation_many_proposals' };
    if (proposals.length >= 1) return { severity: 30, action: 'materialize', targetRole: 'architect', relativePriority: 30, reason: 'observation_some_proposals' };
    return { severity: 20, action: 'materialize', targetRole: 'architect', relativePriority: 20, reason: 'observation_low_severity' };
  }
  if (kind === 'proposal') return { severity: 40, action: 'materialize', targetRole: 'architect', relativePriority: 40, reason: 'proposal_architect_triage' };
  if (kind === 'command_request') return { severity: 45, action: 'materialize', targetRole: 'architect', relativePriority: 45, reason: 'command_request_architect_triage' };
  return { severity: 20, action: 'materialize', targetRole: 'architect', relativePriority: 20, reason: 'default_architect_triage' };
}
