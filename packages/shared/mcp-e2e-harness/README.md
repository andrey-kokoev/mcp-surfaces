# MCP E2E Harness

The mcp-e2e-harness package contains generic mechanics for real MCP end-to-end
tests. It does not create Site configuration, define surface policy, provide
fake domain behavior, or make assertions about a surface.

It provides:

- bounded JSONL and Content-Length MCP child spawning and request/response transport;
- deterministic child shutdown with a bounded kill grace period;
- temporary E2E root creation and cleanup;
- JSON-RPC record and structured-content normalization;
- bounded JSONL evidence readback and result artifact writing;
- TOML path escaping for generated test policy.

Surface tests remain responsible for their Site fabric, registrar/loader
configuration, provider or carrier authority, assertions, and cleanup of
domain-specific resources.
