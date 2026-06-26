import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'launcher-mcp-'));
const registryPath = join(root, 'agents.psd1');
writeFileSync(registryPath, `@{
  NaradaRoot = "${root}"
  WorkspaceRoot = "${root}"
  SiteRoot = "${root}"
  Launcher = "narada-test.ps1"
  Runtime = "agent-cli"
  Agents = @(
    @{ Agent = "narada-test.architect"; Title = "Test Architect"; Site = "narada-test"; Role = "architect"; Profile = "planning"; EnableNativeShell = $false }
    @{ Agent = "narada-test.builder2"; Title = "Test Builder"; Site = "narada-test"; Profile = "implementation"; EnableNativeShell = $true }
  )
}
`, 'utf8');

try {
  const state = createServerState({ naradaRoot: root, registryPath });
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as Promise<Record<string, any>>;
  }
  function view(res: Record<string, any>): Record<string, any> { return res.result.structuredContent as Record<string, any>; }

  const doctor = view(await call('launcher_doctor', {}));
  assert.equal(doctor.registry_exists, true);
  assert.equal(doctor.execution_posture, 'read_only_no_launch_no_shell');
  assert.deepEqual(doctor.mcp_injection_scope_doctrine.scopes, ['host', 'user_site', 'local_site']);
  assert.equal(doctor.mcp_injection_scope_doctrine.canonical_host_example, 'speech');

  const options = view(await call('launcher_options_list', {}));
  assert.ok((options.declared_options as string[]).includes('IntelligenceProvider'));
  assert.ok((options.declared_options as string[]).includes('Profile'));

  const registry = view(await call('launcher_registry_list', { site: ['test'] }));
  assert.equal(registry.total_count, 2);
  assert.equal(registry.records[1].role, 'builder');

  const registryByFullSite = view(await call('launcher_registry_list', { site: ['narada-test'] }));
  assert.equal(registryByFullSite.total_count, 2);

  const registryByProfile = view(await call('launcher_registry_list', { profile: ['implementation'] }));
  assert.equal(registryByProfile.total_count, 1);
  assert.equal(registryByProfile.records[0].agent, 'narada-test.builder2');

  const plan = view(await call('launcher_plan', { agent: ['narada-test.builder2'], runtime: 'agent-cli', launch_profile: 'implementation-fast', intelligence_provider: 'codex-subscription' }));
  assert.equal(plan.schema, 'narada.workspace_launch.dry_run.v1');
  assert.equal(plan.windows_terminal_invoked, false);
  assert.equal(plan.count, 1);
  assert.deepEqual(plan.wt_args.slice(0, 4), ['new-tab', '--title', 'Test Builder', '-d']);
  assert.ok((plan.wt_args as string[]).includes('-EnableNativeShell'));
  assert.ok((plan.wt_args as string[]).includes('-Profile'));
  assert.ok((plan.wt_args as string[]).includes('implementation-fast'));
  assert.ok((plan.wt_args as string[]).includes('codex-subscription'));
  assert.ok((plan.wt_args as string[]).includes('-WaitForEnterBeforeExec'));
  assert.equal(plan.startup_profile_plan.execution_posture, 'planned_not_started_by_mcp');
  assert.deepEqual(plan.startup_profile_plan.profiles, ['implementation-fast']);
  assert.equal(plan.startup_profile_plan.entries[0].registry_profile, 'implementation');
  assert.equal(plan.startup_profile_plan.entries[0].launch_profile, 'implementation-fast');

  const noWait = view(await call('launcher_plan', { all: true, role: ['architect'], no_wait_for_enter_before_exec: true, startup_stagger_seconds: 7 }));
  assert.equal(noWait.count, 1);
  assert.equal((noWait.wt_args as string[]).includes('-WaitForEnterBeforeExec'), false);
  assert.equal(noWait.startup_profile_plan.entries[0].start_after_seconds, 0);

  const staggered = view(await call('launcher_plan', { all: true, startup_stagger_seconds: 7 }));
  assert.deepEqual(staggered.startup_profile_plan.entries.map((entry: Record<string, any>) => entry.start_after_seconds), [0, 7]);
  assert.deepEqual(staggered.startup_profile_plan.profiles, ['planning', 'implementation']);

  const matrix = view(await call('launcher_option_matrix', {}));
  assert.equal(matrix.status, 'modeled');
  assert.equal(matrix.representative_agent, 'narada-test.architect');
  assert.equal(matrix.representative_profile, 'planning');
  assert.equal(matrix.case_count, 15);

  const coherence = view(await call('launcher_coherence_check', {}));
  assert.equal(coherence.status, 'valid_with_warnings');
  assert.equal(coherence.errors, 0);
  assert.ok(coherence.warnings >= 1);

  console.log('launcher-mcp behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
