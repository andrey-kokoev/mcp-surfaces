export const INBOX_ENVELOPE_KINDS = Object.freeze([
  'proposal',
  'observation',
  'command_request',
  'question',
  'knowledge_candidate',
  'task_candidate',
  'incident',
  'upstream_task_candidate',
]);

export const INBOX_ENVELOPE_KIND_SET = new Set<string>(INBOX_ENVELOPE_KINDS);

export function isKnownInboxEnvelopeKind(kind: unknown): kind is string {
  return typeof kind === 'string' && INBOX_ENVELOPE_KIND_SET.has(kind);
}

export function assertKnownInboxEnvelopeKind(kind: unknown): string {
  if (!isKnownInboxEnvelopeKind(kind)) {
    throw new Error(`invalid_envelope_kind: ${String(kind)}; allowed=${INBOX_ENVELOPE_KINDS.join(',')}`);
  }
  return kind;
}
