# Rust Surface Portfolio

This is the runtime portfolio for Narada MCP surfaces. It is an inventory and
decision ledger, not a claim that the portfolio is complete.

## Fit test

A surface is a Rust candidate when all of these remain true:

1. Its contract can be preserved without carrying a JavaScript runtime or
   provider SDK.
2. Its core work is mechanical, bounded, and testable: process, filesystem,
   Git, protocol, or host-system control.
3. Rust can own the same failure, cancellation, and audit semantics.
4. A realistic workload can show a useful operational benefit: startup,
   memory, throughput, or lifecycle reliability.
5. The Rust version does not create a second authority implementation whose
   drift costs more than it saves.

Domain logic, provider adapters, and dynamic Narada composition remain
JavaScript unless evidence changes the decision.

## Current decisions

`Rust-native target` means Rust is the intended primary implementation after
contract parity. `Intentionally dual` means a Rust implementation may be useful,
but both runtimes remain legitimate until workload evidence selects a default.
`JavaScript-native` means a Rust rewrite is not currently a coherent use of
effort; the existing implementation remains the authority.

| Surface | Decision | Current evidence and next proof |
|---|---|---|
| `local-filesystem` | Rust-native target | Rust read applet and `fs_write_file` vertical slice exist. Finish remaining mutation parity, then compare full read/write workloads. |
| `structured-command` | Rust-native target | Rust policy/guidance/synchronous execution slice and direct protocol test now exist. Durable output, process-tree cancellation, PowerShell parsing, elevation, and full parity remain before changing defaults. |
| `git` | Rust-native target | Bounded Git subprocess policy is generic and reusable. Start with read parity, then guarded write/recovery paths and repository workloads. |
| `mcp-loader` | Intentionally dual | Child attachment and lifecycle are mechanical, but loader projections and live contract discovery are tightly coupled to the JS catalog. Extract stable contracts first; benchmark attachment/restart behavior. |
| `mcp-registrar` | Intentionally dual | Config projection is mechanical, but the registrar composes every package descriptor and carrier schema. A Rust implementation is only coherent after descriptor/compiler authority is separated. |
| `runtime-introspection` | Intentionally dual | Read-only trace and SQLite analysis may fit Rust. Compare query/analysis workloads and memory before duplicating the current authority. |
| `launcher` | Intentionally dual | Read-only registry and plan modeling is small, but currently has no demonstrated Rust advantage. Keep a Rust canary as an evidence question, not a rewrite. |
| `scheduler` | Intentionally dual | Host task control is mechanical, but Windows Task Scheduler remains the domain authority. Benchmark a Rust actuator only after the command/contract boundary is isolated. |
| `agent-context` | JavaScript-native | Session, checkpoint, continuation, and hydration semantics are Narada domain behavior backed by shared SQLite and filesystem contracts. |
| `artifacts` | JavaScript-native | Artifact registration and renderable-reference semantics are domain projections; no independent Rust benefit is established. |
| `browser-control` | JavaScript-native | Loopback CDP and authenticated UX verification are host/provider adapters with sensitive lifecycle semantics. |
| `calendar` | JavaScript-native | Microsoft Graph provider and guarded event lifecycle remain the authority. |
| `catalog-observation` | JavaScript-native | Catalog/fabric observation is a projection of the JS descriptor authority. |
| `cloudflare-carrier` | JavaScript-native | Cloudflare carrier/provider adapter; Rust would duplicate provider semantics. |
| `delegated-task` | JavaScript-native | Durable delegated-task records, contracts, events, and handoffs are Narada domain behavior. |
| `graph-mail` | JavaScript-native | Microsoft Graph mail and draft lifecycle are provider/domain behavior. |
| `mailbox` | JavaScript-native | Read-only mailbox projection and synchronization semantics are domain-owned. |
| `nars-session` | JavaScript-native | NARS session authority remains in Narada; this package is its MCP adapter. |
| `operator-console-overlay` | JavaScript-native | Overlay lifecycle belongs to the host console implementation. |
| `operator-routing` | JavaScript-native | Transcript routing and inbox fallback are operator-domain decisions. |
| `quota-meter` | JavaScript-native | Provider quota interpretation and desktop overlay lifecycle remain host/provider-owned. |
| `site-coherence` | JavaScript-native | Site continuity posture is a Narada projection across local and Cloudflare embodiments. |
| `site-inbox` | JavaScript-native | Inbox intake and triage are site-domain behavior. |
| `site-lifecycle` | JavaScript-native | Site creation, lifecycle, relations, and gated mutations follow Narada CLI/domain contracts. |
| `site-loop` | JavaScript-native | Config-governed orchestration and lifecycle policy are Narada domain behavior. |
| `site-registry` | JavaScript-native | User Site registry authority and reconciliation planning use the shared SQLite contract. |
| `sop` | JavaScript-native | SOP templates, run state, handoffs, and action admission are domain semantics. |
| `speech` | JavaScript-native | Host TTS, capture, and transcription are provider/host adapters. |
| `surface-feedback` | JavaScript-native | Feedback authority, routing, and cross-site visibility are Narada control-plane semantics. |
| `task-lifecycle` | JavaScript-native | Task records, evidence admission, reports, and closure gates are domain authority. |
| `work-lifecycle` | JavaScript-native | Workboard and outbox semantics are domain authority. |
| `worker-delegation` | JavaScript-native | Worker runtime admission, affinity, evidence, and handoff policy are domain behavior. |

The Rust proxy itself is shared infrastructure rather than a catalog surface;
it is already Rust-native and is benchmarked independently from child-surface
implementations.

## Evidence ledger

| Area | Existing evidence | Missing evidence |
|---|---|---|
| Runtime proxy | Native protocol tests; minimal and strong runtime benchmarks; native startup/memory measurements | Per-surface lifecycle workload attribution |
| Local filesystem | Native read tests; native write protocol test; direct write microbenchmark | Full write-tool parity; failure/cancellation workload; integrated proxy topology |
| Structured command | JavaScript contract tests and realistic command workload; Rust policy/guidance/synchronous slice, direct protocol/timeout test, and native-child integrated benchmark lane | Durable output, process-tree cancellation, PowerShell parsing, elevation, and full equivalence |
| Git | JavaScript contract tests and bounded Git policy | Rust implementation, read/write/recovery equivalence, repository benchmark |
| Dual infrastructure | JavaScript contract/e2e tests | Rust canaries and evidence strong enough to justify dual maintenance |
| JavaScript-native surfaces | Package contract tests and domain-specific e2e tests | No Rust comparison is required unless the fit decision changes |

## Work order

1. Complete native filesystem mutation parity.
2. Expand the Rust structured-command slice to full contract parity, retaining
   the direct protocol/timeout test and adding integrated native-child
   benchmark evidence.
3. Add the Rust Git read applet, then guarded write/recovery operations.
4. Add focused workload rows for filesystem write, structured command, and Git
   inspection/publication to the benchmark report.
5. Revisit the four dual-runtime infrastructure surfaces only with a concrete
   workload hypothesis.

Each Rust candidate must pass contract equivalence before a registrar default
changes. Benchmarks are measurements, not predeclared latency thresholds; the
decision is based on correctness plus total operational simplicity.
