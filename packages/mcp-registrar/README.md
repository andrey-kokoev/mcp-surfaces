# @narada2/mcp-registrar

MCP surface registrar for binding/unbinding surfaces across Narada sites and carriers (opencode, Kimi, Codex).

## Purpose

Manages the surface-to-site-to-carrier weave so carrier and Site MCP config is generated rather than hand-maintained.

## V2 native catalog
Every registered surface resolves from a package-owned `SurfaceDescriptorV2`.

## V2 native catalog details
`registrar_surface_list` reports the native descriptor, descriptor/tool-contract digests, lifecycle class, and explicit projections.
Materialized Site fabric stores the selected descriptor under `surface_projection` so mcp-loader can compare it with fresh `tools/list` output.
The registrar is native-only; projection selection requires `projection_id` or unambiguous runtime context.
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

1. Run `mcp_loader_site_tool_inventory_check` against the target Site root. It starts fresh children and materializes an immutable `observation_ref`.
2. Validate the Site fabric with `registrar_site_mcp_fabric_validate`.
3. Materialize intentional changes with `registrar_site_surface_registry_sync`.
4. Pass `observation_ref` unchanged to `registrar_site_registry_conformance_check`; Registrar resolves it only under the target Site root.

The proof fails on missing live evidence, absent boolean `readOnlyHint`, duplicate tools, incomplete or overlapping semantics, external refusal lists, fabric/catalog/live drift, projection/provenance drift, and missing output-reader closure. Tool names never determine behavior.

## Recurring Fabric Drift Hygiene

The cross-site declared-versus-live tool check is documented in
[`sops/mcp-fabric-drift-hygiene.sop.yaml`](sops/mcp-fabric-drift-hygiene.sop.yaml)
and is intended to run through a daily Site Loop or task-lifecycle recurrence.
Each run calls `registrar_site_list`, captures a fresh
`mcp_loader_site_tool_inventory_check` result for every returned root, validates
the declared fabric, and classifies each finding before proposing a repair.
Loader capacity, stale-runtime, entrypoint, site-id, duplicate-surface, and
runtime-selection failures remain explicit probe findings. Registry
materialization is dry-run evidence until the owning Site fabric has been
validated; the check never regenerates config merely to conceal drift.

## Site Catalog Boundary

`registrar_site_list` reads the User Site SQLite Site Registry at
`NARADA_SITE_REGISTRY_DB`, or `%USERPROFILE%/Narada/registry.db` on the default
Windows user-locus setup. Its output is a discovery/read-model projection, not
Site authority. Legacy site IDs are returned only as compatibility metadata so
existing carrier bindings can be resolved by root. If the registry cannot be
read, the response explicitly marks `legacy_compatibility_catalog` fallback;
the static definitions are not treated as canonical.

The ref's `created_by` and payload-id namespace provide declarative lineage and accidental-misrouting protection only. They are not cryptographic provenance, grant no authority, and do not resist a principal that already has arbitrary Site filesystem-write authority.

`registrar_carrier_diff` distinguishes the exact full-file projection from parsed server definitions. `projection_changed` covers the complete generated carrier file; `server_projection_changed` and `server_changes` cover server entries only; `carrier_metadata_or_format_only` explains a full-file difference with unchanged server definitions.

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

## Kimi Carrier Contract

`pnpm test:registrar:kimi-contract` materializes the real `kimi-andrey` configuration, launches every emitted stdio server with its generated command and arguments, performs MCP initialization and `tools/list`, and validates every tool `inputSchema` against the strict contract from [MoonshotAI/walle v0.1.13](https://github.com/MoonshotAI/walle). This deterministic test requires no Kimi account or provider call and is included in the registrar package test.

The contract probe is intentionally serial and places each launched server in the Rust-backed E2E process scope. This keeps the live carrier projection coverage intact while ensuring runtime-proxy descendants are reclaimed when each probe closes.

`pnpm test:registrar:kimi-live` adds one real non-interactive Kimi provider turn with the complete materialized MCP config. It is skipped unless `NARADA_KIMI_CARRIER_LIVE_E2E=1`; running it requires operator approval and an authenticated Kimi installation. Set `NARADA_KIMI_COMMAND` to override the executable and `NARADA_KIMI_LIVE_TIMEOUT_MS` to override the 120-second timeout.

The successful live turn is provider-level evidence that Moonshot accepted the complete advertised tool set. The deterministic layer remains responsible for proving that every configured server starts and every returned schema was inspected.

## Quick Start

```
pnpm --filter @narada2/mcp-registrar test
pnpm test:registrar:kimi-contract
```
