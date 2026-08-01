import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpProcessClient, isRecord, type JsonRecord } from './process-client.js';

export interface SiteFabricClientOptions {
  siteRoot: string;
  loaderEntrypoint?: string;
  nodeExecutable?: string;
  allowedSurfaceIds?: readonly string[];
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxConnections?: number;
  env?: NodeJS.ProcessEnv;
}

export interface SiteFabricToolCallOptions {
  runtimeKind?: string;
  timeoutMs?: number;
}

interface AttachedSurface {
  connectionId: string;
  surfaceId: string;
  runtimeKind: string | null;
}

export class SiteFabricClient {
  readonly siteRoot: string;
  readonly allowedSurfaceIds: ReadonlySet<string> | null;

  #client: McpProcessClient;
  #connections = new Map<string, AttachedSurface>();
  #attachments = new Map<string, Promise<AttachedSurface>>();
  #detachTimeoutMs: number;
  #closed = false;

  private constructor(
    client: McpProcessClient,
    siteRoot: string,
    allowedSurfaceIds: ReadonlySet<string> | null,
    detachTimeoutMs: number,
  ) {
    this.#client = client;
    this.siteRoot = siteRoot;
    this.allowedSurfaceIds = allowedSurfaceIds;
    this.#detachTimeoutMs = detachTimeoutMs;
  }

  static async open(options: SiteFabricClientOptions): Promise<SiteFabricClient> {
    const siteRoot = requiredString(options.siteRoot, 'siteRoot');
    const allowedSurfaceIds = normalizeSurfaceIds(options.allowedSurfaceIds);
    const maxConnections = positiveInteger(options.maxConnections, Math.max(8, allowedSurfaceIds?.size ?? 0), 'maxConnections');
    const detachTimeoutMs = positiveInteger(options.closeTimeoutMs, 5_000, 'closeTimeoutMs');
    const args = [
      options.loaderEntrypoint ?? defaultMcpLoaderEntrypoint(),
      '--allowed-site-root', siteRoot,
      '--max-connections', String(maxConnections),
    ];
    for (const surfaceId of allowedSurfaceIds ?? []) args.push('--allowed-surface-id', surfaceId);

    const client = await McpProcessClient.start({
      executable: options.nodeExecutable ?? process.execPath,
      args,
      env: { ...process.env, ...options.env, NARADA_SITE_ROOT: siteRoot },
      requestTimeoutMs: options.requestTimeoutMs,
      closeTimeoutMs: options.closeTimeoutMs,
      clientName: 'narada-site-fabric-runtime-client',
    });
    return new SiteFabricClient(client, siteRoot, allowedSurfaceIds, detachTimeoutMs);
  }

  async attach(surfaceId: string, runtimeKind?: string): Promise<AttachedSurface> {
    this.#assertOpen();
    const normalizedSurfaceId = requiredString(surfaceId, 'surfaceId');
    this.#assertSurfaceAllowed(normalizedSurfaceId);
    const normalizedRuntimeKind = optionalString(runtimeKind);
    const key = connectionKey(normalizedSurfaceId, normalizedRuntimeKind);
    const existing = this.#connections.get(key);
    if (existing) return existing;
    const pending = this.#attachments.get(key);
    if (pending) return await pending;

    const attachment = (async (): Promise<AttachedSurface> => {
      const attached = unwrapOuterToolResult(await this.#client.callTool('mcp_loader_attach_surface', {
        site_root: this.siteRoot,
        surface_id: normalizedSurfaceId,
        ...(normalizedRuntimeKind ? { runtime_kind: normalizedRuntimeKind } : {}),
      }));
      const connectionId = requiredString(attached.connection_id, 'mcp_loader_attach_connection_id');
      this.#assertOpen();
      const connection = { connectionId, surfaceId: normalizedSurfaceId, runtimeKind: normalizedRuntimeKind };
      this.#connections.set(key, connection);
      return connection;
    })();
    this.#attachments.set(key, attachment);
    try {
      return await attachment;
    } finally {
      this.#attachments.delete(key);
    }
  }

  async call(
    surfaceId: string,
    toolName: string,
    args: JsonRecord = {},
    options: SiteFabricToolCallOptions = {},
  ): Promise<JsonRecord> {
    const connection = await this.attach(surfaceId, options.runtimeKind);
    const timeoutMs = options.timeoutMs ?? this.#client.requestTimeoutMs;
    const outer = unwrapOuterToolResult(await this.#client.callTool('mcp_loader_call_tool', {
      connection_id: connection.connectionId,
      tool_name: requiredString(toolName, 'toolName'),
      arguments: args,
    }, timeoutMs));
    if (outer.result_bounded === true || typeof outer.details_ref === 'string') {
      throw new Error(`mcp_runtime_result_materialized:${surfaceId}:${toolName}`);
    }
    const childResult = asRecordStrict(outer.result, 'mcp_loader_child_result_missing');
    return unwrapChildToolResult(childResult, `${surfaceId}:${toolName}`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#attachments.clear();
    let firstError: Error | null = null;
    const connections = [...this.#connections.values()].reverse();
    this.#connections.clear();
    for (const connection of connections) {
      try {
        await this.#client.callTool(
          'mcp_loader_detach',
          { connection_id: connection.connectionId },
          this.#detachTimeoutMs,
        );
      } catch (error) {
        firstError ??= toError(error);
      }
    }
    await this.#client.close();
    if (firstError) throw firstError;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('site_fabric_client_closed');
  }

  #assertSurfaceAllowed(surfaceId: string): void {
    if (this.allowedSurfaceIds && !this.allowedSurfaceIds.has(surfaceId)) {
      throw new Error(`site_fabric_surface_not_allowed:${surfaceId}`);
    }
  }
}

export function defaultMcpLoaderEntrypoint(): string {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const parent = resolve(sourceDirectory, '..');
  const packageRoot = parent.endsWith(`${separator()}dist`) ? resolve(parent, '..') : parent;
  return resolve(packageRoot, '..', '..', 'mcp-loader-mcp', 'dist', 'src', 'main.js');
}

function unwrapOuterToolResult(result: JsonRecord): JsonRecord {
  return unwrapChildToolResult(result, 'mcp-loader');
}

function unwrapChildToolResult(result: JsonRecord, context: string): JsonRecord {
  if (result.isError === true) throw new Error(`mcp_tool_error:${context}:${toolText(result) || 'unknown'}`);
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = toolText(result);
  if (!text) return {};
  try {
    return asRecordStrict(JSON.parse(text), `mcp_tool_result_not_object:${context}`);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`mcp_tool_result_not_json:${context}`);
    throw error;
  }
}

function toolText(result: JsonRecord): string {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .map((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n');
}

function normalizeSurfaceIds(values: readonly string[] | undefined): ReadonlySet<string> | null {
  if (values === undefined) return null;
  const normalized = new Set(values.map((value) => requiredString(value, 'allowedSurfaceId')));
  if (normalized.size === 0) throw new Error('allowedSurfaceIds_must_not_be_empty');
  return normalized;
}

function connectionKey(surfaceId: string, runtimeKind: string | null): string {
  return `${surfaceId}\u0000${runtimeKind ?? ''}`;
}

function asRecordStrict(value: unknown, code: string): JsonRecord {
  if (!isRecord(value)) throw new Error(code);
  return value;
}

function requiredString(value: unknown, name: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${name}_must_be_non_empty_string`);
  return normalized;
}

function optionalString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name}_must_be_positive_integer`);
  return resolved;
}

function separator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
