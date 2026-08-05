[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logPath = Join-Path $env:TEMP 'narada-materialize-all.log'
$pushedLocation = $false

function Write-Log {
  param([Parameter(Mandatory)][string]$Message)

  Add-Content -LiteralPath $logPath -Value ("[{0:o}] {1}" -f (Get-Date), $Message)
}

function Invoke-PnpmStep {
  param(
    [Parameter(Mandatory)][string]$Label,
    [Parameter(Mandatory)][string[]]$Arguments
  )

  Write-Log "Starting ${Label}: pnpm $($Arguments -join ' ')"
  & $pnpmCommand @Arguments *>> $logPath
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "${Label} failed with exit code $exitCode."
  }
  Write-Log "Completed ${Label}."
}

function Show-SuccessNotification {
  try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms

    $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
    try {
      $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
      $notifyIcon.BalloonTipTitle = 'Narada MCP'
      $notifyIcon.BalloonTipText = 'All carriers materialized. Restart Codex to load the refreshed MCP configuration.'
      $notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
      $notifyIcon.Visible = $true
      $notifyIcon.ShowBalloonTip(10000)
      Start-Sleep -Seconds 10
    } finally {
      $notifyIcon.Dispose()
    }
  } catch {
    Write-Log "WARNING: success notification unavailable: $($_ | Out-String)"
  }
}

try {
  Set-Content -LiteralPath $logPath -Value "[$(Get-Date -Format o)] Starting workspace build and all-carrier materialization." -Encoding utf8
  $pnpmCommand = (Get-Command pnpm.cmd -ErrorAction Stop).Source
  Push-Location $repoRoot
  $pushedLocation = $true

  Invoke-PnpmStep -Label 'workspace build' -Arguments @('build')
  Invoke-PnpmStep -Label 'all-carrier materialization' -Arguments @('materialize:carrier', '--materialize-all')
  Write-Log 'Materialization completed successfully.'
  Show-SuccessNotification
  exit 0
} catch {
  $details = ($_ | Out-String).Trim()
  try {
    Write-Log "ERROR: $details"
    Start-Process -FilePath 'notepad.exe' -ArgumentList @($logPath)
  } catch {
    # The log remains available even if the failure viewer cannot be opened.
  }
  exit 1
} finally {
  if ($pushedLocation) {
    Pop-Location
  }
}
