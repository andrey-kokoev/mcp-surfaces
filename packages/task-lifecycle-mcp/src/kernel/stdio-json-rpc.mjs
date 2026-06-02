export async function runJsonRpcStdioServer({
  stdin,
  stdout,
  handleRequest,
  parseJsonRpcInput,
}) {
  let buffer = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) {
    buffer += chunk;
    const drained = drainBufferedRequests(buffer, parseJsonRpcInput);
    buffer = drained.remaining;
    for (const request of drained.requests) {
      const response = await handleRequest(request);
      if (response) writeJsonLine(stdout, response);
    }
  }
  const trailing = buffer.trim();
  if (trailing.length > 0) {
    for (const request of parseJsonRpcInput(trailing)) {
      const response = await handleRequest(request);
      if (response) writeJsonLine(stdout, response);
    }
  }
}

export function drainBufferedRequests(buffer, parseJsonRpcInput) {
  if (buffer.includes('Content-Length:')) {
    return drainJsonRpcFrames(buffer);
  }
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  const requests = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error', data: { line: line.slice(0, 200) } } };
      }
    });
  return { requests, remaining };
}

export function drainJsonRpcFrames(buffer) {
  const requests = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = remaining.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (remaining.length < start + length) break;
    const body = remaining.slice(start, start + length);
    try {
      requests.push(JSON.parse(body));
    } catch {
      requests.push({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error', data: { body: body.slice(0, 200) } } });
    }
    remaining = remaining.slice(start + length);
  }
  return { requests, remaining };
}

function writeJsonLine(stdout, response) {
  stdout.write(`${JSON.stringify(response)}\n`);
}
