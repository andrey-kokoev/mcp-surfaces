# @narada2/site-coherence-mcp

Site-level continuity coherence readback MCP surface for comparing local Narada posture with Cloudflare embodiment posture.

This surface is read-only. It does not mutate site continuity state or perform operator actions.

## Telemetry

Telemetry is optional and disabled unless the site enables `.ai/mcp-telemetry.json`. When enabled, this surface emits metadata-only tool status events and does not persist local health snapshots, Cloudflare responses, or other raw result bodies.
