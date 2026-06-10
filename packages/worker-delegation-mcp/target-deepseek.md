# Target: DeepSeek Agent-Loop Runtime for worker-delegation-mcp

Normative keywords are `MUST`, `MUST NOT`, `SHOULD`, and `SHOULD NOT`.

## 1. Goal

Add `deepseek-api` as a fully-capable worker runtime in `@narada2/worker-delegation-mcp`. DeepSeek workers MUST be able to call MCP tools, maintain multi-turn conversations with reasoning (thinking mode), and support resumable sessions — parity with the existing `codex` runtime.

## 2. Background & Constraints

- DeepSeek API is OpenAI-compatible: `POST /chat/completions`, `https://api.deepseek.com`.
- DeepSeek supports **thinking mode**: chain-of-thought reasoning returned in `reasoning_content` alongside `content`.
- DeepSeek supports **tool calls** in thinking mode. When tools are used, `reasoning_content` MUST be passed back in subsequent requests or the API returns 400.
- The `worker-delegation-mcp` package has **zero external dependencies**. All code MUST use Node.js built-ins only.
- The Codex runtime uses the `codex` CLI as a black-box agent. The DeepSeek runtime MUST implement the agent loop itself because no equivalent CLI exists.

## 3. Architecture Overview

```
worker-delegation-mcp (MCP server)
  └─ worker_run / worker_resume
      └─ deepseek-adapter.ts
          └─ buildInvocation() → spawns deepseek-worker.mjs subprocess
              └─ deepseek-worker.mjs
                  ├─ MCP Client (stdio, connects to host-provided MCP servers)
                  ├─ DeepSeek API Client (node:https, chat.completions)
                  ├─ Agent Loop (reasoning → tool calls → API → repeat)
                  └─ writes last_message.json
```

The `deepseek-worker.mjs` is a **self-contained agent runtime**. It is spawned as a subprocess by the adapter, receives the worker prompt via stdin, and performs the entire delegation autonomously.

## 4. Fixed Scope

The DeepSeek runtime MUST support:

- Single-turn and multi-turn chat via DeepSeek `/chat/completions`.
- Thinking mode (`thinking: { type: "enabled" }`) with `reasoning_content` handling.
- Tool calling loop with MCP tools.
- Session resumption via `worker_session_id`.
- JSON output matching `worker_output.schema.json`.

The DeepSeek runtime MUST NOT:
- Require external npm packages (openai, axios, etc.).
- Support streaming responses in the first implementation.
- Support image/video input.

## 5. MCP Client Inside deepseek-worker.mjs

The worker MUST connect to the same MCP servers that the parent agent uses. This is achieved by:

### 5.1 MCP Server Discovery

The adapter MUST pass the path to a **MCP config file** as a CLI arg to the worker:
```
--mcp-config-file <path>
```

This config file MUST be a JSON file with the same shape as `~/.kimi/mcp.json`:
```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["path/to/server.mjs", "--site-root", "..."],
      "env": { ... }
    }
  }
}
```

The config file path MUST be sourced from the parent environment variable `NARADA_WORKER_MCP_CONFIG`. If absent, the worker MUST run without MCP tools (degraded to single-shot mode).

### 5.2 MCP Client Protocol

The worker MUST implement a minimal MCP stdio client using `node:child_process`:

1. For each server in the config, spawn the process.
2. Send `initialize` request with protocol version `2024-11-05`.
3. Send `initialized` notification.
4. Call `tools/list` to discover available tools.
5. Maintain one `ChildProcess` per MCP server.
6. On worker exit, send `exit` notification and kill processes.

The MCP client MUST support:
- JSON-RPC framed mode (`Content-Length: N\r\n\r\n{body}`).
- Request/response correlation via `id`.
- Timeout of 30s per MCP tool call.

### 5.3 Tool Call Execution

When DeepSeek returns `tool_calls`, the worker MUST:

1. For each `tool_call`, find the matching MCP server by tool name.
2. Call `tools/call` on that server with the parsed arguments.
3. Collect all tool results.
4. Append an `assistant` message with `tool_calls` to the conversation history.
5. Append one `tool` message per result to the conversation history.
6. Send the updated conversation back to DeepSeek API.

Tool call arguments are parsed from the `function.arguments` JSON string.

### 5.4 Tool Result Format

Tool results MUST be serialized as strings and placed in `content` of the `tool` message:
```json
{
  "role": "tool",
  "tool_call_id": "call_xxx",
  "content": "<string result>"
}
```

If a tool call fails, the content MUST be a JSON object with `error` and `message` fields.

## 6. DeepSeek API Client

### 6.1 Request Construction

The worker MUST construct `POST /chat/completions` requests with:

```json
{
  "model": "deepseek-v4-flash",
  "messages": [...],
  "tools": [...],
  "thinking": { "type": "enabled" },
  "reasoning_effort": "high"
}
```

`messages` MUST include:
- A `system` message with the worker output schema and JSON-only instruction.
- The worker prompt as a `user` message.
- All subsequent `assistant` and `tool` messages from the conversation loop.

`tools` MUST be the concatenated `tools/list` results from all connected MCP servers, formatted as OpenAI function definitions:
```json
{
  "type": "function",
  "function": {
    "name": "<tool_name>",
    "description": "<tool_description>",
    "parameters": <tool_inputSchema>
  }
}
```

### 6.2 Response Parsing

The worker MUST parse the response body and extract:
- `choices[0].message.content`: final assistant text
- `choices[0].message.reasoning_content`: chain-of-thought (MUST be stored and forwarded in subsequent requests)
- `choices[0].message.tool_calls`: array of tool call requests

If `tool_calls` is present and non-empty, the worker MUST execute tools and continue the loop.

If `tool_calls` is absent/null and `content` is present, the worker MUST attempt to parse `content` as the worker output JSON.

### 6.3 Thinking Mode Constraints

Per DeepSeek docs:
- Thinking mode defaults to `enabled`.
- `reasoning_effort`: `low` and `medium` map to `high`; `xhigh` maps to `max`.
- Thinking mode does NOT support `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`.
- The worker MUST NOT include these parameters in API requests.

### 6.4 Multi-turn Conversation Rules

The worker MUST maintain a `messages` array across turns.

**Without tool calls:** Previous turns' `reasoning_content` does NOT need to be included in subsequent requests. It MAY be omitted.

**With tool calls:** Every `assistant` message that contains `tool_calls` MUST include its `reasoning_content` in the `messages` array for all subsequent API requests. Omitting it causes API 400 errors.

The worker MUST append the full `message` object (including `content`, `reasoning_content`, and `tool_calls`) to the conversation history after each API response.

### 6.5 Authentication

The worker MUST read the API key from environment variable `DEEPSEEK_API_KEY`.
The worker MUST read the base URL from `DEEPSEEK_API_BASE_URL` (default: `https://api.deepseek.com`).

The request MUST include header `Authorization: Bearer <key>`.
The request MUST include header `Content-Type: application/json`.

### 6.6 HTTP Implementation

The worker MUST use `node:https` for API calls. No external HTTP libraries are permitted.

The worker MUST handle:
- HTTP 200 success
- HTTP 4xx/5xx errors (extract `error.message` from response body)
- Network timeouts (default 60s per request)
- JSON parse errors in response body

## 7. Agent Loop

```
1. Read prompt from stdin.
2. Load MCP config, connect to MCP servers, discover tools.
3. Build initial messages array: [system, user(prompt)].
4. LOOP (max 50 iterations):
   a. Call DeepSeek /chat/completions.
   b. If tool_calls present:
      - Execute each tool_call via MCP client.
      - Append assistant message (with reasoning_content + tool_calls).
      - Append tool messages with results.
      - CONTINUE loop.
   c. If content present and no tool_calls:
      - Attempt to parse content as worker output JSON.
      - Write to last_message.json.
      - EXIT loop.
   d. If empty response:
      - Write error to last_message.json.
      - EXIT loop.
5. Disconnect MCP clients.
6. Exit process.
```

Max iterations MUST be 50 to prevent infinite loops.
Max total runtime MUST be 30 minutes (enforced by parent adapter timeout).

## 8. deepseek-adapter.ts Contract

The adapter MUST implement the same interface as the Codex adapter:

### 8.1 Functions

- `runtimeName(): 'deepseek-api'`
- `supportsResume(): true`
- `buildDeepseekArgv(options): string[]`
- `buildInvocation(resolvedWorkerConfig, environment): Invocation`
- `runDeepseekInvocation(options): Promise<WorkerRunResult>`
- `parseLastMessage(path): WorkerOutputParseResult` (reuse from codex-adapter)
- `resultStatus(deepseekResult, parsed): WorkerRunTerminalStatus` (reuse from codex-adapter)

### 8.2 buildDeepseekArgv

Constructs argv for `node <deepseek-worker.mjs>`:

```
node <worker-script>
  --schema-path <schemaPath>
  --last-message-path <lastMessagePath>
  --model <model>
  --reasoning-effort <reasoningEffort>
  --mcp-config-file <mcpConfigPath>
  --worker-session-id <workerSessionId>   (for resume only)
```

The prompt is passed via stdin (same as Codex).

### 8.3 Session Resume

For `worker_resume`, the adapter MUST pass the existing `worker_session_id` to the worker. The worker MUST load the session state (conversation history + MCP config) from a session file and continue from the last assistant message.

Session files MUST be stored at `<runRoot>/sessions/<encoded_session_id>.json` with this shape:
```json
{
  "schema": "narada.worker.session.v1",
  "worker_session_id": "...",
  "conversation_history": [...],
  "mcp_servers": [...],
  "resolved_worker_config": {...},
  "updated_at": "..."
}
```

The worker MUST write an updated session file after each completed run.

## 9. Configuration & Policy

### 9.1 Runtime Config

`worker.runtimes.deepseek` TOML section:

```toml
[worker.runtimes.deepseek]
command = "node"
command_args = []
default_sandbox = "read-only"
default_reasoning_effort = "high"
ephemeral = true
json_events = false
```

### 9.2 Cognition Defaults

- `low` → `deepseek-v4-flash`, `high`
- `medium` → `deepseek-v4-flash`, `high`
- `high` → `deepseek-v4-flash`, `high`

All cognition levels use `deepseek-v4-flash` with `high` reasoning effort because DeepSeek maps low/medium to high anyway, and the flash model is fast enough for all tiers.

### 9.3 Environment Allowlist

Add to `ENV_KEYS` in `policy.ts`:
- `DEEPSEEK_API_KEY`
- `DEEPSEEK_API_BASE_URL`
- `NARADA_WORKER_MCP_CONFIG`

### 9.4 CLI Args

Add to `mcp-server.ts` parseArgs:
- `--deepseek-command`: override node path
- `--deepseek-command-arg`: prepend arg to worker invocation
- `--deepseek-model`: override default model

## 10. Error Handling

The DeepSeek worker MUST produce clear error outputs:

| Scenario | last_message.json | exit_code |
|----------|-------------------|-----------|
| API key missing | `{summary: "DEEPSEEK_API_KEY not set", ...}` | 1 |
| API 4xx/5xx | `{summary: "DeepSeek API error: ...", ...}` | 1 |
| Network timeout | `{summary: "DeepSeek API timeout", ...}` | 1 |
| Max iterations exceeded | `{summary: "Max tool-call iterations exceeded", ...}` | 1 |
| Invalid JSON in response | `{summary: "Model did not return valid JSON", ...}` | 0 (adapter handles via parseLastMessage) |
| MCP server connection failed | Degraded: run without tools, include warning in summary | 0 |

## 11. Run Record Artifacts

In addition to standard run record files, DeepSeek runs MUST produce:

- `api_requests.jsonl`: one JSON line per API request (sanitized, no API key).
- `api_responses.jsonl`: one JSON line per API response (truncated content if >100KB).
- `mcp_tools.json`: snapshot of discovered MCP tools at start of run.
- `conversation.json`: full conversation history (for debugging resume).

These are non-reserved files and do not conflict with existing artifacts.

## 12. Output Format

The final `last_message.json` MUST match the existing worker output schema exactly:

```json
{
  "summary": "...",
  "deliverables": [...],
  "open_questions": [...],
  "next_actions": [...],
  "edits_performed": true|false,
  "target_state_changed": true|false,
  "changes": [...],
  "verification": [...],
  "exit_interview": null|{...}
}
```

If the model's `content` is not valid JSON, the worker MUST wrap it:
```json
{
  "summary": "<raw text>",
  "deliverables": [],
  "open_questions": ["Model did not return structured JSON"],
  "next_actions": [],
  "edits_performed": false,
  "target_state_changed": false,
  "changes": [],
  "verification": [],
  "exit_interview": null
}
```

## 13. Testing Strategy

### 13.1 Unit Tests (no network)

Create a **fake DeepSeek API server** (Node.js `http.createServer`) that:
- Accepts `/chat/completions` POST requests.
- Returns mock responses with and without tool_calls.
- Returns mock `reasoning_content`.
- Verifies that `reasoning_content` is preserved across tool-call turns.

Tests MUST cover:
- Single-shot run (no tool calls)
- Multi-turn run with tool calls
- Session resume (load conversation, continue)
- Missing API key
- API error response
- Invalid JSON in model output
- MCP server discovery and tool execution
- Thinking mode parameters in request body

### 13.2 Integration Tests

- `pnpm build` passes.
- `pnpm --filter @narada2/worker-delegation-mcp test` passes.
- Protocol smoke test starts server and calls `worker_policy_inspect` with deepseek runtime visible.

### 13.3 Live Test (optional, manual)

Set `DEEPSEEK_API_KEY`, run `worker_run` with `overrides.runtime: 'deepseek-api'`, verify:
- Worker completes.
- `last_message.json` is valid.
- `api_requests.jsonl` contains thinking mode params.
- If MCP config is available, tool calls execute.

## 14. Implementation Order

1. `deepseek-worker.mjs` skeleton (CLI arg parsing, stdin read, file write)
2. `node:https` DeepSeek API client (single request, no tools)
3. JSON output parsing and `last_message.json` writing
4. MCP client (stdio, initialize, tools/list)
5. Tool calling loop
6. `reasoning_content` preservation across turns
7. Session save/load for resume
8. `deepseek-adapter.ts` (invoke worker, parse results)
9. Policy updates (runtime registration, env vars, cognition defaults)
10. `worker-tools.ts` runtime dispatch refactor
11. Tests (fake API server, full lifecycle)
12. README updates

## 15. Completion Criteria

- `worker_run` with `overrides.runtime: 'deepseek-api'` completes successfully.
- `worker_resume` with deepseek runtime loads session and continues conversation.
- Tool calls execute through connected MCP servers.
- Thinking mode is enabled by default (`thinking: {type: "enabled"}`).
- Default model is `deepseek-v4-flash`.
- All existing Codex tests continue to pass.
- New DeepSeek tests pass.
- `pnpm build` passes.
- No external dependencies added to the package.
