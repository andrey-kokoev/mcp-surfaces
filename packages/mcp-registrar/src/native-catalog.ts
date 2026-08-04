import type { DefinedSurface } from '@narada-core/mcp-fabric-contracts';
import { surfaceDefinition as localFilesystem } from '@narada-core/local-filesystem-mcp/surface-definition';
import { surfaceDefinition as structuredCommand } from '@narada-core/structured-command-mcp/surface-definition';
import { surfaceDefinition as git } from '@narada-core/git-mcp/surface-definition';
import { surfaceDefinition as siteInbox } from '@narada-core/site-inbox-mcp/surface-definition';
import { surfaceDefinition as mailbox } from '@narada-core/mailbox-mcp/surface-definition';
import { surfaceDefinition as graphMail } from '@narada-core/graph-mail-mcp/surface-definition';
import { surfaceDefinition as calendar } from '@narada-core/calendar-mcp/surface-definition';
import { surfaceDefinition as taskLifecycle } from '@narada-core/task-lifecycle-mcp/surface-definition';
import { surfaceDefinition as workLifecycle } from '@narada-core/work-lifecycle-mcp/surface-definition';
import { surfaceDefinition as siteLoop } from '@narada-core/site-loop-mcp/surface-definition';
import { surfaceDefinition as siteLifecycle } from '@narada-core/site-lifecycle-mcp/surface-definition';
import { surfaceDefinition as siteRegistry } from '@narada-core/site-registry-mcp/surface-definition';
import { surfaceDefinition as agentContext } from '@narada-core/agent-context-mcp/surface-definition';
import { surfaceDefinition as workerDelegation } from '@narada-core/worker-delegation-mcp/surface-definition';
import { surfaceDefinition as delegatedTask } from '@narada-core/delegated-task-mcp/surface-definition';
import { surfaceDefinition as sop } from '@narada-core/sop-mcp/surface-definition';
import { surfaceDefinition as scheduler } from '@narada-core/scheduler-mcp/surface-definition';
import { surfaceDefinition as mcpLoader } from '@narada-core/mcp-loader-mcp/surface-definition';
import { surfaceDefinition as surfaceFeedback } from '@narada-core/surface-feedback-mcp/surface-definition';
import { surfaceDefinition as launcher } from '@narada-core/launcher-mcp/surface-definition';
import { surfaceDefinition as speech } from '@narada-core/speech-mcp/surface-definition';
import { surfaceDefinition as operatorRouting } from '@narada-core/operator-routing-mcp/surface-definition';
import { surfaceDefinition as artifacts } from '@narada-core/artifacts-mcp/surface-definition';
import { surfaceDefinition as narsSession } from '@narada-core/nars-session-mcp/surface-definition';
import { surfaceDefinition as quotaMeter } from '@narada-core/quota-meter-mcp/surface-definition';
import { surfaceDefinition as operatorConsoleOverlay } from '@narada-core/operator-console-overlay-mcp/surface-definition';
import { surfaceDefinition as browserControl } from '@narada-core/browser-control-mcp/surface-definition';
import { surfaceDefinition as cloudflareCarrier } from '@narada-core/cloudflare-carrier-mcp/surface-definition';
import { surfaceDefinition as siteCoherence } from '@narada-core/site-coherence-mcp/surface-definition';
import { surfaceDefinition as catalogObservation } from '@narada-core/catalog-observation-mcp/surface-definition';
import { surfaceDefinition as runtimeIntrospection } from '@narada-core/runtime-introspection-mcp/surface-definition';

export const NATIVE_SURFACE_DEFINITIONS: Readonly<Record<string, DefinedSurface>> = Object.freeze({
  'local-filesystem': localFilesystem(),
  'structured-command': structuredCommand(),
  git: git(),
  'site-inbox': siteInbox(),
  mailbox: mailbox(),
  'graph-mail': graphMail(),
  calendar: calendar(),
  'task-lifecycle': taskLifecycle(),
  'work-lifecycle': workLifecycle(),
  'site-loop': siteLoop(),
  'site-lifecycle': siteLifecycle(),
  'site-registry': siteRegistry(),
  'agent-context': agentContext(),
  'worker-delegation': workerDelegation(),
  'delegated-task': delegatedTask(),
  sop: sop(),
  scheduler: scheduler(),
  'mcp-loader': mcpLoader(),
  'surface-feedback': surfaceFeedback(),
  launcher: launcher(),
  speech: speech(),
  'operator-routing': operatorRouting(),
  artifacts: artifacts(),
  'nars-session': narsSession(),
  'quota-meter': quotaMeter(),
  'operator-console-overlay': operatorConsoleOverlay(),
  'browser-control': browserControl(),
  'cloudflare-carrier': cloudflareCarrier(),
  'site-coherence': siteCoherence(),
  'catalog-observation': catalogObservation(),
  'runtime-introspection': runtimeIntrospection(),
});
