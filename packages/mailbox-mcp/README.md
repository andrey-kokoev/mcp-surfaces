# @narada2/mailbox-mcp

Read-only MCP surface for site-local synced mailbox projections.

Use this package when an agent needs to inspect mail that has already been synced by a Narada site. This surface does not talk to Microsoft Graph, Outlook, PowerShell, IMAP, or any remote mailbox service. It only reads bounded JSON/JSONL projections from the local site tree.

## Boundary

- Allowed: read site-local synced mailbox projection files.
- Allowed: list accounts, list messages, show one message, search messages, show a thread.
- Not allowed: live Microsoft Graph queries.
- Not allowed: creating, updating, sending, or deleting mail.
- Not allowed: PowerShell or arbitrary command execution.

Use `@narada2/graph-mail-mcp` for live Microsoft Graph reads and draft lifecycle operations.

## Local Data Contract

By default, the server scans these roots under the site root:

```text
.ai/mailboxes
.ai/synced-mailboxes
operator-surfaces/mailboxes
```

A site can override the roots with `.ai/mailbox-mcp.json`:

```json
{
  "roots": [".ai/mailboxes", "operator-surfaces/helpdesk-mail"]
}
```

Roots must resolve inside the site root. Files are scanned recursively and must end in `.json` or `.jsonl`.

Supported JSON shapes:

- A single message object.
- An array of message objects.
- An object with `messages: [...]`.
- An object with Microsoft Graph-style `value: [...]`.
- JSONL with one message object per line.

Common fields are normalized from Graph/Outlook-like names:

```json
{
  "id": "msg-123",
  "conversationId": "thread-456",
  "mailbox_id": "support@example.test",
  "folder": "Inbox",
  "subject": "Customer follow-up",
  "from": { "address": "customer@example.test" },
  "to": [{ "address": "support@example.test" }],
  "receivedDateTime": "2026-06-04T16:00:00.000Z",
  "isRead": false,
  "bodyPreview": "Can you send an update?",
  "body": { "contentType": "text", "content": "Can you send an update on the open ticket?" },
  "attachments": [{ "name": "screenshot.png", "size": 1234 }]
}
```

The normalized output uses stable fields such as `message_id`, `mailbox_id`, `folder`, `thread_id`, `subject`, `from`, `to`, `received_at`, `unread`, `preview`, `body_text`, `body_html`, and `attachments`.

## Tools

- `mailbox_doctor`: reports roots, scan count, message count, and invalid projection records.
- `mailbox_accounts_list`: lists discovered mailbox accounts, folders, total messages, unread count, and latest message time.
- `mailbox_messages_list`: lists messages with optional `mailbox_id`, `folder`, `unread`, `since`, `before`, and `query` filters.
- `mailbox_message_show`: shows one message by `message_id`; includes plain text body by default.
- `mailbox_search`: searches subject/body/address/category text.
- `mailbox_thread_show`: shows messages in one conversation/thread.

## Agent Guidance

Agents should prefer this surface for routine mailbox inspection because it is read-only and does not require live mailbox credentials. Use `graph-mail-mcp` only when the local sync is stale, missing required detail, or draft work is required.

## Verification

```powershell
pnpm --filter @narada2/mailbox-mcp test
```
