[CmdletBinding()]
param(
  [string]$Configuration,
  [switch]$DryRun,
  [string]$TargetPlatform,
  [switch]$Online,
  [switch]$Explain,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $repoRoot 'ops\Automation.Operations.psm1') -Force
if ($SelfTest) {
  $results = Invoke-OperationsSelfTest
  $results | Format-Table -AutoSize
  if (@($results | Where-Object { -not $_.Passed }).Count) { exit 1 }
  Write-Output 'Operations self-test passed without creating, deleting, registering, starting, stopping, or contacting GitHub.'
  exit 0
}
if ([string]::IsNullOrWhiteSpace($Configuration)) { throw 'Configuration is required unless -SelfTest is used' }
$loaded = Read-OperationsConfig -Configuration $Configuration -AllowExamplePlaceholders:$DryRun -TargetPlatform $TargetPlatform
$ops = $loaded.Operations
$instances = @(Get-RunnerInstances -Loaded $loaded)
if ($Explain) {
  if (-not $DryRun) {
    $activeLogin = & $loaded.Config.ghExecutable api user --jq '.login' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $activeLogin.Trim().Equals($loaded.Config.github.login, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Active GitHub CLI identity does not match github.login'
    }
  }
  $resolver = if ($DryRun) { $null } else {
    {
      param($Repository, $Name)
      $value = & $loaded.Config.ghExecutable variable get $Name --repo $Repository --json value --jq '.value' 2>$null
      if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ Found = $false; Value = $null } }
      return [pscustomobject]@{ Found = $true; Value = $value.Trim() }
    }
  }
  $explanation = @(
    Get-ConfigurationExplanation -Loaded $loaded -RepositoryVariableResolver $resolver
    Get-ReviewWorkspaceExplanation -Instances $instances -StateRoot $ops.stateRoot -GitExecutable $loaded.Config.gitExecutable -DryRun:$DryRun
  ) | Sort-Object Path
  $explanation | Format-Table Path, Value, SourceType, Source, Line, Override, Status -Wrap
  Write-Output "AUTOMATION_CONFIGURATION_EXPLAIN_JSON=$(ConvertTo-Json -InputObject $explanation -Depth 8 -Compress)"
  if (-not $DryRun -and @($explanation | Where-Object Status -in @('missing', 'invalid', 'mismatch')).Count) { exit 1 }
  exit 0
}
$runtimeSnapshot = Get-OperationsRuntimeSnapshotDefinition -SourceRoot (Join-Path $repoRoot 'ops') -InstallRoot $ops.installRoot
if ($DryRun) {
  $plan = New-InstallationPlan -Loaded $loaded -Platform $TargetPlatform -RuntimeSnapshot $runtimeSnapshot
  Write-Output "Configuration dry-run passed: $($ops.controller.registrationScope) topology with $(@($loaded.Config.repositories).Count) repository mapping(s) and $(@($plan.runnerInstances).Count) runner instance(s)."
  foreach ($instance in @($plan.runnerInstances)) {
    $scope = if ($instance.repository) { $instance.repository } else { $instance.registrationOwner }
    Write-Output "DRY-RUN instance $($instance.id): $scope -> $($instance.serviceName)"
  }
  foreach ($mapping in @($ops.repositoryMappings)) {
    Write-Output "DRY-RUN protection $($mapping.repository): strict; $(@($mapping.requiredChecks) -join ', ') and agent/review bound to GitHub Actions app id 15368"
  }
  Write-Output "DRY-RUN operations runtime snapshot: $($runtimeSnapshot.id) -> $($runtimeSnapshot.root)"
  Write-Output "AUTOMATION_INSTALLATION_PLAN_JSON=$(ConvertTo-InstallationPlanJson -Plan $plan)"
  Write-Output 'Doctor dry-run completed: no network call, task change, process change, registration, creation, or deletion was requested.'
  exit 0
}

$findings = [Collections.Generic.List[object]]::new()
function Add-Finding {
  param([string]$Name, [bool]$Ok, [string]$Detail)
  $findings.Add([pscustomobject]@{ Check = $Name; Status = if ($Ok) { 'PASS' } else { 'FAIL' }; Detail = $Detail })
}

Add-Finding 'configuration' $true "$($ops.controller.registrationScope); $($instances.Count) runner instance(s)"
$manifest = $null
try {
  $manifest = Read-InstallManifest -Loaded $loaded
  Add-Finding 'install manifest' ($null -ne $manifest) $(if ($manifest) { 'valid schemaVersion 1 manifest' } else { 'not installed' })
} catch {
  Add-Finding 'install manifest' $false $_.Exception.Message
}
$managedState = $null
if ($manifest) {
  try {
    $managedState = Get-ManagedArtifactState -Loaded $loaded -Manifest $manifest -RuntimeSnapshot $runtimeSnapshot
    Add-Finding 'manifest registration scope' (-not $managedState.ScopeChanged) $(if ($managedState.ScopeChanged) { 'installed scope differs; explicit migration required' } else { 'matches desired configuration' })
    Add-Finding 'manifest runner package' (-not $managedState.RunnerPackageChanged) $(if ($managedState.RunnerPackageChanged) { 'installed runner version/hash differs; explicit migration required' } else { 'matches desired configuration' })
    Add-Finding 'operations runtime desired snapshot' (-not $managedState.RuntimeSnapshotChanged) $(if ($managedState.RuntimeSnapshotChanged) { 'checkout runtime differs; explicit migration required' } else { "matches $($runtimeSnapshot.id)" })
    Add-Finding 'operations runtime installed hash' (-not $managedState.RuntimeSnapshotInvalid) $(if ($managedState.RuntimeSnapshotInvalid) { 'missing or hash/path verification failed' } else { 'verified' })
    Add-Finding 'obsolete manifest instances' ($managedState.StaleEntries.Count -eq 0) $(if ($managedState.StaleEntries.Count) { @($managedState.StaleEntries.id) -join ', ' } else { 'none' })
    Add-Finding 'changed manifest instances' ($managedState.ChangedEntries.Count -eq 0) $(if ($managedState.ChangedEntries.Count) { @($managedState.ChangedEntries.id) -join ', ' } else { 'none' })
    Add-Finding 'missing manifest instances' ($managedState.MissingEntries.Count -eq 0) $(if ($managedState.MissingEntries.Count) { @($managedState.MissingEntries.Id) -join ', ' } else { 'none' })
    $unexpected = @($managedState.UnexpectedTaskIds + $managedState.UnexpectedRunnerIds + $managedState.UnexpectedProcessRecordIds + $managedState.UnexpectedRuntimeSnapshotIds | Select-Object -Unique)
    Add-Finding 'untracked managed artifacts' ($unexpected.Count -eq 0) $(if ($unexpected.Count) { $unexpected -join ', ' } else { 'none' })
    $dshReconciled = -not $managedState.DshWebUnexpected -and -not $managedState.DshWebStale -and -not $managedState.DshWebMissing -and -not $managedState.DshWebManifestMissing
    Add-Finding 'DSH Web Host manifest' $dshReconciled $(if ($dshReconciled) { 'matches desired configuration' } else { 'desired, manifest, and Scheduled Task state differ' })
  } catch {
    Add-Finding 'manifest reconciliation' $false $_.Exception.Message
  }
} else {
  try {
    $managedState = Get-ManagedArtifactState -Loaded $loaded -Manifest $null -RuntimeSnapshot $runtimeSnapshot
    $unexpected = @($managedState.UnexpectedTaskIds + $managedState.UnexpectedRunnerIds + $managedState.UnexpectedProcessRecordIds + $managedState.UnexpectedRuntimeSnapshotIds | Select-Object -Unique)
    if ($managedState.DshWebUnexpected) { $unexpected += 'dsh-web' }
    Add-Finding 'untracked managed artifacts' ($unexpected.Count -eq 0) $(if ($unexpected.Count) { $unexpected -join ', ' } else { 'none' })
  } catch {
    Add-Finding 'manifest reconciliation' $false $_.Exception.Message
  }
  try {
    $maintenanceInstances = @($instances | Where-Object Role -eq 'maintenance')
    $actualMaintenanceReplica = & $loaded.Config.ghExecutable variable get AGENT_AUTOMATION_MAINTENANCE_REPLICA_ID --repo $ops.controller.repository --json value --jq '.value' 2>$null
    $maintenanceReplicaMatches = $maintenanceInstances.Count -eq 1 -and $LASTEXITCODE -eq 0 -and $actualMaintenanceReplica.Trim().Equals($maintenanceInstances[0].Id, [StringComparison]::Ordinal)
    Add-Finding 'Controller maintenance replica variable' $maintenanceReplicaMatches $(if ($maintenanceReplicaMatches) { 'matches exact installed replica' } else { 'missing or mismatched' })
  } catch { Add-Finding 'Controller maintenance replica variable' $false 'query failed' }
}
foreach ($path in @($ops.installRoot, $ops.stateRoot, $ops.logsRoot)) {
  $exists = Test-Path -LiteralPath $path
  $detail = if ($exists) { 'exists' } else { 'not created (run install)' }
  Add-Finding "path $path" $exists $detail
}
foreach ($instance in $instances) {
  $acl = Test-PrivateDirectoryAcl -Path $instance.RunnerRoot
  Add-Finding "$($instance.Id) directory" $acl.Ok $acl.Detail
  $entry = if ($manifest) { @($manifest.instances | Where-Object { $_.id -eq $instance.Id }) } else { @() }
  $task = Get-ScheduledTask -TaskName $instance.TaskName -ErrorAction SilentlyContinue
  $owned = Test-OwnedProcessRecord -Operations $ops -InstanceId $instance.Id
  if ($entry.Count -eq 1 -and -not [bool]$entry[0].taskEnabled) {
    Add-Finding "$($instance.Id) heartbeat" $true 'not required while intentionally offline'
    $taskOk = $null -eq $task -and $owned.Ok -and -not $owned.Running
    Add-Finding "$($instance.Id) task/process" $taskOk $(if ($taskOk) { 'intentionally uninstalled; runtime retained' } else { 'manifest disables task but a task/process remains or PID state is invalid' })
  } else {
    $heartbeat = Test-OperationHeartbeat -Operations $ops -InstanceId $instance.Id
    Add-Finding "$($instance.Id) heartbeat" $heartbeat.Ok $heartbeat.Detail
    $taskOk = $null -ne $task -and $task.State -eq 'Running' -and $owned.Ok -and $owned.Running
    Add-Finding "$($instance.Id) task/process" $taskOk $(if ($task) { "$($task.State); $($owned.Detail)" } else { 'not installed' })
  }
  if ($task) {
    $expectedRuntimeScript = if ($manifest -and $manifest.psobject.Properties.Name -contains 'operationsRuntime' -and $manifest.operationsRuntime) { Join-Path $manifest.operationsRuntime.root 'runner-supervisor.ps1' } else { '' }
    $taskRuntime = if ($expectedRuntimeScript) { Test-ScheduledTaskRuntimePath -Task $task -ExpectedScript $expectedRuntimeScript } else { [pscustomobject]@{ Ok = $false; Detail = 'manifest has no operations runtime snapshot' } }
    Add-Finding "$($instance.Id) task runtime" $taskRuntime.Ok $taskRuntime.Detail
  }
  if ($instance.Role -eq 'review') {
    try {
      $workspaceAcl = Test-PrivateDirectoryAcl -Path $instance.WorkspaceSlot
      Add-Finding "$($instance.Id) review workspace" $workspaceAcl.Ok $workspaceAcl.Detail
      $lease = Get-ReviewWorkspaceLeaseState -Instance $instance -StateRoot $ops.stateRoot
      Add-Finding "$($instance.Id) review workspace lease" (-not $lease.Reclaim) "$($lease.State): $($lease.Detail)"
    } catch {
      Add-Finding "$($instance.Id) review workspace" $false $_.Exception.Message
    }
  }
}
$legacy = Get-ScheduledTask -TaskName 'DSH-Agent-Automation-controller' -ErrorAction SilentlyContinue
$legacyDetail = if ($legacy) { 'run install to remove it' } else { 'absent' }
Add-Finding 'obsolete controller task absent' ($null -eq $legacy) $legacyDetail

if ($ops.dshWebHost.enabled) {
  $task = Get-ScheduledTask -TaskName (Get-DshWebTaskName) -ErrorAction SilentlyContinue
  $owned = Test-OwnedProcessRecord -Operations $ops -InstanceId 'dsh-web'
  $dshManaged = $manifest -and [bool]$manifest.dshWebManaged
  if ($dshManaged) {
    $heartbeat = Test-OperationHeartbeat -Operations $ops -InstanceId 'dsh-web'
    Add-Finding 'DSH Web Host heartbeat' $heartbeat.Ok $heartbeat.Detail
  } else {
    Add-Finding 'DSH Web Host heartbeat' $true 'not required while intentionally offline'
  }
  $dshOk = $dshManaged -and $null -ne $task -and $task.State -eq 'Running' -and $owned.Ok -and $owned.Running
  $taskDetail = if ($task) { "$($task.State); $($owned.Detail)" } else { 'not installed' }
  Add-Finding 'DSH Web Host task/process' $dshOk $taskDetail
  if ($task) {
    $expectedRuntimeScript = if ($manifest -and $manifest.psobject.Properties.Name -contains 'operationsRuntime' -and $manifest.operationsRuntime) { Join-Path $manifest.operationsRuntime.root 'dsh-web-host-supervisor.ps1' } else { '' }
    $taskRuntime = if ($expectedRuntimeScript) { Test-ScheduledTaskRuntimePath -Task $task -ExpectedScript $expectedRuntimeScript } else { [pscustomobject]@{ Ok = $false; Detail = 'manifest has no operations runtime snapshot' } }
    Add-Finding 'DSH Web Host task runtime' $taskRuntime.Ok $taskRuntime.Detail
  }
  if ($Online) {
    $dshWorkerRoutes = @(Get-DshWebWorkerRoutes -Workers $loaded.Config.workers -BaseUrl $ops.dshWebHost.baseUrl)
    $dshHealthy = Test-DshWebHost -HostConfig $ops.dshWebHost -WorkerRoutes $dshWorkerRoutes
    $dshDetail = if ($dshHealthy) { 'valid session.list and configured worker route responses' } else { 'unreachable or invalid session.list or configured worker route response' }
    Add-Finding 'DSH Web Host RPC' $dshHealthy $dshDetail
  }
}
foreach ($executable in @('pwsh.exe', $loaded.Config.ghExecutable, $loaded.Config.gitExecutable)) {
  Add-Finding "executable $executable" ($null -ne (Get-Command $executable -ErrorAction SilentlyContinue)) 'resolved without running it'
}
if ($Online) {
  try {
    $principal = Test-HostGitHubLogin -Config $loaded.Config
    Add-Finding 'GitHub CLI principal' $principal.Ok $principal.Detail
  } catch { Add-Finding 'GitHub CLI principal' $false 'gh api user failed' }
  foreach ($workerId in @($loaded.Config.operations.roles.maintenance.workers)) {
    $maintenancePrincipal = Test-MaintenanceGitHubLogin -Config $loaded.Config -Worker $loaded.Config.workers.$workerId -ControllerRepository $ops.controller.repository
    Add-Finding "maintenance Worker $workerId GitHub credential" $maintenancePrincipal.Ok $maintenancePrincipal.Detail
  }
  foreach ($mapping in @($ops.repositoryMappings)) {
    try {
      $actualWorkflows = & $loaded.Config.ghExecutable variable get DSH_AUTOMATION_CI_WORKFLOWS --repo $mapping.repository --json value --jq '.value' 2>$null
      $workflowMatches = $LASTEXITCODE -eq 0 -and $actualWorkflows.Trim().Equals((ConvertTo-Json -InputObject @($mapping.ciWorkflows) -Compress), [StringComparison]::Ordinal)
      Add-Finding "$($mapping.repository) CI workflows variable" $workflowMatches $(if ($workflowMatches) { 'matches ciWorkflows' } else { 'missing or mismatched' })
      $actualChecks = & $loaded.Config.ghExecutable variable get DSH_AUTOMATION_REQUIRED_CHECKS --repo $mapping.repository --json value --jq '.value' 2>$null
      $checkMatches = $LASTEXITCODE -eq 0 -and $actualChecks.Trim().Equals((ConvertTo-Json -InputObject @($mapping.requiredChecks) -Compress), [StringComparison]::Ordinal)
      Add-Finding "$($mapping.repository) required checks variable" $checkMatches $(if ($checkMatches) { 'matches requiredChecks' } else { 'missing or mismatched' })
      $actualControllerLogin = & $loaded.Config.ghExecutable variable get AGENT_AUTOMATION_CONTROLLER_LOGIN --repo $mapping.repository --json value --jq '.value' 2>$null
      $controllerLoginMatches = $LASTEXITCODE -eq 0 -and $actualControllerLogin.Trim().Equals([string]$loaded.Config.github.login, [StringComparison]::Ordinal)
      Add-Finding "$($mapping.repository) controller login variable" $controllerLoginMatches $(if ($controllerLoginMatches) { 'matches github.login' } else { 'missing or mismatched' })
      $expectedReplicaHealth = ConvertTo-Json -InputObject ([ordered]@{ include = @($instances | Where-Object {
        $_.Role -in @('change', 'review') -and ($null -eq $_.Repository -or $_.Repository -eq $mapping.repository)
      } | ForEach-Object { [ordered]@{ role = $_.Role; label = $_.Id; primary = ($_.Replica -eq 1) } }) }) -Compress -Depth 4
      $actualReplicaHealth = & $loaded.Config.ghExecutable variable get AGENT_AUTOMATION_REPLICA_HEALTH --repo $mapping.repository --json value --jq '.value' 2>$null
      $replicaHealthMatches = $LASTEXITCODE -eq 0 -and $actualReplicaHealth.Trim().Equals($expectedReplicaHealth, [StringComparison]::Ordinal)
      Add-Finding "$($mapping.repository) replica health variable" $replicaHealthMatches $(if ($replicaHealthMatches) { 'matches exact installed replicas' } else { 'missing or mismatched' })
    } catch { Add-Finding "$($mapping.repository) CI workflow variable" $false 'query failed' }
    try {
      $protection = Get-RepositoryRequiredStatusChecks -Mapping $mapping -GhExecutable $loaded.Config.ghExecutable
      $requiredCheckResult = if ($protection.Exists) { Test-RequiredStatusChecks -Current $protection.Current -RequiredNames (Get-RequiredCheckNames -Mapping $mapping) } else { [pscustomobject]@{ Ok = $false; Detail = 'branch protection or required checks are not configured' } }
      Add-Finding "$($mapping.repository) required checks" $requiredCheckResult.Ok $requiredCheckResult.Detail
    } catch { Add-Finding "$($mapping.repository) required checks" $false 'query failed, branch protection is disabled, or Administration permission is missing' }
  }
}
$findings | Format-Table -AutoSize
if (@($findings | Where-Object { $_.Status -eq 'FAIL' }).Count) { exit 1 }
