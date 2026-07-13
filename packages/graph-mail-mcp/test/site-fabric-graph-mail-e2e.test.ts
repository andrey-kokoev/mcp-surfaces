import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  writeE2eResultArtifact,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('graph-mail-site-fabric-e2e');
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const resultPath = join(packageRoot, '.tmp', 'e2e-results', 'graph-mail.site-fabric.external-mail-lifecycle.json');
let resultStatus: 'passed' | 'not_run' | 'failed' = 'failed';
const startedAt = new Date().toISOString();
let missingPrerequisites: string[] = [];
const liveRequested = process.env.NARADA_E2E_GRAPH_MAIL_LIVE === '1';
const accessToken = process.env.NARADA_E2E_GRAPH_ACCESS_TOKEN;
const mailbox = process.env.NARADA_E2E_GRAPH_MAILBOX;
const recipient = process.env.NARADA_E2E_GRAPH_DRAFT_RECIPIENT;
const messageId = process.env.NARADA_E2E_GRAPH_MESSAGE_ID;
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));

mkdirSync(join(siteRoot, '.ai'), { recursive: true });
writeFileSync(join(siteRoot, 'controlled-attachment.txt'), 'Controlled Graph Mail MCP E2E attachment.\n', 'utf8');
writeFileSync(join(siteRoot, '.ai', 'graph-mail-mcp.json'), JSON.stringify({
  graph_base_url: process.env.NARADA_E2E_GRAPH_BASE_URL ?? 'https://graph.microsoft.com/v1.0',
  allowed_mailboxes: mailbox ? [mailbox] : [],
  allowed_attachment_roots: ['.'],
  allow_send_draft: false,
  allow_folder_create: false,
  allow_message_move: false,
}, null, 2), 'utf8');

if (accessToken) writeFileSync(join(siteRoot, '.env'), `MS_GRAPH_ACCESS_TOKEN=${accessToken}\n`, 'utf8');

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MS_GRAPH_ACCESS_TOKEN: undefined,
  GRAPH_ACCESS_TOKEN: undefined,
  GRAPH_TENANT_ID: undefined,
  GRAPH_CLIENT_ID: undefined,
  GRAPH_CLIENT_SECRET: undefined,
};
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', siteRoot], {
  cwd: siteRoot,
  env: childEnv,
  label: 'graph-mail Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'narada-graph-mail-mcp',
    requiredTools: [
      'graph_mail_doctor',
      'graph_mail_query',
      'graph_mail_message_show',
      'graph_mail_folder_list',
      'graph_mail_folder_create',
      'graph_mail_message_move',
      'graph_mail_draft_create',
      'graph_mail_draft_update',
      'graph_mail_attachment_upload_file',
      'graph_mail_attachment_list',
      'graph_mail_attachment_get',
      'graph_mail_attachment_delete',
      'graph_mail_draft_discard',
      'graph_mail_draft_send',
      'graph_mail_output_show',
    ],
  });

  const doctor = structured(await server.client.request(3, 'tools/call', {
    name: 'graph_mail_doctor',
    arguments: {},
  }));
  assert.equal(doctor.status, 'ok', JSON.stringify(doctor));
  assert.equal(doctor.allow_send_draft, false, JSON.stringify(doctor));
  assert.deepEqual(doctor.allowed_mailboxes, mailbox ? [mailbox] : [], JSON.stringify(doctor));

  const prerequisites = [
    ['live_authority_not_enabled', liveRequested],
    ['controlled_access_token_missing', Boolean(accessToken)],
    ['controlled_mailbox_missing', Boolean(mailbox)],
    ['controlled_draft_recipient_missing', Boolean(recipient)],
    ['controlled_message_id_missing', Boolean(messageId)],
  ] as const;
  missingPrerequisites = prerequisites.filter(([, present]) => !present).map(([reason]) => reason);
  if (missingPrerequisites.length > 0) {
    resultStatus = 'not_run';
    console.log(JSON.stringify({
      status: 'not_run',
      test_id: 'graph-mail.site-fabric.external-mail-lifecycle',
      authority: 'A1',
      reason_code: 'controlled_graph_authority_not_configured',
      missing_prerequisites: missingPrerequisites,
      doctor_auth_mode: doctor.auth_mode,
      cleanup: 'completed_after_finally',
    }));
  } else {
    const queried = structured(await server.client.request(4, 'tools/call', {
      name: 'graph_mail_query',
      arguments: { mailbox_id: mailbox, limit: 5, select: 'id,subject,receivedDateTime' },
    }));
    assert.equal(queried.status, 'ok', JSON.stringify(queried));

    const shown = structured(await server.client.request(5, 'tools/call', {
      name: 'graph_mail_message_show',
      arguments: { mailbox_id: mailbox, message_id: messageId, select: 'id,subject,receivedDateTime,parentFolderId' },
    }));
    assert.equal(shown.status, 'ok', JSON.stringify(shown));

    const folders = structured(await server.client.request(6, 'tools/call', {
      name: 'graph_mail_folder_list',
      arguments: { mailbox_id: mailbox, limit: 20, select: 'id,displayName,parentFolderId' },
    }));
    assert.equal(folders.status, 'ok', JSON.stringify(folders));

    const folderCreateRefused = structured(await server.client.request(7, 'tools/call', {
      name: 'graph_mail_folder_create',
      arguments: { mailbox_id: mailbox, display_name: `Narada E2E refusal ${Date.now()}`, confirm_write: true },
    }));
    assert.equal(folderCreateRefused.status, 'refused', JSON.stringify(folderCreateRefused));
    assert.equal(folderCreateRefused.reason, 'folder_create_disallowed_by_policy', JSON.stringify(folderCreateRefused));

    const messageMoveRefused = structured(await server.client.request(8, 'tools/call', {
      name: 'graph_mail_message_move',
      arguments: { mailbox_id: mailbox, message_id: 'controlled-message-not-used', destination_folder_id: 'inbox', confirm_write: true },
    }));
    assert.equal(messageMoveRefused.status, 'refused', JSON.stringify(messageMoveRefused));
    assert.equal(messageMoveRefused.reason, 'message_move_disallowed_by_policy', JSON.stringify(messageMoveRefused));

    const draft = structured(await server.client.request(9, 'tools/call', {
      name: 'graph_mail_draft_create',
      arguments: {
        mailbox_id: mailbox,
        subject: `Narada E2E ${new Date().toISOString()}`,
        body_text: 'Controlled MCP E2E draft. This draft must be discarded by cleanup.',
        to_recipients: [recipient],
      },
    }));
    assert.equal(draft.status, 'created', JSON.stringify(draft));
    const draftId = String((draft.draft as JsonRecord).id ?? '');
    assert.ok(draftId);

    try {
      const updated = structured(await server.client.request(10, 'tools/call', {
        name: 'graph_mail_draft_update',
        arguments: {
          mailbox_id: mailbox,
          draft_id: draftId,
          subject: `Narada E2E updated ${new Date().toISOString()}`,
          body_text: 'Updated controlled MCP E2E draft.',
        },
      }));
      assert.equal(updated.status, 'updated', JSON.stringify(updated));

      const uploaded = structured(await server.client.request(11, 'tools/call', {
        name: 'graph_mail_attachment_upload_file',
        arguments: {
          mailbox_id: mailbox,
          draft_id: draftId,
          file_path: 'controlled-attachment.txt',
          name: 'controlled-attachment.txt',
          content_type: 'text/plain',
        },
      }));
      assert.equal(uploaded.status, 'uploaded', JSON.stringify(uploaded));

      const attachments = structured(await server.client.request(12, 'tools/call', {
        name: 'graph_mail_attachment_list',
        arguments: { mailbox_id: mailbox, draft_id: draftId, limit: 10 },
      }));
      assert.equal(attachments.status, 'ok', JSON.stringify(attachments));
      const attachmentItems = collectionItems(attachments.attachments);
      const uploadedAttachment = attachmentItems.find((item) => item.name === 'controlled-attachment.txt');
      assert.ok(uploadedAttachment, JSON.stringify(attachments));
      const attachmentId = String(uploadedAttachment.id ?? '');
      assert.ok(attachmentId, JSON.stringify(uploadedAttachment));

      const attachment = structured(await server.client.request(13, 'tools/call', {
        name: 'graph_mail_attachment_get',
        arguments: { mailbox_id: mailbox, draft_id: draftId, attachment_id: attachmentId, include_content: false },
      }));
      assert.equal(attachment.status, 'ok', JSON.stringify(attachment));
      assert.equal((attachment.attachment as JsonRecord).name, 'controlled-attachment.txt', JSON.stringify(attachment));

      const deletedAttachment = structured(await server.client.request(14, 'tools/call', {
        name: 'graph_mail_attachment_delete',
        arguments: { mailbox_id: mailbox, draft_id: draftId, attachment_id: attachmentId },
      }));
      assert.equal(deletedAttachment.status, 'deleted', JSON.stringify(deletedAttachment));

      const send = structured(await server.client.request(15, 'tools/call', {
        name: 'graph_mail_draft_send',
        arguments: { mailbox_id: mailbox, draft_id: draftId, confirm_send: true },
      }));
      assert.equal(send.status, 'refused', JSON.stringify(send));
      assert.equal(send.reason, 'send_draft_disallowed_by_policy', JSON.stringify(send));
    } finally {
      const discarded = structured(await server.client.request(16, 'tools/call', {
        name: 'graph_mail_draft_discard',
        arguments: { mailbox_id: mailbox, draft_id: draftId },
      }));
      assert.equal(discarded.status, 'discarded', JSON.stringify(discarded));
    }

    console.log(JSON.stringify({
      status: 'passed',
      test_id: 'graph-mail.site-fabric.external-mail-lifecycle',
      authority: 'A1',
      coverage: ['query', 'message_show', 'folder_list', 'folder_create_refusal', 'message_move_refusal', 'draft_create', 'draft_update', 'attachment_upload_file', 'attachment_list', 'attachment_get', 'attachment_delete', 'send_refusal', 'draft_discard'],
      cleanup: 'completed_after_finally',
    }));
    resultStatus = 'passed';
  }
} finally {
  let cleanupStatus = 'passed';
  try { await server.close(); } catch { cleanupStatus = 'failed'; }
  if (!removeTemporaryE2eRoot(siteRoot)) cleanupStatus = 'failed';
  if (cleanupStatus === 'failed') {
    resultStatus = 'failed';
    process.exitCode = 1;
  }
  writeE2eResultArtifact(resultPath, {
    schema: 'narada.mcp.e2e.result.v1',
    test_id: 'graph-mail.site-fabric.external-mail-lifecycle',
    status: resultStatus,
    authority: 'A1',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ...(resultStatus === 'not_run' ? {
      reason_code: 'controlled_graph_authority_not_configured',
      missing_prerequisites: missingPrerequisites,
    } : {}),
    cleanup: { status: cleanupStatus },
  });
}

function collectionItems(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const items = (value as JsonRecord).value;
    if (Array.isArray(items)) return items.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  }
  return [];
}
