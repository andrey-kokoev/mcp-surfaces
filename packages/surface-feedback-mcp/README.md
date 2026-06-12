# @narada2/surface-feedback-mcp

Cross-site MCP surface feedback intake and routing. Any site may submit feedback about any surface — bugs, improvements, gaps, observations.

## Purpose

Provides a single durable feedback channel for MCP surfaces. Agents across all Narada sites can report surface issues without needing knowledge of which site owns the surface. SQLite-backed for durability.

## Tools

| Tool | Description |
|------|-------------|
| `surface_feedback_submit` | Submit feedback (surface_id, site, principal, kind, summary, details) |
| `surface_feedback_list` | List entries with filters by surface, site, kind, status |
| `surface_feedback_show` | Show one entry by ID |

## Kinds

- `bug` — something is broken
- `improvement` — enhancement request
- `gap` — missing capability
- `observation` — general observation

## Quick Start

```
pnpm --filter @narada2/surface-feedback-mcp test
```
