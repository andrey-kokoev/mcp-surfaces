# @narada2/sonar-site-ops-mcp

Sonar site-ops MCP runtime and site loop tools.

This package exposes Sonar-local operational helpers, documentation/test selectors, and the Sonar email resident Site Operating Loop controls.

## Boundary

- Allowed: inspect Sonar site-ops readiness and allowlisted docs/tests.
- Allowed: run approved local test selectors.
- Allowed: inspect and control the Sonar email resident Site Operating Loop.
- Allowed: run one bounded site-loop pass.
- Not allowed: arbitrary shell commands.
- Not allowed: general task lifecycle mutation outside the explicit site-loop/task dispatch behavior.
- Not allowed: mailbox reading or Graph draft operations; those belong to `mailbox-mcp` and `graph-mail-mcp`.

## Tools

General site ops:

- `site_ops_doctor`
- `site_docs_list`
- `site_docs_show`
- `site_test_list`
- `site_test_run`

Sonar email resident loop:

- `site_loop_status`
- `site_loop_health`
- `site_loop_operating_status`
- `site_loop_readiness`
- `site_loop_coherence`
- `site_loop_runs_list`
- `site_loop_run_show`
- `site_loop_attention_list`
- `site_loop_attention_show`
- `site_loop_attention_ack`
- `site_loop_control_set`
- `site_loop_run_once`

## Site Loop Notes

`site_loop_run_once` runs a bounded Sonar email resident loop pass. It can request `source_sync`, bridge inbox envelopes to task lifecycle work, reconcile mailbox ticket tasks, and dispatch resident directives through the site loop logic. Source sync delegates to the site CLI; this package does not itself implement mailbox sync.

Readiness/coherence tools report whether operating prerequisites are satisfied, including optional mailbox-chain proof checks when requested.

## Run

```powershell
pnpm --filter @narada2/sonar-site-ops-mcp build
node packages/sonar-site-ops-mcp/dist/src/site-ops-mcp-server.js --site-root D:/code/site
```

## Agent Guidance

Agents should use the docs and test selector tools instead of shelling out. Loop control mutations should include a reason and principal. Use `site_loop_run_once` for bounded operation, not as a general-purpose automation shell.

## Verification

```powershell
pnpm --filter @narada2/sonar-site-ops-mcp test
```
