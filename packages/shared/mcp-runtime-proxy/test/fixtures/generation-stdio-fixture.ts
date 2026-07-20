import { createInterface } from 'node:readline';

const version = process.env.GENERATION_VERSION ?? 'unknown';
const tools = [
  {
    name: 'generation_fixture_guidance',
    description: 'Show generation fixture guidance.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'generation_fixture_health',
    description: 'Read generation fixture health.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'generation_fixture_echo',
    description: 'Echo from one concrete generation.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
        delay_ms: { type: 'integer', minimum: 0, maximum: 2000 },
      },
      required: ['value'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  const request = JSON.parse(line) as Record<string, any>;
  if (request.id === undefined) continue;
  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'generation-stdio-fixture', version },
    });
    continue;
  }
  if (request.method === 'tools/list') {
    respond(request.id, { tools });
    continue;
  }
  if (request.method === 'tools/call') {
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};
    if (name === 'generation_fixture_health') {
      respond(request.id, {
        content: [{ type: 'text', text: version }],
        structuredContent: { status: 'ok', version },
        isError: process.env.GENERATION_HEALTH_FAIL === '1',
      });
      continue;
    }
    if (name === 'generation_fixture_guidance') {
      respond(request.id, {
        content: [{ type: 'text', text: 'initialize, tools/list, echo' }],
        structuredContent: { lifecycle: 'replayable' },
      });
      continue;
    }
    if (name === 'generation_fixture_echo') {
      const delay = Math.max(0, Math.min(2000, Number(args.delay_ms ?? 0)));
      await new Promise((resolve) => setTimeout(resolve, delay));
      respond(request.id, {
        content: [{ type: 'text', text: JSON.stringify({ version, value: args.value }) }],
        structuredContent: { version, value: args.value },
      });
      continue;
    }
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    error: { code: -32601, message: 'not_found' },
  })}\n`);
}

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
