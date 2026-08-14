[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$Configuration,
  [ValidateSet('change', 'review')][string[]]$Roles = @('change', 'review'),
  [string[]]$Repositories,
  [switch]$RemoveRunnerRegistration,
  [switch]$PurgeRuntime,
  [switch]$RemoveDshWebHost,
  [switch]$ConfirmRemoval,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $ConfirmRemoval) { throw 'Uninstall requires -ConfirmRemoval. Run with -DryRun first to inspect its exact scope.' }
if ($PurgeRuntime -and -not $RemoveRunnerRegistration) { throw '-PurgeRuntime requires -RemoveRunnerRegistration so no unmanaged remote registration is left behind.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $repoRoot 'ops\Automation.Operations.psm1') -Force
$loaded = Read-OperationsConfig -Configuration $Configuration -AllowExamplePlaceholders:$DryRun
$ops = $loaded.Operations
$instances = @(Get-RunnerInstances -Loaded $loaded -Roles $Roles -Repositories $Repositories)
if (-not $instances.Count) { throw 'The requested role/repository selection produced no runner instances' }
$manifest = Read-InstallManifest -Loaded $loaded
$managedState = Get-ManagedArtifactState -Loaded $loaded -Manifest $manifest
$unreconciled = $managedState.ScopeChanged -or $managedState.RunnerPackageChanged -or $managedState.StaleEntries.Count -or $managedState.ChangedEntries.Count -or $managedState.UnexpectedTaskIds.Count -or $managedState.UnexpectedRunnerIds.Count -or $managedState.UnexpectedProcessRecordIds.Count -or $managedState.UnexpectedRuntimeSnapshotIds.Count -or $managedState.DshWebUnexpected -or $managedState.DshWebStale
if ($unreconciled) { throw 'Installed state does not match desired configuration. Run install.ps1 -Migrate -DryRun and then -Migrate -ConfirmMigration before uninstalling.' }
if (-not $manifest) {
  Write-OperationLog 'No managed install manifest or managed artifacts exist; nothing to uninstall.'
  exit 0
}
if ($RemoveRunnerRegistration -and -not $DryRun) {
  $principal = Test-HostGitHubLogin -Config $loaded.Config
  if (-not $principal.Ok) { throw 'The authenticated GitHub CLI principal does not match github.login' }
}

function Invoke-RemovalAction {
  param([string]$Description, [scriptblock]$Action)
  if ($DryRun) { Write-OperationLog "DRY-RUN $Description"; return }
  if ($PSCmdlet.ShouldProcess($Description, 'remove')) { & $Action }
}

foreach ($instance in $instances) {
  $entry = @($manifest.instances | Where-Object { $_.id -eq $instance.Id })
  if (-not $entry.Count) {
    Write-OperationLog "Instance $($instance.Id) is not present in the managed install manifest; nothing to uninstall."
    continue
  }
  $entry = $entry[0]
  Invoke-RemovalAction "stop and unregister task $($instance.TaskName)" {
    Stop-ManagedComponent -Operations $ops -InstanceId $entry.id -TaskName $entry.taskName | Out-Null
    $task = Get-ScheduledTask -TaskName $entry.taskName -ErrorAction SilentlyContinue
    if ($task) {
      Unregister-ScheduledTask -TaskName $entry.taskName -Confirm:$false
    }
    $entry.taskEnabled = $false
    Set-ManifestEntry -Manifest $manifest -Entry $entry
    Write-InstallManifest -Loaded $loaded -Manifest $manifest
  }
  if ($RemoveRunnerRegistration) {
    Invoke-RemovalAction "remove GitHub registration for $($instance.Id)" {
      if (Test-Path -LiteralPath (Join-Path $instance.RunnerRoot '.runner')) {
        $token = Get-RunnerToken -Instance $instance -GhExecutable $loaded.Config.ghExecutable -Purpose remove
        try {
          Push-Location $instance.RunnerRoot
          try { & (Join-Path $instance.RunnerRoot 'config.cmd') remove --unattended --token $token } finally { Pop-Location }
          if ($LASTEXITCODE -ne 0) { throw "GitHub runner removal failed for $($instance.Id)" }
        } finally { $token = $null }
      }
    }
  }
  if ($PurgeRuntime) {
    Invoke-RemovalAction "delete exact isolated runner directory $($instance.RunnerRoot)" {
      Assert-ManagedDirectoryForRemoval -Path $instance.RunnerRoot -Root $ops.installRoot
      if (Test-Path -LiteralPath $instance.RunnerRoot) { Remove-Item -LiteralPath $instance.RunnerRoot -Recurse -Force }
      Remove-ManifestEntry -Manifest $manifest -InstanceId $instance.Id
      Write-InstallManifest -Loaded $loaded -Manifest $manifest
    }
  }
}

if ($RemoveDshWebHost -and $manifest -and $manifest.dshWebManaged) {
  $taskName = Get-DshWebTaskName
  Invoke-RemovalAction "stop and unregister task $taskName" {
    Stop-ManagedComponent -Operations $ops -InstanceId 'dsh-web' -TaskName $taskName | Out-Null
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    $manifest.dshWebManaged = $false
    Write-InstallManifest -Loaded $loaded -Manifest $manifest
  }
}
if ($PurgeRuntime -and @($manifest.instances).Count -eq 0 -and -not $manifest.dshWebManaged -and $manifest.psobject.Properties.Name -contains 'operationsRuntime' -and $manifest.operationsRuntime) {
  Invoke-RemovalAction "delete unreferenced operations runtime snapshot $($manifest.operationsRuntime.root)" {
    Remove-OperationsRuntimeSnapshot -Snapshot $manifest.operationsRuntime -InstallRoot $manifest.installRoot
    $manifest.operationsRuntime = $null
    Write-InstallManifest -Loaded $loaded -Manifest $manifest
  }
}
Write-OperationLog "Uninstall completed for $($instances.Count) runner instance(s). Repository variables, logs, work directories, and the machine-local configuration were retained."
