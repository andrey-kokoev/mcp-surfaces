import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  assertLiveToolsConform,
  defineSurface,
  type DefinedSurface,
  type McpToolDefinition,
} from './index.js';

const PROTOCOL_VERSION = '2024-11-05';

function toolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: 'fabric_fixture_guidance',
      description: 'Show operating guidance for the bounded MCP Fabric HTTP fixture.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'fabric_fixture_echo',
      description: 'Echo one bounded string from the session-pinned fixture.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', maxLength: 256 } },
        required: ['value'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

export function defineHttpFixtureSurface(url: string): DefinedSurface {
  const definitions = toolDefinitions();
  return defineSurface({
    surface_id: 'mcp-fabric-http-fixture',
    surface_version: '0.1.0',
    package: '@narada2/mcp-fabric-contracts',
    tools: definitions.map((definition) => ({
      definition,
      effect: { class: 'read', idempotency: 'replayable', confirmation: 'never' },
    })),
    projections: [{
      id: 'streamable-http',
      transport: { kind: 'streamable_http', url, headers: [] },
      injection_scope: 'local_site',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: {
        mode: 'session_pinned',
        reason: 'Reconnect to the same fixture session URL while its bounded server is alive.',
      },
    }],
  });
}

export async function startHttpFixture(): Promise<{
  url: string;
  surface: DefinedSurface;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('mcp_fabric_http_fixture_address_unavailable');
  }
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const surface = defineHttpFixtureSurface(url);
  return {
    url,
    surface,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      send(response, 404, { error: 'not_found' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 16_384) {
        send(response, 413, { error: 'request_too_large' });
        return;
      }
      chunks.push(buffer);
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      send(response, 400, { error: 'invalid_json' });
      return;
    }
    const id = message.id ?? null;
    if (message.method === 'initialize') {
      send(response, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-fabric-http-fixture', version: '0.1.0' },
        },
      });
      return;
    }
    if (message.method === 'tools/list') {
      assertLiveToolsConform(surface.descriptor, surface.tools);
      send(response, 200, { jsonrpc: '2.0', id, result: { tools: surface.tools } });
      return;
    }
    if (message.method === 'tools/call') {
      const params = asRecord(message.params);
      const args = asRecord(params.arguments);
      if (params.name === 'fabric_fixture_guidance') {
        send(response, 200, rpcToolResult(id, {
          workflow: ['initialize', 'tools/list', 'fabric_fixture_echo'],
          lifecycle: 'session_pinned',
          reconnect: 'Reuse this fixture URL while the server remains alive.',
        }));
        return;
      }
      if (params.name === 'fabric_fixture_echo' && typeof args.value === 'string') {
        send(response, 200, rpcToolResult(id, { value: args.value.slice(0, 256) }));
        return;
      }
    }
    send(response, 200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'method_or_tool_not_found' },
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rpcToolResult(id: unknown, value: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
    },
  };
}

function send(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}
