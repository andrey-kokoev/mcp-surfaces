import { setTimeout as delay } from 'node:timers/promises';

export type JsonRecord = Record<string, unknown>;

export type CdpTarget = {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type CdpSocket = {
  addEventListener(event: 'open' | 'message' | 'error' | 'close', listener: (value: any) => void): void;
  send(data: string): void;
  close(): void;
};

type PendingCall = {
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

export class BrowserControlError extends Error {
  readonly code: string;
  readonly details: JsonRecord;

  constructor(code: string, message: string, details: JsonRecord = {}) {
    super(message);
    this.name = 'BrowserControlError';
    this.code = code;
    this.details = details;
  }
}

function loopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function validateCdpEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BrowserControlError('cdp_endpoint_required', 'cdp_endpoint is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserControlError('cdp_endpoint_invalid', 'cdp_endpoint must be a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserControlError('cdp_endpoint_invalid_protocol', 'cdp_endpoint must use HTTP or HTTPS.');
  }
  if (!loopbackHost(parsed.hostname)) {
    throw new BrowserControlError('cdp_endpoint_not_loopback', 'cdp_endpoint must target localhost, 127.0.0.1, or ::1.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new BrowserControlError('cdp_endpoint_path_invalid', 'cdp_endpoint must identify the loopback browser endpoint, not an arbitrary path.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BrowserControlError('cdp_endpoint_contains_credentials_or_query', 'cdp_endpoint cannot contain credentials, query, or fragment data.');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function validateCdpWebSocketUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BrowserControlError('cdp_websocket_url_missing', 'The selected browser target did not provide a WebSocket debugger URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserControlError('cdp_websocket_url_invalid', 'The browser target WebSocket URL is invalid.');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new BrowserControlError('cdp_websocket_url_invalid_protocol', 'The browser target WebSocket URL must use ws or wss.');
  }
  if (!loopbackHost(parsed.hostname)) {
    throw new BrowserControlError('cdp_websocket_url_not_loopback', 'The browser target WebSocket URL must remain on the loopback host.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BrowserControlError('cdp_websocket_url_contains_credentials_or_query', 'The browser target WebSocket URL cannot contain credentials, query, or fragment data.');
  }
  return parsed.toString();
}

export function normalizeAllowedOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new BrowserControlError('allowed_origins_required', 'allowed_origins must contain one to 32 exact origins.');
  }
  const origins = value.map((item) => {
    if (typeof item !== 'string' || item.trim().length === 0 || item.includes('*')) {
      throw new BrowserControlError('allowed_origin_invalid', 'allowed_origins must contain exact, non-wildcard origins.');
    }
    let parsed: URL;
    try {
      parsed = new URL(item);
    } catch {
      throw new BrowserControlError('allowed_origin_invalid', 'Each allowed origin must be a valid URL origin.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BrowserControlError('allowed_origin_invalid', 'Allowed origins must use HTTP or HTTPS.');
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/' && parsed.pathname !== '' || parsed.search || parsed.hash) {
      throw new BrowserControlError('allowed_origin_invalid', 'Allowed origins must contain only scheme, host, and optional port.');
    }
    return parsed.origin;
  });
  return [...new Set(origins)];
}

export function assertAllowedOrigin(value: string, allowedOrigins: string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserControlError('navigation_url_invalid', 'The navigation URL must be valid HTTP or HTTPS.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserControlError('navigation_protocol_not_allowed', 'Only HTTP and HTTPS navigation is allowed.');
  }
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new BrowserControlError('origin_not_allowed', 'The URL origin is not in the explicit allowlist.', {
      origin: parsed.origin,
      allowed_origins: allowedOrigins,
    });
  }
  return parsed.toString();
}

async function fetchTargets(endpoint: string, timeoutMs = 5000): Promise<CdpTarget[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL('/json/list', endpoint), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new BrowserControlError('cdp_target_list_failed', `CDP target discovery returned HTTP ${response.status}.`);
    }
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new BrowserControlError('cdp_target_list_invalid', 'CDP target discovery returned a non-array response.');
    return value.filter((item): item is CdpTarget => Boolean(item && typeof item === 'object' && typeof (item as any).id === 'string'));
  } catch (error) {
    if (error instanceof BrowserControlError) throw error;
    throw new BrowserControlError('cdp_endpoint_unavailable', 'The loopback CDP endpoint could not be queried.', {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function listCdpTargets(endpoint: string, timeoutMs = 5000): Promise<CdpTarget[]> {
  return fetchTargets(validateCdpEndpoint(endpoint), timeoutMs);
}

function socketConstructor(): new (url: string) => CdpSocket {
  const ctor = (globalThis as unknown as { WebSocket?: new (url: string) => CdpSocket }).WebSocket;
  if (!ctor) throw new BrowserControlError('websocket_unavailable', 'This Node runtime does not expose a WebSocket implementation.');
  return ctor;
}

export class CdpConnection {
  private readonly socket: CdpSocket;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingCall>();

  private constructor(socket: CdpSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event: any) => this.handleMessage(event?.data));
    socket.addEventListener('close', () => this.failPending(new BrowserControlError('cdp_connection_closed', 'The browser CDP connection closed.')));
    socket.addEventListener('error', (error: unknown) => this.failPending(new BrowserControlError('cdp_connection_error', 'The browser CDP connection reported an error.', { cause: String(error) })));
  }

  static async connect(webSocketUrl: string, timeoutMs = 8000): Promise<CdpConnection> {
    const validatedUrl = validateCdpWebSocketUrl(webSocketUrl);
    const Ctor = socketConstructor();
    const socket = new Ctor(validatedUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BrowserControlError('cdp_connect_timeout', 'Timed out connecting to the selected browser target.')), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', (error: unknown) => {
        clearTimeout(timer);
        reject(new BrowserControlError('cdp_connect_failed', 'Could not connect to the selected browser target.', { cause: String(error) }));
      });
    });
    return new CdpConnection(socket);
  }

  async call(method: string, params: JsonRecord = {}, timeoutMs = 8000): Promise<any> {
    if (this.closed) throw new BrowserControlError('cdp_connection_closed', 'The browser CDP connection is closed.');
    const id = this.nextId++;
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserControlError('cdp_call_timeout', `Timed out waiting for CDP method ${method}.`, { method, timeout_ms: timeoutMs }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new BrowserControlError('cdp_connection_closed', 'The browser CDP connection closed.'));
    this.socket.close();
  }

  private handleMessage(data: unknown): void {
    let message: any;
    try {
      message = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (!Number.isInteger(message?.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new BrowserControlError(
        'cdp_method_failed',
        String(message.error.message ?? 'CDP method failed.'),
        { method_error: message.error },
      ));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  private failPending(error: BrowserControlError): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

export async function boundedDelay(ms: number): Promise<void> {
  await delay(ms);
}