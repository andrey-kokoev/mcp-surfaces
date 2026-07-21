export async function runJsonRpcStdioServer({
  stdin,
  stdout,
  handleRequest,
  parseJsonRpcInput,
}) {
  const activeRequests = new Map();
  const pendingRequests = new Set();
  let buffer = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  for await (const chunk of stdin) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')]);
    const drained = drainBufferedRequests(buffer, parseJsonRpcInput);
    buffer = drained.remaining;
    for (const request of drained.requests) {
      trackRequest(processRequest({ request, stdout, framed: drained.framed, handleRequest, activeRequests }), pendingRequests);
    }
  }
  const trailing = buffer.toString('utf8').trim();
  if (trailing.length > 0) {
    for (const request of parseJsonRpcInput(trailing)) {
      trackRequest(processRequest({ request, stdout, framed: false, handleRequest, activeRequests }), pendingRequests);
    }
  }
  await Promise.allSettled([...pendingRequests]);
}

function trackRequest(promise, pendingRequests) {
  pendingRequests.add(promise);
  promise.finally(() => pendingRequests.delete(promise)).catch(() => {});
}

async function processRequest({ request, stdout, framed, handleRequest, activeRequests }) {
  if (!request?.id && request?.method === 'notifications/cancelled') {
    const requestId = String(request.params?.requestId ?? '');
    activeRequests.get(requestId)?.abort();
    return;
  }
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return;
  const requestId = String(request.id ?? '');
  const abortController = new AbortController();
  activeRequests.set(requestId, abortController);
  writeProgress(stdout, request, 0, 'started', framed);
  try {
    const response = await handleRequest(request, {
      abortSignal: abortController.signal,
      requestId: request.id === undefined || request.id === null ? undefined : String(request.id),
    });
    writeProgress(stdout, request, 1, abortController.signal.aborted ? 'cancelled' : 'completed', framed);
    if (response) writeJsonResponse(stdout, response, framed);
  } finally {
    activeRequests.delete(requestId);
  }
}

export function drainBufferedRequests(buffer, parseJsonRpcInput) {
  const bytes = toBuffer(buffer);
  if (bytes.includes('Content-Length:')) {
    return { ...drainJsonRpcFrames(bytes), framed: true };
  }
  const requests = [];
  let cursor = 0;
  while (true) {
    const newline = bytes.indexOf(0x0a, cursor);
    if (newline < 0) break;
    const line = bytes.subarray(cursor, newline).toString('utf8').replace(/\r$/, '');
    cursor = newline + 1;
    if (line.trim().length === 0) continue;
    requests.push((() => {
      try {
        return JSON.parse(line);
      } catch {
        return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error', data: { line: line.slice(0, 200) } } };
      }
    })());
  }
  return { requests, remaining: bytes.subarray(cursor), framed: false };
}

export function drainJsonRpcFrames(buffer) {
  const requests = [];
  let remaining = toBuffer(buffer);
  while (true) {
    const separator = findHeaderSeparator(remaining);
    if (!separator) break;
    const header = remaining.subarray(0, separator.offset).toString('ascii');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const length = Number(match[1]);
    const start = separator.offset + separator.length;
    if (remaining.length < start + length) break;
    const body = remaining.subarray(start, start + length).toString('utf8');
    try {
      requests.push(JSON.parse(body));
    } catch {
      requests.push({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error', data: { body: body.slice(0, 200) } } });
    }
    remaining = remaining.subarray(start + length);
  }
  return { requests, remaining, framed: true };
}

function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
}

function findHeaderSeparator(buffer) {
  const crlfOffset = buffer.indexOf(Buffer.from('\r\n\r\n', 'ascii'));
  if (crlfOffset >= 0) return { offset: crlfOffset, length: 4 };
  const lfOffset = buffer.indexOf(Buffer.from('\n\n', 'ascii'));
  if (lfOffset >= 0) return { offset: lfOffset, length: 2 };
  return null;
}

function writeJsonResponse(stdout, response, framed) {
  const body = JSON.stringify(response);
  if (framed) {
    stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    return;
  }
  stdout.write(`${body}\n`);
}

function writeProgress(stdout, request, progress, message, framed) {
  const progressToken = request?.params?._meta?.progressToken;
  if (progressToken === undefined) return;
  writeJsonResponse(stdout, {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken, progress, total: 1, message },
  }, framed);
}
