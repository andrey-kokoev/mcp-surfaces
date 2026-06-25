# @narada2/calendar-mcp

Policy-gated Microsoft Graph calendar MCP surface for live calendar reads and guarded event management.

## Configuration

The server reads `.ai/calendar-mcp.json` from the site root.

```json
{
  "graph_base_url": "https://graph.microsoft.com/v1.0",
  "allowed_mailboxes": ["calendar@example.com"],
  "allow_event_writes": false,
  "write_approval_token": null
}
```

Authentication follows the Graph mail surface: `GRAPH_ACCESS_TOKEN`, `MS_GRAPH_ACCESS_TOKEN`, or client credentials from `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, and `GRAPH_CLIENT_SECRET`. Site `.env` and parent workspace `.env` files are read before process environment.

## Tools

- `calendar_doctor` - inspect readiness, auth mode, policy, and configured mailboxes.
- `calendar_list` - list calendars for an allowed mailbox.
- `calendar_event_query` - query calendar view events over an explicit time window.
- `calendar_event_show` - read one event.
- `calendar_event_create` - create an event only when policy enables writes and `confirm_write=true`.
- `calendar_event_update` - update an event only when policy enables writes and `confirm_write=true`.
- `calendar_event_delete` - delete an event only when policy enables writes and `confirm_write=true`.

Writes are refused by default and audited when attempted.
