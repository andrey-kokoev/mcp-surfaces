# Worker Delegation Test Ownership

- `output-contract.test.ts` owns worker-authored output parsing, normalization, schema-shape recovery, markdown-fenced JSON recovery, plain assistant-message fallback behavior, and worker output contract projection helpers.
- `runtime-events.test.ts` owns agent-runtime-server event extraction, assistant-message text recovery, terminal event evidence, and mutation-admission evidence.
- `diagnostics.test.ts` owns runtime error classification, runtime failure phase classification, and run progress tail parsing.
- `run-store.test.ts` owns durable run artifact listing and artifact readback projection.
- `status-handler.test.ts` owns run status/list/wait presentation helpers.
- `batch-handler.test.ts` owns batch request and run-id input normalization helpers.
- `dashboard-handler.test.ts` owns read-only dashboard mode parsing, compact dashboard run projection, pending join gates, and dashboard endpoint descriptors.
- `prompt.test.ts` owns worker prompt assembly, mode-specific guidance, runtime-specific completion guards, and exit-interview prompt requirements.
- `worker-delegation-mcp.test.ts` owns end-to-end MCP tool flows, policy/config resolution, run lifecycle behavior, status/list/wait/batch behavior, and compatibility coverage that has not yet been split into narrower subsystem tests.
- `protocol-smoke.test.ts` owns MCP JSON-RPC protocol smoke coverage.
- `diagnostic-canary-e2e.test.ts` owns the opt-in direct-stdio read-only canary, earliest-stage failure classification, child stdout/stderr capture, bounded wait, output-ref readback, durable run-artifact checks, and failure-root preservation.
