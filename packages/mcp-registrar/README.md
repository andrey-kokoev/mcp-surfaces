# @narada2/mcp-registrar

MCP surface registrar for binding/unbinding surfaces across Narada sites and carriers (opencode, Kimi, Codex).

## Purpose

Manages the surface-to-site-to-carrier weave so carrier and Site MCP config is generated rather than hand-maintained.

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
| `registrar_sync` | Bind surfaces across configured sites and carriers |
| `registrar_site_mcp_fabric_validate` | Validate a Site's materialized MCP fabric |
| `registrar_site_surface_registry_sync` | Materialize the Site action-admission registry from fabric and catalog |
| `registrar_site_registry_conformance_check` | Prove live tools, fabric, catalog, and materialized registry agree |
| `registrar_site_output_reader_closure_check` | Prove output-ref producers retain an admitted read-only reader |

## Materialized Registry Conformance

Conformance is a four-layer proof, not a tool-name allowlist check:

1. Run `mcp_loader_site_tool_inventory_check` against the target Site root. It starts fresh children and returns `observed_tools`, `observed_read_only_tools`, and `observed_mutating_tools`.
2. Validate the Site fabric with `registrar_site_mcp_fabric_validate`.
3. Materialize intentional changes with `registrar_site_surface_registry_sync`.
4. Pass all three live observation maps unchanged to `registrar_site_registry_conformance_check`.

The proof fails on missing live evidence, absent boolean `readOnlyHint`, duplicate tools, incomplete or overlapping semantics, external refusal lists, fabric/catalog/live drift, projection/provenance drift, and missing output-reader closure. Tool names never determine behavior.

## Boundary

Edits config files (JSON/TOML) but does not start or stop servers, mutate the surfaces themselves, or grant runtime authority.

Carrier approval controls are treated as volatile carrier UX/admission mechanics, not Narada policy authority. The registrar may generate carrier availability metadata, such as Codex `approval_mode = "approve"`, so registered Narada MCP tools are available without redundant carrier prompts. Authorization, refusal, audit, and semantic constraints remain owned by the MCP surfaces themselves.

This is the `CarrierAdmissionNeutralization` concept in Narada proper: `D:/code/narada/packages/domains/concepts/records/carrier-admission-neutralization.concept.json`.

## Wiring Surfaces

Use the registrar when you want to inject a standalone MCP surface into Codex, opencode, Kimi, or a Narada site without hand-editing carrier config.

- `registrar_site_bind` writes a site-local `.ai/mcp/` binding.
- `registrar_carrier_bind` writes carrier config in the carrier's own format.
- `registrar_sync` applies the same surface binding across the supported sites and carriers.

For a concrete example, `@narada2/local-filesystem-mcp` can run standalone, while this registrar handles how it gets exposed to a specific CLI or TUI. See `docs/mcp-wiring.md` for the emitted Codex, opencode, and Kimi shapes.

## Quick Start

```
pnpm --filter @narada2/mcp-registrar test
```
