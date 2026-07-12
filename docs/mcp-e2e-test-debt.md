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

## Coverage Levels

Each debt item should name the missing level explicitly.

| Level | Boundary proved |
| --- | --- |
| L1 | Actual surface child process and MCP transport |
| L2 | Site fabric, registrar/loader admission, and configured entrypoint |
| L3 | Real local authority such as SQLite, filesystem, Git, scheduler, or process lifecycle |
| L4 | Real external authority or carrier: Graph, provider runtime, speech API, Windows host, or carrier session |
| L5 | Complete user workflow across launcher, carrier, Site fabric, surface, authority, and durable evidence |

## Current Evidence

| Surface | Existing test | Honest classification | What it does not prove |
| --- | --- | --- | --- |
| `site-loop-mcp` | `test/site-loop-live-e2e.test.ts` | L1, isolated temporary Site | Production scheduler, resident carrier, real Site registry, and unattended recovery |
| `delegated-task-mcp` | [`test/site-fabric-worker-e2e.test.ts`](../packages/delegated-task-mcp/test/site-fabric-worker-e2e.test.ts), `test/live-worker-integration.test.ts`, Narada `packages/agent-web-ui/test/live-delegated-task-launcher-e2e.mjs` | L1-L3 Site-fabric delegation proof plus L5 launcher-to-carrier workflow through the actual launcher, NARS carrier, `nars-session-mcp`, delegated-task child, worker carrier, and controlled provider; verifies task/event persistence, review acceptance, binding evidence, negative admission, durable worker artifacts, and cleanup | External provider service behavior remains separate; both controlled tests use a bounded local HTTP provider fixture |
| `worker-delegation-mcp` | [`test/live-edit-e2e.test.ts`](../packages/worker-delegation-mcp/test/live-edit-e2e.test.ts), [`test/site-fabric-provider-e2e.test.ts`](../packages/worker-delegation-mcp/test/site-fabric-provider-e2e.test.ts), [`test/real-carrier-e2e.test.ts`](../packages/worker-delegation-mcp/test/real-carrier-e2e.test.ts) | L1-L3 edit and Site-fabric proofs plus L4 real `narada-agent-runtime-server` carrier execution through the built MCP child; verifies provider request, model/reasoning binding, lifecycle events, durable run artifacts, refusal, and cleanup | External provider service behavior; the L4 test deliberately uses a bounded local HTTP fixture authority |
| `surface-feedback-mcp` | `test/surface-feedback-task-lifecycle-integration.test.ts` | In-process multi-Site integration test | Real MCP child transport and real registrar/loader fabric |
| `task-lifecycle-mcp` | `stdio-smoke.test.ts`, `protocol-smoke.test.ts`, `inbox-bridge.test.ts` and review regressions | L1-adjacent and domain integration | A carrier-launched Site session and real external delivery |
| all other surfaces | Package tests and protocol smoke tests | Unit, contract, or protocol coverage | Real child-process Site-bound workflows unless listed below |

## Debt Register

Status vocabulary: `missing`, `partial`, `blocked`, `complete`. A row is not
complete until its acceptance evidence is linked from the test and the result
is reproducible without hidden operator state.

The worker-delegation provider/cognition row below is complete only for local
binding and projection through the admitted worker runtime. External provider
or carrier execution is a separate L4/L5 concern and is not claimed by this
controlled fixture.

Controlled L4/L5 coverage is now present for delegation. The worker L4 test
uses the production `narada-agent-runtime-server` carrier with a bounded local
HTTP provider fixture. The Narada Agent Web UI L5 test starts the real launcher,
carrier, Site-local MCP fabric, `nars-session-mcp`, delegated-task surface, and
worker carrier, then verifies durable task and worker artifacts. These tests
prove the local production topology and carrier protocol; they do not claim
live external-provider authority.

| Priority | Surface | Missing real boundary | Required proof | Status |
| --- | --- | --- | --- | --- |
| P0 | `site-loop-mcp` | Production Site Loop operation | Start the configured supervisor or sanctioned scheduler path, run one bounded pass, prove resident delivery, durable run outcome, recovery state, and cleanup | missing |
| P0 | `task-lifecycle-mcp` | Site-bound carrier lifecycle | Launch the actual Site-bound MCP child, claim/finish/review a controlled task, and verify SQLite plus Markdown closure evidence | partial |
| P0 | `mcp-registrar` | Registry-to-live-surface conformance | Generate a Site fabric, load every declared surface through the loader, compare tools/list with admission metadata, and fail on drift | partial |
| P0 | `mcp-loader-mcp` | Runtime attachment workflow | Attach a declared surface from generated Site fabric, call it through the proxy, inspect child health, replace it, and detach it | partial |
| P0 | `launcher-mcp` | Launcher-to-carrier inheritance | Start a carrier through the launcher, verify selected Site/User Site MCP inheritance, process ownership, hidden child posture, and clean teardown | missing |
| P0 | `delegated-task-mcp` | Real worker runtime and launcher workflow | [`test/site-fabric-worker-e2e.test.ts`](../packages/delegated-task-mcp/test/site-fabric-worker-e2e.test.ts) proves the L1-L3 Site-fabric boundary; Narada `packages/agent-web-ui/test/live-delegated-task-launcher-e2e.mjs` proves the L5 launcher/carrier/Site-fabric/delegated-task/worker/artifact workflow with a controlled provider | complete |
| P0 | `worker-delegation-mcp` | Provider/cognition binding and real carrier | [`test/site-fabric-provider-e2e.test.ts`](../packages/worker-delegation-mcp/test/site-fabric-provider-e2e.test.ts) proves controlled provider binding; [`test/real-carrier-e2e.test.ts`](../packages/worker-delegation-mcp/test/real-carrier-e2e.test.ts) proves L4 execution through the production NARS carrier and durable artifacts | complete |
| P0 | `worker-delegation-mcp` | External provider authority | Run the L4 carrier proof against an explicitly admitted external provider account or controlled tenant and retain bounded provider evidence without weakening credential or mutation policy | missing |
| P1 | `local-filesystem-mcp` | Real governed filesystem child | Start the surface through Site fabric, exercise read/write/reader boundaries, timeout behavior, allowed roots, and refusal evidence | missing |
| P1 | `structured-command-mcp` | Real command policy boundary | Start the child, run admitted argv commands, verify bounded stdout/stderr paging, timeout behavior, refusal classification, and no shell escape | missing |
| P1 | `git-mcp` | Real repository publication path | Use a disposable repository and verify status/diff/add/commit/push policy through the MCP child, including refusal and cleanup | missing |
| P1 | `site-inbox-mcp` | Real Site inbox bridge | Materialize a controlled envelope, promote/acknowledge it through the child, and verify task/inbox durable state and idempotency | missing |
| P1 | `mailbox-mcp` | Real synced mailbox projection | Start against a controlled mailbox projection, read a bounded message/thread, exercise output paging, and verify site-root isolation | missing |
| P0 | `graph-mail-mcp` | Real Graph delegated auth and mail lifecycle | Use device-code or configured delegated auth against a controlled mailbox; query, create draft, attach a controlled file, list/move folders, and prove no send without policy | missing |
| P1 | `calendar-mcp` | Real Graph calendar lifecycle | Use a controlled calendar and delegated auth to read/create/update/delete only under explicit policy, then verify idempotency and cleanup | missing |
| P1 | `speech-mcp` | Real remote speech path | Call the configured TTS and transcription providers, capture bounded audio, verify transcript/artifact routing, and prove `ask-and-transcribe` response semantics | missing |
| P1 | `scheduler-mcp` | Real Windows Task Scheduler boundary | Register a uniquely scoped disposable task, inspect/run it, observe result, and remove it through MCP with bounded host cleanup | missing |
| P1 | `agent-context-mcp` | Real startup hydration | Launch a Site-bound child, execute startup hydration, read bounded checkpoint/output pages, and verify authority/checkpoint persistence | missing |
| P1 | `sop-mcp` | Real SOP durable run | Start and advance a controlled SOP through the MCP child, restart it, resume it, and verify durable state and explicit operator gates | missing |
| P1 | `surface-feedback-mcp` | Real feedback-to-task fabric | Submit feedback through a child process, convert it through the admitted task-lifecycle child, retry idempotently, and read audit/handoff state | partial |
| P1 | `artifacts-mcp` | Real artifact registration/readback | Register a bounded Site-owned artifact through the child, retrieve the render reference, and verify root/authority isolation | missing |
| P1 | `nars-session-mcp` | Existing NARS session control | Attach to a real existing session, submit bounded input, read bounded events/artifacts, and verify stale-session refusal | missing |
| P2 | `runtime-introspection-mcp` | Real runtime trace | Inspect a live launcher/carrier/session chain and verify process identity, surface composition, and bounded trace readback | missing |
| P2 | `operator-routing-mcp` | Real operator routing | Submit a controlled transcript, route to a selected Site/agent, verify fallback packaging, and prove unsupported carrier behavior is truthfully reported | missing |
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
