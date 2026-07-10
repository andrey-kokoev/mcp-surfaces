# NARS Session MCP

`@narada2/nars-session-mcp` is a Narada-specific MCP adapter for governed
input to an existing NARS session.

The canonical semantic contract is maintained in Narada proper:

`D:/code/narada/docs/architecture/nars-session-input-contract.md`

The MCP-facing target and boundary notes are in:

`docs/nars-session-mcp-target.md`

## Tools

- `nars_session_guidance`
- `nars_session_list`
- `nars_session_show`
- `nars_session_input_deliver`
- `nars_session_input_status`

## Binding

The process requires `NARADA_SITE_ROOT` and `NARADA_AGENT_ID` for the default
agent-source posture. `NARADA_SITE_ID` and `NARADA_CARRIER_SESSION_ID` provide
additional binding provenance. `steer` requires explicit
`NARADA_NARS_SESSION_ALLOW_STEER=1`.

Session paths are resolved through `@narada2/site-paths`; the adapter does not
construct `.narada` or `crew/nars-sessions` paths itself.

## Boundary

The adapter discovers session projections, verifies the live authority health
and write posture, creates a canonical carrier input event, and submits it
through the NARS WebSocket event endpoint. It does not write `control.jsonl`,
own a second queue, invoke a provider, or claim provider completion.
