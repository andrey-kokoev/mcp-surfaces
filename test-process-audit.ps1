[CmdletBinding()]
param(
    [string]$RepoRoot = $PSScriptRoot,
    [string]$LogRoot = (Join-Path $env:TEMP 'mcp-surfaces-test-audit'),
    [int]$TimeoutMinutes = 10,
    [int]$GraceSeconds = 3,
    [int]$PostTestObservationSeconds = 10,
    [switch]$IncludeNamedTestScripts,
    [string[]]$OnlyPackage,
    [switch]$KeepTimedOutProcesses,
    [bool]$UseRustScope = $true,
    [switch]$IsolatedWorktree
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if ($IsolatedWorktree) {
    $scriptPath = (Resolve-Path -LiteralPath $PSCommandPath).Path
    $dirty = @(git -C $RepoRoot status --porcelain 2>$null)
    if ($dirty.Count -gt 0) {
        throw 'Isolated worktree mode requires a clean source checkout so the tested revision is explicit.'
    }
    $outerRunId = Get-Date -Format 'yyyyMMdd-HHmmss'
    $worktreeRoot = Join-Path (Split-Path -Parent $RepoRoot) ('mcp-surfaces-audit-' + $outerRunId)
    $gitLog = Join-Path $env:TEMP ('mcp-surfaces-audit-git-' + $outerRunId + '.log')
    $installLog = Join-Path $env:TEMP ('mcp-surfaces-audit-install-' + $outerRunId + '.log')
    $worktreeAdded = $false
    $childExit = 1
    try {
        & git -C $RepoRoot worktree add --detach $worktreeRoot HEAD *> $gitLog
        if ($LASTEXITCODE -ne 0) { throw ('git worktree add failed; see ' + $gitLog) }
        $worktreeAdded = $true
        Push-Location $worktreeRoot
        try {
            & pnpm install --offline --ignore-scripts *> $installLog
            if ($LASTEXITCODE -ne 0) { throw ('isolated pnpm install failed; see ' + $installLog) }
            & pnpm --filter @narada2/mcp-e2e-harness build *> $installLog
            if ($LASTEXITCODE -ne 0) { throw ('isolated harness build failed; see ' + $installLog) }
        } finally {
            Pop-Location
        }
        $forward = @('-RepoRoot', $worktreeRoot, '-LogRoot', $LogRoot, '-TimeoutMinutes', $TimeoutMinutes, '-GraceSeconds', $GraceSeconds, '-PostTestObservationSeconds', $PostTestObservationSeconds)
        if ($IncludeNamedTestScripts) { $forward += '-IncludeNamedTestScripts' }
        if ($UseRustScope) { $forward += '-UseRustScope' } else { $forward += '-UseRustScope:$false' }
        if ($OnlyPackage.Count -gt 0) { $forward += '-OnlyPackage'; $forward += $OnlyPackage }
        & $scriptPath @forward
        $childExit = $LASTEXITCODE
    } finally {
        if ($worktreeAdded) {
            & git -C $RepoRoot worktree remove --force $worktreeRoot *> $gitLog
        }
    }
    exit $childExit
}
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$runRoot = Join-Path $LogRoot $runId
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$repoNeedle = $RepoRoot.Replace('\', '/')
$unexpectedExternalProcessNames = @('conhost.exe')

function Write-JsonFile {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Path
    )
    $json = ConvertTo-Json -InputObject $Value -Depth 8
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-FirstCommandLine {
    param(
        [Parameter(Mandatory)][string]$Command,
        [string[]]$Arguments = @()
    )
    try {
        $line = & $Command @Arguments 2>$null | Select-Object -First 1
        if ($null -ne $line) { return [string]$line }
    } catch {}
    return $null
}

function Get-FileSha256OrNull {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() } catch { return $null }
}

function Get-ProcessSnapshot {
    $raw = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    foreach ($p in $raw) {
        $commandLine = [string]$p.CommandLine
        if ($commandLine.Length -gt 1000) {
            $commandLine = $commandLine.Substring(0, 1000) + '...'
        }
        $created = $null
        try {
            $created = ([datetime]$p.CreationDate).ToString('o')
        } catch {}
        [pscustomobject]@{
            ProcessId = [int]$p.ProcessId
            Identity = '{0}|{1}' -f ([int]$p.ProcessId), [string]$created
            ParentProcessId = [int]$p.ParentProcessId
            Name = [string]$p.Name
            CreationDate = $created
            ExecutablePath = [string]$p.ExecutablePath
            CommandLine = $commandLine
        }
    }
}

function Get-NewProcesses {
    param(
        [Parameter(Mandatory)]$Before,
        [Parameter(Mandatory)]$After
    )
    $beforeIdentities = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($p in @($Before)) {
        [void]$beforeIdentities.Add([string]$p.Identity)
    }
    @($After | Where-Object { -not $beforeIdentities.Contains([string]$_.Identity) })
}

function Get-DescendantProcesses {
    param(
        [Parameter(Mandatory)]$Snapshot,
        [Parameter(Mandatory)][int]$RootPid
    )
    $map = @{}
    foreach ($p in @($Snapshot)) {
        $map[[int]$p.ProcessId] = $p
    }
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootPid)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($p in @($Snapshot)) {
            if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
                [void]$ids.Add([int]$p.ProcessId)
                $changed = $true
            }
        }
    }
    @($ids | ForEach-Object {
        if ($map.ContainsKey([int]$_)) {
            $map[[int]$_]
        }
    })
}

function Get-DescendantProcessIds {
    param([Parameter(Mandatory)][int]$RootPid)
    $snapshot = @(Get-ProcessSnapshot)
    @((Get-DescendantProcesses -Snapshot $snapshot -RootPid $RootPid) | ForEach-Object { [int]$_.ProcessId })
}

function Test-ObservedAncestry {
    param(
        [Parameter(Mandatory)]$Process,
        [Parameter(Mandatory)]$ObservedProcesses,
        [Parameter(Mandatory)]$CurrentProcessMap
    )
    $observedByPid = @{}
    foreach ($observedProcess in @($ObservedProcesses)) {
        $observedByPid[[int]$observedProcess.ProcessId] = $observedProcess
    }
    $current = $Process
    for ($depth = 0; $depth -lt 12 -and $null -ne $current; $depth++) {
        $parentId = [int]$current.ParentProcessId
        if ($CurrentProcessMap.ContainsKey($parentId)) {
            $parent = $CurrentProcessMap[$parentId]
            if ($observedByPid.ContainsKey($parentId) -and [string]$observedByPid[$parentId].Identity -eq [string]$parent.Identity) {
                return $true
            }
            $current = $parent
            continue
        }
        if ($observedByPid.ContainsKey($parentId)) {
            return $true
        }
        break
    }
    return $false
}

function Stop-ProcessTree {
    param([Parameter(Mandatory)][int]$RootPid)
    $ids = @(Get-DescendantProcessIds -RootPid $RootPid | Sort-Object -Descending)
    foreach ($id in $ids) {
        if ($id -ne $PID) {
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-RepoOwnedProcess {
    param(
        [Parameter(Mandatory)]$Process,
        [Parameter(Mandatory)]$ProcessMap
    )
    $current = $Process
    for ($depth = 0; $depth -lt 12 -and $null -ne $current; $depth++) {
        $commandLine = [string]$current.CommandLine
        $executablePath = [string]$current.ExecutablePath
        if ($commandLine.IndexOf($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $commandLine.IndexOf($repoNeedle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $executablePath.IndexOf($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $executablePath.IndexOf($repoNeedle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
        $parentId = [int]$current.ParentProcessId
        if (-not $ProcessMap.ContainsKey($parentId)) {
            break
        }
        $current = $ProcessMap[$parentId]
    }
    return $false
}

function Get-ProcessGroupSummary {
    param([AllowNull()][AllowEmptyCollection()]$Processes)
    @($Processes |
        Group-Object Name |
        Sort-Object Count -Descending |
        ForEach-Object {
            [pscustomobject]@{
                Name = $_.Name
                Count = $_.Count
                Pids = @($_.Group | ForEach-Object { [int]$_.ProcessId })
            }
        })
}

$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpmCommand) {
    $pnpmCommand = Get-Command pnpm -ErrorAction Stop
}
$pnpmPath = $pnpmCommand.Source
$rustScopePath = Join-Path $RepoRoot 'packages/shared/mcp-e2e-harness/native/target/release/narada-test-process-scope.exe'
if ($UseRustScope -and -not (Test-Path -LiteralPath $rustScopePath)) {
    throw ('Rust process scope is not built: ' + $rustScopePath + '. Run the harness build first or pass -UseRustScope:$false.')
}
$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json
$commands = [System.Collections.Generic.List[object]]::new()

$rootTestBoundary = @($rootPackage.scripts.psobject.Properties | Where-Object Name -eq 'test:ui-boundary')
if ($rootTestBoundary.Count -gt 0 -and $OnlyPackage.Count -eq 0) {
    [void]$commands.Add([pscustomobject]@{
        Order = 0
        Label = 'root:test:ui-boundary'
        Package = '(root)'
        Arguments = @('run', 'test:ui-boundary')
        WorkingDirectory = $RepoRoot
    })
}

$packageFiles = @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'packages') -Filter package.json -Recurse -File)
foreach ($file in $packageFiles) {
    $package = Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json
    if (-not $package.name) {
        continue
    }
    if ($OnlyPackage.Count -gt 0 -and $OnlyPackage -notcontains [string]$package.name) {
        continue
    }
    $hasTest = @($package.scripts.psobject.Properties | Where-Object Name -eq 'test').Count -gt 0
    if ($hasTest) {
        [void]$commands.Add([pscustomobject]@{
            Order = 10
            Label = "$($package.name):test"
            Package = [string]$package.name
            Arguments = @('--filter', [string]$package.name, 'run', 'test')
            WorkingDirectory = $RepoRoot
        })
    }
    if ($IncludeNamedTestScripts) {
        $named = @($package.scripts.psobject.Properties | Where-Object { $_.Name -match '^test:' } | Sort-Object Name)
        foreach ($scriptProperty in $named) {
            [void]$commands.Add([pscustomobject]@{
                Order = 20
                Label = "$($package.name):$($scriptProperty.Name)"
                Package = [string]$package.name
                Arguments = @('--filter', [string]$package.name, 'run', [string]$scriptProperty.Name)
                WorkingDirectory = $RepoRoot
            })
        }
    }
}
if ($IncludeNamedTestScripts -and $OnlyPackage.Count -eq 0) {
    $rootNamed = @($rootPackage.scripts.psobject.Properties | Where-Object { $_.Name -match '^test:' -and $_.Name -ne 'test:ui-boundary' } | Sort-Object Name)
    foreach ($scriptProperty in $rootNamed) {
        [void]$commands.Add([pscustomobject]@{
            Order = 30
            Label = "root:$($scriptProperty.Name)"
            Package = '(root)'
            Arguments = @('run', [string]$scriptProperty.Name)
            WorkingDirectory = $RepoRoot
        })
    }
}
$commands = @($commands | Sort-Object Order, Label)
if ($commands.Count -eq 0) {
    throw 'No test commands were discovered.'
}

$manifest = [ordered]@{
    runId = $runId
    repoRoot = $RepoRoot
    startedAt = (Get-Date).ToString('o')
    timeoutMinutes = $TimeoutMinutes
    graceSeconds = $GraceSeconds
    postTestObservationSeconds = $PostTestObservationSeconds
    includeNamedTestScripts = [bool]$IncludeNamedTestScripts
    runtimeIdentity = [ordered]@{
        powershell = [string]$PSVersionTable.PSVersion
        node = Get-FirstCommandLine -Command 'node' -Arguments @('--version')
        pnpm = Get-FirstCommandLine -Command $pnpmPath -Arguments @('--version')
        pnpmPath = $pnpmPath
        rustScopePath = if ($UseRustScope) { $rustScopePath } else { $null }
        rustScopeSha256 = if ($UseRustScope) { Get-FileSha256OrNull -Path $rustScopePath } else { $null }
        gitHead = Get-FirstCommandLine -Command 'git' -Arguments @('-C', $RepoRoot, 'rev-parse', 'HEAD')
    }
    commands = @($commands | ForEach-Object {
        [ordered]@{
            label = $_.Label
            package = $_.Package
            arguments = @($_.Arguments)
        }
    })
}
Write-JsonFile -Value $manifest -Path (Join-Path $runRoot 'manifest.json')

$results = [System.Collections.Generic.List[object]]::new()
$index = 0
try {
    foreach ($test in $commands) {
        $index++
        $slug = ($test.Label -replace '[^A-Za-z0-9._-]', '_')
        $testRoot = Join-Path $runRoot ('{0:D3}-{1}' -f $index, $slug)
        New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
        $stdoutPath = Join-Path $testRoot 'stdout.log'
        $stderrPath = Join-Path $testRoot 'stderr.log'
        $beforePath = Join-Path $testRoot 'before-processes.json'
        $afterPath = Join-Path $testRoot 'after-processes.json'
        $residualPath = Join-Path $testRoot 'residual-processes.json'

        $before = @(Get-ProcessSnapshot)
        Write-JsonFile -Value $before -Path $beforePath
        $startedAt = Get-Date
        $process = $null
        $rootPid = $null
        $status = 'launcher-error'
        $exitCode = $null
        $timedOut = $false
        $errorText = $null
        $observed = [System.Collections.Generic.Dictionary[string, object]]::new()

        try {
            if ($UseRustScope) {
                $commandLine = '"' + $pnpmPath + '" ' + (@($test.Arguments) -join ' ')
                $startParameters = @{
                    FilePath = $rustScopePath
                    ArgumentList = @('--', $env:ComSpec, '/d', '/s', '/c', $commandLine)
                    WorkingDirectory = $test.WorkingDirectory
                    RedirectStandardOutput = $stdoutPath
                    RedirectStandardError = $stderrPath
                    NoNewWindow = $true
                    PassThru = $true
                }
            } else {
                $startParameters = @{
                    FilePath = $pnpmPath
                    ArgumentList = $test.Arguments
                    WorkingDirectory = $test.WorkingDirectory
                    RedirectStandardOutput = $stdoutPath
                    RedirectStandardError = $stderrPath
                    NoNewWindow = $true
                    PassThru = $true
                }
            }
            $process = Start-Process @startParameters
            $rootPid = [int]$process.Id
            $deadline = (Get-Date).AddMinutes([Math]::Max(1, $TimeoutMinutes))
            do {
                $current = @(Get-ProcessSnapshot)
                foreach ($child in @(Get-DescendantProcesses -Snapshot $current -RootPid $rootPid)) {
                    $observed[[string]$child.Identity] = $child
                }
                $completed = $process.WaitForExit(1000)
            } while (-not $completed -and (Get-Date) -lt $deadline)

            if (-not $completed) {
                $timedOut = $true
                $status = 'timeout'
                if (-not $KeepTimedOutProcesses) {
                    if ($UseRustScope) { Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue } else { Stop-ProcessTree -RootPid $rootPid }
                }
                $process.Refresh()
                try { $exitCode = $process.ExitCode } catch {}
            } else {
                $process.Refresh()
                try { $exitCode = $process.ExitCode } catch {}
                $status = if ($exitCode -eq 0) { 'passed' } else { 'failed' }
            }
        } catch {
            $errorText = $_ | Out-String
            [System.IO.File]::WriteAllText((Join-Path $testRoot 'launcher-error.log'), $errorText, [System.Text.UTF8Encoding]::new($false))
        }

        if ($GraceSeconds -gt 0) {
            Start-Sleep -Seconds $GraceSeconds
        }
        $observationRemaining = [Math]::Max(0, $PostTestObservationSeconds - $GraceSeconds)
        if ($observationRemaining -gt 0) {
            Start-Sleep -Seconds $observationRemaining
        }
        $after = @(Get-ProcessSnapshot)
        Write-JsonFile -Value $after -Path $afterPath
        $newProcesses = @(Get-NewProcesses -Before $before -After $after)
        $afterMap = @{}
        foreach ($p in $after) {
            $afterMap[[int]$p.ProcessId] = $p
        }
        $ownedResidual = if ($UseRustScope) {
            @($newProcesses | Where-Object { $observed.ContainsKey([string]$_.Identity) })
        } else {
            @($newProcesses | Where-Object {
                $observed.ContainsKey([string]$_.Identity) -or (Test-RepoOwnedProcess -Process $_ -ProcessMap $afterMap)
            })
        }
        $externalNewProcesses = if ($UseRustScope) {
            @($newProcesses | Where-Object { -not $observed.ContainsKey([string]$_.Identity) })
        } else {
            @($newProcesses | Where-Object {
                -not ($observed.ContainsKey([string]$_.Identity) -or (Test-RepoOwnedProcess -Process $_ -ProcessMap $afterMap))
            })
        }
        $observedProcesses = @($observed.Values)
        $unexpectedExternalProcesses = @($externalNewProcesses | Where-Object {
            $unexpectedExternalProcessNames -contains ([string]$_.Name).ToLowerInvariant() -and
            (Test-ObservedAncestry -Process $_ -ObservedProcesses $observedProcesses -CurrentProcessMap $afterMap)
        })
        Write-JsonFile -Value ([ordered]@{
            owned = $ownedResidual
            external = $externalNewProcesses
            unexpectedExternal = $unexpectedExternalProcesses
        }) -Path $residualPath
        $groups = @(Get-ProcessGroupSummary -Processes $ownedResidual)
        $externalGroups = @(Get-ProcessGroupSummary -Processes $externalNewProcesses)
        $unexpectedExternalGroups = @(Get-ProcessGroupSummary -Processes $unexpectedExternalProcesses)
        $result = [ordered]@{
            index = $index
            label = $test.Label
            package = $test.Package
            status = $status
            exitCode = $exitCode
            timedOut = $timedOut
            startedAt = $startedAt.ToString('o')
            finishedAt = (Get-Date).ToString('o')
            durationSeconds = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
            stdout = $stdoutPath
            stderr = $stderrPath
            rootPid = $rootPid
            ownershipMode = if ($UseRustScope) { 'rust_job_object' } else { 'legacy_process_heuristic' }
            observedProcessCount = $observed.Count
            newProcessesStillAlive = $newProcesses.Count
            ownedResidualProcessCount = $ownedResidual.Count
            externalNewProcessCount = $externalNewProcesses.Count
            unexpectedExternalProcessCount = $unexpectedExternalProcesses.Count
            residualProcessGroups = $groups
            externalProcessGroups = $externalGroups
            unexpectedExternalProcessGroups = $unexpectedExternalGroups
        }
        if ($errorText) {
            $result.launcherError = $errorText
        }
        [void]$results.Add([pscustomobject]$result)
        Write-JsonFile -Value $results.ToArray() -Path (Join-Path $runRoot 'results.json')
    }
} catch {
    $fatal = $_ | Out-String
    [System.IO.File]::WriteAllText((Join-Path $runRoot 'fatal-error.log'), $fatal, [System.Text.UTF8Encoding]::new($false))
    throw
}

$passed = @($results | Where-Object status -eq 'passed').Count
$failed = @($results | Where-Object status -eq 'failed').Count
$timedOut = @($results | Where-Object status -eq 'timeout').Count
$launcherErrors = @($results | Where-Object status -eq 'launcher-error').Count
$residualTests = @($results | Where-Object ownedResidualProcessCount -gt 0).Count
$residualProcessCount = ($results | Measure-Object -Property ownedResidualProcessCount -Sum).Sum
if ($null -eq $residualProcessCount) { $residualProcessCount = 0 }
$externalChurnTests = @($results | Where-Object externalNewProcessCount -gt 0).Count
$externalProcessCount = ($results | Measure-Object -Property externalNewProcessCount -Sum).Sum
if ($null -eq $externalProcessCount) { $externalProcessCount = 0 }
$unexpectedExternalTests = @($results | Where-Object unexpectedExternalProcessCount -gt 0).Count
$unexpectedExternalProcessCount = ($results | Measure-Object -Property unexpectedExternalProcessCount -Sum).Sum
if ($null -eq $unexpectedExternalProcessCount) { $unexpectedExternalProcessCount = 0 }
$summary = [ordered]@{
    runId = $runId
    repoRoot = $RepoRoot
    finishedAt = (Get-Date).ToString('o')
    total = $results.Count
    passed = $passed
    failed = $failed
    timedOut = $timedOut
    launcherErrors = $launcherErrors
    testsWithOwnedResidualProcesses = $residualTests
    ownedResidualProcessCount = [int]$residualProcessCount
    testsWithExternalProcessChurn = $externalChurnTests
    externalProcessCount = [int]$externalProcessCount
    testsWithUnexpectedExternalProcesses = $unexpectedExternalTests
    unexpectedExternalProcessCount = [int]$unexpectedExternalProcessCount
    runRoot = $runRoot
    results = (Join-Path $runRoot 'results.json')
}
Write-JsonFile -Value $summary -Path (Join-Path $runRoot 'summary.json')
Write-Output ("runId={0} total={1} passed={2} failed={3} timedOut={4} launcherErrors={5} ownedResidualTests={6} ownedResidualProcesses={7} externalChurnTests={8} externalProcesses={9} unexpectedExternalTests={10} unexpectedExternalProcesses={11} report={12}" -f $runId, $summary.total, $passed, $failed, $timedOut, $launcherErrors, $residualTests, $summary.ownedResidualProcessCount, $externalChurnTests, $summary.externalProcessCount, $unexpectedExternalTests, $summary.unexpectedExternalProcessCount, (Join-Path $runRoot 'summary.json'))
if ($failed -gt 0 -or $timedOut -gt 0 -or $launcherErrors -gt 0 -or $residualTests -gt 0 -or $unexpectedExternalTests -gt 0) { exit 1 }

