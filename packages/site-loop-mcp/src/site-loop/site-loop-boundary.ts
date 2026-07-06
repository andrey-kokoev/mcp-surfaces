export type SiteLoopDependencyKind = 'owned' | 'configured_command' | 'read_adapter' | 'delegated_surface' | 'compatibility';

export type SiteLoopDependencyBoundary = {
  surface: string;
  kind: SiteLoopDependencyKind;
  siteLoopUse: string;
  owner: string;
  rule: string;
};

export const SITE_LOOP_BOUNDARIES: SiteLoopDependencyBoundary[] = [
  {
    surface: 'site-loop',
    kind: 'owned',
    siteLoopUse: 'Loop config validation, configured docs/tests exposure, loop status, control, health, run records, and bounded run orchestration.',
    owner: '@narada2/site-loop-mcp',
    rule: 'Site Loop may own loop orchestration state and readback, but site identity and policy must come from site-loop-config.json.',
  },
  {
    surface: 'task-lifecycle',
    kind: 'read_adapter',
    siteLoopUse: 'Directive/status readback and configured resident task dispatch compatibility.',
    owner: '@narada2/task-lifecycle-mcp and @narada2/task-governance-core',
    rule: 'Task lifecycle remains the authority for tasks, claims, evidence, reviews, and closeout. Site Loop must not become a general task mutation surface.',
  },
  {
    surface: 'sop',
    kind: 'delegated_surface',
    siteLoopUse: 'Site-specific procedural workflows such as synced-email control cycles when configured by a site.',
    owner: '@narada2/sop-mcp or site-owned SOP adapters',
    rule: 'Site Loop may observe or invoke configured SOP adapter commands, but SOP templates and run state are not Site Loop state.',
  },
  {
    surface: 'scheduler',
    kind: 'delegated_surface',
    siteLoopUse: 'Operator recovery hints and scheduled launcher status.',
    owner: '@narada2/scheduler-mcp or platform scheduler tooling',
    rule: 'Site Loop may report configured scheduler names and recovery steps; it must not become a general scheduler mutation surface.',
  },
  {
    surface: 'agent-context',
    kind: 'delegated_surface',
    siteLoopUse: 'Resident launch/session posture and recovery evidence when supplied by site config or adjacent surfaces.',
    owner: '@narada2/agent-context-mcp',
    rule: 'Agent identity, session hydration, and context persistence stay with agent-context; Site Loop consumes evidence and configured hints.',
  },
  {
    surface: 'structured-command',
    kind: 'configured_command',
    siteLoopUse: 'Bounded configured source-sync, reconciliation, proof, and smoke-test commands.',
    owner: '@narada2/structured-command-mcp or local approved process execution policy',
    rule: 'Site Loop accepts argv-shaped configured command slots only. It must not accept arbitrary shell strings or open-ended command execution.',
  },
  {
    surface: 'site-ops naming',
    kind: 'compatibility',
    siteLoopUse: 'Legacy tool and entrypoint names retained as aliases during the migration from sonar-site-ops to site-loop.',
    owner: '@narada2/site-loop-mcp',
    rule: 'New docs and tests should prefer site_loop_* names. Compatibility aliases must remain documented until all registered callers move.',
  },
];

export function siteLoopDependencyBoundaries(): SiteLoopDependencyBoundary[] {
  return SITE_LOOP_BOUNDARIES.map((item) => ({ ...item }));
}
