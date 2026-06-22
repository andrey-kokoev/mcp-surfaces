param(
  [Parameter(Position = 0)]
  [ValidateSet("agent-start")]
  [string]$Command = "agent-start",
  [Alias("AgentId")]
  [string]$Agent,
  [string]$Runtime = "agent-cli",
  [switch]$Exec,
  [switch]$DryRun,
  [switch]$Json,
  [switch]$EnableNativeShell,
  [switch]$AgentTuiInteractiveLoop,
  [switch]$AgentTuiProviderExecution,
  [switch]$AgentTuiMcpFabric,
  [int]$AgentTuiMaxSteps,
  [string]$AgentTuiStartingDirective,
  [string]$AgentTuiStartingDirectiveFile
)

$ErrorActionPreference = "Stop"

if ($Command -ne "agent-start") {
  throw "unsupported_command: $Command"
}

if ($env:NARADA_LAUNCH_REGISTRY_SITE_ROOT) {
  $siteRoot = $env:NARADA_LAUNCH_REGISTRY_SITE_ROOT
} else {
  $nestedSiteRoot = Join-Path $PSScriptRoot ".narada"
  $siteRoot = if (Test-Path -LiteralPath $nestedSiteRoot) { $nestedSiteRoot } else { $PSScriptRoot }
}
$workspaceRoot = "D:\code"
$naradaProperRoot = "D:\code\narada"
$agentStart = Join-Path $naradaProperRoot "packages\agent-start\src\narada-agent-start.ts"
if (-not (Test-Path -LiteralPath $agentStart)) {
  throw "packaged_agent_start_missing: $agentStart"
}

if (-not $Agent) {
  $Agent = "mcp-surfaces.architect"
}

$flags = @($Agent, "--target-site-root", $siteRoot, "--site-root", $siteRoot, "--launch-source", "$($MyInvocation.MyCommand.Name) agent-start")
if ($Runtime) { $flags += @("--runtime", $Runtime) }
if ($Exec) { $flags += "--exec" }
if ($DryRun) { $flags += "--dry-run" }
if ($Json) { $flags += "--json" }
if ($EnableNativeShell) { $flags += "--enable-native-shell" }
if ($AgentTuiInteractiveLoop) { $flags += "--agent-tui-interactive-loop" }
if ($AgentTuiProviderExecution) { $flags += "--agent-tui-provider-execution" }
if ($AgentTuiMcpFabric) { $flags += "--agent-tui-mcp-fabric" }
if ($AgentTuiMaxSteps -gt 0) { $flags += @("--agent-tui-max-steps", [string]$AgentTuiMaxSteps) }
if ($AgentTuiStartingDirective) { $flags += @("--agent-tui-starting-directive", $AgentTuiStartingDirective) }
if ($AgentTuiStartingDirectiveFile) { $flags += @("--agent-tui-starting-directive-file", $AgentTuiStartingDirectiveFile) }

$env:NARADA_AGENT_ID = $Agent
$env:NARADA_TARGET_SITE_ROOT = $siteRoot
$env:NARADA_LAUNCH_REGISTRY_SITE_ROOT = $siteRoot
$env:NARADA_WORKSPACE_ROOT = $workspaceRoot
$tsxLoader = "file:///D:/code/narada/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs"

Push-Location $workspaceRoot
try {
    & node --import $tsxLoader $agentStart @flags
} finally {
    Pop-Location
}
exit $LASTEXITCODE
