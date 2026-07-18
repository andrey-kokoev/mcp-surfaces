export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000;
export const MAX_TOOL_CALL_TIMEOUT_MS = 900_000;
export const DEFAULT_TOOL_TIMEOUT_GRACE_MS = 1_000;
export const MAX_TOOL_TIMEOUT_GRACE_MS = 60_000;
export const MAX_OUTER_TOOL_CALL_TIMEOUT_MS = MAX_TOOL_CALL_TIMEOUT_MS + MAX_TOOL_TIMEOUT_GRACE_MS;

export type ToolCallTimeoutResolution =
  | { status: 'ok'; timeoutMs: number; outerTimeoutMs: number; graceMs: number; source: 'policy_default' | 'tool_request' }
  | { status: 'refused'; reason: 'invalid' | 'exceeds_loader_max'; requestedTimeoutMs: unknown; maxTimeoutMs: number };

/**
 * Resolve the tool-declared timeout (timeoutMs, forwarded to the child in the tool
 * arguments) and the loader's own outer wait deadline (outerTimeoutMs). When the
 * caller declares timeout_ms, the child bounds itself at timeoutMs and needs a
 * bounded grace window beyond it to return its own timeout result; without the
 * grace the loader's child_timeout races the child's bounded response at the same
 * deadline. Policy-default calls have no inner timer, so no grace is applied.
 */
export function resolveToolCallTimeoutMs(
  requestedTimeoutMs: unknown,
  fallbackTimeoutMs: number = DEFAULT_TOOL_CALL_TIMEOUT_MS,
  graceMs: number = DEFAULT_TOOL_TIMEOUT_GRACE_MS,
): ToolCallTimeoutResolution {
  const fallback = Number.isFinite(fallbackTimeoutMs)
    ? Math.max(1, Math.min(MAX_TOOL_CALL_TIMEOUT_MS, Math.trunc(fallbackTimeoutMs)))
    : DEFAULT_TOOL_CALL_TIMEOUT_MS;
  const grace = Number.isFinite(graceMs)
    ? Math.max(0, Math.min(MAX_TOOL_TIMEOUT_GRACE_MS, Math.trunc(graceMs)))
    : DEFAULT_TOOL_TIMEOUT_GRACE_MS;

  if (requestedTimeoutMs === undefined || requestedTimeoutMs === null) {
    return { status: 'ok', timeoutMs: fallback, outerTimeoutMs: fallback, graceMs: 0, source: 'policy_default' };
  }

  const numeric = typeof requestedTimeoutMs === 'number'
    ? requestedTimeoutMs
    : typeof requestedTimeoutMs === 'string' && requestedTimeoutMs.trim()
      ? Number(requestedTimeoutMs)
      : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return { status: 'refused', reason: 'invalid', requestedTimeoutMs, maxTimeoutMs: MAX_TOOL_CALL_TIMEOUT_MS };
  }

  const timeoutMs = Math.trunc(numeric);
  if (timeoutMs > MAX_TOOL_CALL_TIMEOUT_MS) {
    return { status: 'refused', reason: 'exceeds_loader_max', requestedTimeoutMs, maxTimeoutMs: MAX_TOOL_CALL_TIMEOUT_MS };
  }
  const inner = Math.max(1, timeoutMs);
  return { status: 'ok', timeoutMs: inner, outerTimeoutMs: Math.min(MAX_OUTER_TOOL_CALL_TIMEOUT_MS, inner + grace), graceMs: grace, source: 'tool_request' };
}
