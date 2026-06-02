export function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prev = new Array(n + 1);
  const curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= n; j++) {
      prev[j] = curr[j];
    }
  }

  return prev[n];
}

export function normalizeTitle(title) {
  return String(title ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function classifyEnvelope(envelope) {
  const title = normalizeTitle(envelope.payload?.title ?? envelope.title ?? '');
  const summary = normalizeTitle(envelope.payload?.summary ?? '');
  const text = `${title} ${summary}`;
  const kind = envelope.kind ?? 'unknown';
  const recommendation = String(envelope.payload?.recommendation ?? '').toLowerCase();
  const hasCapaRequest = envelope.payload?.capa_request && typeof envelope.payload.capa_request === 'object';

  const categories = [];
  const recurrenceEvidencePattern = /\b(recurrence|recurring|regression|incident|failure|failed|broken|blocked|missing|risk|error|violation|drift|gap|cannot|can't|stale)\b/;
  const keywordMap = {
    review_request: /\breview\b.*\btask\b|\breview\b.*\brequest\b/,
    dogfood_proof: /\bdogfood\b|\bproof\b|\blive proof\b/,
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

  for (const [category, pattern] of Object.entries(keywordMap)) {
    if (pattern.test(text)) {
      categories.push(category);
    }
  }
  if (hasCapaRequest && !categories.includes('capa_request')) categories.push('capa_request');
  if (kind === 'incident' && !categories.includes('incident')) categories.push('incident');
  if (/\brecurrence\b|\brecurring\b/.test(text) && recurrenceEvidencePattern.test(text) && !categories.includes('capa_request')) {
    categories.push('capa_request');
  }

  if (categories.length === 0) {
    if (kind === 'proposal') categories.push('proposal');
    else if (kind === 'incident') categories.push('incident');
    else if (kind === 'command_request') categories.push('command_request');
    else categories.push('general');
  }

  return { categories, recommendation };
}

export function determineTargetRole(envelope, categories) {
  const explicit = envelope.payload?.target_role ?? envelope.target_role ?? null;
  if (explicit) return explicit;

  if (categories.includes('capa_request') || categories.includes('incident')) return 'architect';
  if (categories.includes('doctrinal_drift') || categories.includes('proposal')) return 'architect';
  if (categories.includes('operator_surface')) return 'operator';
  if (categories.includes('mcp_gap') || categories.includes('task_lifecycle')) return 'architect';
  if (categories.includes('inbox_pipeline')) return 'architect';
  if (categories.includes('review_request')) return 'architect';
  if (categories.includes('ergonomics')) return 'builder';
  if (categories.includes('builder_idle')) return 'architect';
  if (categories.includes('git_hygiene')) return 'builder';
  return 'architect';
}

export function determineAction(envelope, categories, recommendation, ageHours, duplicateInfo) {
  if (duplicateInfo.isDuplicate) return 'acknowledge_duplicate';

  const kind = envelope.kind ?? 'unknown';
  const title = normalizeTitle(envelope.payload?.title ?? envelope.title ?? '');

  const statusReportPatterns = /\bbuilder session complete\b|\bbuilder idle\b|\binbox backlog check\b|\bworkboard check\b|\bno tasks available\b|\bno claimable\b|\bchecking for materializable\b/;
  if (statusReportPatterns.test(title)) return 'acknowledge';

  if (recommendation === 'acknowledge') return 'acknowledge';
  if (recommendation === 'dismiss') return 'archive';
  if (recommendation === 'escalate') return 'materialize';

  if (categories.includes('review_request') && ageHours > 48) return 'acknowledge';
  if (categories.includes('dogfood_proof') && ageHours > 24) return 'acknowledge';

  if (kind === 'incident') return 'materialize';
  if (categories.includes('capa_request')) return 'review_capa_request';
  if (categories.includes('incident')) return 'materialize';

  if (kind === 'proposal') return 'review';

  if (kind === 'observation') {
    const hasProposals = Array.isArray(envelope.payload?.proposal) && envelope.payload.proposal.length > 0;
    if (hasProposals) {
      return ageHours < 72 ? 'materialize' : 'acknowledge';
    }
    if (ageHours > 48) return 'acknowledge';
    return 'triage';
  }

  if (kind === 'command_request') {
    return ageHours > 72 ? 'acknowledge' : 'materialize';
  }

  if (ageHours > 168) return 'acknowledge';

  return 'triage';
}

export function evaluateEnvelopeSeverity(envelope) {
  if (envelope.target_role) {
    const explicitSeverity = envelope.severity ?? 50;
    return {
      severity: explicitSeverity,
      action: 'materialize',
      targetRole: envelope.target_role,
      relativePriority: explicitSeverity,
      reason: 'explicit_target_role',
    };
  }

  const kind = envelope.kind ?? 'observation';
  const authority = envelope.authority?.level ?? 'agent_reported';
  const payload = envelope.payload ?? {};
  const recommendation = String(payload.recommendation ?? '');
  const proposals = Array.isArray(payload.proposal) ? payload.proposal : [];

  if (kind === 'incident') {
    return {
      severity: 90,
      action: 'materialize',
      targetRole: 'architect',
      relativePriority: 90,
      reason: 'incident_always_materializes',
    };
  }

  if (payload.capa_request && typeof payload.capa_request === 'object') {
    const severity = authority === 'operator_confirmed' || authority === 'operator_directed' ? 75 : 60;
    return {
      severity,
      action: 'review_capa_request',
      targetRole: 'architect',
      relativePriority: severity,
      reason: 'capa_request_requires_promotion_review',
    };
  }

  if (kind === 'observation') {
    if (recommendation.toLowerCase().includes('address before next operational cycle')) {
      return {
        severity: 70,
        action: 'materialize',
        targetRole: 'architect',
        relativePriority: 70,
        reason: 'observation_urgent_recommendation',
      };
    }
    if (proposals.length >= 3) {
      return {
        severity: 50,
        action: 'materialize',
        targetRole: 'architect',
        relativePriority: 50,
        reason: 'observation_many_proposals',
      };
    }
    if (proposals.length >= 1) {
      return {
        severity: 30,
        action: 'materialize',
        targetRole: 'architect',
        relativePriority: 30,
        reason: 'observation_some_proposals',
      };
    }
    return {
      severity: 20,
      action: 'materialize',
      targetRole: 'architect',
      relativePriority: 20,
      reason: 'observation_low_severity',
    };
  }

  if (kind === 'proposal') {
    return {
      severity: 40,
      action: 'materialize',
      targetRole: 'architect',
      relativePriority: 40,
      reason: 'proposal_architect_triage',
    };
  }

  if (kind === 'command_request') {
    return {
      severity: 45,
      action: 'materialize',
      targetRole: 'architect',
      relativePriority: 45,
      reason: 'command_request_architect_triage',
    };
  }

  return {
    severity: 20,
    action: 'materialize',
    targetRole: 'architect',
    relativePriority: 20,
    reason: 'default_architect_triage',
  };
}

export function matchNormalizedTitles(a, b, options = {}) {
  const absoluteThreshold = options.absoluteThreshold ?? 10;
  const normalizedThreshold = options.normalizedThreshold ?? 0.25;
  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  const normalized = maxLen > 0 ? distance / maxLen : 0;

  return {
    matched: distance < absoluteThreshold || normalized < normalizedThreshold,
    distance,
    normalized,
  };
}

export function findDuplicateInTitleIndex(titleIndex, title) {
  const normTitle = normalizeTitle(title);
  if (normTitle.length === 0) {
    return { isDuplicate: false };
  }

  for (const existing of titleIndex) {
    const result = matchNormalizedTitles(normTitle, existing.normTitle, {
      absoluteThreshold: 5,
      normalizedThreshold: 0.15,
    });
    if (result.matched) {
      return {
        isDuplicate: true,
        duplicateOf: existing.envelopeId,
        matchType: 'title_similarity',
        distance: result.distance,
        normalized: result.normalized,
      };
    }
  }

  return { isDuplicate: false };
}

export function findDuplicateTaskRows(taskRows, envelope) {
  const envelopeId = envelope.envelope_id;
  const title = String(envelope.payload?.title ?? envelope.title ?? '').trim();

  for (const row of taskRows) {
    if (hasEnvelopeCoverageEvidence(row, envelopeId)) {
      return {
        isDuplicate: true,
        duplicateTaskId: row.task_id,
        duplicateTaskNumber: Number(row.task_number),
        duplicateOf: `task:${row.task_number}`,
        matchType: 'envelope_id_in_context',
      };
    }
  }

  const normTitle = normalizeTitle(title);
  if (normTitle.length > 0) {
    for (const row of taskRows) {
      const taskTitle = String(row.title ?? '').trim();
      const normTaskTitle = normalizeTitle(taskTitle);
      if (normTaskTitle.length === 0) continue;
      const result = matchNormalizedTitles(normTitle, normTaskTitle);
      if (result.matched) {
        return {
          isDuplicate: true,
          duplicateTaskId: row.task_id,
          duplicateTaskNumber: Number(row.task_number),
          duplicateOf: `task:${row.task_number}`,
          matchType: 'title_similarity',
          distance: result.distance,
          normalized: result.normalized,
        };
      }
    }
  }

  return {
    isDuplicate: false,
    duplicateTaskId: null,
    duplicateTaskNumber: null,
    duplicateOf: null,
    matchType: null,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasEnvelopeCoverageEvidence(row, envelopeId) {
  if (!envelopeId || String(envelopeId).length < 8) return false;

  const context = String(row?.context_markdown ?? '');
  const envelopePattern = escapeRegExp(envelopeId);
  const hasCanonicalEnvelopeMarker = new RegExp(
    `(^|\\n)\\s*\\*\\*Envelope ID:\\*\\*\\s*${envelopePattern}(\\s|$)`,
    'i',
  ).test(context);
  const hasLegacyCreatedFromMarker = new RegExp(
    `\\bTask created from (an )?(inbox )?envelope\\s+${envelopePattern}\\b`,
    'i',
  ).test(context);

  if (!hasCanonicalEnvelopeMarker && !hasLegacyCreatedFromMarker) return false;
  return !hasPreservedResidualEvidence(row, envelopeId);
}

export function hasPreservedResidualEvidence(row, envelopeId) {
  const fields = [
    row?.context_markdown,
    row?.required_work_markdown,
    row?.non_goals_markdown,
    row?.goal_markdown,
  ].map((value) => String(value ?? ''));
  const text = fields.join('\n').toLowerCase();
  if (!text.includes(String(envelopeId).toLowerCase())) return false;

  return [
    'follow-up ledger',
    'residual',
    'non-goal',
    'non-goaled',
    'out of scope',
    'preserved follow-up',
    'preserves remaining',
    'remaining work',
    'deferred:',
  ].some((marker) => text.includes(marker));
}
