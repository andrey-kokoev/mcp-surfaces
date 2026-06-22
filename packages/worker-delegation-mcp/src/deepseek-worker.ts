import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { resolve, dirname } from 'node:path';

const DEEPSEEK_API_BASE_URL = process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MAX_ITERATIONS = 50;
const MCP_TOOL_TIMEOUT_MS = 30_000;
const API_TIMEOUT_MS = 60_000;

let diagnosticLogPath = '';

type DeepseekMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: DeepseekToolCall[];
  tool_call_id?: string;
};

type DeepseekToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type DeepseekApiChoice = {
  message: {
    content: string | null;
    reasoning_content?: string;
    tool_calls?: DeepseekToolCall[];
  };
};

type DeepseekApiResponse = {
  choices: DeepseekApiChoice[];
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type McpPendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type McpServerConnection = {
  child: ChildProcess;
  tools: McpTool[];
  buffer: string;
  pending: Map<string, McpPendingRequest>;
  nextId: number;
  dead: boolean;
  stderrTail?: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lastMessagePath = args['last-message-path'] || '';
  const model = args.model || 'deepseek-v4-flash';
  const reasoningEffort = args['reasoning-effort'] || 'high';
  const mcpConfigFile = args['mcp-config-file'] || '';
  const workerSessionId = args['worker-session-id'] || '';
  const runDir = dirname(lastMessagePath);
  diagnosticLogPath = resolve(runDir, 'diagnostic.log');

  if (!DEEPSEEK_API_KEY) {
    writeLastMessage(lastMessagePath, buildErrorOutput('DEEPSEEK_API_KEY not set'));
    process.exit(1);
  }

  const apiRequestsPath = resolve(runDir, 'api_requests.jsonl');
  const apiResponsesPath = resolve(runDir, 'api_responses.jsonl');
  const mcpToolsPath = resolve(runDir, 'mcp_tools.json');
  const conversationPath = resolve(runDir, 'conversation.json');
  const sessionsDir = resolve(runDir, '..', 'sessions');

  let conversationHistory: DeepseekMessage[];
  let mcpConnections: McpServerConnection[] = [];
  let mcpTools: McpTool[] = [];
  let sessionId = workerSessionId || generateSessionId();
  let mcpDegraded = false;

  writeFileSync(resolve(runDir, 'worker_session_id.txt'), sessionId, 'utf8');

  const prompt = readStdinAll();

  if (workerSessionId) {
    const loaded = loadSession(sessionsDir, workerSessionId);
    if (loaded) {
      conversationHistory = loaded.conversation_history;
      conversationHistory.push({ role: 'user', content: prompt });
    } else {
      conversationHistory = buildInitialMessages(prompt);
    }
  } else {
    conversationHistory = buildInitialMessages(prompt);
  }

  if (mcpConfigFile && existsSync(mcpConfigFile)) {
    try {
      const configJson = JSON.parse(readFileSync(mcpConfigFile, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
      const servers = configJson.mcpServers || {};
      const names = Object.keys(servers);
      if (names.length > 0) {
        const results = await Promise.allSettled(names.map((name) => spawnMcpServer(name, servers[name])));
        for (const r of results) {
          if (r.status === 'fulfilled') {
            mcpConnections.push(r.value);
            for (const tool of r.value.tools) mcpTools.push(tool);
          }
        }
        mcpDegraded = names.length > 0 && mcpConnections.length === 0;
        writeFileSync(mcpToolsPath, JSON.stringify(mcpTools, null, 2), 'utf8');
      }
    } catch {
      mcpDegraded = true;
    }
  }

  const toolsPayload = mcpTools.length > 0 ? mcpTools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || {},
    },
  })) : undefined;

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;

    const requestBody = buildApiRequestBody(model, reasoningEffort, conversationHistory, toolsPayload);
    appendLine(apiRequestsPath, JSON.stringify(sanitizeRequestBody(JSON.parse(requestBody))));

    const apiResult = await callDeepSeekApi(requestBody);
    if (apiResult === null) {
      writeLastMessage(lastMessagePath, addDegradedWarning(buildErrorOutput('DeepSeek API call failed - network error or timeout'), mcpDegraded));
      cleanupMcpConnections(mcpConnections);
      process.exit(1);
    }
    if (typeof apiResult !== 'string') {
      writeLastMessage(lastMessagePath, addDegradedWarning(buildErrorOutput(`DeepSeek API error: ${apiResult.message}`), mcpDegraded));
      cleanupMcpConnections(mcpConnections);
      process.exit(1);
    }
    const responseBody = apiResult;

    appendLine(apiResponsesPath, JSON.stringify(truncateResponseBody(responseBody)));

    let parsedResponse: DeepseekApiResponse;
    try {
      parsedResponse = JSON.parse(responseBody) as DeepseekApiResponse;
    } catch {
      writeLastMessage(lastMessagePath, addDegradedWarning(buildErrorOutput('Invalid JSON in API response'), mcpDegraded));
      cleanupMcpConnections(mcpConnections);
      process.exit(1);
    }

    const choice = parsedResponse.choices?.[0];
    if (!choice) {
      writeLastMessage(lastMessagePath, addDegradedWarning(buildErrorOutput('No choices in API response'), mcpDegraded));
      cleanupMcpConnections(mcpConnections);
      process.exit(1);
    }

    const msg = choice.message;
    const assistantMsg: DeepseekMessage = {
      role: 'assistant',
      content: msg.content,
    };
    if (msg.reasoning_content) assistantMsg.reasoning_content = msg.reasoning_content;
    if (msg.tool_calls && msg.tool_calls.length > 0) assistantMsg.tool_calls = msg.tool_calls;
    conversationHistory.push(assistantMsg);

    writeFileSync(conversationPath, JSON.stringify(conversationHistory, null, 2), 'utf8');

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        let toolResult: string;
        try {
          const result = await executeMcpToolCall(mcpConnections, toolCall);
          toolResult = JSON.stringify(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toolResult = JSON.stringify({ error: true, message });
        }
        conversationHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }

      saveSession(sessionsDir, sessionId, conversationHistory);
      continue;
    }

    if (msg.content) {
      const parsed = parseWorkerOutput(msg.content);
      if (parsed) {
        writeLastMessage(lastMessagePath, addDegradedWarning(parsed, mcpDegraded));
      } else {
        const wrapped = buildErrorOutput(msg.content);
        wrapped.open_questions = ['Model did not return structured JSON'];
        writeLastMessage(lastMessagePath, addDegradedWarning(wrapped, mcpDegraded));
      }
      saveSession(sessionsDir, sessionId, conversationHistory);
      cleanupMcpConnections(mcpConnections);
      return;
    }

    writeLastMessage(lastMessagePath, addDegradedWarning(buildErrorOutput('Empty response from model'), mcpDegraded));
    cleanupMcpConnections(mcpConnections);
    process.exit(1);
  }

  writeLastMessage(lastMessagePath, addDegradedWarning(buildErrorOutput('Max tool-call iterations exceeded'), mcpDegraded));
  cleanupMcpConnections(mcpConnections);
  process.exit(1);
}

function buildInitialMessages(prompt: string): DeepseekMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are a worker agent. Return one JSON object matching the worker output schema.',
        '',
        'Output schema fields:',
        '- summary (string): brief summary of what was done',
        '- deliverables (array of {path, description}): files produced or modified',
        '- open_questions (array of string): unresolved questions',
        '- next_actions (array of string): recommended follow-up actions',
        '- edits_performed (boolean): whether files were edited',
        '- target_state_changed (boolean): whether target state was modified',
        '- changes (array of {path, status, summary}): detailed list of changes',
        '- verification (array of {tool, command, status, summary, command_classification}): verification results; command_classification is focused, broad, or not_applicable',
        '- verification_budget_respected (boolean or null): whether verification/test budget and stop discipline were respected',
        '- broad_unrelated_failures (array of {command, status, summary}): unrelated failures from broad commands only',
        '- exit_interview (object or null): structured feedback',
        '',
        'Return ONLY valid JSON. Do not include markdown fences or explanatory text before or after the JSON.',
      ].join('\n'),
    },
    { role: 'user', content: prompt },
  ];
}

function buildApiRequestBody(
  model: string,
  reasoningEffort: string,
  messages: DeepseekMessage[],
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
): string {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map(serializeMessage),
    thinking: { type: 'enabled' },
    reasoning_effort: reasoningEffort,
  };
  if (tools && tools.length > 0) body.tools = tools;
  return JSON.stringify(body);
}

function serializeMessage(msg: DeepseekMessage): Record<string, unknown> {
  const result: Record<string, unknown> = { role: msg.role, content: msg.content };
  if (msg.reasoning_content) result.reasoning_content = msg.reasoning_content;
  if (msg.tool_calls) result.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) result.tool_call_id = msg.tool_call_id;
  return result;
}

function callDeepSeekApi(requestBody: string): Promise<string | { message: string } | null> {
  return new Promise((resolve) => {
    const url = new URL('/chat/completions', DEEPSEEK_API_BASE_URL);
    const req = httpsRequest(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: API_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            try {
              const parsed = JSON.parse(body);
              const errorMsg = parsed.error?.message || body;
              resolve({ message: errorMsg });
            } catch {
              resolve({ message: `HTTP ${statusCode}` });
            }
          } else {
            resolve(body);
          }
        });
      },
    );

    req.on('error', (err) => {
      console.error('HTTP request error:', err?.message || String(err));
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      console.error('HTTP request timeout');
      resolve(null);
    });
    req.write(requestBody);
    req.end();
  });
}

async function spawnMcpServer(name: string, config: McpServerConfig): Promise<McpServerConnection> {
  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  if (config.env) {
    for (const [key, val] of Object.entries(config.env)) {
      if (val !== undefined) env[key] = val;
    }
  }

  const child = spawn(config.command, config.args || [], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const connection: McpServerConnection = {
    child,
    tools: [],
    buffer: '',
    pending: new Map(),
    nextId: 1,
    dead: false,
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    connection.buffer += chunk;
    processMcpFrames(connection);
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    connection.stderrTail = (connection.stderrTail ?? '') + chunk;
  });
  child.on('error', () => {
    connection.dead = true;
    rejectAllPending(connection, new Error('MCP process error'));
  });
  child.on('close', () => {
    connection.dead = true;
    rejectAllPending(connection, new Error('MCP process closed'));
  });

  const initResult = await waitForMcpResponse(
    connection,
    sendMcpRequest(connection, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} }),
    5000,
  );
  if (initResult === undefined) throw new Error(`MCP server ${name} initialize failed`);
  sendMcpNotification(connection, 'notifications/initialized', {});

  const toolsResult = await waitForMcpResponse(
    connection,
    sendMcpRequest(connection, 'tools/list', {}),
    5000,
  );
  if (toolsResult && typeof toolsResult === 'object') {
    const resp = toolsResult as Record<string, unknown>;
    if (Array.isArray(resp.tools)) {
      connection.tools = resp.tools as McpTool[];
    }
  }

  return connection;
}

function sendMcpRequest(connection: McpServerConnection, method: string, params: Record<string, unknown>): number {
  const id = connection.nextId++;
  writeMcpFrame(connection, { jsonrpc: '2.0', id, method, params });
  return id;
}

function sendMcpNotification(connection: McpServerConnection, method: string, params: Record<string, unknown>): void {
  writeMcpFrame(connection, { jsonrpc: '2.0', method, params });
}

function writeMcpFrame(connection: McpServerConnection, message: Record<string, unknown>): void {
  const body = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  if (connection.child.stdin && !connection.child.stdin.destroyed) {
    try {
      connection.child.stdin.write(header + body);
    } catch {
      connection.dead = true;
    }
  }
}

function waitForMcpResponse(connection: McpServerConnection, id: number, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(String(id));
      reject(new Error(`MCP response timeout for request ${id}`));
    }, timeoutMs);

    connection.pending.set(String(id), {
      resolve: (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (reason: unknown) => {
        clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
      timer,
    });
  });
}

function processMcpFrames(connection: McpServerConnection): void {
  const { messages, remaining } = drainMcpFrames(connection.buffer);
  connection.buffer = remaining;

  for (const msg of messages) {
    if (msg.id !== undefined && msg.id !== null) {
      const pending = connection.pending.get(String(msg.id));
      if (pending) {
        connection.pending.delete(String(msg.id));
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result !== undefined ? msg.result : msg);
        }
      }
    }
  }
}

function drainMcpFrames(buffer: string): { messages: Record<string, unknown>[]; remaining: string } {
  const messages: Record<string, unknown>[] = [];
  let remaining = buffer;
  while (true) {
    const match = remaining.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
    if (!match) break;
    const headerLength = match[0].length;
    const length = Number(match[1]);
    if (remaining.length < headerLength + length) break;
    const body = remaining.slice(headerLength, headerLength + length);
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      messages.push(parsed);
    } catch {
      // skip malformed frames
    }
    remaining = remaining.slice(headerLength + length);
  }
  return { messages, remaining };
}

async function executeMcpToolCall(connections: McpServerConnection[], toolCall: DeepseekToolCall): Promise<unknown> {
  const toolName = toolCall.function.name;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    // use empty args
  }

  for (const conn of connections) {
    if (conn.dead) continue;
    if (!conn.tools.some((t) => t.name === toolName)) continue;
    if (conn.child.exitCode !== null || conn.child.killed || !conn.child.stdin?.writable) {
      conn.dead = true;
      rejectAllPending(conn, new Error('MCP process closed'));
      continue;
    }
    try {
      const id = sendMcpRequest(conn, 'tools/call', { name: toolName, arguments: args });
      return await waitForMcpResponse(conn, id, MCP_TOOL_TIMEOUT_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('MCP process closed') || message.includes('response timeout')) {
        conn.dead = true;
      }
      throw error;
    }
  }

  throw new Error(`No MCP server found for tool: ${toolName}`);
}

function rejectAllPending(connection: McpServerConnection, error: Error): void {
  for (const [id, pending] of connection.pending) {
    clearTimeout(pending.timer);
    pending.reject(error);
    connection.pending.delete(id);
  }
}

function cleanupMcpConnections(connections: McpServerConnection[]): void {
  for (const conn of connections) {
    if (conn.stderrTail) {
      try { appendFileSync(diagnosticLogPath, conn.stderrTail); } catch { /* ignore */ }
    }
    try {
      sendMcpNotification(conn, 'notifications/exit', {});
      if (conn.child.stdin) conn.child.stdin.end();
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      try { conn.child.kill(); } catch { /* ignore */ }
    }, 2000);
    conn.child.on('close', () => clearTimeout(timer));
  }
}

function parseWorkerOutput(content: string): WorkerOutput | null {
  let text = content.trim();
  if (text.startsWith('```')) {
    const end = text.indexOf('```', 3);
    if (end !== -1) {
      text = text.slice(3, end).trim();
      const firstNewline = text.indexOf('\n');
      if (firstNewline !== -1) {
        const firstLine = text.slice(0, firstNewline).toLowerCase();
        if (firstLine.includes('json')) {
          text = text.slice(firstNewline + 1).trim();
        }
      }
    }
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.summary === 'string') {
      return {
        summary: parsed.summary,
        deliverables: Array.isArray(parsed.deliverables) ? parsed.deliverables as Array<{ path: string; description: string }> : [],
        open_questions: Array.isArray(parsed.open_questions) ? parsed.open_questions.map(String) : [],
        next_actions: Array.isArray(parsed.next_actions) ? parsed.next_actions.map(String) : [],
        edits_performed: Boolean(parsed.edits_performed),
        target_state_changed: Boolean(parsed.target_state_changed),
        changes: Array.isArray(parsed.changes) ? parsed.changes as Array<{ path: string; status: string; summary: string }> : [],
        verification: Array.isArray(parsed.verification) ? parsed.verification as Array<{ tool: string | null; command: string | null; status: string; summary: string; command_classification?: 'focused' | 'broad' | 'not_applicable' }> : [],
        verification_budget_respected: typeof parsed.verification_budget_respected === 'boolean' ? parsed.verification_budget_respected : null,
        broad_unrelated_failures: Array.isArray(parsed.broad_unrelated_failures) ? parsed.broad_unrelated_failures as Array<{ command: string | null; status: string; summary: string }> : [],
        exit_interview: parsed.exit_interview !== undefined && parsed.exit_interview !== null ? parsed.exit_interview as Record<string, unknown> : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

type WorkerOutput = {
  summary: string;
  deliverables: Array<{ path: string; description: string }>;
  open_questions: string[];
  next_actions: string[];
  edits_performed: boolean;
  target_state_changed: boolean;
  changes: Array<{ path: string; status: string; summary: string }>;
  verification: Array<{ tool: string | null; command: string | null; status: string; summary: string; command_classification?: 'focused' | 'broad' | 'not_applicable' }>;
  verification_budget_respected: boolean | null;
  broad_unrelated_failures: Array<{ command: string | null; status: string; summary: string }>;
  exit_interview: null | Record<string, unknown>;
};

function addDegradedWarning(output: WorkerOutput, degraded: boolean): WorkerOutput {
  if (!degraded) return output;
  const warning = 'MCP servers unavailable; running without tools';
  return {
    ...output,
    summary: output.summary ? `${output.summary} [${warning}]` : warning,
    open_questions: output.open_questions.includes(warning) ? output.open_questions : [warning, ...output.open_questions],
  };
}

function buildErrorOutput(summary: string): WorkerOutput {
  return {
    summary,
    deliverables: [],
    open_questions: [],
    next_actions: [],
    edits_performed: false,
    target_state_changed: false,
    changes: [],
    verification: [],
    verification_budget_respected: null,
    broad_unrelated_failures: [],
    exit_interview: null,
  };
}

function writeLastMessage(path: string, output: WorkerOutput): void {
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(output, null, 2), 'utf8');
  } catch {
    // ignore write errors
  }
}

function appendLine(path: string, line: string): void {
  if (!path) return;
  try {
    appendFileSync(path, line + '\n', 'utf8');
  } catch {
    // ignore write errors
  }
}

function sanitizeRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'messages' && Array.isArray(value)) {
      sanitized[key] = value.map((msg) => {
        if (typeof msg === 'object' && msg !== null) {
          const m: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(msg as Record<string, unknown>)) {
            if (k !== 'reasoning_content') m[k] = v;
          }
          return m;
        }
        return msg;
      });
    } else if (key !== 'authorization' && key !== 'Authorization') {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function truncateResponseBody(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const truncated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key === 'choices' && Array.isArray(value)) {
        truncated[key] = value.map((choice: Record<string, unknown>) => {
          const c: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(choice)) {
            if (k === 'message' && typeof v === 'object' && v !== null) {
              const m: Record<string, unknown> = {};
              for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
                if (mk === 'content' && typeof mv === 'string' && mv.length > 100_000) {
                  m[mk] = mv.slice(0, 100_000) + '... [truncated]';
                } else {
                  m[mk] = mv;
                }
              }
              c[k] = m;
            } else {
              c[k] = v;
            }
          }
          return c;
        });
      } else {
        truncated[key] = value;
      }
    }
    return truncated;
  } catch {
    return { truncate_error: 'could not parse response' };
  }
}

function generateSessionId(): string {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `ds-${now}-${rand}`;
}

function saveSession(sessionsDir: string, sessionId: string, history: DeepseekMessage[]): void {
  try {
    mkdirSync(sessionsDir, { recursive: true });
    const path = resolve(sessionsDir, `${encodeURIComponent(sessionId)}.json`);
    const data = {
      schema: 'narada.worker.session.v1',
      worker_session_id: sessionId,
      conversation_history: history,
      mcp_servers: [],
      resolved_worker_config: {},
      updated_at: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // ignore save errors
  }
}

function loadSession(sessionsDir: string, sessionId: string): { conversation_history: DeepseekMessage[] } | null {
  try {
    const path = resolve(sessionsDir, `${encodeURIComponent(sessionId)}.json`);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      schema: string;
      worker_session_id: string;
      conversation_history: DeepseekMessage[];
    };
    return { conversation_history: data.conversation_history || [] };
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i += 1;
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
}

function readStdinAll(): string {
  const fd = process.stdin.fd;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const buf = Buffer.alloc(65536);
  while (true) {
    try {
      const bytesRead = readSync(fd, buf, 0, 65536, null);
      if (bytesRead <= 0) break;
      const copy = Buffer.alloc(bytesRead);
      buf.copy(copy, 0, 0, bytesRead);
      chunks.push(copy);
      totalBytes += bytesRead;
    } catch {
      break;
    }
  }
  if (totalBytes === 0) return '';
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

main().catch((err) => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
