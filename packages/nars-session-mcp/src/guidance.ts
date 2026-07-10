export const NARS_SESSION_GUIDANCE_SCHEMA = 'narada.nars_session_mcp.guidance.v1';

export function guidanceToolDefinition() {
  return {
    name: 'nars_session_guidance',
    description: 'Explain governed NARS session discovery, input delivery, authority fencing, and status readback.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: 'NARS session guidance',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  };
}

export function buildGuidanceResult() {
  return {
    schema: NARS_SESSION_GUIDANCE_SCHEMA,
    status: 'ok',
    purpose: 'Deliver bounded, authorized input to an already-existing NARS session and read back authoritative admission evidence.',
    first_use: [
      'Call nars_session_list to discover sessions in the bound Site scope.',
      'Call nars_session_show with an explicit session_id to verify liveness and authority posture.',
      'Call nars_session_input_deliver with explicit delivery: send, enqueue, or steer and an idempotency_key.',
      'Use nars_session_input_status to distinguish admission, queueing, provider completion, refusal, and unknown state.',
    ],
    delivery_modes: {
      send: 'Current or next eligible turn according to NARS queue semantics; never assume provider completion.',
      enqueue: 'NARS-owned durable queue entry after the active turn; this surface owns no second queue.',
      steer: 'Explicit interruptive delivery; disabled by default and never inferred from timeout or activity.',
    },
    authority: [
      'The bound caller supplies intent; it does not supply an arbitrary source principal or authority locus.',
      'The NARS authority runtime owns session state, queue state, turn admission, and provider dispatch.',
      'A stale, closed, superseded, or non-writable session is refused.',
    ],
    boundaries: [
      'This is live session coordination, not a task, inbox, delegated-work, or hidden message-bus surface.',
      'Do not write control.jsonl or operator-input-queue.json directly.',
      'Transport acknowledgement is not provider completion.',
    ],
    recovery: [
      'On timeout, call nars_session_input_status; do not retry blindly with a new idempotency key.',
      'On stale authority refusal, rediscover the session and require an explicit current session_id.',
      'On missing health or event endpoint, repair the carrier launch/session registration rather than bypassing the authority runtime.',
    ],
  };
}
