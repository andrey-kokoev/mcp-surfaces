# MCP runtime benchmark target

## Objective

Determine whether the native Rust MCP proxy provides a material, attributable
benefit for the currently supported Bun and Node topologies, and
measure Deno as an explicitly experimental compatibility lane. The runtime
fixture also exposes a diagnostic Native/Boa lane without making Boa a
supported runtime. The benchmark
is diagnostic and user-runnable. It does not choose the production default;
the registrar selects native on supported Windows hosts and falls back to Bun
when the artifact is unavailable. A measured Deno lane does not by itself make
Deno a supported production runtime.

The benchmark must measure the same protocol fixture through each available
topology, attribute startup and resource costs by phase and process, and emit
both a canonical machine-readable report and an offline interactive HTML
artifact.

Use `benchmark:runtime` for the minimal attribution question—what overhead does the proxy add to a small fixture? Use `benchmark:strong` for the representative question—does a nontrivial surface with initialization work, payload pressure, restart churn, or a real MCP entrypoint change the user-visible result? The runtime profile reports measurements and baseline comparisons without predeclared performance thresholds; the strong profile retains workload-specific acceptance checks.

## Fixed topology matrix

The primary matrix is fixed before observing results:

| Topology | Proxy implementation/runtime | Child runtime | Role |
| --- | --- | --- | --- |
| `bun-bun` | JavaScript proxy under Bun | Bun | current baseline |
| `node-node` | JavaScript proxy under Node | Node | supported Node baseline |
| `deno-deno` | JavaScript proxy under Deno | Deno | experimental Deno baseline |
| `native-bun` | Rust native proxy | Bun | native candidate |
| `native-node` | Rust native proxy | Node | native candidate |
| `native-deno` | Rust native proxy | Deno | experimental native candidate |
| `native-boa` | Rust native proxy | Boa embedded in a Rust runner | diagnostic-only native candidate |

Unavailable runtimes are reported as skipped with a reason. Cross-runtime
combinations are out of the primary target unless an existing carrier emits
them. The Deno lanes test the narrow conjecture that the existing JavaScript
proxy and native proxy can execute the benchmark fixture under Deno's
Node-compatible runtime; they do not assert full Deno support for every
surface.

The `native-boa` lane is Windows-oriented and diagnostic-only. Boa is embedded
in a separate Rust child runner; it is not treated as a production JavaScript
runtime and has no performance threshold.

The `filesystem-search-load` workload also includes an implementation lane
outside the runtime matrix:

| Topology | Proxy | Child | Role |
| --- | --- | --- | --- |
| `native-filesystem` | Rust native proxy | Rust `filesystem` applet | measure the native local-filesystem implementation itself |
| `native-rhai-filesystem` | Rust native proxy | Rust + Rhai `rhai-filesystem` applet | measure script-dispatch overhead while keeping filesystem operations native |
| `native-dotnet-filesystem` | Rust native proxy | .NET NativeAOT filesystem applet | compare a second native implementation under the same contract |

This lane is selected only for the filesystem workload; it does not replace
the runtime matrix or add Boa to the strong workloads.

## Measurements

Each topology records:

- preflight duration;
- proxy process creation and child ownership duration;
- child `initialize` duration;
- `tools/list` duration;
- warm-call p50 and p95 latency;
- private bytes and working-set bytes for every attributed process;
- process-tree shape and exit/lifecycle status;
- runtime versions, platform, architecture, sample counts, and benchmark
  configuration.

The benchmark runs cold-start samples and a separate warm-call sample set.
The report includes raw samples, p50/p95 summaries, skipped cases, and any
harness error. It must not upload data or require a network connection.

## Interpretation

The runtime report exposes p50/p95 measurements and descriptive native-versus-
baseline ratios. It does not encode predeclared performance thresholds or turn
one topology into a pass/fail performance verdict. Harness, protocol, or
lifecycle failure still fails the command; a measured performance conclusion
requires interpreting the phase and process evidence.

## Artifact contract

The JSON report is canonical and contains a schema version, report ID,
environment, matrix, raw samples, summaries, baseline comparisons, and verdict. The HTML
artifact embeds that JSON and renders it without external assets. Users can
filter topologies, inspect individual processes and samples, and download the
embedded JSON. Paths and command arguments are redacted or normalized where
they are not needed to reproduce the measurement.

The report must state the exact command, runtime versions, sample counts, and
whether each topology was measured or skipped. A performance conclusion is
not accepted without phase attribution and process attribution. Deno command
permission flags are part of the measured environment and must remain visible
in the report or reproduction instructions.

## Strong workload profile

The repository-level strong profile is the heavier acceptance-oriented scenario. It uses the fixed topology matrix above where applicable, and adds an explicit real-surface lane for the structured-command entrypoint.

| Workload | What it proves | Default load |
| --- | --- | --- |
| `representative` | Initialization and normal use are measured against a nontrivial surface rather than a toy echo server. | 8 cold samples; 32 domain tools plus 1 proxy-owned status tool; 24 data files; 20 warm calls per sample |
| `payload-load` | Framing and transport remain correct under size and concurrency pressure. | 8 samples; 32 B, 4 KB, 64 KB; sequential plus two batches of 8 concurrent calls |
| `restart-soak` | Repeated replacement does not leak processes or fail to complete warm work. | 200 cold restarts; 2,000 warm calls |
| `real-structured-command` | The benchmark reaches a real surface and performs policy inspection plus a safe command. | 8 samples; Bun, Node, Deno when available, and native Node proxy lanes |
| `filesystem-search-load` | The benchmark reaches the real local-filesystem MCP surface and exercises search/read work over a large deterministic haystack. | 8 samples; 2,048 files (~54 MB), eight sequential filesystem commands, and eight concurrent searches per sample across the fixed matrix plus Rust, Rust + Rhai, and .NET native applet lanes |
| `filesystem-write-load` | The benchmark exercises governed low-level filesystem mutation, readback, directory lifecycle, moves, and refusal paths under the same write contract. | 8 samples; write, exact/range edits, directory create/rename/delete, move, stale-hash refusal, and nonempty-delete refusal across the fixed matrix plus Rust and Rust + Rhai native applet lanes |

The .NET lane uses the same `native_applet` invocation contract and is
reported as skipped when the .NET SDK or published executable is unavailable.

The Rust + Rhai lane compiles a fixed dispatch script once at startup. The
script receives no raw filesystem, process, or network capability; it can only
route to the existing Rust filesystem host operations.

The filesystem workload's topology list includes `native-filesystem` and
`native-rhai-filesystem` and `native-dotnet-filesystem`. The write workload
also includes `native-filesystem-write` and `native-rhai-filesystem-write`.
Each launches the
Rust proxy with `--child-invocation-kind native_applet`; the child applet
argument selects the implementation and each lane has an artifact manifest
covering the native binary.

Run it with:

```powershell
pnpm --filter @narada-core/mcp-runtime-proxy benchmark:strong
```

The strong report is canonical JSON plus an offline HTML artifact. It retains raw samples, phase timings, attributed processes, runtime versions, skipped reasons, and failures. Deno is experimental: a missing executable is `not_run`; a measured Deno failure is retained as evidence and is not silently converted into a pass.

The strong payload gate compares native Node with Node using `max(1.05 * baseline, baseline + 1 ms)`. The absolute term is a declared allowance for fixed proxy/IPC cost on tiny payloads; it is not applied to representative initialization or lifecycle correctness.

The filesystem-search-load workload is selected by default in the strong profile. Use
`--filesystem-files`, `--filesystem-lines`, and `--filesystem-concurrent` to scale
the deterministic haystack and concurrent search pressure. The workload uses
read-only fs_grep_search (files, counts, and content), fs_glob_search,
fs_file_metrics, fs_read_file_range, and fs_stat; every response and process
lifecycle must remain valid.

The filesystem-write-load workload is selected by default when requested with
`NARADA_MCP_STRONG_WORKLOADS=filesystem-write-load` (or the equivalent CLI
selection). It uses the write-mode contract and requires every topology to
advertise the complete bounded mutation set before measuring it.

For paired runtime comparisons, set
`NARADA_MCP_STRONG_REVERSE_WRITE_TOPOLOGIES=1` for a second run so collection
order is reversed; compare raw per-sample metrics rather than relying only on
the report's aggregate p95.
