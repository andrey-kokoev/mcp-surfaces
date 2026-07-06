# @narada2/mcp-registrar

MCP surface registrar for binding/unbinding surfaces across Narada sites and carriers (opencode, Kimi, Codex).

## Purpose

Manages the surface-to-site-to-carrier weave — so you never edit `config.toml` or `mcp.json` by hand. Knows the catalog of all 14 MCP surfaces, all 8 Narada sites, and all 3 carriers.

## Tools

| Tool | Description |
|------|-------------|
| `registrar_surface_list` | List all known surfaces with packages, entrypoints, tools |
| `registrar_site_list` | List all Narada sites |
| `registrar_site_surfaces` | Show which surfaces are bound to a site |
| `registrar_site_bind` | Write a surface config into a site's `.ai/mcp/` |
| `registrar_site_unbind` | Remove a surface from a site |
| `registrar_carrier_list` | List carriers |
| `registrar_carrier_bind` | Add surface to a carrier (JSON for opencode/kimi, TOML for Codex) |
| `registrar_carrier_unbind` | Remove from carrier |
| `registrar_sync` | Bind a surface to all 8 sites + 3 carriers in one call |

## Boundary

Edits config files (JSON/TOML) but does not start or stop servers, mutate the surfaces themselves, or grant runtime authority.

Carrier approval controls are treated as volatile carrier UX/admission mechanics, not Narada policy authority. The registrar may generate carrier availability metadata, such as Codex `approval_mode = "approve"`, so registered Narada MCP tools are available without redundant carrier prompts. Authorization, refusal, audit, and semantic constraints remain owned by the MCP surfaces themselves.

This is the `CarrierAdmissionNeutralization` concept in Narada proper: `D:/code/narada/packages/domains/concepts/records/carrier-admission-neutralization.concept.json`.

## Quick Start

```
pnpm --filter @narada2/mcp-registrar test
```
