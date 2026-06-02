const FOLLOW_UP_LEDGER_HEADING = 'Follow-Up Ledger';
const ACCEPTED_LEDGER_ENTRY_EXAMPLES = [
  'created #N: <task or residual summary>',
  'covered by #N: <existing task or evidence summary>',
  'envelope env_<id>: <residual or routing summary>',
  'CAPA <capa_id>: <corrective-action summary>',
  'deferred: <reason and revisit condition>',
  'no follow-up needed: <rationale>',
];
const FOLLOW_UP_LEDGER_REMEDIATION = `Accepted Follow-Up Ledger line forms: ${ACCEPTED_LEDGER_ENTRY_EXAMPLES.map((entry) => `\`${entry}\``).join(', ')}. Prefix matching is case-insensitive, but use these exact prefixes for readability.`;

function extractSection(body, heading) {
  const pattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, 'mi');
  const match = body.match(pattern);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.match(/^##\s/m);
  const end = nextHeading ? start + nextHeading.index : body.length;
  return body.slice(start, end).trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function needsFollowUpLedger(body) {
  const dispositionSignal = /\b(disposition|acknowledge(?:d)?|acknowledge(?:d)? with corrections|dismiss(?:ed)?|escalat(?:e|ed|ion)|supersed(?:e|ed)|stale|remaining)\b/i;
  const followUpSignal = /\b(follow-?up|remaining (?:work|concern|finding)s?|split(?:ting)?|create(?:d)? (?:a )?(?:follow-?up )?task|covered by|deferred)\b/i;
  return dispositionSignal.test(body) && followUpSignal.test(body);
}

function normalizeLedgerLine(line) {
  return line
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim();
}

function isValidLedgerEntry(line) {
  const normalized = normalizeLedgerLine(line);
  if (/\b(created|covered by)\s+#\d+\b/i.test(normalized)) return true;
  if (/\benvelope\s+env_[A-Za-z0-9_-]+\s*:\s*\S.{10,}/i.test(normalized)) return true;
  if (/\bCAPA\s+(?:capa_[A-Za-z0-9_-]+|env_[A-Za-z0-9_-]+|[A-Za-z][A-Za-z0-9_-]{3,})\s*:\s*\S.{10,}/i.test(normalized)) return true;
  if (/\bdeferred\s*:\s*\S.{10,}/i.test(normalized)) return true;
  if (/\bno follow-?up needed\s*:\s*\S.{10,}/i.test(normalized)) return true;
  return false;
}

function ledgerLines(section) {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('<!--'));
}

export function validateFollowUpLedger(body) {
  if (!needsFollowUpLedger(body)) {
    return { ok: true, required: false, errors: [], ledger: null };
  }

  const ledger = extractSection(body, FOLLOW_UP_LEDGER_HEADING);
  const baseError = `Follow-Up Ledger required: disposition preserves remaining work but no valid ledger entry links created tasks, existing tasks, deferral, or no-follow-up rationale. ${FOLLOW_UP_LEDGER_REMEDIATION}`;
  if (!ledger) {
    return { ok: false, required: true, errors: [baseError], ledger: null };
  }

  const entries = ledgerLines(ledger);
  if (entries.length === 0) {
    return { ok: false, required: true, errors: [baseError], ledger };
  }

  const invalidEntries = entries.filter((line) => !isValidLedgerEntry(line));
  if (invalidEntries.length > 0) {
    return {
      ok: false,
      required: true,
      errors: [
        `${baseError} Invalid ledger entries: ${invalidEntries.map((line) => `"${normalizeLedgerLine(line)}"`).join('; ')}`,
      ],
      ledger,
    };
  }

  return { ok: true, required: true, errors: [], ledger };
}

export { FOLLOW_UP_LEDGER_HEADING };
