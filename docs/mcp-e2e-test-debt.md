# MCP E2E Test Debt

This is the canonical inventory of end-to-end test gaps for the MCP surfaces
repository. It records which real boundaries still need proof. Package test
files and task records may link here, but they do not replace this inventory.

## Meaning Of Real E2E

An E2E test must cross the boundary that production relies on. A test is not
E2E merely because it calls a function named `handleRequest`, uses a temporary
directory, or has `live` in its filename.

For an MCP surface, real E2E means all of the following that apply:

- Start the actual built MCP entrypoint as a child process or connect through
  the actual production transport.
- Send requests through MCP JSON-RPC framing and consume the real response
  path, including output references and reader tools when applicable.
- Materialize the real Site or carrier configuration used by the boundary under
  test. Do not bypass the registrar, loader, launcher, or admission fabric.
- Use real SQLite, filesystem, process, scheduler, or provider boundaries. A
  fake boundary may be used only in a separately labelled contract test.
- Use a controlled fixture, tenant, mailbox, or task namespace for external
  authorities. Customer-visible sends, destructive operations, and broad host
  mutations are forbidden by default.
- Fail as `not_run` when a required authority is absent. An unavailable
  prerequisite must never become a passing assertion or a silent skip.
- Record bounded evidence: test id, surface, site/carrier binding, start/end
  time, prerequisite result, operation result, and cleanup result.

These are integration or contract tests, not E2E proof:

- Direct calls to an exported `handleRequest` without a real child process.
- Injected worker, Graph, scheduler, filesystem, carrier, or transport mocks.
- Tests that only inspect generated JSON without starting the declared entrypoint.
- Tests that skip missing credentials or providers and still report success.
- Tests that exercise a temporary in-memory store without the Site fabric.

## Proof Dimensions

These are orthogonal proof claims, not a strict quality ladder. `B1`-`B4`
describe boundaries. `W1` describes composition across boundaries; it is not
a fifth boundary and does not automatically prove every direct surface
contract. Every debt item should name its required boundary and composition
claims explicitly.

| Claim | Meaning |
| --- | --- |
| `B1` | Actual surface child process and MCP transport |
| `B2` | Site fabric, registrar/loader admission, and configured entrypoint |
| `B3` | Real local authority such as SQLite, filesystem, Git, scheduler, or process lifecycle |
| `B4` | Real external authority or carrier: Graph, provider runtime, speech API, Windows host, or carrier session |
| `W1` | Complete user workflow across launcher, carrier, Site fabric, surface, authority, and durable evidence |

Authority posture is a separate dimension:

| Posture | Meaning |
| --- | --- |
| `A0` | Controlled local fixture or deterministic local authority |
| `A1` | Explicitly admitted controlled external tenant or account |
| `A2` | Production external authority |

An `A0` proof does not claim `A1` or `A2` authority. A `W1` proof may compose
`B1`-`B4` while still using `A0` for a provider or external authority.

## Current Evidence

| Surface | Existing test | Honest classification | What it does not prove |
| --- | --- | --- | --- |
| `site-loop-mcp` | `test/site-loop-live-e2e.test.ts` | B1, isolated temporary Site | Production scheduler, resident carrier, real Site registry, and unattended recovery |
| `delegated-task-mcp` | [`test/site-fabric-worker-e2e.test.ts`](../packages/delegated-task-mcp/test/site-fabric-worker-e2e.test.ts), `test/live-worker-integration.test.ts`, Narada `packages/agent-web-ui/test/live-delegated-task-launcher-e2e.mjs` | B1-B3 Site-fabric delegation proof plus W1 launcher-to-carrier workflow through the actual launcher, NARS carrier, `nars-session-mcp`, delegated-task child, worker carrier, and controlled provider; verifies task/event persistence, review acceptance, binding evidence, negative admission, durable worker artifacts, and cleanup | External provider service behavior remains separate; both controlled tests use a bounded local HTTP provider fixture (A0) |
| `worker-delegation-mcp` | [`test/live-edit-e2e.test.ts`](../packages/worker-delegation-mcp/test/live-edit-e2e.test.ts), [`test/site-fabric-provider-e2e.test.ts`](../packages/worker-delegation-mcp/test/site-fabric-provider-e2e.test.ts), [`test/real-carrier-e2e.test.ts`](../packages/worker-delegation-mcp/test/real-carrier-e2e.test.ts) | B1-B3 edit and Site-fabric proofs plus B4 real `narada-agent-runtime-server` carrier execution through the built MCP child; verifies provider request, model/reasoning binding, lifecycle events, durable run artifacts, refusal, and cleanup | External provider service behavior; the B4 test deliberately uses a bounded local HTTP fixture authority (A0) |
| `surface-feedback-mcp` | [`test/site-fabric-feedback-e2e.test.ts`](../packages/surface-feedback-mcp/test/site-fabric-feedback-e2e.test.ts), `test/surface-feedback-task-lifecycle-integration.test.ts` | B1-B3 nested child handoff, durable feedback/task state, and idempotent conversion | External User Site authority remains separate |
| `task-lifecycle-mcp` | [`test/site-fabric-lifecycle-e2e.test.ts`](../packages/task-lifecycle-mcp/test/site-fabric-lifecycle-e2e.test.ts), `stdio-smoke.test.ts`, `protocol-smoke.test.ts`, `inbox-bridge.test.ts` | B1-B3 Site-fabric carrier lifecycle with SQLite and Markdown closure evidence | A carrier-launched production Site session and external delivery |
| `agent-context-mcp` | [`test/site-fabric-agent-context-e2e.test.ts`](../packages/agent-context-mcp/test/site-fabric-agent-context-e2e.test.ts), `test/agent-context-mcp.test.ts` | B1-B3 startup hydration, SQLite checkpoints, bounded output reader, and root refusal | Production carrier/session authority |
| `sop-mcp` | [`test/site-fabric-sop-e2e.test.ts`](../packages/sop-mcp/test/site-fabric-sop-e2e.test.ts) | B1-B3 durable run, restart/resume, operator gate, and event history | Production Site Loop scheduling |
| `artifacts-mcp` | [`test/site-fabric-artifacts-e2e.test.ts`](../packages/artifacts-mcp/test/site-fabric-artifacts-e2e.test.ts) | B1-B3 child registration/read/presentation through a controlled NARS HTTP authority | Real NARS carrier authority remains separate |
| `operator-routing-mcp` | [`test/site-fabric-routing-e2e.test.ts`](../packages/operator-routing-mcp/test/site-fabric-routing-e2e.test.ts) | B1-B3 durable fallback envelope and route log with truthful unsupported-direct-delivery semantics | Runtime-specific message injection |
| all other surfaces | Package tests and protocol smoke tests | Unit, contract, or protocol coverage | Real child-process Site-bound workflows unless listed below |

## Debt Register

Status vocabulary: `missing`, `partial`, `blocked`, `complete`. A row is not
complete until its acceptance evidence is linked from the test and the result
is reproducible without hidden operator state.

The worker-delegation provider/cognition row below is complete only for local
binding and projection through the admitted worker runtime. External provider
authority remains a separate B4/A1-A2 claim and is not established by this
controlled fixture.

Controlled B4/W1 coverage is now present for delegation. The worker B4 test
uses the production `narada-agent-runtime-server` carrier with a bounded local
HTTP provider fixture (A0). The Narada Agent Web UI W1 test starts the real launcher,
carrier, Site-local MCP fabric, `nars-session-mcp`, delegated-task surface, and
worker carrier, then verifies durable task and worker artifacts. These tests
prove the local production topology and carrier protocol; they do not claim
live external-provider authority.

| Priority | Surface | Missing real boundary | Required proof | Status |
| --- | --- | --- | --- | --- |
| P0 | `site-loop-mcp` | Production Site Loop operation | Start the configured supervisor or sanctioned scheduler path, run one bounded pass, prove resident delivery, durable run outcome, recovery state, and cleanup | missing |
| P0 | `task-lifecycle-mcp` | Site-bound carrier lifecycle | [`test/site-fabric-lifecycle-e2e.test.ts`](../packages/task-lifecycle-mcp/test/site-fabric-lifecycle-e2e.test.ts) launches the actual child, claims/finishes/reviews a controlled task, and verifies SQLite plus Markdown closure evidence | complete |
| P0 | `mcp-registrar` | Registry-to-live-surface conformance | [`test/site-fabric-loader-e2e.test.ts`](../packages/mcp-registrar/test/site-fabric-loader-e2e.test.ts) plus `test/mcp-registrar.test.ts` prove live registry/loader handoff and drift checks for controlled declared surfaces; a full catalog sweep remains | partial |
| P0 | `mcp-loader-mcp` | Runtime attachment workflow | [`test/site-fabric-loader-e2e.test.ts`](../packages/mcp-registrar/test/site-fabric-loader-e2e.test.ts) plus `test/mcp-loader-mcp.test.ts` attach/call/status/detach and replace/drift behavior through real children | complete |
| P0 | `launcher-mcp` | Launcher-to-carrier inheritance | Start a carrier through the launcher, verify selected Site/User Site MCP inheritance, process ownership, hidden child posture, and clean teardown | missing |
| P0 | `delegated-task-mcp` | Real worker runtime and launcher workflow | [`test/site-fabric-worker-e2e.test.ts`](../packages/delegated-task-mcp/test/site-fabric-worker-e2e.test.ts) proves the B1-B3 Site-fabric boundary; Narada `packages/agent-web-ui/test/live-delegated-task-launcher-e2e.mjs` proves the W1 launcher/carrier/Site-fabric/delegated-task/worker/artifact workflow with a controlled provider (A0) | complete |
| P0 | `worker-delegation-mcp` | Provider/cognition binding and real carrier | [`test/site-fabric-provider-e2e.test.ts`](../packages/worker-delegation-mcp/test/site-fabric-provider-e2e.test.ts) proves controlled provider binding; [`test/real-carrier-e2e.test.ts`](../packages/worker-delegation-mcp/test/real-carrier-e2e.test.ts) proves B4 execution through the production NARS carrier and durable artifacts with a controlled provider (A0) | complete |
| P0 | `worker-delegation-mcp` | External provider authority | Run the B4 carrier proof against an explicitly admitted external provider account or controlled tenant (A1/A2) and retain bounded provider evidence without weakening credential or mutation policy | missing |
| P1 | `local-filesystem-mcp` | Real governed filesystem child | [`test/site-fabric-filesystem-e2e.test.ts`](../packages/local-filesystem-mcp/test/site-fabric-filesystem-e2e.test.ts) proves child read/write/range/stat/glob, allowed-root refusal, and bounded line windows; a deterministic blocked-read timeout case remains | partial |
| P1 | `structured-command-mcp` | Real command policy boundary | [`test/site-fabric-command-e2e.test.ts`](../packages/structured-command-mcp/test/site-fabric-command-e2e.test.ts) proves child argv execution, bounded output, timeout, refusal classification, and no shell escape | complete |
| P1 | `git-mcp` | Real repository publication path | [`test/site-fabric-git-e2e.test.ts`](../packages/git-mcp/test/site-fabric-git-e2e.test.ts) proves child status/diff/add/commit/push/log, broad-path refusal, disposable remote, and cleanup | complete |
| P1 | `site-inbox-mcp` | Real Site inbox bridge | [`test/site-fabric-inbox-e2e.test.ts`](../packages/site-inbox-mcp/test/site-fabric-inbox-e2e.test.ts) proves child admission, durable envelope state, acknowledgment, audit, and repeated-ack behavior | complete |
| P1 | `mailbox-mcp` | Real synced mailbox projection | [`test/site-fabric-mailbox-e2e.test.ts`](../packages/mailbox-mcp/test/site-fabric-mailbox-e2e.test.ts) proves child projection discovery, bounded message/thread reads, output paging, and foreign-root isolation | complete |
| P0 | `graph-mail-mcp` | Real Graph delegated auth and mail lifecycle | Use device-code or configured delegated auth against a controlled mailbox; query, create draft, attach a controlled file, list/move folders, and prove no send without policy | missing |
| P1 | `calendar-mcp` | Real Graph calendar lifecycle | Use a controlled calendar and delegated auth to read/create/update/delete only under explicit policy, then verify idempotency and cleanup | missing |
| P1 | `speech-mcp` | Real remote speech path | Call the configured TTS and transcription providers, capture bounded audio, verify transcript/artifact routing, and prove `ask-and-transcribe` response semantics | missing |
| P1 | `scheduler-mcp` | Real Windows Task Scheduler boundary | [`test/site-fabric-scheduler-e2e.test.ts`](../packages/scheduler-mcp/test/site-fabric-scheduler-e2e.test.ts), run by the explicit `test:e2e:host` script, registers/runs/inspects/history-reads/deletes one uniquely scoped disposable task | complete |
| P1 | `agent-context-mcp` | Real startup hydration | [`test/site-fabric-agent-context-e2e.test.ts`](../packages/agent-context-mcp/test/site-fabric-agent-context-e2e.test.ts) launches a Site-bound child, hydrates, persists checkpoints, reads bounded output pages, and verifies roster/root authority | complete |
| P1 | `sop-mcp` | Real SOP durable run | [`test/site-fabric-sop-e2e.test.ts`](../packages/sop-mcp/test/site-fabric-sop-e2e.test.ts) starts/advances a controlled run, restarts the child, resumes it, and verifies durable events and operator gates | complete |
| P1 | `surface-feedback-mcp` | Real feedback-to-task fabric | [`test/site-fabric-feedback-e2e.test.ts`](../packages/surface-feedback-mcp/test/site-fabric-feedback-e2e.test.ts) submits through a child, converts through its nested task-lifecycle child, retries idempotently, and reads durable task/handoff state | complete |
| P1 | `artifacts-mcp` | Real artifact registration/readback | [`test/site-fabric-artifacts-e2e.test.ts`](../packages/artifacts-mcp/test/site-fabric-artifacts-e2e.test.ts) registers/reads/presents through the child and controlled NARS HTTP authority; real NARS carrier authority remains | partial |
| P1 | `nars-session-mcp` | Existing NARS session control | Attach to a real existing session, submit bounded input, read bounded events/artifacts, and verify stale-session refusal | missing |
| P2 | `runtime-introspection-mcp` | Real runtime trace | Inspect a live launcher/carrier/session chain and verify process identity, surface composition, and bounded trace readback | missing |
| P2 | `operator-routing-mcp` | Real operator routing | [`test/site-fabric-routing-e2e.test.ts`](../packages/operator-routing-mcp/test/site-fabric-routing-e2e.test.ts) submits a controlled transcript, records the Site-inbox fallback, persists the route log, and verifies unsupported carrier behavior truthfully | complete |
| P2 | `cloudflare-carrier-mcp` | Real Cloudflare carrier | Connect to a controlled carrier endpoint, inspect health/continuity, and verify stale or unavailable carrier handling | missing |
| P2 | `site-coherence-mcp` | Cross-embodiment coherence | Compare a controlled local Site and Cloudflare embodiment and verify posture mismatch/readiness evidence | missing |
| P2 | `site-lifecycle-mcp` | Real Site lifecycle | Plan/create/inspect a disposable Site through the child, apply only allowed mutations, and verify registry/config durability | missing |
| P2 | `site-registry-mcp` | User Site registry workflow | Inspect and reconcile a controlled multi-Site registry through the child, verifying read-only and plan-only boundaries | missing |

## Required Test Artifacts

Every new real E2E test must provide:

- A package-local test and a root command discoverable from `package.json`.
- An explicit authority matrix: credentials, Site root, carrier, provider, and
  destructive-operation policy.
- A bounded setup and teardown protocol. Orphaned child processes, scheduler
  tasks, mailbox drafts, files, and temporary Sites are failures.
- A structured result artifact with `passed`, `failed`, or `not_run`; skipped
  prerequisites must include a machine-readable reason.
- At least one negative assertion for the governing refusal or boundary.
- A link from the corresponding debt row to the test and the implementing task.

The debt list is complete only when every `missing` or `partial` row has a
real test, durable evidence, and a reviewed transition to `complete`.

Host-authority tests are opt-in when they create or remove host state. The
Scheduler proof is exposed as `pnpm --filter @narada2/scheduler-mcp run
test:e2e:host`; the ordinary package test does not mutate Windows Task
Scheduler. External-authority rows remain open until a controlled tenant,
provider account, carrier session, or production Site is explicitly supplied.
A local HTTP fixture may prove the child/protocol contract, but it must not
promote a Graph, speech, NARS, Cloudflare, or production Site claim to
`complete`.
