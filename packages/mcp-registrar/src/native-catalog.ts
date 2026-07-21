import type { DefinedSurface } from '@narada2/mcp-fabric-contracts';
import { surfaceDefinition as localFilesystem } from '@narada2/local-filesystem-mcp/surface-definition';
import { surfaceDefinition as structuredCommand } from '@narada2/structured-command-mcp/surface-definition';
import { surfaceDefinition as git } from '@narada2/git-mcp/surface-definition';
import { surfaceDefinition as siteInbox } from '@narada2/site-inbox-mcp/surface-definition';
import { surfaceDefinition as mailbox } from '@narada2/mailbox-mcp/surface-definition';
import { surfaceDefinition as graphMail } from '@narada2/graph-mail-mcp/surface-definition';
import { surfaceDefinition as calendar } from '@narada2/calendar-mcp/surface-definition';
import { surfaceDefinition as taskLifecycle } from '@narada2/task-lifecycle-mcp/surface-definition';
import { surfaceDefinition as siteLoop } from '@narada2/site-loop-mcp/surface-definition';
import { surfaceDefinition as siteLifecycle } from '@narada2/site-lifecycle-mcp/surface-definition';
import { surfaceDefinition as siteRegistry } from '@narada2/site-registry-mcp/surface-definition';
import { surfaceDefinition as agentContext } from '@narada2/agent-context-mcp/surface-definition';
import { surfaceDefinition as workerDelegation } from '@narada2/worker-delegation-mcp/surface-definition';
import { surfaceDefinition as delegatedTask } from '@narada2/delegated-task-mcp/surface-definition';
import { surfaceDefinition as sop } from '@narada2/sop-mcp/surface-definition';
import { surfaceDefinition as scheduler } from '@narada2/scheduler-mcp/surface-definition';
import { surfaceDefinition as mcpLoader } from '@narada2/mcp-loader-mcp/surface-definition';
import { surfaceDefinition as surfaceFeedback } from '@narada2/surface-feedback-mcp/surface-definition';
import { surfaceDefinition as launcher } from '@narada2/launcher-mcp/surface-definition';
import { surfaceDefinition as speech } from '@narada2/speech-mcp/surface-definition';
import { surfaceDefinition as operatorRouting } from '@narada2/operator-routing-mcp/surface-definition';
import { surfaceDefinition as artifacts } from '@narada2/artifacts-mcp/surface-definition';
import { surfaceDefinition as narsSession } from '@narada2/nars-session-mcp/surface-definition';
import { surfaceDefinition as quotaMeter } from '@narada2/quota-meter-mcp/surface-definition';
import { surfaceDefinition as cloudflareCarrier } from '@narada2/cloudflare-carrier-mcp/surface-definition';
import { surfaceDefinition as siteCoherence } from '@narada2/site-coherence-mcp/surface-definition';

export const NATIVE_SURFACE_DEFINITIONS: Readonly<Record<string, DefinedSurface>> = Object.freeze({
  'local-filesystem': localFilesystem(),
  'structured-command': structuredCommand(),
  git: git(),
  'site-inbox': siteInbox(),
  mailbox: mailbox(),
  'graph-mail': graphMail(),
  calendar: calendar(),
  'task-lifecycle': taskLifecycle(),
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
  'cloudflare-carrier': cloudflareCarrier(),
  'site-coherence': siteCoherence(),
});
