const SERIOUS_FAILURE_STATES = Object.freeze([
  'inventory_in_progress',
  'inventory_complete_corrective_open',
  'corrective_in_progress',
  'corrective_complete_pending_review',
  'terminal_corrected',
  'terminal_blocked',
]);

const REQUIRED_TRUTHFULNESS_FIELDS = Object.freeze([
  'known_facts',
  'inferences',
  'uncertainty',
  'changed',
  'not_changed',
  'remaining_work',
  'evidence_limits',
  'capa_open_status',
  'state',
]);

const TERMINAL_CORRECTED_REQUIRED_FIELDS = Object.freeze([
  'remaining_work',
  'capa_open_status',
  'repository_durability',
  'changed',
]);

const TRIGGER_SURFACES = Object.freeze([
  'task_lifecycle_finish',
  'task_lifecycle_submit_report',
  'task_lifecycle_closeout',
  'capa_queue_or_capability_closeout_review',
  'chapter_closure_packet',
  'operator_final_summary',
]);

const TRIGGER_DEFINITIONS = Object.freeze([
  {
    code: 'high_severity_or_recurrent_capa',
    description: 'A CAPA or corrective obligation is high severity, recurring, or explicitly about failed recovery from prior serious operator harm.',
  },
  {
    code: 'operator_trust_or_deception_concern',
    description: 'The work concerns misleading the operator, hiding uncertainty, overstating completion, or recovering from a trust/deception failure.',
  },
  {
    code: 'authority_or_locus_boundary_error',
    description: 'The recovery concerns identity, authority, User/PC locus, durable-state ownership, or crossing-boundary confusion.',
  },
  {
    code: 'false_completion_claim',
    description: 'The closeout could imply corrective work is complete when only inventory, planning, routing, evidence capture, task creation, or review preparation occurred.',
  },
  {
    code: 'missing_evidence_recovery',
    description: 'The closeout recovers from missing, fabricated, stale, or insufficient evidence and must state what the evidence does and does not prove.',
  },
  {
    code: 'task_created_only_remediation',
    description: 'The closeout relies on creating a task, artifact, checklist, dashboard, or proposal as if that alone corrected the underlying failure.',
  },
  {
    code: 'unqualified_504_claim',
    description: 'The closeout or summary describes the architect audit corpus as a gapless 504-item source instead of the preserved 492-item artifact formerly called 504.',
  },
  {
    code: 'remediation_evidence_authorization_conflation',
    description: 'The closeout cites rollback, remediation, or closure evidence as if it proves the original action was authorized.',
  },
]);

function text(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function textMatches(packet, pattern) {
  const haystack = [
    packet.title,
    packet.summary,
    packet.context,
    packet.claim,
    packet.closeout_text,
    packet.operator_summary,
    packet.evidence,
    packet.remaining_work,
    packet.changed,
    packet.not_changed,
    packet.original_authorization_evidence,
    packet.authorization_evidence,
  ].map(text).join('\n');
  return pattern.test(haystack);
}

function boolOrText(packet, key, pattern) {
  if (packet[key] === true) return true;
  return textMatches(packet, pattern);
}

function unique(values) {
  return [...new Set(values)];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMarkdownSection(body, heading) {
  const pattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, 'mi');
  const match = body.match(pattern);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.match(/^##\s/m);
  const end = nextHeading ? start + nextHeading.index : body.length;
  return body.slice(start, end).trim();
}

function parseRecoveryTruthfulnessSection(section) {
  if (!section) return {};
  const packet = {};
  const aliases = new Map([
    ['known facts', 'known_facts'],
    ['known_facts', 'known_facts'],
    ['inferences', 'inferences'],
    ['uncertainty', 'uncertainty'],
    ['changed', 'changed'],
    ['not changed', 'not_changed'],
    ['not_changed', 'not_changed'],
    ['remaining work', 'remaining_work'],
    ['remaining_work', 'remaining_work'],
    ['evidence limits', 'evidence_limits'],
    ['what evidence does not prove', 'evidence_limits'],
    ['capa open status', 'capa_open_status'],
    ['capa_open_status', 'capa_open_status'],
    ['repository durability', 'repository_durability'],
    ['repository_durability', 'repository_durability'],
    ['commit push state', 'repository_durability'],
    ['commit/push state', 'repository_durability'],
    ['commit status', 'repository_durability'],
    ['push status', 'repository_durability'],
    ['state', 'state'],
  ]);

  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, '');
    if (!line || line.startsWith('<!--')) continue;
    const match = line.match(/^([A-Za-z_ ]+):\s*(.+)$/);
    if (!match) continue;
    const field = aliases.get(match[1].toLowerCase().trim());
    if (!field) continue;
    if (packet[field]) {
      packet[field] = `${packet[field]}\n${match[2].trim()}`;
    } else {
      packet[field] = match[2].trim();
    }
  }
  return packet;
}

export function recoveryTruthfulnessTriggerContract() {
  return {
    schema: 'narada.recovery_truthfulness.trigger_contract.v0',
    parent_task: 634,
    defining_task: 654,
    chapter_packet: 'kb/operations/2026-05-12-architect-audit-corpus-corrective-program.md',
    state_vocabulary: SERIOUS_FAILURE_STATES,
    required_truthfulness_fields: REQUIRED_TRUTHFULNESS_FIELDS,
    trigger_surfaces: TRIGGER_SURFACES,
    trigger_definitions: TRIGGER_DEFINITIONS,
    non_trigger_rule: 'Routine low-risk work does not trigger this packet unless it asserts serious-failure recovery, CAPA correction, operator-trust recovery, authority/locus repair, or terminal completion for corrective work.',
  };
}

export function evaluateRecoveryTruthfulnessTrigger(packet = {}) {
  const triggers = [];

  if (packet.serious_failure_recovery === true) triggers.push('explicit_serious_failure_recovery');
  if (SERIOUS_FAILURE_STATES.includes(packet.state)) triggers.push('explicit_recovery_state');
  if (packet.capa?.severity === 'high' || packet.capa?.severity === 'critical' || packet.capa?.recurrence_count > 1 || packet.recurrent_capa === true) {
    triggers.push('high_severity_or_recurrent_capa');
  }
  if (boolOrText(packet, 'operator_trust_or_deception_concern', /\b(deceiv|mislead|trust|false\s+complete|hidden\s+uncertainty|overstat(?:e|ed|ing))\b/i)) {
    triggers.push('operator_trust_or_deception_concern');
  }
  if (packet.authority_or_locus_boundary_error === true || textMatches(packet, /\b(authority|locus|user-locus|pc-locus|identity|principal|crossing|durable\s+state)\b.{0,80}\b(error|failure|confusion|mismatch|repair|recovery|violation|wrong|false|misleading)\b/i) || textMatches(packet, /\b(error|failure|confusion|mismatch|repair|recovery|violation|wrong|false|misleading)\b.{0,80}\b(authority|locus|user-locus|pc-locus|identity|principal|crossing|durable\s+state)\b/i)) {
    triggers.push('authority_or_locus_boundary_error');
  }
  if (packet.false_completion_claim === true || textMatches(packet, /\b(complete|fixed|corrected|resolved|closed)\b/i) && textMatches(packet, /\b(only\s+created|created\s+(?:a\s+)?tasks?|planned|inventor(?:y|ied)|captured\s+evidence|proposal|checklist|future\s+work|queued)\b/i)) {
    triggers.push('false_completion_claim');
  }
  if (boolOrText(packet, 'missing_evidence_recovery', /\b(missing|fabricated|stale|insufficient|unverified)\s+evidence\b/i)) {
    triggers.push('missing_evidence_recovery');
  }
  if (packet.task_created_only_remediation === true || textMatches(packet, /\b(created|opened|materialized|published)\b.{0,40}(tasks?|#\d+|artifact|checklist|dashboard|proposal).*\b(corrected|fixed|resolved|complete)\b/i)) {
    triggers.push('task_created_only_remediation');
  }
  if (packet.unqualified_504_claim === true || textMatches(packet, /\b(?:504(?:-item)?|gapless\s+504)\b/i) && !textMatches(packet, /\b492\b|\bfka\s+504\b|formerly\s+(?:called\s+)?504|missing\s+labels/i)) {
    triggers.push('unqualified_504_claim');
  }
  if (packet.remediation_evidence_authorization_conflation === true || claimsRemediationEvidenceAsAuthorization(packet)) {
    triggers.push('remediation_evidence_authorization_conflation');
    triggers.push('authority_or_locus_boundary_error');
  }

  const normalizedTriggers = unique(triggers);
  const triggered = normalizedTriggers.length > 0;
  return {
    schema: 'narada.recovery_truthfulness.trigger_evaluation.v0',
    triggered,
    triggers: normalizedTriggers,
    required_fields: triggered ? REQUIRED_TRUTHFULNESS_FIELDS : [],
    trigger_surfaces: triggered ? TRIGGER_SURFACES : [],
    state_vocabulary: SERIOUS_FAILURE_STATES,
    non_trigger_reason: triggered ? null : recoveryTruthfulnessTriggerContract().non_trigger_rule,
  };
}

export function validateRecoveryTruthfulnessBody({ body = '', summary = '', context = '' } = {}) {
  const recoverySection = extractMarkdownSection(body, 'Recovery Truthfulness');
  const parsedPacket = parseRecoveryTruthfulnessSection(recoverySection);
  const packet = {
    ...parsedPacket,
    summary,
    context,
    closeout_text: body,
  };
  const validation = validateRecoveryTruthfulnessPacket(packet);
  if (validation.ok) return { ...validation, recovery_section_present: Boolean(recoverySection) };
  return {
    ...validation,
    recovery_section_present: Boolean(recoverySection),
    errors: validation.errors.map((error) => `${error} Add or repair a ## Recovery Truthfulness section with labels: Known facts, Inferences, Uncertainty, Changed, Not changed, Remaining work, Evidence limits, CAPA open status, State. For terminal_corrected, also include Repository durability / commit-push state.`),
  };
}

function normalizedText(value) {
  return text(value).toLowerCase();
}

function claimsRemediationEvidenceAsAuthorization(packet) {
  const haystack = [
    packet.summary,
    packet.operator_summary,
    packet.closeout_text,
    packet.evidence,
    packet.known_facts,
    packet.inferences,
  ].map(text).join('\n');
  const citesRemediationEvidence = /\b(?:rollback|rolled\s+back|remediation|remediated|closure\s+evidence|repair\s+evidence|bg_\d+[A-Za-z0-9_]*)\b/i.test(haystack);
  const claimsOriginalAuthorization = /\b(?:original|initial|startup|prior)\b.{0,80}\b(?:authori[sz]ed|authority|allowed|approved)\b/i.test(haystack)
    || /\b(?:authori[sz]ed|authority|allowed|approved)\b.{0,80}\b(?:original|initial|startup|prior)\b/i.test(haystack);
  return citesRemediationEvidence && claimsOriginalAuthorization && !hasSeparateOriginalAuthorizationEvidence(packet);
}

function hasSeparateOriginalAuthorizationEvidence(packet) {
  const evidence = text(packet.original_authorization_evidence ?? packet.authorization_evidence).trim();
  if (!evidence) return false;
  if (/\b(?:rollback|rolled\s+back|remediation|remediated|closure\s+evidence|repair\s+evidence|bg_\d+[A-Za-z0-9_]*)\b/i.test(evidence)) return false;
  return /\b(?:operator|direct|explicit|instruction|authorization|approved|allowed)\b/i.test(evidence);
}

function claimsNoRemainingWork(value) {
  const content = normalizedText(value);
  if (!content.trim()) return false;
  if (/\b#\d+\b/.test(content)) return false;
  if (/\b(no|none|zero)\b.{0,40}\b(remaining|residual|open|pending|corrective|follow[- ]?up|work|tasks?|capas?|reviews?)\b/i.test(content)) return true;
  if (/\ball\b.{0,40}\b(corrective|residual|follow[- ]?up)\b.{0,40}\b(closed|complete|done|resolved)\b/i.test(content)) return true;
  return false;
}

function claimsCapaClosed(value) {
  const content = normalizedText(value);
  if (!content.trim()) return false;
  if (/\b(no|none|zero)\b.{0,40}\b(open|active|pending)\b.{0,40}\b(capas?|corrective)\b/i.test(content)) return true;
  if (/\bcapas?\b.{0,40}\b(closed|resolved|none|not\s+applicable|n\/a)\b/i.test(content)) return true;
  if (/\bnone\b.{0,40}\b(capas?|corrective)\b/i.test(content)) return true;
  return false;
}

function claimsRepositoryDurable(value) {
  const content = normalizedText(value);
  if (!content.trim()) return false;
  if (/\b(not|no|uncommitted|unpushed|pending|missing|failed|cannot|unable)\b.{0,40}\b(commit|push|pushed|durable|repository)\b/i.test(content)) return false;
  return /\b(commit(?:ted)?\b.{0,80}\bpush(?:ed)?\b|push(?:ed)?\b.{0,80}\bcommit(?:ted)?\b|durable\b.{0,40}\b(commit|push|git|repository))\b/i.test(content);
}

function hasDurableChangeEvidence(packet) {
  const changed = packet.changed;
  if (Array.isArray(changed)) {
    return changed.some((item) => text(item).trim().length > 0 && text(item).trim() !== '__narada_no_files_changed_declared__');
  }
  const content = text(changed).trim();
  return content.length > 0 && content !== '__narada_no_files_changed_declared__' && !/\bno\s+files?\s+changed\b/i.test(content);
}

export function validateRecoveryTruthfulnessPacket(packet = {}) {
  const evaluation = evaluateRecoveryTruthfulnessTrigger(packet);
  if (!evaluation.triggered) return { ok: true, evaluation, errors: [] };

  const errors = [];
  const missingFields = REQUIRED_TRUTHFULNESS_FIELDS.filter((field) => {
    const value = packet[field];
    if (Array.isArray(value)) return value.length === 0;
    return text(value).trim().length === 0;
  });
  if (missingFields.length > 0) {
    errors.push(`Missing recovery truthfulness fields: ${missingFields.join(', ')}.`);
  }
  if (packet.state && !SERIOUS_FAILURE_STATES.includes(packet.state)) {
    errors.push(`Invalid recovery state '${packet.state}'. Use one of: ${SERIOUS_FAILURE_STATES.join(', ')}.`);
  }
  if (evaluation.triggers.includes('task_created_only_remediation') && /\b(corrected|fixed|resolved|complete)\b/i.test(text(packet.operator_summary ?? packet.summary)) && text(packet.remaining_work).trim().length === 0) {
    errors.push('Task-created-only remediation claim must name remaining corrective work before it can be reported as truthful.');
  }
  if (evaluation.triggers.includes('remediation_evidence_authorization_conflation')) {
    errors.push('Rollback/remediation/closure evidence cannot prove the original action was authorized. Name separate original_authorization_evidence or state that original authorization remains unproven.');
  }
  if (packet.state === 'terminal_corrected') {
    if (!claimsNoRemainingWork(packet.remaining_work)) {
      errors.push('terminal_corrected recovery state requires remaining_work to explicitly say there is no remaining, open, residual, or pending corrective work/tasks/reviews.');
    }
    if (!claimsCapaClosed(packet.capa_open_status)) {
      errors.push('terminal_corrected recovery state requires capa_open_status to explicitly say no related CAPA/corrective obligation remains open.');
    }
    if (!claimsRepositoryDurable(packet.repository_durability ?? packet.commit_push_state ?? packet.commit_status ?? packet.push_status)) {
      errors.push('terminal_corrected recovery state requires repository_durability / commit-push state showing the correction is committed and pushed, or otherwise repository-durable.');
    }
    if (!hasDurableChangeEvidence(packet)) {
      errors.push('terminal_corrected recovery state requires changed evidence for the correction; no-files-changed evidence cannot support terminal correction.');
    }
  }

  return { ok: errors.length === 0, evaluation, errors };
}

export { REQUIRED_TRUTHFULNESS_FIELDS, TERMINAL_CORRECTED_REQUIRED_FIELDS, SERIOUS_FAILURE_STATES, TRIGGER_SURFACES, TRIGGER_DEFINITIONS };
