# Start-AgentCliSession.ps1
# narada_template_id: narada.agent_cli.windows_wrapper
# narada_template_version: 2
# narada_template_source: @narada-core/agent-runtime-server ./agent-cli-windows-wrapper-template
# narada_template_hash: 495bbfc8c022ca8fa2ced5790fd150f77026ecdc5ac6fce793135e11eb339504

param(
    [Parameter(Mandatory)]
    [string]$IdentityName,

    [Parameter(Mandatory)]
    [string]$WorkDir,

    [string]$SessionName = ($IdentityName -replace '\.', '-'),

    [switch]$SessionInventory,

    [switch]$SessionInventoryJson,

    [switch]$SessionInventoryOperations,

    [switch]$SessionInventoryOperationsJson,

    [switch]$SessionInventoryHostCommands,

    [switch]$SessionInventoryHostCommandsJson,

    [switch]$SessionInventoryActions,

    [switch]$SessionInventoryActionsJson,

    [switch]$SessionInventoryRecovery,

    [switch]$SessionInventoryRecoveryJson,

    [switch]$SessionInventoryEvents,
    [switch]$SessionInventoryEventsJson,

    [ValidateSet('mcp_state', 'recommended_action', 'recovery_kind')]
    [ValidateSet('operational_posture', 'request_posture', 'mcp_state', 'heartbeat_status', 'recommended_action', 'recovery_kind')]
    [string]$SessionInventoryFilter,

    [string]$SessionInventoryMatch,

    [ValidateSet('all', 'lifecycle', 'issues', 'diagnostics')]
    [string]$SessionInventoryEventsFilter = 'all',

    [int]$SessionInventoryEventsCount = 20,

    [switch]$SessionRead,

    [switch]$SessionRecovery,

    [switch]$SessionRecoveryJson,

    [switch]$SessionReadJson,

    [switch]$SessionOperations,

    [switch]$SessionOperationsJson,

    [switch]$HostCommandOutputRead,

    [switch]$HostCommandOutputReadJson,

    [string]$HostCommandOutputRef,

    [switch]$SessionEvents,

    [switch]$SessionEventsJson,

    [ValidateSet('all', 'lifecycle', 'issues', 'diagnostics', 'operations')]
    [string]$SessionEventsFilter = 'all',

    [int]$SessionEventsCount = 20,

    [switch]$AutoApprove
)
$ErrorActionPreference = 'Stop'

$SiteControlRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$SiteRoot = Split-Path -Parent $SiteControlRoot
$UserHome = [Environment]::GetFolderPath('UserProfile')
$SourceRoot = if ($env:NARADA_SRC_ROOT) { $env:NARADA_SRC_ROOT } else { Join-Path $UserHome 'src' }
$NaradaProperRoot = if ($env:NARADA_PROPER_ROOT) {
    $env:NARADA_PROPER_ROOT
} elseif ($env:NARADA_ROOT) {
    $env:NARADA_ROOT
} else {
    Join-Path $SourceRoot 'narada'
}

if (-not ([string]$env:NODE_OPTIONS -match '(^|\s)--no-warnings(=|\s|$)')) {
    $env:NODE_OPTIONS = (($env:NODE_OPTIONS, '--no-warnings=ExperimentalWarning') | Where-Object { $_ }) -join ' '
}

function Resolve-NaradaPackageRoot {
    param([Parameter(Mandatory)][string]$PackageName)

    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $escaped = $PackageName.Replace('\', '\\').Replace("'", "\'")
        $script = "const { dirname } = require('node:path'); try { console.log(dirname(require.resolve('$escaped/package.json'))); } catch {}"
        $resolved = & $node.Source -e $script 2>$null
        if ($LASTEXITCODE -eq 0 -and $resolved) {
            return [string]$resolved
        }
    }

    if (-not $NaradaProperRoot) {
        throw "narada_package_not_resolvable: $PackageName; set NARADA_PROPER_ROOT or install the package where Node can resolve it"
    }

    if ($PackageName -eq '@narada-core/agent-cli') {
        $agentCliRoot = if ($env:NARADA_AGENT_CLI_ROOT) { $env:NARADA_AGENT_CLI_ROOT } else { Join-Path $SourceRoot 'agent-cli' }
        $agentCliPackageJson = Join-Path $agentCliRoot 'package.json'
        if (Test-Path -LiteralPath $agentCliPackageJson -PathType Leaf) {
            return $agentCliRoot
        }
    }

    $parts = $PackageName -split '/'
    return (Join-Path (Join-Path $NaradaProperRoot 'packages') $parts[$parts.Count - 1])
}

function Get-NaradaPackageJson {
    param([Parameter(Mandatory)][string]$PackageName)

    $packageRoot = Resolve-NaradaPackageRoot -PackageName $PackageName
    $packageJsonPath = Join-Path $packageRoot 'package.json'
    if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
        throw "narada_package_json_missing: $PackageName at $packageJsonPath"
    }
    return [pscustomobject]@{
        Root = $packageRoot
        Json = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
    }
}

function Resolve-NaradaPackageBin {
    param(
        [Parameter(Mandatory)][string]$PackageName,
        [Parameter(Mandatory)][string]$BinName
    )

    $package = Get-NaradaPackageJson -PackageName $PackageName
    $bin = $package.Json.bin
    $target = if ($bin -is [string]) { $bin } else { $bin.PSObject.Properties[$BinName].Value }
    if (-not $target) {
        throw "narada_package_bin_missing: $PackageName $BinName"
    }
    return Join-Path $package.Root $target
}

$AgentCliPath = Resolve-NaradaPackageBin -PackageName '@narada-core/agent-cli' -BinName 'narada-agent-cli'
$AgentRuntimeServerPath = Resolve-NaradaPackageBin -PackageName '@narada-core/agent-runtime-server' -BinName 'narada-agent-runtime-server'

function Import-DotEnvFile {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $parts = $trimmed -split '=', 2
        if ($parts.Count -ne 2) { continue }
        $name = $parts[0].Trim()
        if (-not $name) { continue }
        if ([Environment]::GetEnvironmentVariable($name, 'Process')) { continue }
        $value = $parts[1].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

Import-DotEnvFile -Path (Join-Path $SiteRoot '.env')

# Set window title for OSL binding and general identification
$Host.UI.RawUI.WindowTitle = $IdentityName
# Validate node is available
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "node.exe is required but not found on PATH."
    exit 1
}

if (-not (Test-Path $AgentCliPath)) {
    Write-Error "Agent CLI not found at $AgentCliPath"
    exit 1
}
if (-not (Test-Path $AgentRuntimeServerPath)) {
    Write-Error "Agent runtime server not found at $AgentRuntimeServerPath"
    exit 1
}

if ($SessionInventory) {
    Write-Host "Session inventory..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryJson) {
    Set-Location $WorkDir
    $inventoryJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-json')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryJsonArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryOperations) {
    Write-Host "Session operations..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryOperationArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-operations')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryOperationArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryOperationArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryOperationsJson) {
    Set-Location $WorkDir
    $inventoryOperationJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-operations-json')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryOperationJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryOperationJsonArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryHostCommands) {
    Write-Host "Session host commands..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryHostCommandArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-host-commands')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryHostCommandArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryHostCommandArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryHostCommandsJson) {
    Set-Location $WorkDir
    $inventoryHostCommandJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-host-commands-json')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryHostCommandJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryHostCommandJsonArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryActions) {
    Write-Host "Session inventory actions..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryActionArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-actions')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryActionArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryActionArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryActionsJson) {
    Set-Location $WorkDir
    $inventoryActionsJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-actions-json')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryActionsJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryActionsJsonArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryRecovery) {
    Write-Host "Session inventory recovery..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryRecoveryArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-recovery')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryRecoveryArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryRecoveryArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryRecoveryJson) {
    Set-Location $WorkDir
    $inventoryRecoveryJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-recovery-json')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryRecoveryJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryRecoveryJsonArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryEvents) {
    Write-Host "Session inventory events..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryEventArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-events', '--session-inventory-events-filter', $SessionInventoryEventsFilter, '--session-inventory-events-count', $SessionInventoryEventsCount)
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryEventArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryEventArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryEventsJson) {
    Set-Location $WorkDir
    $inventoryEventsJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-events-json', '--session-inventory-events-filter', $SessionInventoryEventsFilter, '--session-inventory-events-count', $SessionInventoryEventsCount)
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryEventsJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryEventsJsonArgs
    exit $LASTEXITCODE
}

if ($SessionRead) {
    Write-Host "Session read..." -ForegroundColor Cyan
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-read'
    exit $LASTEXITCODE
}

if ($SessionRecovery) {
    Write-Host "Session recovery..." -ForegroundColor Cyan
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-recovery'
    exit $LASTEXITCODE
}

if ($SessionRecoveryJson) {
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-recovery-json'
    exit $LASTEXITCODE
}

if ($SessionReadJson) {
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-read-json'
    exit $LASTEXITCODE
}

if ($SessionOperations) {
    Write-Host "Session operations..." -ForegroundColor Cyan
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-operations'
    exit $LASTEXITCODE
}

if ($SessionOperationsJson) {
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-operations-json'
    exit $LASTEXITCODE
}

if ($HostCommandOutputRead) {
    Write-Host "Host command output..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $hostCommandOutputArgs = @('--identity', $IdentityName, '--session', $SessionName, '--host-command-output-read')
    if ($HostCommandOutputRef) {
        $hostCommandOutputArgs += @('--host-command-output-ref', $HostCommandOutputRef)
    }
    & node $AgentCliPath @hostCommandOutputArgs
    exit $LASTEXITCODE
}

if ($HostCommandOutputReadJson) {
    Set-Location $WorkDir
    $hostCommandOutputJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--host-command-output-read-json')
    if ($HostCommandOutputRef) {
        $hostCommandOutputJsonArgs += @('--host-command-output-ref', $HostCommandOutputRef)
    }
    & node $AgentCliPath @hostCommandOutputJsonArgs
    exit $LASTEXITCODE
}

if ($SessionEvents) {
    Write-Host "Session events..." -ForegroundColor Cyan
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-events' '--session-events-filter' $SessionEventsFilter '--session-events-count' $SessionEventsCount
    exit $LASTEXITCODE
}

if ($SessionEventsJson) {
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-events-json' '--session-events-filter' $SessionEventsFilter '--session-events-count' $SessionEventsCount
    exit $LASTEXITCODE
}

$argList = @($AgentRuntimeServerPath, '--identity', $IdentityName, '--session', $SessionName)
if ($AutoApprove) {
    $argList += '--auto-approve'
}

Write-Host "Starting agent-runtime-server for $IdentityName..." -ForegroundColor Cyan
Write-Host "  Session: $SessionName" -ForegroundColor DarkGray
Write-Host "  WorkDir: $WorkDir" -ForegroundColor DarkGray
Write-Host "  Intelligence: resolved at invocation time from the Site registry" -ForegroundColor DarkGray
Write-Host ""
Set-Location $WorkDir
& node @argList

$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Warning "NARS exited with code $exitCode"

    $sessionRecoveryArgs = @($AgentCliPath, '--identity', $IdentityName, '--session', $SessionName, '--session-recovery-json')
    $sessionRecoveryRaw = & node @sessionRecoveryArgs
    $sessionRecoveryExitCode = $LASTEXITCODE
    $sessionRecovery = $null
    if ($sessionRecoveryExitCode -eq 0 -and $sessionRecoveryRaw) {
        try {
            $sessionRecovery = $sessionRecoveryRaw | ConvertFrom-Json
        } catch {
            Write-Warning "Session recovery returned non-JSON output; skipping post-session recovery guidance."
        }
    }

    if ($sessionRecovery -and $sessionRecovery.found -and $sessionRecovery.recovery) {
        $recommendedAction = [string]$sessionRecovery.recovery.recommended_action
        if ($recommendedAction -and $recommendedAction -ne 'review_session_summary') {
            Write-Host ""
            Write-Host "Post-session recovery..." -ForegroundColor Cyan
            if ($sessionRecovery.recovery.recovery_kind_display) {
                Write-Host ("  Recovery kind:      {0}" -f $sessionRecovery.recovery.recovery_kind_display) -ForegroundColor DarkGray
            }
            if ($sessionRecovery.recovery.recommended_action_display) {
                Write-Host ("  Recommended action: {0}" -f $sessionRecovery.recovery.recommended_action_display) -ForegroundColor DarkGray
            }
            if ($sessionRecovery.recovery.recommended_command) {
                Write-Host ("  Recommended command: {0}" -f $sessionRecovery.recovery.recommended_command) -ForegroundColor DarkYellow
            }
            if ($sessionRecovery.recovery.recovery_primary_command) {
                Write-Host ("  Recovery primary:   {0}" -f $sessionRecovery.recovery.recovery_primary_command) -ForegroundColor DarkYellow
            }
            if ($sessionRecovery.recovery.recovery_followup_command) {
                Write-Host ("  Recovery followup:  {0}" -f $sessionRecovery.recovery.recovery_followup_command) -ForegroundColor DarkGray
            }
            if ($sessionRecovery.record -and $sessionRecovery.record.handoffs -and $sessionRecovery.record.handoffs.session_recovery) {
                Write-Host ("  Session recovery:   {0}" -f $sessionRecovery.record.handoffs.session_recovery) -ForegroundColor DarkGray
            }
        }
    }
}
