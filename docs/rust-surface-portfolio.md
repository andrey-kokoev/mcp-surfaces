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
| `local-filesystem` | Intentionally dual | Rust read applet and `fs_write_file` vertical slice are tested and benchmarked. JavaScript remains authoritative for string/range edit, patch, move, directory, and delete tools until a full mutation-parity slice earns a default change. |
| `structured-command` | Intentionally dual | Rust policy, synchronous argv execution, timeout/cancellation, input refs, paging, output refs, and parse-check canary exist. JavaScript remains authoritative for durable background execution and confirmed Windows UAC elevation; benchmark both lanes without changing the default. |
| `git` | Intentionally dual | Rust read-only Git subprocess canary is a coherent bounded implementation; JavaScript remains authoritative for scoped mutation, conflict recovery, and publication until those semantics justify a second authority. |
| `mcp-loader` | JavaScript-native | Child attachment is mechanical, but loader projections and live contract discovery are coupled to the JavaScript catalog; a Rust port would duplicate the descriptor authority without a demonstrated lifecycle benefit. |
| `mcp-registrar` | JavaScript-native | The registrar composes every package descriptor and carrier schema, then projects carrier-specific configuration; moving that compiler to Rust would create a second authority. |
| `runtime-introspection` | JavaScript-native | Trace analysis is portable, but the memory observer includes V8-attributed/residual process semantics and a Node-owned SQLite store; a Rust port would change the meaning of the evidence rather than merely change the runtime. |
| `launcher` | JavaScript-native | Registry and plan modeling are small, but launcher behavior is host-console policy with no independent Rust advantage established. |
| `scheduler` | JavaScript-native | Task activation, outbox dispatch, and Windows Task Scheduler behavior are policy/domain orchestration; a Rust actuator would not replace that authority. |
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
| Runtime proxy | Native protocol tests; minimal and strong runtime benchmarks; native startup/memory measurements; registrar unit test confirms native proxy default when available | Per-surface lifecycle workload attribution beyond the candidate matrix |
| Local filesystem | Native read tests; native `fs_write_file` protocol test; direct write microbenchmark; `filesystem-write-load` strong workload across JavaScript and Rust-native lanes | Full write-tool parity beyond `fs_write_file`; mutation failure/cancellation breadth; integrated parity for every remaining mutation tool |
| Structured command | JavaScript contract tests and realistic command workload; Rust policy/guidance/synchronous slice, direct protocol/timeout test, and native-child integrated benchmark lane | Background durability and confirmed UAC remain JavaScript authority; add parity evidence for the retained Rust canary |
| Git | JavaScript contract tests and bounded Git policy | Rust read canary, direct protocol test, and `real-git` strong workload now cover policy, status, sync state, branches, dirty summary, diff, log, and show. Mutation/recovery/publication remain JavaScript authority. |
| Dual infrastructure | The shared Rust proxy is already native; structured-command and Git are the only current dual surface canaries | Reopen another infrastructure port only when a concrete Rust-owned boundary and workload hypothesis exists |
| JavaScript-native surfaces | Package contract tests and domain-specific e2e tests | No Rust comparison is required unless the fit decision changes |

## Work order

1. Complete native filesystem mutation parity.
2. Keep structured-command explicitly dual: maintain the Rust synchronous
   canary and benchmark it against the JavaScript authority for retained
   behavior.
3. Keep the Rust Git implementation as a read canary and benchmark it against
   the JavaScript authority; keep guarded write/recovery operations in the
   JavaScript authority unless evidence changes the decision.
4. Add focused workload rows for filesystem write, structured command, and Git
   inspection/publication to the benchmark report.
5. Treat the remaining infrastructure surfaces as JavaScript-native unless a
   concrete workload hypothesis identifies a separable Rust-owned boundary.

Each Rust candidate must pass contract equivalence before a registrar default
changes. Benchmarks are measurements, not predeclared latency thresholds; the
decision is based on correctness plus total operational simplicity.
