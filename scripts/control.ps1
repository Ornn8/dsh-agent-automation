[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Configuration,
  [Parameter(Mandatory)][ValidateSet('change', 'review', 'maintenance', 'dsh-web')][string]$Component,
  [string]$Repository,
  [ValidateRange(1, 8)][int]$Replica = 1,
  [Parameter(Mandatory)][ValidateSet('status', 'start', 'stop', 'restart', 'fault')][string]$Action
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $repoRoot 'ops\Automation.Operations.psm1') -Force
$loaded = Read-OperationsConfig -Configuration $Configuration
$ops = $loaded.Operations

if ($Component -eq 'dsh-web') {
  if ($Repository) { throw '-Repository is not valid for the host-wide dsh-web component' }
  if ($PSBoundParameters.ContainsKey('Replica')) { throw '-Replica is not valid for the host-wide dsh-web component' }
  if (-not $ops.dshWebHost.enabled) { throw 'dsh-web is disabled in configuration' }
  $target = [pscustomobject]@{
    Id = 'dsh-web'
    TaskName = Get-DshWebTaskName
    FaultFile = Join-Path $ops.stateRoot (Join-Path 'faults' 'dsh-web.restart')
  }
} else {
  if ($Component -ne 'maintenance' -and $ops.controller.registrationScope -eq 'target-repositories' -and [string]::IsNullOrWhiteSpace($Repository)) { throw '-Repository is required in target-repositories mode so exactly one runner is selected' }
  if ($Component -eq 'maintenance' -and $Repository) { throw '-Repository is not valid for the Controller maintenance role' }
  if ($ops.controller.registrationScope -eq 'organization' -and $Repository) { throw '-Repository is not valid in organization mode because each role is shared' }
  $repositories = if ($Repository) { @($Repository) } else { @() }
  $matches = @(Get-RunnerInstances -Loaded $loaded -Roles @($Component) -Repositories $repositories | Where-Object { $_.Replica -eq $Replica })
  if ($matches.Count -ne 1) { throw "Component selection must resolve exactly one instance; got $($matches.Count)" }
  $target = $matches[0]
}

$manifest = Read-InstallManifest -Loaded $loaded
$managedState = Get-ManagedArtifactState -Loaded $loaded -Manifest $manifest
$unreconciled = $managedState.ScopeChanged -or $managedState.RunnerPackageChanged -or $managedState.StaleEntries.Count -or $managedState.ChangedEntries.Count -or $managedState.UnexpectedTaskIds.Count -or $managedState.UnexpectedRunnerIds.Count -or $managedState.UnexpectedProcessRecordIds.Count -or $managedState.DshWebUnexpected -or $managedState.DshWebStale
if ($unreconciled) { throw 'Installed state is unreconciled. Run install.ps1 -Migrate -DryRun before controlling services.' }
if ($Component -eq 'dsh-web') {
  if (-not $manifest -or -not $manifest.dshWebManaged) { throw 'dsh-web is not present in the managed install manifest' }
} elseif (-not $manifest -or $target.Id -notin @($manifest.instances.id)) {
  throw "$($target.Id) is not present in the managed install manifest"
}
$runtime = if ($manifest.psobject.Properties.Name -contains 'operationsRuntime') { $manifest.operationsRuntime } else { $null }
$runtimeStatus = if ($runtime) { Test-OperationsRuntimeSnapshot -Snapshot $runtime } else { [pscustomobject]@{ Ok = $false; Detail = 'manifest has no operations runtime snapshot' } }
$expectedRuntimeScript = if ($runtime) { Join-Path $runtime.root $(if ($Component -eq 'dsh-web') { 'dsh-web-host-supervisor.ps1' } else { 'runner-supervisor.ps1' }) } else { '' }
$installedTask = Get-ScheduledTask -TaskName $target.TaskName -ErrorAction SilentlyContinue
$taskRuntimeStatus = if ($installedTask -and $expectedRuntimeScript) { Test-ScheduledTaskRuntimePath -Task $installedTask -ExpectedScript $expectedRuntimeScript } else { [pscustomobject]@{ Ok = $false; Detail = 'task or managed runtime path is missing' } }

switch ($Action) {
  'status' {
    $task = Get-ScheduledTask -TaskName $target.TaskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Output "$($target.Id): not installed"; exit 1 }
    $info = Get-ScheduledTaskInfo -TaskName $target.TaskName
    $owned = Test-OwnedProcessRecord -Operations $ops -InstanceId $target.Id
    $taskRuntime = if ($expectedRuntimeScript) { Test-ScheduledTaskRuntimePath -Task $task -ExpectedScript $expectedRuntimeScript } else { [pscustomobject]@{ Ok = $false; Detail = 'missing runtime' } }
    $consistent = $runtimeStatus.Ok -and $taskRuntime.Ok -and $owned.Ok -and (($task.State -eq 'Running' -and $owned.Running) -or ($task.State -ne 'Running' -and -not $owned.Running))
    Write-Output "$($target.Id): task $($task.State); process $($owned.Detail); runtime $($runtimeStatus.Detail); last result $($info.LastTaskResult); last run $($info.LastRunTime)"
    if (-not $consistent) { exit 1 }
  }
  'start' {
    if (-not $runtimeStatus.Ok -or -not $taskRuntimeStatus.Ok) { throw "Cannot start with an invalid operations runtime or task path" }
    Start-ManagedComponent -Operations $ops -InstanceId $target.Id -TaskName $target.TaskName | Out-Null
  }
  'stop' { Stop-ManagedComponent -Operations $ops -InstanceId $target.Id -TaskName $target.TaskName | Out-Null }
  'restart' {
    if (-not $runtimeStatus.Ok -or -not $taskRuntimeStatus.Ok) { throw "Cannot restart with an invalid operations runtime or task path" }
    Stop-ManagedComponent -Operations $ops -InstanceId $target.Id -TaskName $target.TaskName | Out-Null
    Start-ManagedComponent -Operations $ops -InstanceId $target.Id -TaskName $target.TaskName | Out-Null
  }
  'fault' {
    if (-not $runtimeStatus.Ok -or -not $taskRuntimeStatus.Ok) { throw "Cannot inject a fault with an invalid operations runtime or task path" }
    $faultDirectory = Split-Path -Parent $target.FaultFile
    if (-not (Test-Path -LiteralPath $faultDirectory -PathType Container)) { throw 'Fault directory is missing; install the operations layer first' }
    New-Item -ItemType File -LiteralPath $target.FaultFile -Force | Out-Null
    Write-Output "$($target.Id): one controlled restart fault was requested; only its supervisor will consume the marker."
  }
}
