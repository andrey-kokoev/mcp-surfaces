import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { preflightMaterializationGeneration } from '@narada-core/mcp-runtime-proxy/materialization-contract';

type JsonRecord = Record<string, any>;

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workspaceRoot = resolve(packageRoot, '..', '..');
const registrarEntrypoint = join(packageRoot, 'dist', 'src', 'main.js');
const artifactManifestPath = join(workspaceRoot, '.ai', 'runtime', 'workspace-artifact-manifest.json');
const surfacesRoot = join(workspaceRoot, 'packages');

type RpcRun = {
  exitCode: number | null;
  responses: JsonRecord[];
  stdout: string;
  stderr: string;
};

function testEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NARADA_MCP_WORKSPACE_ROOT: workspaceRoot, NARADA_MCP_SURFACES_ROOT: surfacesRoot };
  delete env['NARADA_MCP_REGISTRAR_FRESH_CHILD'];
  return env;
}

function runCli(args: string[]): Promise<RpcRun> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: workspaceRoot,
      env: testEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectRun(new Error(`materialization_cli_e2e_timeout:${args.join(' ')}`));
    }, 45_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun({ exitCode, responses: [], stdout, stderr });
    });
  });
}

function runRpc(command: string, args: string[], request: JsonRecord): Promise<RpcRun> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: testEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectRun(new Error(`materialization_contract_e2e_timeout:${command}`));
    }, 45_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const responses = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as JsonRecord);
      resolveRun({ exitCode, responses, stdout, stderr });
    });
    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end();
  });
}

function structuredResult(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.result?.structuredContent as JsonRecord;
}

function codexLaunch(config: string, serverKey: string): { command: string; args: string[] } {
  const marker = `[mcp_servers.${serverKey}]`;
  const start = config.indexOf(marker);
  assert.notEqual(start, -1, `missing generated carrier section: ${serverKey}`);
  const next = config.indexOf('\n[', start + marker.length);
  const section = config.slice(start, next < 0 ? config.length : next);
  const commandMatch = /^command = "([^"]+)"$/m.exec(section);
  const argsMatch = /^args = (.+)$/m.exec(section);
  assert.ok(commandMatch, section);
  assert.ok(argsMatch, section);
  return { command: commandMatch[1]!, args: JSON.parse(argsMatch[1]!) as string[] };
}

test('fresh registrar materializes, validates, and launches a carrier generation', async () => {
  assert.equal(existsSync(registrarEntrypoint), true, registrarEntrypoint);
  assert.equal(existsSync(artifactManifestPath), true, artifactManifestPath);
  const root = mkdtempSync(join(tmpdir(), 'mcp-registrar-materialization-e2e-'));
  const configPath = join(root, 'config.toml');
  const sidecarPath = `${resolve(configPath)}.narada-generation.json`;
  try {
    const rejectedSingle = await runCli([
      registrarEntrypoint,
      '--materialize-carrier',
      'codex-andrey',
      '--output-path',
      configPath,
    ]);
    assert.notEqual(rejectedSingle.exitCode, 0);
    assert.match(rejectedSingle.stderr, /registrar_single_carrier_materialization_requires_explicit_escape_hatch/);

    const emergencySingle = await runCli([
      registrarEntrypoint,
      '--materialize-carrier',
      'codex-andrey',
      '--allow-single-carrier',
      '--output-path',
      configPath,
    ]);
    assert.equal(emergencySingle.exitCode, 0, emergencySingle.stderr);
    const emergencyResult = JSON.parse(emergencySingle.stdout) as JsonRecord;
    assert.equal(emergencyResult.status, 'materialized');
    assert.equal(emergencyResult.carrier_id, 'codex-andrey');
    assert.equal(emergencyResult.materialization_validation.ok, true, JSON.stringify(emergencyResult));

    const directMaterialize = await runCli([
      registrarEntrypoint,
      '--materialize-all',
      '--output-dir',
      root,
    ]);
    assert.equal(directMaterialize.exitCode, 0, directMaterialize.stderr);
    const directResult = JSON.parse(directMaterialize.stdout) as JsonRecord;
    assert.equal(directResult.status, 'materialized_all');
    assert.equal(directResult.carrier_count, 3);
    const directCodex = (directResult.carriers as JsonRecord[]).find((carrier) => carrier.carrier_id === 'codex-andrey')!;
    assert.equal(directCodex.materialization_validation.ok, true, JSON.stringify(directCodex));
    assert.equal(existsSync(configPath), true);
    assert.equal(existsSync(sidecarPath), true);
    assert.equal(existsSync(join(root, 'mcp.json')), true);
    assert.equal(existsSync(join(root, 'opencode.jsonc')), true);

    const materialize = await runRpc(process.execPath, [registrarEntrypoint], {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'registrar_materialize_all', arguments: { output_dir: root } },
    });
    assert.equal(materialize.exitCode, 0, materialize.stderr);
    const result = structuredResult(materialize.responses[0]!);
    assert.equal(result.status, 'materialized_all');
    assert.equal(result.carrier_count, 3);
    const codexResult = (result.carriers as JsonRecord[]).find((carrier) => carrier.carrier_id === 'codex-andrey')!;
    assert.equal(result.runtime_contract_version, 2);
    assert.equal(codexResult.materialization_validation.ok, true, JSON.stringify(codexResult.materialization_validation));
    assert.equal(codexResult.materialization_generation.config_path, resolve(configPath));
    assert.equal(existsSync(configPath), true);
    assert.equal(existsSync(sidecarPath), true);

    const config = readFileSync(configPath, 'utf8');
    assert.match(config, /\[features\]\r?\napps = false\r?\n/);
    const proxyCount = codexResult.materialization_validation.proxy_count as number;
    assert.equal((config.match(/--artifact-manifest/g) ?? []).length, proxyCount);
    assert.equal((config.match(/--runtime-contract-version/g) ?? []).length, proxyCount);
    assert.equal((config.match(/--materialization-sidecar/g) ?? []).length, proxyCount);
    assert.deepEqual(
      preflightMaterializationGeneration({
        sidecarPath,
        manifestPath: artifactManifestPath,
        manifestFingerprint: codexResult.materialization_generation.artifact_manifest_fingerprint,
      }),
      { ok: true, generation_fingerprint: codexResult.materialization_generation.generation_fingerprint },
    );

    const launch = codexLaunch(config, 'narada-site-andrey-user-mcp-registrar');
    assert.equal(launch.args[launch.args.indexOf('--carrier-id') + 1], 'codex-andrey');
    assert.equal(launch.args[launch.args.indexOf('--carrier-kind') + 1], 'codex');
    assert.equal(launch.args.includes('--registrar-entrypoint'), true);
    const proxyRun = await runRpc(launch.command === 'node' ? process.execPath : launch.command, launch.args, {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.equal(proxyRun.exitCode, 0, proxyRun.stderr);
    assert.equal(proxyRun.responses[0]?.result?.serverInfo?.name, 'mcp-registrar');

    const toolsRun = await runRpc(launch.command === 'node' ? process.execPath : launch.command, launch.args, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {},
    });
    assert.equal(toolsRun.exitCode, 0, toolsRun.stderr);
    assert.equal(toolsRun.responses[0]?.result?.tools?.some((tool: JsonRecord) => tool.name === 'mcp_runtime_proxy_status'), true);

    writeFileSync(configPath, config + '# stale generation test\n', 'utf8');
    const staleRun = await runRpc(launch.command === 'node' ? process.execPath : launch.command, launch.args, {
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.notEqual(staleRun.exitCode, 0);
    assert.equal(staleRun.responses[0]?.error?.data?.code, 'materialization_generation_stale');
    const staleRecovery = staleRun.responses[0]?.error?.data?.details?.recovery;
    assert.match(staleRecovery?.recovery_group_id, /^materialization-[0-9a-f]{20}$/);
    assert.equal(staleRecovery?.regeneration?.available, true);
    assert.deepEqual(staleRecovery?.regeneration?.command?.args.slice(1), ['--materialize-all']);
    assert.equal(staleRecovery?.restart_required, true);
    assert.match(staleRecovery?.restart?.instruction, /Restart Codex/);

    const staleBootstrapRuns = await Promise.all([
      'narada-site-andrey-user-agent-context',
      'narada-site-andrey-user-local-filesystem',
      'narada-site-andrey-user-mcp-loader',
    ].map(async (serverKey) => {
      const bootstrapLaunch = codexLaunch(config, serverKey);
      return runRpc(bootstrapLaunch.command === 'node' ? process.execPath : bootstrapLaunch.command, bootstrapLaunch.args, {
        jsonrpc: '2.0',
        id: 40,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      });
    }));
    const recoveryGroupIds = [
      staleRecovery?.recovery_group_id,
      ...staleBootstrapRuns.map((run) => run.responses[0]?.error?.data?.details?.recovery?.recovery_group_id),
    ];
    assert.equal(new Set(recoveryGroupIds).size, 1, JSON.stringify(recoveryGroupIds));

    const missingVersionArgs = [...launch.args];
    const versionIndex = missingVersionArgs.indexOf('--runtime-contract-version');
    missingVersionArgs.splice(versionIndex, 2);
    const missingVersionRun = await runRpc(process.execPath, missingVersionArgs, {
      jsonrpc: '2.0',
      id: 5,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.notEqual(missingVersionRun.exitCode, 0);
    assert.equal(missingVersionRun.responses[0]?.error?.data?.code, 'runtime_contract_version_missing');

    const missingManifestArgs = [...launch.args];
    const manifestIndex = missingManifestArgs.indexOf('--artifact-manifest');
    missingManifestArgs.splice(manifestIndex, 2);
    const missingManifestRun = await runRpc(process.execPath, missingManifestArgs, {
      jsonrpc: '2.0',
      id: 6,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.notEqual(missingManifestRun.exitCode, 0);
    assert.equal(missingManifestRun.responses[0]?.error?.data?.code, 'workspace_manifest_missing');
    const workspaceRecovery = missingManifestRun.responses[0]?.error?.data?.details?.recovery;
    assert.match(workspaceRecovery?.recovery_group_id, /^workspace-materialization-[0-9a-f]{20}$/);
    assert.equal(workspaceRecovery?.steps?.[0]?.command?.display, 'pnpm build');
    assert.equal(workspaceRecovery?.steps?.[1]?.available, true);
    assert.equal(workspaceRecovery?.restart_required, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
