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

try {
  Set-Content -LiteralPath $logPath -Value "[$(Get-Date -Format o)] Starting workspace build and all-carrier materialization." -Encoding utf8
  $pnpmCommand = (Get-Command pnpm.cmd -ErrorAction Stop).Source
  Push-Location $repoRoot
  $pushedLocation = $true

  Invoke-PnpmStep -Label 'workspace build' -Arguments @('build')
  Invoke-PnpmStep -Label 'all-carrier materialization' -Arguments @('materialize:carrier', '--materialize-all')
  Write-Log 'Materialization completed successfully.'
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
