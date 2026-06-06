# @narada2/graph-mail-mcp

Policy-gated Microsoft Graph mail MCP surface for live reads and draft lifecycle operations.

Use this package when an agent needs live Microsoft Graph state or needs to create and manage Outlook drafts. Routine mailbox reading should use `@narada2/mailbox-mcp` first.

## Boundary

- Allowed: query live Microsoft Graph mail for configured mailboxes.
- Allowed: show one live Graph message.
- Allowed: create new drafts.
- Allowed: create reply, reply-all, and forward drafts.
- Allowed: update or discard drafts.
- Send from draft: disallowed by default.
- Not exposed: one-shot direct send operations such as Graph `sendMail`, direct reply send, direct reply-all send, or direct forward send.
- Not allowed: PowerShell or arbitrary command execution.

## Runtime Contract

The server needs a Microsoft Graph access token. Provide it with:

```text
MS_GRAPH_ACCESS_TOKEN
```

The token must already have the Graph permissions needed by the site runtime. This MCP package does not perform interactive authentication, token refresh, device login, or secret storage.

## Site Policy

Policy is read from `.ai/graph-mail-mcp.json` under the site root.

Conservative default:

```json
{
  "graph_base_url": "https://graph.microsoft.com/v1.0",
  "allowed_mailboxes": ["support@example.test"],
  "allow_send_draft": false
}
```

Sending drafts requires explicit opt-in:

```json
{
  "graph_base_url": "https://graph.microsoft.com/v1.0",
  "allowed_mailboxes": ["support@example.test"],
  "allow_send_draft": true,
  "send_approval_token": "operator-issued-token"
}
```

Policy fields:

- `graph_base_url`: optional Graph API base URL. Defaults to `https://graph.microsoft.com/v1.0`.
- `allowed_mailboxes`: optional mailbox allowlist. When present, `me` must also be listed explicitly if agents may use `/me`.
- `allow_send_draft`: defaults to `false`.
- `send_approval_token`: optional token required by `graph_mail_draft_send`.

## Audit

Draft mutations and send refusals/completions are written to:

```text
.ai/audit/graph-mail-mcp.jsonl
```

This includes draft create/update/discard requests, draft-send refusals, and draft-send completions.

## Tools

- `graph_mail_doctor`: reports token presence and active policy.
- `graph_mail_query`: queries live Graph messages with optional mailbox, folder, search, filter, select, and limit arguments.
- `graph_mail_message_show`: shows one live Graph message by `message_id`.
- `graph_mail_draft_create`: creates a new draft message.
- `graph_mail_reply_draft_create`: creates a reply draft from an existing message.
- `graph_mail_reply_all_draft_create`: creates a reply-all draft from an existing message.
- `graph_mail_forward_draft_create`: creates a forward draft from an existing message.
- `graph_mail_draft_update`: updates an existing draft.
- `graph_mail_draft_discard`: deletes an existing draft.
- `graph_mail_draft_send`: sends an existing draft only when policy allows it.

## Send Safety

`graph_mail_draft_send` refuses by default.

To send, all of the following must be true:

- `.ai/graph-mail-mcp.json` has `allow_send_draft: true`.
- The tool call includes `confirm_send: true`.
- If `send_approval_token` is configured, the tool call includes the same `approval_token`.
- The mailbox is allowed by `allowed_mailboxes`, when an allowlist is configured.

There is intentionally no direct-send tool. Agents must create or update a draft first, then send that existing draft only through the policy-gated send path.

## Agent Guidance

Agents should:

- Prefer `mailbox-mcp` for routine reads from synced local projections.
- Use `graph_mail_query` or `graph_mail_message_show` only when live Graph state is needed.
- Use draft tools for outbound customer-facing work.
- Never send unless an operator has intentionally enabled sending and provided the required confirmation/approval inputs.

## Verification

```powershell
pnpm --filter @narada2/graph-mail-mcp test
```
