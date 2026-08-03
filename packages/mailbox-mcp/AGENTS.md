# Mailbox MCP package instructions

## Role

This package owns the mailbox domain boundary for a Site. It provides two
explicit kinds of capability:

- bounded inspection of normalized local mailbox projections;
- governed, durable mailbox operations: sync generations, first-observation
  facts, mechanical admission, and outbox consumption.

Do not describe the whole package as a generic mail client. Projection reads
are read-only and must not silently turn into live provider calls. Sync,
admission, and outbox tools are deliberate state transitions and must remain
finite, idempotent, and replay-safe.

The mailbox domain does not own Site Loop orchestration, SOP definitions or
runs, scheduler/resident lifecycle, tasks or tickets, or arbitrary command
execution. A mailbox admission produces a durable mailbox-domain fact/event;
the downstream task/work-lifecycle surface owns ticket or task creation.

## Authority split

- Mailbox MCP owns mailbox projections, generations, cursors, leases,
  idempotency, admission facts, outbox events, consumer registrations, and
  acknowledgement receipts.
- The mailbox/provider connector boundary owns provider calls, credential
  readiness, token handling, provider-specific 401/403 classification,
  retry/backoff, and provider error details. Keep those details out of Site
  Loop policy.
- graph-mail-mcp owns its explicitly configured live Graph reads and draft
  lifecycle effects. Do not make local projection inspection depend on it.
- Site Loop may consume typed mailbox outcomes and choose defer, attention,
  retry, or resume behavior. It must not implement provider authentication,
  mailbox cursor mechanics, mailbox SQL, or mailbox-specific recovery.
- Task/work lifecycle owns the downstream task and ticket projections.
- Scheduler/resident infrastructure owns cadence, execution leases, and
  process restart behavior; it does not own mailbox correctness.

Every error crossing the MCP boundary must be bounded, typed, actionable, and
redacted. Never expose tokens, authorization headers, credential-file
contents, or unbounded message bodies in diagnostics.

## Site-root and projection contract

- The Site root is the authority root.
- Default projection roots are .ai/mailboxes, .ai/synced-mailboxes, and
  operator-surfaces/mailboxes.
- .ai/mailbox-mcp.json may override projection roots only when every resolved
  root remains inside the Site root.
- Scan only the supported bounded JSON and JSONL projection shapes. Reject
  path escapes and malformed records; do not silently discard invalid mail.
- Normalize supported Graph/Outlook-shaped inputs into stable fields while
  preserving mailbox, message, thread, and timestamp identity.
- Keep tool responses bounded. Add an explicit readback/reference mechanism
  when a result cannot fit a bounded response; do not solve this with an
  unbounded dump.

The read tools operate on local projections. Missing or stale local data is
not permission to query a provider implicitly; use the explicitly governed
sync or live connector surface.

## Durability and replay invariants

- Every sync generation has a stable idempotency key and a scope lease.
- A retry with the same idempotency key and equivalent input is a replay or
  readback, never a second generation. Conflicting input fails closed.
- Never advance a cursor until the generation's durable records and required
  first-observation receipts are committed.
- Lease loss, scope contention, incomplete batches, staged-batch conflicts,
  and cursor conflicts are explicit failures. Never guess, skip, or advance
  state after one of these failures.
- Publish first-observation outbox events atomically with the completed
  generation/records as required by the domain contract.
- Consumers register a stable consumer ID and an explicit starting watermark.
- Acknowledge an outbox event only after the downstream durable effect or
  receipt is committed. Acknowledgements are idempotent; conflicting receipts
  fail closed.
- Replays must not duplicate first-observation facts, admission, outbox events,
  downstream receipts, tasks, or tickets.

Use the mailbox MCP tools for production domain operations and verification;
do not bypass the contract with direct SQLite or projection-file mutation.

## MCP surface discipline

- Treat surface-definition.ts, tool schemas, protocol smoke tests, and this
  file as one public contract.
- Keep tool names, input validation, error codes, and output shapes stable;
  make compatibility changes explicit and tested.
- Keep reads local and mechanical operations explicit. Never add hidden live
  network behavior to a read tool.
- Do not add shell-string execution, arbitrary filesystem access, or provider
  credentials to a tool merely for convenience.
- Do not make Site Loop call internal mailbox storage APIs.
- Keep diagnostics useful without including message bodies or secrets by
  default.

## Testing and change workflow

Use the package's source and scripts as the authority:

    pnpm --filter @narada-core/mailbox-mcp typecheck
    pnpm --filter @narada-core/mailbox-mcp build
    pnpm --filter @narada-core/mailbox-mcp test

Default tests must use isolated temporary Site roots and deterministic
provider fixtures. They must not require live mailbox credentials or network
access. Live tests, if any, must be explicitly named, bounded, redacted, and
skipped with a clear reason when prerequisites are absent.

The test suite should cover at least:

- protocol initialization, tool listing, and malformed input;
- projection normalization, malformed records, bounds, and path-escape
  rejection;
- sync idempotency/replay, leases, staged batches, cursor commit, and failure
  recovery;
- mechanical admission and first-observation deduplication;
- outbox ordering, consumer registration, delivery, acknowledgement replay,
  conflicting receipts, and cleanup;
- Site-fabric integration without relying on a hidden live provider.

Tests and maintenance commands must be finite and bounded. A package check
that can hang indefinitely, emit an unbounded database dump, or depend on a
provider timeout is not an acceptable default test.

Write TypeScript source and regenerate dist/ through the package build; do
not hand-edit generated JavaScript. Keep generated output, temporary
databases, WAL/SHM files, and runtime artifacts out of source commits. When a
public contract changes, update the README, surface metadata, schemas, and
relevant e2e/protocol tests together.

## Operational diagnosis

Start with mailbox_doctor for roots, projection counts, malformed records,
configuration, and durable-state readiness. Report provider readiness as a
typed mailbox/connector outcome; do not make Site Loop infer it from a generic
timeout or 403 string.

The package README currently foregrounds the read-only projection use case.
Keep that wording aligned with the actual surface definition: it must not
obscure the explicit sync, admission, and outbox mechanics described here.
