export function describeUnknownError(error: unknown, fallback = 'mcp_error'): string {
  if (error instanceof Error) return error.message || error.name || fallback;
  if (typeof error === 'string' && error.length > 0) return error;

  const record = asRecord(error);
  const nested = firstRecord(record.data, record.diagnostic, record.error);
  const message = record.message ?? nested?.message ?? nested?.reason;
  if (typeof message === 'string' && message.length > 0) return message;
  if (message !== undefined) return `${fallback}: ${safeJson(message)}`;

  const serialized = safeJson(error);
  return serialized ?? `${fallback}: <unserializable ${objectTag(error)}>`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value);
    if (Object.keys(record).length > 0) return record;
  }
  return null;
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string') return serialized;
  } catch {
    // Fall through to a non-opaque type label for cyclic values.
  }
  return `<unserializable ${objectTag(value)}>`;
}

function objectTag(value: unknown): string {
  return Object.prototype.toString.call(value).slice(8, -1) || 'unknown';
}
