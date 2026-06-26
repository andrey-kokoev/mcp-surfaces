export type JsonRecord = Record<string, unknown>;

export function drainJsonLines(buffer: string): { framed: false; remaining: string; requests: JsonRecord[] } {
  const lines = buffer.split(/\r?\n/);
  return { framed: false, remaining: lines.pop() ?? '', requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))) };
}

export function drainJsonRpcFrames(buffer: Buffer<ArrayBufferLike>): { framed: true; remaining: Buffer<ArrayBufferLike>; requests: JsonRecord[] } {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  const frameSeparator = Buffer.from('\r\n\r\n');
  while (true) {
    const headerEnd = remaining.indexOf(frameSeparator);
    if (headerEnd < 0) break;
    const header = remaining.subarray(0, headerEnd).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    requests.push(asRecord(JSON.parse(remaining.subarray(bodyStart, bodyEnd).toString('utf8'))));
    remaining = remaining.subarray(bodyEnd);
  }
  return { framed: true, remaining, requests };
}

export function writeJsonRpcResponse(response: JsonRecord, { framed }: { framed: boolean }): void {
  const body = JSON.stringify(response);
  if (framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  else process.stdout.write(`${body}\n`);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
