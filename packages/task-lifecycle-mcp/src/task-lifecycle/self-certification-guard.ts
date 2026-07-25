type TaskLifecyclePayload = Record<string, unknown>;

const TARGET_CATEGORIES: any = Object.freeze([
  'architect_failure',
  'deception_trust',
  'misleading_completion',
  'self_certification',
]);

const NON_TARGET_CATEGORY: any = 'non_target_low_risk';

const ALLOWED_PENDING_STATES: any = Object.freeze([
  'review_required',
  'corrective_complete_pending_review',
  'blocked_missing_reviewer',
  'blocked_missing_policy_gate',
  'terminal_blocked_missing_enforcement',
  'operator_acceptance_required',
  NON_TARGET_CATEGORY,
]);

const TERMINAL_STATES: any = Object.freeze([
  'corrected',
  'closed',
  'accepted',
  'terminal_corrected',
  'terminal_complete',
  'no_residuals',
]);

const REQUIRED_TARGET_FIELDS: any = Object.freeze([
  'target_category',
  'subject_principal',
  'requires_independent_review',
  'misleading_completion_answer',
  'allowed_pending_state',
]);

function text(value: any) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function normalizePrincipal(value: any) {
  return text(value).trim().toLowerCase();
}

function normalizeCategory(value: any) {
  const category: any = text(value).trim().toLowerCase().replace(/[-\s/]+/g, '_');
  if (['architect_failure', 'architect_duty_failure', 'authority_failure'].includes(category)) return 'architect_failure';
  if (['deception_trust', 'trust_deception', 'operator_trust', 'deception', 'trust'].includes(category)) return 'deception_trust';
  if (['misleading_completion', 'false_completion', 'misleading_closeout'].includes(category)) return 'misleading_completion';
  if (['self_certification', 'same_subject_self_certification'].includes(category)) return 'self_certification';
  if (['non_target', 'low_risk', 'non_target_low_risk', 'routine'].includes(category)) return NON_TARGET_CATEGORY;
  return category;
}

function combinedText(packet: any) {
  return [
    packet.title,
    packet.summary,
    packet.context,
    packet.body,
    packet.evidence,
    packet.closeout_text,
    packet.operator_summary,
    packet.misleading_completion_answer,
  ].map(text).join('\n');
}

function inferTargetCategory(packet: any) {
  const explicit: any = normalizeCategory(packet.target_category ?? packet.capa_category ?? packet.category);
  if (TARGET_CATEGORIES.includes(explicit) || explicit === NON_TARGET_CATEGORY) return explicit;
  const haystack: any = combinedText(packet);
  if (/\b(architect[-\s]?failure|architect duty failure|architect[-\s]?duty)\b/i.test(haystack)) return 'architect_failure';
  if (/\b(deceiv|deception|mislead|trust[-\s]?repair|operator trust)\b/i.test(haystack)) return 'deception_trust';
  if (/\b(false complete|misleading completion|misleading closeout|terminal correction claim)\b/i.test(haystack)) return 'misleading_completion';
  if (/\b(self[-\s]?certification|same[-\s]?subject)\b/i.test(haystack)) return 'self_certification';
  return NON_TARGET_CATEGORY;
}

function hasTerminalClaim(packet: any) {
  if (packet.terminal_correction_claim === true) return true;
  const state: any = normalizeCategory(packet.closure_state ?? packet.state ?? packet.claimed_state);
  if (TERMINAL_STATES.includes(state)) return true;
  const haystack: any = combinedText(packet);
  if (/\b(corrected|fully\s+corrected|terminal(?:ly)?\s+complete|no\s+residuals?|closed\s+as\s+corrected|accepted\s+as\s+corrected)\b/i.test(haystack)) {
    return !/\b(pending\s+review|review\s+required|blocked|remaining|residual|not\s+terminal|not\s+corrected|corrective[_\s-]complete[_\s-]pending[_\s-]review)\b/i.test(haystack);
  }
  return false;
}

function hasIndependentReview(packet: any) {
  const reviewer: any = normalizePrincipal(packet.reviewer_principal);
  const subject: any = normalizePrincipal(packet.subject_principal);
  return Boolean(
    packet.independent_review_ref
    && packet.reviewer_eligibility_ref
    && reviewer
    && reviewer !== subject
  );
}

function hasOperatorAcceptance(packet: any) {
  return text(packet.operator_acceptance_ref).trim().length > 0;
}

function parseSelfCertificationSection(section: any) {
  if (!section) return {};
  const aliases: any = new Map([
    ['target category', 'target_category'],
    ['target_category', 'target_category'],
    ['capa category', 'target_category'],
    ['subject principal', 'subject_principal'],
    ['subject_principal', 'subject_principal'],
    ['actor principal', 'actor_principal'],
    ['actor_principal', 'actor_principal'],
    ['closer principal', 'actor_principal'],
    ['reviewer principal', 'reviewer_principal'],
    ['reviewer_principal', 'reviewer_principal'],
    ['requires independent review', 'requires_independent_review'],
    ['requires_independent_review', 'requires_independent_review'],
    ['reviewer eligibility ref', 'reviewer_eligibility_ref'],
    ['reviewer_eligibility_ref', 'reviewer_eligibility_ref'],
    ['independent review ref', 'independent_review_ref'],
    ['independent_review_ref', 'independent_review_ref'],
    ['operator acceptance ref', 'operator_acceptance_ref'],
    ['operator_acceptance_ref', 'operator_acceptance_ref'],
    ['misleading completion answer', 'misleading_completion_answer'],
    ['misleading_completion_answer', 'misleading_completion_answer'],
    ['allowed pending state', 'allowed_pending_state'],
    ['allowed_pending_state', 'allowed_pending_state'],
    ['closure state', 'closure_state'],
    ['closure_state', 'closure_state'],
  ]);
  const packet: any = {};
  for (const rawLine of section.split(/\r?\n/)) {
    const line: any = rawLine.trim().replace(/^[-*]\s+/, '');
    if (!line || line.startsWith('<!--')) continue;
    const match: any = line.match(/^([A-Za-z_ ]+):\s*(.+)$/);
    if (!match) continue;
    const field: any = aliases.get(match[1].toLowerCase().trim());
    if (!field) continue;
    packet[field] = match[2].trim();
  }
  return packet;
}

function extractMarkdownSection(body: any, heading: any) {
  const escaped: any = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern: any = new RegExp(`^##\\s+${escaped}\\s*$`, 'mi');
  const match: any = body.match(pattern);
  if (!match) return null;
  const start: any = match.index + match[0].length;
  const rest: any = body.slice(start);
  const nextHeading: any = rest.match(/^##\s/m);
  const end: any = nextHeading ? start + nextHeading.index : body.length;
  return body.slice(start, end).trim();
}

function coerceBoolean(value: any) {
  if (value === true || value === false) return value;
  const normalized: any = text(value).trim().toLowerCase();
  if (['true', 'yes', 'required'].includes(normalized)) return true;
  if (['false', 'no', 'not required'].includes(normalized)) return false;
  return null;
}

export function selfCertificationGuardContract() {
  return {
    schema: 'narada.self_certification.guard_contract.v0',
    defining_task: 878,
    design_review_task: 812,
    target_categories: TARGET_CATEGORIES,
    non_target_category: NON_TARGET_CATEGORY,
    required_target_fields: REQUIRED_TARGET_FIELDS,
    allowed_pending_states: ALLOWED_PENDING_STATES,
    terminal_states: TERMINAL_STATES,
    surfaces: [
      'task_lifecycle_finish',
      'task_lifecycle_submit_report',
      'task_lifecycle_review',
      'task_lifecycle_close',
      'capa_closeout',
      'evidence_admission',
      'chapter_closure_packet',
      'operator_final_summary',
    ],
  };
}

export function evaluateSelfCertificationGuard(packet: TaskLifecyclePayload = {}) {
  const targetCategory: any = inferTargetCategory(packet);
  const target: any = TARGET_CATEGORIES.includes(targetCategory);
  const subjectPrincipal: any = normalizePrincipal(packet.subject_principal);
  const actorPrincipal: any = normalizePrincipal(packet.actor_principal ?? packet.closer_principal ?? packet.reviewer_principal);
  const sameSubject: any = Boolean(target && subjectPrincipal && actorPrincipal && subjectPrincipal === actorPrincipal);
  const independentReviewSatisfied: any = hasIndependentReview(packet);
  const operatorAcceptanceSatisfied: any = hasOperatorAcceptance(packet);
  const terminalClaim: any = hasTerminalClaim(packet);
  const allowedPendingState: any = normalizeCategory(packet.allowed_pending_state ?? packet.fallback_state);
  const missingCapability: any = packet.missing_capability === true || allowedPendingState === 'terminal_blocked_missing_enforcement';

  return {
    schema: 'narada.self_certification.guard_evaluation.v0',
    target,
    target_category: targetCategory,
    same_subject: sameSubject,
    subject_principal: subjectPrincipal || null,
    actor_principal: actorPrincipal || null,
    terminal_claim: terminalClaim,
    independent_review_satisfied: independentReviewSatisfied,
    operator_acceptance_satisfied: operatorAcceptanceSatisfied,
    missing_capability: missingCapability,
    allowed_pending_state: allowedPendingState || null,
    allowed_pending_states: ALLOWED_PENDING_STATES,
    required_fields: target ? REQUIRED_TARGET_FIELDS : [],
    non_target_reason: target ? null : 'Routine low-risk or non-target material is outside architect-failure/deception/trust self-certification enforcement.',
  };
}

export function validateSelfCertificationPacket(packet: TaskLifecyclePayload = {}) {
  const evaluation: any = evaluateSelfCertificationGuard(packet);
  const errors: any[] = [];

  if (!evaluation.target) return { ok: true, evaluation, errors };

  const missingFields: any = REQUIRED_TARGET_FIELDS.filter((field: any) => {
    if (field === 'requires_independent_review') return coerceBoolean(packet[field]) !== true;
    return text(packet[field]).trim().length === 0;
  });
  if (missingFields.length > 0) {
    errors.push(`Missing self-certification guard fields: ${missingFields.join(', ')}.`);
  }

  if (packet.allowed_pending_state && !ALLOWED_PENDING_STATES.includes(evaluation.allowed_pending_state)) {
    errors.push(`Invalid allowed_pending_state '${packet.allowed_pending_state}'. Use one of: ${ALLOWED_PENDING_STATES.join(', ')}.`);
  }

  if (evaluation.same_subject && evaluation.terminal_claim && !evaluation.independent_review_satisfied && !evaluation.operator_acceptance_satisfied) {
    errors.push('Same-subject architect terminal correction for architect-failure/deception/trust material requires an eligible independent review ref or explicit operator acceptance ref.');
  }

  if (evaluation.same_subject && evaluation.missing_capability && evaluation.terminal_claim) {
    errors.push('Missing self-certification enforcement capability must remain a pending/blocker state; it cannot be reported as terminal correction.');
  }

  return { ok: errors.length === 0, evaluation, errors };
}

export function validateSelfCertificationBody({ body = '', summary = '', actor_principal = '' }: TaskLifecyclePayload = {}) {
  const section: any = extractMarkdownSection(body, 'Self-Certification Guard');
  const parsed: any = parseSelfCertificationSection(section) as TaskLifecyclePayload;
  return validateSelfCertificationPacket({
    ...parsed,
    actor_principal: parsed.actor_principal ?? actor_principal,
    body,
    summary,
  });
}

export {
  TARGET_CATEGORIES,
  NON_TARGET_CATEGORY,
  ALLOWED_PENDING_STATES,
  REQUIRED_TARGET_FIELDS,
};
