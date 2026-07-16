export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000;
export const MAX_TOOL_CALL_TIMEOUT_MS = 600_000;

export type ToolCallTimeoutResolution =
  | { status: 'ok'; timeoutMs: number; source: 'policy_default' | 'tool_request' }
  | { status: 'refused'; reason: 'invalid' | 'exceeds_loader_max'; requestedTimeoutMs: unknown; maxTimeoutMs: number };

export function resolveToolCallTimeoutMs(
  requestedTimeoutMs: unknown,
  fallbackTimeoutMs: number = DEFAULT_TOOL_CALL_TIMEOUT_MS,
): ToolCallTimeoutResolution {
  const fallback = Number.isFinite(fallbackTimeoutMs)
    ? Math.max(1, Math.min(MAX_TOOL_CALL_TIMEOUT_MS, Math.trunc(fallbackTimeoutMs)))
    : DEFAULT_TOOL_CALL_TIMEOUT_MS;

  if (requestedTimeoutMs === undefined || requestedTimeoutMs === null) {
    return { status: 'ok', timeoutMs: fallback, source: 'policy_default' };
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
  return { status: 'ok', timeoutMs: Math.max(1, timeoutMs), source: 'tool_request' };
}
