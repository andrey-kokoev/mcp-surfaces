# @narada2/launcher-mcp

Read-only MCP surface for Narada launcher registry inspection, option modeling, startup planning, and coherence checks.

This surface does not launch agents or execute PowerShell. It reports registry and plan state only.

## Telemetry

Telemetry is optional and disabled unless the site enables `.ai/mcp-telemetry.json`. When enabled, this surface emits metadata-only tool status events and does not persist registry records, launch plans, or other raw result payloads.
