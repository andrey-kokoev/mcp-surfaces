import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line) as Record<string, any>;
  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fresh-payload-echo-mcp', version: '1.0.0' },
    });
    return;
  }
  if (request.method === 'tools/call') {
    const payload = {
      status: 'ok',
      invoked_tool: request.params?.name ?? null,
      received_arguments: request.params?.arguments ?? {},
    };
    respond(request.id, {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
    });
  }
});

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
