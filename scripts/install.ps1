[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$Configuration,
  [ValidateSet('change', 'review', 'maintenance')][string[]]$Roles = @('change', 'review', 'maintenance'),
  [string[]]$Repositories,
  [switch]$NoStart,
  [switch]$Migrate,
  [switch]$ConfirmMigration,
  [string]$TargetPlatform,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $repoRoot 'ops\Automation.Operations.psm1') -Force
if ($ConfirmMigration -and -not $Migrate) { throw '-ConfirmMigration requires -Migrate' }
if ($Migrate -and -not $DryRun -and -not $ConfirmMigration) { throw 'A state migration requires -ConfirmMigration. Run -Migrate -DryRun first.' }
$migrationRepositories = @($Repositories | Where-Object { $_ })
$migrationRoles = @($Roles | Select-Object -Unique)
if ($Migrate -and ($migrationRepositories.Count -or $migrationRoles.Count -ne 3)) { throw '-Migrate must reconcile the full configured topology; do not combine it with -Repositories or a partial -Roles selection.' }
$loaded = Read-OperationsConfig -Configuration $Configuration -AllowExamplePlaceholders:$DryRun -TargetPlatform $TargetPlatform
$ops = $loaded.Operations
$runtimeSourceRoot = Join-Path $repoRoot 'ops'
$runtimeSnapshot = Get-OperationsRuntimeSnapshotDefinition -SourceRoot $runtimeSourceRoot -InstallRoot $ops.installRoot
$plan = New-InstallationPlan -Loaded $loaded -Platform $TargetPlatform -Roles $Roles -Repositories $Repositories -NoStart:$NoStart -RuntimeSnapshot $runtimeSnapshot
$instances = @($plan.runnerInstances)
if (-not $instances.Count) { throw 'The requested role/repository selection produced no runner instances' }
$hostPlatform = Resolve-InstallationPlatform
if (-not $DryRun -and $plan.platform.id -ne $hostPlatform.id) { throw "TargetPlatform $($plan.platform.id) does not match this host ($($hostPlatform.id))" }
if (-not $DryRun -and $hostPlatform.id -ne 'windows-x64') { throw 'Installation execution is implemented only for windows-x64; use -DryRun to inspect the portable plan' }
Write-Output "AUTOMATION_INSTALLATION_PLAN_JSON=$(ConvertTo-InstallationPlanJson -Plan $plan)"
if ($DryRun -and $plan.platform.id -ne 'windows-x64') {
  Write-OperationLog "DRY-RUN planning only for $($plan.platform.id); no host or GitHub state was inspected"
  exit 0
}

function Invoke-InstallAction {
  param([string]$Description, [scriptblock]$Action)
  if ($DryRun) { Write-OperationLog "DRY-RUN $Description"; return }
  if ($PSCmdlet.ShouldProcess($Description, 'install')) { & $Action }
}

function Get-RunnerArchive {
  $archivePath = Join-Path $ops.installRoot 'downloads\actions-runner.zip'
  if ($DryRun) { Write-OperationLog "DRY-RUN download and SHA-256 verify $($plan.runnerPackage.downloadUri)"; return $archivePath }
  Initialize-PrivateDirectory -Path (Split-Path -Parent $archivePath)
  if (-not (Test-Path -LiteralPath $archivePath)) {
    Write-OperationLog 'Downloading the pinned GitHub Actions runner archive'
    Invoke-WebRequest -Uri $plan.runnerPackage.downloadUri -OutFile $archivePath -UseBasicParsing
  }
  $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
  if (-not $actual.Equals($plan.runnerPackage.sha256, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runner archive SHA-256 mismatch; refusing to extract it' }
  return $archivePath
}

function Register-InstanceTask {
  param([Parameter(Mandatory)]$Instance)
  $processHost = Join-Path $runtimeSnapshot.root 'windows-role-process-host.ps1'
  $supervisor = Join-Path $runtimeSnapshot.root 'runner-supervisor.ps1'
  $targetArguments = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $supervisor, '-Configuration', $loaded.Path, '-InstanceId', $Instance.Id))))
  $arguments = "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$processHost`" -TargetExecutable `"$pwshExecutable`" -TargetArgumentsBase64 $targetArguments -WorkingDirectory `"$($runtimeSnapshot.root)`""
  $action = New-ScheduledTaskAction -Execute $pwshExecutable -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -Hidden -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $Instance.TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Register-DshWebTask {
  $processHost = Join-Path $runtimeSnapshot.root 'windows-role-process-host.ps1'
  $supervisor = Join-Path $runtimeSnapshot.root 'dsh-web-host-supervisor.ps1'
  $targetArguments = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $supervisor, '-Configuration', $loaded.Path))))
  $arguments = "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$processHost`" -TargetExecutable `"$pwshExecutable`" -TargetArgumentsBase64 $targetArguments -WorkingDirectory `"$($runtimeSnapshot.root)`""
  $action = New-ScheduledTaskAction -Execute $pwshExecutable -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -Hidden -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName (Get-DshWebTaskName) -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Remove-InstalledInstance {
  param([Parameter(Mandatory)]$Entry)
  Stop-ManagedComponent -Operations $ops -InstanceId $Entry.id -TaskName $Entry.taskName | Out-Null
  if (Test-Path -LiteralPath (Join-Path $Entry.runnerRoot '.runner')) {
    $configCommand = Join-Path $Entry.runnerRoot 'config.cmd'
    if (-not (Test-Path -LiteralPath $configCommand -PathType Leaf)) { throw "Registered runner is missing config.cmd: $($Entry.id)" }
    $token = Get-RunnerToken -Instance $Entry -GhExecutable $loaded.Config.ghExecutable -Purpose remove
    try {
      Push-Location $Entry.runnerRoot
      try { & $configCommand remove --unattended --token $token 1>$null 2>$null } finally { Pop-Location }
      if ($LASTEXITCODE -ne 0) { throw "GitHub runner removal failed during migration for $($Entry.id)" }
    } finally { $token = $null }
  }
  $task = Get-ScheduledTask -TaskName $Entry.taskName -ErrorAction SilentlyContinue
  if ($task) { Unregister-ScheduledTask -TaskName $Entry.taskName -Confirm:$false }
  Assert-ManagedDirectoryForRemoval -Path $Entry.runnerRoot -Root $manifest.installRoot
  if (Test-Path -LiteralPath $Entry.runnerRoot) { Remove-Item -LiteralPath $Entry.runnerRoot -Recurse -Force }
}

function Assert-NoTaskReferencesRuntime {
  param([Parameter(Mandatory)][string]$RuntimeRoot)
  $references = @()
  foreach ($task in @(Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    foreach ($action in @($task.Actions)) {
      $arguments = $action.PSObject.Properties['Arguments']
      if ($arguments -and ([string]$arguments.Value).IndexOf($RuntimeRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $references += $task
        break
      }
    }
  }
  if ($references.Count) { throw "Refusing to remove operations runtime still referenced by Scheduled Task: $($references[0].TaskName)" }
}

function Get-DshCliInvocation {
  $hostConfig = $ops.dshWebHost
  $arguments = @($hostConfig.arguments)
  $executableName = [IO.Path]::GetFileName([string]$hostConfig.executable)
  if (($executableName -match '^(?i:node(?:\.exe)?)$') -and ($arguments.Count -ge 2) -and ($arguments[1] -eq 'web') -and ([IO.Path]::GetExtension([string]$arguments[0]) -in @('.js', '.mjs', '.cjs'))) {
    return [pscustomobject]@{ Executable = [string]$hostConfig.executable; Prefix = @([string]$arguments[0]) }
  }
  if ($executableName -match '^(?i:dsh(?:\.exe|\.cmd)?)$' -and $arguments.Count -ge 1 -and $arguments[0] -eq 'web') {
    return [pscustomobject]@{ Executable = [string]$hostConfig.executable; Prefix = @() }
  }
  throw 'dshWebHost must launch either node <dsh-bin> web or dsh web so the installer can use the same CLI'
}

function Install-DshWorkPlugin {
  $pluginRoot = Join-Path $repoRoot 'dsh-plugin'
  $pluginManifest = Join-Path $pluginRoot 'package.json'
  if (-not (Test-Path -LiteralPath $pluginManifest -PathType Leaf)) { throw "DSH work plugin package is missing: $pluginManifest" }
  $packageRoot = Join-Path $ops.stateRoot 'packages'
  Initialize-PrivateDirectory -Path $packageRoot
  $staging = Join-Path $packageRoot ".dsh-plugin-pack.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    Initialize-PrivateDirectory -Path $staging
    Push-Location $pluginRoot
    try { & pnpm.cmd pack --pack-destination $staging 1>$null } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Could not pack the DSH work plugin' }
    $archives = @(Get-ChildItem -LiteralPath $staging -Filter '*.tgz' -File)
    if ($archives.Count -ne 1 -or $archives[0].Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'DSH work plugin pack did not produce one regular tarball' }
    $hash = (Get-FileHash -LiteralPath $archives[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $archive = Join-Path $packageRoot "dsh-github-work-$hash.tgz"
    Assert-PathInside -Child $archive -Parent $packageRoot -Name 'DSH work plugin archive'
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { Move-Item -LiteralPath $archives[0].FullName -Destination $archive }

    $cli = Get-DshCliInvocation
    & $cli.Executable @($cli.Prefix) plugin --profile web add $archive 1>$null
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the DSH work plugin into the web profile' }
    $dump = (& $cli.Executable @($cli.Prefix) --profile web --dump-config 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $dump -notmatch '(?m)^- id: github-work-skills\r?$' -or $dump -notmatch '(?m)^\s+name: dsh-github-work\r?$') {
      throw 'The DSH web profile does not contain the installed GitHub work plugin row'
    }
  } finally {
    if (Test-Path -LiteralPath $staging) {
      Assert-ManagedDirectoryForRemoval -Path $staging -Root $packageRoot
      Remove-Item -LiteralPath $staging -Recurse -Force
    }
  }
}

if ($ops.dshWebHost.enabled -and -not $DryRun -and -not (Test-Path -LiteralPath $ops.dshWebHost.executable -PathType Leaf)) { throw "DSH Web Host executable does not exist: $($ops.dshWebHost.executable)" }
foreach ($required in @('pwsh.exe', $loaded.Config.ghExecutable, $loaded.Config.gitExecutable)) {
  if (-not (Get-Command $required -ErrorAction SilentlyContinue)) { throw "Required executable is unavailable: $required" }
}
$pwshExecutable = (Get-Command pwsh.exe -ErrorAction Stop).Source
if (-not [IO.Path]::IsPathFullyQualified($pwshExecutable) -or -not (Test-Path -LiteralPath $pwshExecutable -PathType Leaf)) { throw 'pwsh.exe did not resolve to an absolute executable path' }
if ($ops.dshWebHost.enabled -and -not (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) { throw 'Required executable is unavailable: pnpm.cmd' }
if (-not $DryRun) {
  $principal = Test-HostGitHubLogin -Config $loaded.Config
  if (-not $principal.Ok) { throw 'The authenticated GitHub CLI principal does not match github.login' }
}

$manifest = Read-InstallManifest -Loaded $loaded
$managedState = Get-ManagedArtifactState -Loaded $loaded -Manifest $manifest -RuntimeSnapshot $runtimeSnapshot
$unexpectedIds = @($managedState.UnexpectedTaskIds + $managedState.UnexpectedRunnerIds + $managedState.UnexpectedProcessRecordIds | Select-Object -Unique)
$unexpectedRuntimeIds = @($managedState.UnexpectedRuntimeSnapshotIds)
$desiredIds = @($managedState.Desired | ForEach-Object { $_.Id })
if ($unexpectedIds.Count -and -not $Migrate) {
  throw "Untracked managed artifacts were found: $($unexpectedIds -join ', '). Re-run with -Migrate -DryRun; do not change or delete them manually."
}
if (@($unexpectedIds | Where-Object { $_ -notin $desiredIds }).Count) {
  throw "Untracked artifacts do not match the desired configuration: $($unexpectedIds -join ', '). Restore a configuration that selects those instances, adopt it with -Migrate, then migrate to this configuration."
}
if ($unexpectedRuntimeIds.Count -and -not $Migrate) { throw "Untracked operations runtime snapshots were found: $($unexpectedRuntimeIds -join ', '). Re-run with -Migrate -DryRun." }
$removedEntries = if ($managedState.RunnerPackageChanged) { @($manifest.instances) } else { @($managedState.StaleEntries + $managedState.ChangedEntries | Sort-Object id -Unique) }
$removedEntries = @($removedEntries)
$requiresMigration = $managedState.ScopeChanged -or $managedState.RunnerPackageChanged -or $managedState.RuntimeSnapshotChanged -or $managedState.RuntimeSnapshotInvalid -or $removedEntries.Count -or $unexpectedIds.Count -or $unexpectedRuntimeIds.Count -or $managedState.DshWebUnexpected -or $managedState.DshWebStale
if ($requiresMigration -and -not $Migrate) {
  $oldIds = @($removedEntries | ForEach-Object { $_.id })
  throw "Installed state differs from desired configuration: $($oldIds -join ', '). Re-run with -Migrate -DryRun, then -Migrate -ConfirmMigration."
}
if (-not $manifest) { $manifest = New-InstallManifest -Loaded $loaded -RuntimeSnapshot $runtimeSnapshot }

foreach ($repositoryPlan in @($plan.repositories)) {
  $ciWorkflowsJson = $repositoryPlan.variables.DSH_AUTOMATION_CI_WORKFLOWS
  $requiredChecksJson = $repositoryPlan.variables.DSH_AUTOMATION_REQUIRED_CHECKS
  $protectionMapping = [pscustomobject]@{
    repository = $repositoryPlan.repository
    requiredChecks = @($repositoryPlan.branchProtection.requiredChecks | ForEach-Object { $_.name } | Where-Object { $_ -ne 'agent/review' })
  }
  Invoke-InstallAction "set CI workflow and required-check variables for $($repositoryPlan.repository)" {
    & $loaded.Config.ghExecutable variable set DSH_AUTOMATION_CI_WORKFLOWS --repo $repositoryPlan.repository --body $ciWorkflowsJson 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Could not set DSH_AUTOMATION_CI_WORKFLOWS for $($repositoryPlan.repository)" }
    & $loaded.Config.ghExecutable variable set DSH_AUTOMATION_REQUIRED_CHECKS --repo $repositoryPlan.repository --body $requiredChecksJson 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Could not set DSH_AUTOMATION_REQUIRED_CHECKS for $($repositoryPlan.repository)" }
  }
  Invoke-InstallAction "ensure strict app-bound required checks, bootstrapping an unprotected default branch of $($repositoryPlan.repository)" {
    Set-RepositoryRequiredStatusChecks -Mapping $protectionMapping -GhExecutable $loaded.Config.ghExecutable
  }
}

if ('maintenance' -in @($Roles)) {
  $maintenanceInstances = @($instances | Where-Object role -eq 'maintenance')
  if ($maintenanceInstances.Count -ne 1) { throw 'Exactly one Controller maintenance instance is required.' }
  Invoke-InstallAction "set exact maintenance replica variable for $($ops.controller.repository)" {
    & $loaded.Config.ghExecutable variable set AGENT_AUTOMATION_MAINTENANCE_REPLICA_ID --repo $ops.controller.repository --body $maintenanceInstances[0].id 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Could not set AGENT_AUTOMATION_MAINTENANCE_REPLICA_ID for the Controller repository' }
  }
}

if ($Migrate) {
  $runtimeNeedsMigration = $managedState.RuntimeSnapshotChanged -or $managedState.RuntimeSnapshotInvalid
  if ($runtimeNeedsMigration -and $manifest) {
    $removedIds = @($removedEntries | ForEach-Object { $_.id })
    foreach ($entry in @($manifest.instances | Where-Object { $_.id -notin $removedIds })) {
      if ($DryRun) {
        Write-OperationLog "DRY-RUN stop $($entry.id) and detach its task from the installed operations runtime"
      } else {
        Stop-ManagedComponent -Operations $ops -InstanceId $entry.id -TaskName $entry.taskName | Out-Null
        $task = Get-ScheduledTask -TaskName $entry.taskName -ErrorAction SilentlyContinue
        if ($task) { Unregister-ScheduledTask -TaskName $entry.taskName -Confirm:$false }
        $entry.taskEnabled = $false
        Set-ManifestEntry -Manifest $manifest -Entry $entry
        Write-InstallManifest -Loaded $loaded -Manifest $manifest
      }
    }
    if ($manifest.dshWebManaged) {
      if ($DryRun) {
        Write-OperationLog 'DRY-RUN stop DSH Web Host and detach its task from the installed operations runtime'
      } else {
        Stop-ManagedComponent -Operations $ops -InstanceId 'dsh-web' -TaskName (Get-DshWebTaskName) | Out-Null
        $task = Get-ScheduledTask -TaskName (Get-DshWebTaskName) -ErrorAction SilentlyContinue
        if ($task) { Unregister-ScheduledTask -TaskName (Get-DshWebTaskName) -Confirm:$false }
        $manifest.dshWebManaged = $false
        Write-InstallManifest -Loaded $loaded -Manifest $manifest
      }
    }
  }
  if ($managedState.DshWebStale) {
    if ($DryRun) {
      Write-OperationLog 'DRY-RUN stop and unregister obsolete managed DSH Web Host task'
    } else {
      Stop-ManagedComponent -Operations $ops -InstanceId 'dsh-web' -TaskName (Get-DshWebTaskName) | Out-Null
      $dshTask = Get-ScheduledTask -TaskName (Get-DshWebTaskName) -ErrorAction SilentlyContinue
      if ($dshTask) { Unregister-ScheduledTask -TaskName (Get-DshWebTaskName) -Confirm:$false }
      $manifest.dshWebManaged = $false
      Write-InstallManifest -Loaded $loaded -Manifest $manifest
    }
  }
  foreach ($entry in $removedEntries) {
    if ($DryRun) {
      Write-OperationLog "DRY-RUN stop, unregister, and purge obsolete managed instance $($entry.id)"
    } else {
      Remove-InstalledInstance -Entry $entry
      Remove-ManifestEntry -Manifest $manifest -InstanceId $entry.id
      Write-InstallManifest -Loaded $loaded -Manifest $manifest
    }
  }
  foreach ($id in $unexpectedIds) {
    $wanted = @($managedState.Desired | Where-Object { $_.Id -eq $id })[0]
    $task = Get-ScheduledTask -TaskName $wanted.TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq 'Running' -and -not (Read-OwnedProcessRecord -Operations $ops -InstanceId $id)) {
      throw "Cannot adopt running instance $id without an owned process record. Stop that legacy process explicitly before retrying migration."
    }
    if ($DryRun) {
      Write-OperationLog "DRY-RUN stop and adopt exact desired managed instance $id into the install manifest"
    } else {
      Stop-ManagedComponent -Operations $ops -InstanceId $id -TaskName $wanted.TaskName | Out-Null
      if ($task) { Unregister-ScheduledTask -TaskName $wanted.TaskName -Confirm:$false }
      Set-ManifestEntry -Manifest $manifest -Entry (ConvertTo-ManifestEntry -Instance $wanted -TaskEnabled $false)
      Write-InstallManifest -Loaded $loaded -Manifest $manifest
    }
  }
  if ($managedState.DshWebUnexpected) {
    $dshTask = Get-ScheduledTask -TaskName (Get-DshWebTaskName) -ErrorAction SilentlyContinue
    if ($dshTask -and $dshTask.State -eq 'Running' -and -not (Read-OwnedProcessRecord -Operations $ops -InstanceId 'dsh-web')) {
      throw 'Cannot adopt a running DSH Web Host task without an owned process record. Stop that legacy process explicitly before retrying migration.'
    }
    if ($DryRun -and $ops.dshWebHost.enabled) {
      Write-OperationLog 'DRY-RUN adopt exact desired DSH Web Host task into the install manifest'
    } elseif ($DryRun) {
      Write-OperationLog 'DRY-RUN stop and unregister untracked disabled DSH Web Host task'
    } elseif ($ops.dshWebHost.enabled) {
      Stop-ManagedComponent -Operations $ops -InstanceId 'dsh-web' -TaskName (Get-DshWebTaskName) | Out-Null
      if ($dshTask) { Unregister-ScheduledTask -TaskName (Get-DshWebTaskName) -Confirm:$false }
      $manifest.dshWebManaged = $true
      Write-InstallManifest -Loaded $loaded -Manifest $manifest
    } else {
      Stop-ManagedComponent -Operations $ops -InstanceId 'dsh-web' -TaskName (Get-DshWebTaskName) | Out-Null
      if ($dshTask) { Unregister-ScheduledTask -TaskName (Get-DshWebTaskName) -Confirm:$false }
    }
  }
  $snapshotsToRemove = @()
  if ($runtimeNeedsMigration -and $manifest.psobject.Properties.Name -contains 'operationsRuntime' -and $manifest.operationsRuntime) { $snapshotsToRemove += [pscustomobject]@{ snapshot = $manifest.operationsRuntime; installRoot = $manifest.installRoot } }
  foreach ($id in $unexpectedRuntimeIds) { $snapshotsToRemove += [pscustomobject]@{ snapshot = [pscustomobject]@{ id = $id; root = Join-Path $ops.installRoot (Join-Path 'operations-runtime' $id) }; installRoot = $ops.installRoot } }
  foreach ($removal in @($snapshotsToRemove | Sort-Object { $_.snapshot.root } -Unique)) {
    $snapshot = $removal.snapshot
    if ($DryRun) {
      Write-OperationLog "DRY-RUN remove exact unreferenced operations runtime snapshot $($snapshot.root)"
    } else {
      Assert-NoTaskReferencesRuntime -RuntimeRoot $snapshot.root
      Remove-OperationsRuntimeSnapshot -Snapshot $snapshot -InstallRoot $removal.installRoot
    }
  }
  if (-not $DryRun) {
    $manifest.registrationScope = $ops.controller.registrationScope
    $manifest.runnerVersion = $ops.runner.version
    $manifest.runnerSha256 = $ops.runner.sha256
    $manifest.configPath = $loaded.Path
    $manifest.installRoot = $ops.installRoot
    $manifest.logsRoot = $ops.logsRoot
    Write-InstallManifest -Loaded $loaded -Manifest $manifest
  }
}

Invoke-InstallAction 'create private runtime, state, logs, and fault directories' {
  foreach ($path in @($plan.paths)) { Initialize-PrivateDirectory -Path $path.path }
}
Invoke-InstallAction "deploy immutable operations runtime snapshot $($runtimeSnapshot.id)" {
  Install-OperationsRuntimeSnapshot -Snapshot $runtimeSnapshot -SourceRoot $runtimeSourceRoot
  if ($manifest.psobject.Properties.Name -contains 'operationsRuntime') { $manifest.operationsRuntime = $runtimeSnapshot } else { $manifest | Add-Member -NotePropertyName operationsRuntime -NotePropertyValue $runtimeSnapshot }
  Write-InstallManifest -Loaded $loaded -Manifest $manifest
}
if ($ops.dshWebHost.enabled) {
  if ($manifest -and [bool]$manifest.dshWebManaged) {
    Invoke-InstallAction 'stop the managed DSH Web Host before updating its plugin profile' {
      Stop-ManagedComponent -Operations $ops -InstanceId 'dsh-web' -TaskName (Get-DshWebTaskName) | Out-Null
    }
  }
  Invoke-InstallAction 'pack and install the DSH GitHub work plugin into the web profile' {
    Install-DshWorkPlugin
  }
}
Invoke-InstallAction 'remove obsolete local controller supervisor task' {
  $legacy = Get-ScheduledTask -TaskName 'DSH-Agent-Automation-controller' -ErrorAction SilentlyContinue
  if ($legacy) {
    if ($legacy.State -eq 'Running') { throw 'Obsolete controller task is running without an owned PID record; stop its process tree explicitly before installation' }
    Unregister-ScheduledTask -TaskName 'DSH-Agent-Automation-controller' -Confirm:$false
  }
}
$archive = Get-RunnerArchive

foreach ($instance in $instances) {
  if (-not $DryRun) {
    Set-ManifestEntry -Manifest $manifest -Entry (ConvertTo-ManifestEntry -Instance $instance -TaskEnabled $false)
    Write-InstallManifest -Loaded $loaded -Manifest $manifest
  }
  Invoke-InstallAction "install isolated runner instance $($instance.Id) at $($instance.RunnerRoot)" {
    Initialize-PrivateDirectory -Path $instance.RunnerRoot
    Initialize-PrivateDirectory -Path $instance.WorkDirectory
    if (-not (Test-Path -LiteralPath (Join-Path $instance.RunnerRoot '.runner'))) {
      Expand-Archive -LiteralPath $archive -DestinationPath $instance.RunnerRoot -Force
      $token = Get-RunnerToken -Instance $instance -GhExecutable $loaded.Config.ghExecutable
      try {
        $registrationUrl = Get-RegistrationUrl -Instance $instance
        Push-Location $instance.RunnerRoot
        try {
          & (Join-Path $instance.RunnerRoot 'config.cmd') --unattended --replace --url $registrationUrl --token $token --name $instance.RunnerName --labels ($instance.Labels -join ',') --work $instance.WorkDirectory
        } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw "GitHub runner configuration failed for $($instance.Id)" }
      } finally { $token = $null }
    }
    Initialize-PrivateDirectory -Path $instance.RunnerRoot
  }
  Invoke-InstallAction "register hidden supervisor task $($instance.TaskName)" {
    Register-InstanceTask -Instance $instance
    Set-ManifestEntry -Manifest $manifest -Entry (ConvertTo-ManifestEntry -Instance $instance -TaskEnabled $true)
    Write-InstallManifest -Loaded $loaded -Manifest $manifest
  }
}

if ($ops.dshWebHost.enabled) {
  Invoke-InstallAction 'register hidden DSH Web Host supervisor task' {
    Register-DshWebTask
    $manifest.dshWebManaged = $true
    Write-InstallManifest -Loaded $loaded -Manifest $manifest
  }
}
if (-not $NoStart) {
  foreach ($instance in $instances) { Invoke-InstallAction "start supervisor $($instance.TaskName)" { Start-ManagedComponent -Operations $ops -InstanceId $instance.Id -TaskName $instance.TaskName | Out-Null } }
  if ($ops.dshWebHost.enabled) { Invoke-InstallAction 'start DSH Web Host supervisor' { Start-ManagedComponent -Operations $ops -InstanceId 'dsh-web' -TaskName (Get-DshWebTaskName) | Out-Null } }
}
Write-OperationLog "Install completed for $($instances.Count) runner instance(s). Use scripts/doctor.ps1 -Online for post-install health checks."
