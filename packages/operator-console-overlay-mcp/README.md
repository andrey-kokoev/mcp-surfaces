# @narada2/operator-console-overlay-mcp

Host-level dedicated MCP surface for the Narada Operator Console Windows overlay.

The surface owns the bounded MCP command boundary only. It delegates overlay lifecycle operations to the canonical Narada proper package at:

    packages/operator-console-overlay/src/cli.mjs

It does not use structured-command MCP, start or stop the Operator Router, manage the console server, launch a browser, or terminate arbitrary processes.

## Tools

- operator_console_overlay_guidance
- operator_console_overlay_status
- operator_console_overlay_open
- operator_console_overlay_refresh
- operator_console_overlay_close

Set NARADA_ROOT when the Narada checkout is not at the host default. The surface validates that the canonical overlay entrypoint remains inside that root. The overlay state root follows NARADA_WINDOW_SURFACE_OVERLAY_STATE_ROOT and the shared window-overlay-core default when unset.

## Verify

    pnpm --filter @narada2/operator-console-overlay-mcp test
