# @narada2/graph-mail-mcp

Policy-gated Microsoft Graph mail MCP surface for live reads and draft lifecycle operations.

Use this package when an agent needs live Microsoft Graph state or needs to create and manage Outlook drafts. Routine mailbox reading should use `@narada2/mailbox-mcp` first.

## Boundary

- Allowed: query live Microsoft Graph mail for configured mailboxes.
- Allowed: show one live Graph message.
- Allowed: create new drafts.
- Allowed: create reply, reply-all, and forward drafts.
- Allowed: update or discard drafts.
- Allowed: inspect, add, upload, and delete message attachments through Graph mail tools.
- Send from draft: disallowed by default.
- Not exposed: one-shot direct send operations such as Graph `sendMail`, direct reply send, direct reply-all send, or direct forward send.
- Not allowed: PowerShell or arbitrary command execution.

## Runtime Contract

The server needs Microsoft Graph authorization. Prefer non-interactive application credentials, matching the mailbox sync path:

```text
GRAPH_TENANT_ID
GRAPH_CLIENT_ID
GRAPH_CLIENT_SECRET
```

The server reads these from process environment or from `.env` at the workspace root beside the site `.narada` directory. It mints and caches short-lived client-credentials tokens as needed.

For diagnostics or explicit override, callers may still provide a ready access token with:

```text
MS_GRAPH_ACCESS_TOKEN
```

The configured identity must have the Graph permissions needed by the site runtime. This MCP package does not perform interactive authentication, device login, or secret storage.

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
- `allowed_mailboxes`: optional mailbox allowlist. When exactly one mailbox is allowed, omitted `mailbox_id` arguments resolve to that mailbox. Otherwise omitted `mailbox_id` resolves to `me`, which must be listed explicitly if an allowlist is configured.
- `allowed_attachment_roots`: optional local filesystem roots for `graph_mail_attachment_upload_file`. Relative paths resolve under the site root. Defaults to the site root when omitted.
- `allow_send_draft`: defaults to `false`.
- `send_approval_token`: optional token required by `graph_mail_draft_send`.

## Audit

Draft mutations and send refusals/completions are written to:

```text
.ai/audit/graph-mail-mcp.jsonl
```

This includes draft create/update/discard requests, draft-send refusals, and draft-send completions.

Attachment uploads are not sent through `graph_request`; upload tools validate the opaque `uploadUrl`, require `https`, and only allow the exact Graph-owned hosts `outlook.office.com`, `outlook.office365.com`, and `graph.microsoft.com`.

## Tools

- `graph_mail_doctor`: reports Graph auth availability, auth mode, and active policy.
- `graph_mail_query`: queries live Graph messages with optional mailbox, folder, search, filter, select, and limit arguments.
- `graph_mail_message_show`: shows one live Graph message by `message_id`.
- `graph_mail_attachment_list`: lists attachments for a message or draft.
- `graph_mail_attachment_get`: shows one attachment and can strip `contentBytes`/`content` when `include_content` is `false`.
- `graph_mail_attachment_add`: adds a small file attachment with `name`, `content_type`, and `content_base64` using `@odata.type` `#microsoft.graph.fileAttachment`.
- `graph_mail_attachment_upload_session_create`: creates an upload session for a large file attachment with `name`, positive `size`, and optional content metadata.
- `graph_mail_attachment_upload_chunk`: uploads one chunk to a guarded upload URL with `upload_url`, `content_base64`, `range_start`, `range_end`, and `total_size`, using binary body bytes and explicit `Content-Length` / `Content-Range` headers.
- `graph_mail_attachment_upload_file`: preferred path for local files. Reads a file under an allowed attachment root, creates an upload session, uploads bounded binary chunks internally, and returns compact metadata without exposing base64 content or upload URLs.
- `graph_mail_attachment_delete`: deletes one attachment from a message or draft.
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
- Use the attachment tools only for live Graph attachment state, and prefer `mailbox-mcp` for routine reads first.
- Use `graph_mail_attachment_upload_file` for local files instead of base64-printing file content through command output.
- Use draft tools for outbound customer-facing work.
- Never send unless an operator has intentionally enabled sending and provided the required confirmation/approval inputs.

## Verification

```powershell
pnpm --filter @narada2/graph-mail-mcp test
```
