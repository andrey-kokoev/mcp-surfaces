import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  legacyMaterializationConfigFingerprint,
  validateV2PredecessorForHardCutover,
  validateV2PredecessorRecords,
  type V2PredecessorRecords,
} from '../src/v2-predecessor.js';

const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const artifact = (path: string, content: string) => ({
  path: resolve(path),
  sha256: sha256(content),
  size: Buffer.byteLength(content),
  mtime_ms: 1,
});

function fixture(options: {
  config_content?: string;
  fingerprint_content?: string;
  include_child_artifact?: boolean;
  registrar_fingerprint?: string;
} = {}): V2PredecessorRecords {
  const workspaceRoot = resolve('v2-predecessor-fixture');
  const configPath = join(workspaceRoot, 'codex', 'config.toml');
  const sidecarPath = `${configPath}.narada-generation.json`;
  const manifestPath = join(workspaceRoot, '.ai', 'runtime', 'workspace-artifact-manifest.json');
  const runtimeProxyEntrypoint = join(
    workspaceRoot,
    'packages',
    'shared',
    'mcp-runtime-proxy',
    'dist',
    'src',
    'main.js',
  );
  const registrarEntrypoint = join(
    workspaceRoot,
    'packages',
    'mcp-registrar',
    'dist',
    'src',
    'main.js',
  );
  const childEntrypoint = join(
    workspaceRoot,
    'packages',
    'mailbox-mcp',
    'dist',
    'src',
    'main.js',
  );
  const originalConfig = [
    'approval_policy = "on-request"',
    '',
    '[mcp_servers.mailbox]',
    'command = "node"',
    `args = ["${runtimeProxyEntrypoint.replace(/\\/gu, '\\\\')}"]`,
    '',
    '[tui]',
    'notifications = true',
    '',
  ].join('\r\n');
  const configContent = options.config_content ?? originalConfig;
  const fingerprintContent = options.fingerprint_content ?? originalConfig;
  const registrarArtifact = artifact(registrarEntrypoint, 'registrar-v2');
  const artifacts = [
    artifact(runtimeProxyEntrypoint, 'runtime-proxy-v2'),
    registrarArtifact,
    ...(options.include_child_artifact === false
      ? []
      : [artifact(childEntrypoint, 'mailbox-v2')]),
  ];
  const manifestUnsigned = {
    schema: 'narada.workspace_artifact_manifest.v1',
    generated_at: '2026-01-01T00:00:00.000Z',
    workspace_root: workspaceRoot,
    packages: [],
    artifacts,
  };
  const manifest = {
    ...manifestUnsigned,
    manifest_fingerprint: sha256(JSON.stringify(manifestUnsigned)),
  };
  const sidecarUnsigned = {
    schema: 'narada.mcp_materialization_generation.v1',
    contract_version: 2,
    carrier_id: 'codex-user',
    carrier_kind: 'codex',
    config_path: configPath,
    config_sha256: legacyMaterializationConfigFingerprint({
      carrier_kind: 'codex',
      content: fingerprintContent,
    }),
    artifact_manifest_path: manifestPath,
    artifact_manifest_fingerprint: manifest.manifest_fingerprint,
    registrar_entrypoint: registrarEntrypoint,
    registrar_fingerprint: options.registrar_fingerprint ?? registrarArtifact.sha256,
    server_count: 1,
    proxy_count: 1,
    generated_at: '2026-01-01T00:00:00.000Z',
  };
  const sidecar = {
    ...sidecarUnsigned,
    generation_fingerprint: sha256(JSON.stringify(sidecarUnsigned)),
  };
  return {
    carrier_id: 'codex-user',
    carrier_kind: 'codex',
    config_path: configPath,
    config_content: configContent,
    server_count: 1,
    launches: [{
      server_key: 'mailbox',
      launch: {
        command: 'node',
        args: [
          runtimeProxyEntrypoint,
          '--surface-id',
          'mailbox',
          '--artifact-manifest',
          manifestPath,
          '--runtime-contract-version',
          '2',
          '--materialization-sidecar',
          sidecarPath,
          '--entrypoint',
          childEntrypoint,
          '--',
        ],
      },
    }],
    sidecar_path: sidecarPath,
    sidecar,
    manifest_path: manifestPath,
    manifest,
    runtime_proxy_entrypoint: runtimeProxyEntrypoint,
    registrar_entrypoint: registrarEntrypoint,
    workspace_root: workspaceRoot,
  };
}

function assertRefused(
  input: V2PredecessorRecords,
  expectedReason: string,
): void {
  assert.throws(
    () => validateV2PredecessorRecords(input),
    (error: unknown) => {
      const record = error as {
        codeName?: string;
        details?: { reason?: string };
      };
      assert.equal(record.codeName, 'registrar_v2_predecessor_unverifiable');
      assert.equal(record.details?.reason, expectedReason);
      return true;
    },
  );
}

validateV2PredecessorRecords(fixture());

const staleArtifactReferences = fixture();
const { generation_fingerprint: _staleGenerationFingerprint, ...staleSidecarFields } = staleArtifactReferences.sidecar;
const staleSidecarUnsigned = {
  ...staleSidecarFields,
  artifact_manifest_fingerprint: sha256('prior-workspace-manifest'),
  registrar_fingerprint: sha256('prior-registrar-artifact'),
};
staleArtifactReferences.sidecar = {
  ...staleSidecarUnsigned,
  generation_fingerprint: sha256(JSON.stringify(staleSidecarUnsigned)),
};
validateV2PredecessorForHardCutover(staleArtifactReferences);

const original = fixture();
const unrelatedSettingChanged = original.config_content
  .replace('approval_policy = "on-request"', 'approval_policy = "never"')
  .replace('notifications = true', 'notifications = false');
validateV2PredecessorRecords(fixture({
  config_content: unrelatedSettingChanged,
  fingerprint_content: original.config_content,
}));

const mcpTableChanged = original.config_content.replace(
  'command = "node"',
  'command = "different-node"',
);
assertRefused(
  fixture({
    config_content: mcpTableChanged,
    fingerprint_content: original.config_content,
  }),
  'sidecar_not_self_consistent',
);

assertRefused(
  fixture({ include_child_artifact: false }),
  'manifest_artifact_cross_link_missing',
);

assertRefused(
  fixture({ registrar_fingerprint: sha256('different-registrar') }),
  'sidecar_not_self_consistent',
);

console.log('V2 predecessor validation tests passed');
