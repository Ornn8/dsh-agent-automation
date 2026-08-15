Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RoleNames = @('change', 'review')
$script:GitHubActionsAppId = 15368
$script:ReviewRequiredCheckName = 'codex/review'
$script:OperationsRuntimeFiles = @('Automation.Operations.psm1', 'runner-supervisor.ps1', 'dsh-web-host-supervisor.ps1')

function Write-OperationLog {
  param([string]$Message, [string]$Level = 'INFO', [string]$LogFile)
  $line = '{0:o} [{1}] {2}' -f (Get-Date), $Level, $Message
  Write-Host $line
  if ($LogFile) {
    $directory = Split-Path -Parent $LogFile
    if (Test-Path -LiteralPath $directory) { Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8 }
  }
}

function Resolve-OperationPath {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Name)
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path.IndexOfAny([char[]]'*?') -ge 0) { throw "$Name must be a literal path" }
  if ($Path.StartsWith('\\')) { throw "$Name must be a local volume path, not a UNC path" }
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  if ($root -eq $full) { throw "$Name must not be a volume root" }
  if ($root.TrimEnd('\').Equals('C:', [StringComparison]::OrdinalIgnoreCase)) { throw "$Name must not use C:; choose a data volume" }
  return $full.TrimEnd('\')
}

function Assert-PathInside {
  param([Parameter(Mandatory)][string]$Child, [Parameter(Mandatory)][string]$Parent, [Parameter(Mandatory)][string]$Name)
  $childPath = [IO.Path]::GetFullPath($Child).TrimEnd('\')
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  if (-not $childPath.StartsWith($parentPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "$Name must be inside $parentPath" }
}

function Get-RepositoryKey {
  param([Parameter(Mandatory)][string]$Repository)
  $slug = $Repository.ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  $slug = $slug.Trim('-')
  if ($slug.Length -gt 20) { $slug = $slug.Substring(0, 20).TrimEnd('-') }
  $bytes = [Text.Encoding]::UTF8.GetBytes($Repository.ToLowerInvariant())
  $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).Substring(0, 12).ToLowerInvariant()
  return "$slug-$hash"
}

function Assert-AgentWorkerConfiguration {
  param([Parameter(Mandatory)]$Workers)
  foreach ($property in @($Workers.psobject.Properties)) {
    $worker = $property.Value
    if ($worker.adapter -eq 'dsh-web') {
      foreach ($field in 'agentPreset', 'permissionPreset', 'provider', 'model', 'reasoningEffort') {
        if ($worker.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($worker.$field)) {
          throw "workers.$($property.Name).$field is required for a dsh-web worker"
        }
      }
      continue
    }
    if ($worker.adapter -eq 'claude-code-cli') {
      foreach ($field in 'executable', 'model', 'effort') {
        if ($worker.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($worker.$field)) {
          throw "workers.$($property.Name).$field is required for a claude-code-cli worker"
        }
      }
      if ($worker.effort -notin @('low', 'medium', 'high', 'xhigh', 'max', 'ultracode')) {
        throw "workers.$($property.Name).effort is not supported"
      }
      if ($worker.mode -notin @('change', 'review')) { throw "workers.$($property.Name).mode must be change or review" }
      if ($worker.mode -eq 'review' -and ($worker.gitExecutable -isnot [string] -or [string]::IsNullOrWhiteSpace($worker.gitExecutable))) {
        throw "workers.$($property.Name).gitExecutable is required for review"
      }
      continue
    }
    if ($worker.adapter -ne 'opencode-cli') { continue }
    foreach ($field in 'executable', 'model', 'variant') {
      if ($worker.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($worker.$field)) {
        throw "workers.$($property.Name).$field is required for an opencode-cli worker"
      }
    }
    if ($worker.model -notmatch '^[^/\s]+/[^/\s]+$') { throw "workers.$($property.Name).model must be provider/model" }
    if ($worker.mode -notin @('change', 'review')) { throw "workers.$($property.Name).mode must be change or review" }
    if ($worker.mode -eq 'review' -and ($worker.gitExecutable -isnot [string] -or [string]::IsNullOrWhiteSpace($worker.gitExecutable))) {
      throw "workers.$($property.Name).gitExecutable is required for review"
    }
  }
}

function Read-OperationsConfig {
  param([Parameter(Mandatory)][string]$Configuration, [switch]$AllowExamplePlaceholders)
  $configurationPath = [IO.Path]::GetFullPath($Configuration)
  if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) { throw "Configuration file does not exist: $configurationPath" }
  try { $config = Get-Content -LiteralPath $configurationPath -Raw -Encoding utf8 | ConvertFrom-Json -Depth 32 } catch { throw "Configuration is not valid JSON: $($_.Exception.Message)" }
  if ($config.schemaVersion -ne 2 -or $config.operations.schemaVersion -ne 2) { throw 'Configuration schemaVersion must be 2' }
  if (-not @($config.repositories).Count) { throw 'repositories must not be empty' }
  if (@($config.repositories).Count -gt 32) { throw 'repositories is limited to 32 entries per host' }
  foreach ($repository in @($config.repositories)) { if ($repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "Invalid repository mapping: $repository" } }
  if (-not $config.workers -or @($config.workers.psobject.Properties).Count -eq 0) { throw 'workers must not be empty' }
  Assert-AgentWorkerConfiguration -Workers $config.workers
  foreach ($field in 'ghExecutable', 'gitExecutable') { if ([string]::IsNullOrWhiteSpace($config.$field)) { throw "$field is required" } }
  if ($config.github.login -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$') { throw 'github.login must be a GitHub login name' }
  if ($config.github.login -like 'REPLACE-*' -and -not $AllowExamplePlaceholders) { throw 'github.login must name the expected host GitHub principal' }

  $ops = $config.operations
  foreach ($field in 'installRoot', 'stateRoot', 'logsRoot') { $ops.$field = Resolve-OperationPath -Path $ops.$field -Name "operations.$field" }
  if ($ops.installRoot.Equals($ops.stateRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'installRoot and stateRoot must be separate paths' }
  Assert-PathInside -Child $ops.logsRoot -Parent $ops.stateRoot -Name 'operations.logsRoot'
  if (-not $AllowExamplePlaceholders) { Assert-PathInside -Child $configurationPath -Parent $ops.stateRoot -Name 'machine-local configuration' }
  if ($ops.controller.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'operations.controller.repository must be owner/repository' }
  if ($ops.controller.registrationScope -notin @('organization', 'target-repositories')) { throw 'registrationScope must be organization or target-repositories' }
  if ($ops.controller.registrationScope -eq 'organization' -and $ops.controller.organization -notmatch '^[A-Za-z0-9_.-]+$') { throw 'organization registration requires operations.controller.organization' }

  if ([string]::IsNullOrWhiteSpace($ops.runner.version) -or ($ops.runner.version -like 'REPLACE-*' -and -not $AllowExamplePlaceholders)) { throw 'runner.version must be a pinned release version' }
  if ($ops.runner.downloadUri -notmatch '^https://' -or ($ops.runner.downloadUri -match 'REPLACE_' -and -not $AllowExamplePlaceholders)) { throw 'runner.downloadUri must be a pinned HTTPS release URL' }
  if ($ops.runner.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -and -not $AllowExamplePlaceholders) { throw 'runner.sha256 must be an official 64-character SHA-256 value' }
  foreach ($roleName in $script:RoleNames) {
    $role = $ops.roles.$roleName
    if (-not $role) { throw "operations.roles.$roleName is required" }
    if ([string]::IsNullOrWhiteSpace($role.runnerNamePrefix) -or $role.runnerNamePrefix -match '[^A-Za-z0-9_.-]' -or $role.runnerNamePrefix.Length -gt 16) { throw "roles.$roleName.runnerNamePrefix is invalid" }
    $replicasProperty = $role.PSObject.Properties['replicas']
    if (-not $replicasProperty) {
      $role | Add-Member -NotePropertyName replicas -NotePropertyValue 1
    } elseif (($replicasProperty.Value -isnot [int] -and $replicasProperty.Value -isnot [long]) -or [int]$replicasProperty.Value -lt 1 -or [int]$replicasProperty.Value -gt 8) {
      throw "roles.$roleName.replicas must be an integer between 1 and 8"
    }
    if (-not @($role.labels).Count -or @($role.labels | Where-Object { $_ -notmatch '^[A-Za-z0-9_.-]+$' }).Count) { throw "roles.$roleName.labels must be non-empty simple labels" }
  }
  if ($ops.roles.change.labels -notcontains 'agent-change') { throw 'change role must have the agent-change label' }
  if ($ops.roles.review.labels -notcontains 'agent-reviewer') { throw 'review role must have the agent-reviewer label' }

  $mappings = @($ops.repositoryMappings)
  if (-not $mappings.Count -or $mappings.Count -gt 32) { throw 'repositoryMappings must contain between 1 and 32 entries' }
  $mapped = @($mappings | ForEach-Object { $_.repository })
  if (@($mapped | Select-Object -Unique).Count -ne $mapped.Count -or @($mapped | Where-Object { $_ -notin @($config.repositories) }).Count) { throw 'repositoryMappings must map each allowed repository exactly once' }
  if ($mapped.Count -ne @($config.repositories).Count) { throw 'repositoryMappings must map every allowed repository' }
  foreach ($mapping in $mappings) {
    foreach ($field in 'changeWorker', 'reviewWorker', 'ciWorkflowName', 'ciRequiredCheckName') { if ([string]::IsNullOrWhiteSpace($mapping.$field)) { throw "repositoryMappings.$field is required" } }
    if ($mapping.ciWorkflowName.Length -gt 128 -or $mapping.ciWorkflowName -match '[\r\n]') { throw "repositoryMappings.ciWorkflowName is invalid for $($mapping.repository)" }
    if ($mapping.ciRequiredCheckName.Length -gt 128 -or $mapping.ciRequiredCheckName -match '[\r\n]' -or $mapping.ciRequiredCheckName -eq $script:ReviewRequiredCheckName) { throw "repositoryMappings.ciRequiredCheckName is invalid for $($mapping.repository)" }
    if (-not $config.workers.($mapping.changeWorker)) { throw "repositoryMappings changeWorker is unknown: $($mapping.changeWorker)" }
    if (-not $config.workers.($mapping.reviewWorker)) { throw "repositoryMappings reviewWorker is unknown: $($mapping.reviewWorker)" }
  }

  if ($ops.dshWebHost.enabled) {
    foreach ($field in 'executable', 'workingDirectory', 'baseUrl', 'healthPath') { if ([string]::IsNullOrWhiteSpace($ops.dshWebHost.$field)) { throw "dshWebHost.$field is required when enabled" } }
    if ($ops.dshWebHost.baseUrl -notmatch '^http://(127\.0\.0\.1|localhost)(:\d+)?$') { throw 'dshWebHost.baseUrl must be a loopback HTTP origin' }
    if ($ops.dshWebHost.healthPath -ne '/api/session.list') { throw 'dshWebHost.healthPath must be /api/session.list' }
    if ([int]$ops.dshWebHost.restartAfterFailures -lt 1) { throw 'dshWebHost.restartAfterFailures must be at least 1' }
    $dshWorkers = @($config.workers.psobject.Properties | ForEach-Object { $_.Value } | Where-Object { $_.adapter -eq 'dsh-web' })
    if ($dshWorkers.Count -eq 0 -or @($dshWorkers | Where-Object { $_.baseUrl -eq $ops.dshWebHost.baseUrl }).Count -eq 0) { throw 'An enabled dshWebHost must match a dsh-web worker baseUrl' }
  }
  return [pscustomobject]@{ Path = $configurationPath; Config = $config; Operations = $ops }
}

function Get-RunnerInstances {
  param(
    [Parameter(Mandatory)]$Loaded,
    [ValidateSet('change', 'review')][string[]]$Roles = @('change', 'review'),
    [string[]]$Repositories
  )
  $ops = $Loaded.Operations
  $roleSet = @($Roles | Select-Object -Unique)
  $repositorySet = @($Repositories | Where-Object { $_ } | Select-Object -Unique)
  if ($repositorySet.Count) {
    $unknown = @($repositorySet | Where-Object { $_ -notin @($Loaded.Config.repositories) })
    if ($unknown.Count) { throw "Unknown repository selection: $($unknown -join ', ')" }
  }
  $instances = [Collections.Generic.List[object]]::new()
  if ($ops.controller.registrationScope -eq 'organization') {
    if ($repositorySet.Count) { throw '-Repositories is not valid in organization mode because each role runner is shared by every allowlisted target' }
    $organizationKey = Get-RepositoryKey -Repository "$($ops.controller.organization)/organization"
    foreach ($roleName in $roleSet) {
      for ($replica = 1; $replica -le [int]$ops.roles.$roleName.replicas; $replica += 1) {
        $replicaSuffix = if ($replica -eq 1) { '' } else { "-r$replica" }
        $id = "organization-$($roleName)$replicaSuffix"
        $runnerNameBase = "$($ops.roles.$roleName.runnerNamePrefix)-$organizationKey-$(([string]$env:COMPUTERNAME).Substring(0, [Math]::Min(12, ([string]$env:COMPUTERNAME).Length)))"
        $runnerName = if ($replica -eq 1) { $runnerNameBase } else { "$($runnerNameBase.Substring(0, [Math]::Min(64 - $replicaSuffix.Length, $runnerNameBase.Length)))$replicaSuffix" }
        $instances.Add([pscustomobject]@{
          Id = $id
          Role = $roleName
          Replica = $replica
          Repository = $null
          RegistrationKind = 'organization'
          RegistrationOwner = $ops.controller.organization
          RunnerName = $runnerName
          Labels = @($ops.roles.$roleName.labels)
          RunnerRoot = Join-Path $ops.installRoot (Join-Path 'runners' $id)
          WorkDirectory = Join-Path $ops.stateRoot (Join-Path 'work' $id)
          TaskName = "DSH-Agent-Automation-$id"
          LogFile = Join-Path $ops.logsRoot "$id-supervisor.log"
          FaultFile = Join-Path $ops.stateRoot (Join-Path 'faults' "$id.restart")
        })
      }
    }
  } else {
    $selectedMappings = @($ops.repositoryMappings | Where-Object { -not $repositorySet.Count -or $_.repository -in $repositorySet })
    foreach ($mapping in $selectedMappings) {
      $key = Get-RepositoryKey -Repository $mapping.repository
      foreach ($roleName in $roleSet) {
        for ($replica = 1; $replica -le [int]$ops.roles.$roleName.replicas; $replica += 1) {
          $replicaSuffix = if ($replica -eq 1) { '' } else { "-r$replica" }
          $id = "target-$key-$($roleName)$replicaSuffix"
          $runnerNameBase = "$($ops.roles.$roleName.runnerNamePrefix)-$key-$(([string]$env:COMPUTERNAME).Substring(0, [Math]::Min(12, ([string]$env:COMPUTERNAME).Length)))"
          $runnerName = if ($replica -eq 1) { $runnerNameBase } else { "$($runnerNameBase.Substring(0, [Math]::Min(64 - $replicaSuffix.Length, $runnerNameBase.Length)))$replicaSuffix" }
          $instances.Add([pscustomobject]@{
            Id = $id
            Role = $roleName
            Replica = $replica
            Repository = $mapping.repository
            RegistrationKind = 'repository'
            RegistrationOwner = $mapping.repository
            RunnerName = $runnerName
            Labels = @($ops.roles.$roleName.labels)
            RunnerRoot = Join-Path $ops.installRoot (Join-Path 'runners' $id)
            WorkDirectory = Join-Path $ops.stateRoot (Join-Path 'work' $id)
            TaskName = "DSH-Agent-Automation-$id"
            LogFile = Join-Path $ops.logsRoot "$id-supervisor.log"
            FaultFile = Join-Path $ops.stateRoot (Join-Path 'faults' "$id.restart")
          })
        }
      }
    }
  }
  foreach ($instance in $instances) {
    Assert-PathInside -Child $instance.RunnerRoot -Parent $ops.installRoot -Name "$($instance.Id) runner root"
    Assert-PathInside -Child $instance.WorkDirectory -Parent $ops.stateRoot -Name "$($instance.Id) work directory"
  }
  return @($instances)
}

function Get-RunnerInstance {
  param([Parameter(Mandatory)]$Loaded, [Parameter(Mandatory)][string]$InstanceId)
  $matches = @(Get-RunnerInstances -Loaded $Loaded | Where-Object { $_.Id -eq $InstanceId })
  if ($matches.Count -ne 1) { throw "Unknown or ambiguous runner instance: $InstanceId" }
  return $matches[0]
}

function Initialize-PrivateDirectory {
  param([Parameter(Mandatory)][string]$Path, [switch]$DryRun)
  if ($DryRun) { Write-OperationLog "DRY-RUN create and ACL $Path"; return }
  if (Test-Path -LiteralPath $Path) {
    $existing = Get-Item -LiteralPath $Path -Force
    if (-not $existing.PSIsContainer -or $existing.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Managed path is not a regular directory: $Path" }
  }
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $Path /inheritance:r /grant:r ($identity + ':(OI)(CI)F') /grant:r 'SYSTEM:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not secure directory: $Path" }
}

function Test-PrivateDirectoryAcl {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return [pscustomobject]@{ Ok = $false; Detail = 'missing' } }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return [pscustomobject]@{ Ok = $false; Detail = 'reparse point is not allowed' } }
  $rules = (Get-Acl -LiteralPath $Path).Access
  $unsafe = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match '(^|\\)(Everyone|Users|Authenticated Users)$' -and $_.FileSystemRights.ToString() -match 'Write|Modify|FullControl' })
  return [pscustomobject]@{ Ok = ($unsafe.Count -eq 0); Detail = if ($unsafe.Count) { 'shared write ACL present' } else { 'private ACL' } }
}

function Assert-ManagedDirectoryForRemoval {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Root)
  Assert-PathInside -Child $Path -Parent $Root -Name 'removal path'
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer) { throw "Removal target is not a directory: $Path" }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Removal target is a reparse point: $Path" }
  $parent = Get-Item -LiteralPath (Split-Path -Parent $Path) -Force
  if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Removal parent is a reparse point: $($parent.FullName)" }
  $nestedReparsePoints = @(Get-ChildItem -LiteralPath $Path -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
  if ($nestedReparsePoints.Count) { throw "Removal target contains $($nestedReparsePoints.Count) reparse point(s): $Path" }
}

function Get-RegistrationEndpoint {
  param([Parameter(Mandatory)]$Instance, [ValidateSet('registration', 'remove')][string]$Purpose = 'registration')
  $suffix = if ($Purpose -eq 'registration') { 'registration-token' } else { 'remove-token' }
  if ($Instance.RegistrationKind -eq 'organization') { return "orgs/$($Instance.RegistrationOwner)/actions/runners/$suffix" }
  return "repos/$($Instance.RegistrationOwner)/actions/runners/$suffix"
}

function Get-RegistrationUrl {
  param([Parameter(Mandatory)]$Instance)
  if ($Instance.RegistrationKind -eq 'organization') { return "https://github.com/$($Instance.RegistrationOwner)" }
  return "https://github.com/$($Instance.Repository)"
}

function Get-RunnerToken {
  param([Parameter(Mandatory)]$Instance, [Parameter(Mandatory)][string]$GhExecutable, [ValidateSet('registration', 'remove')][string]$Purpose = 'registration')
  $endpoint = Get-RegistrationEndpoint -Instance $Instance -Purpose $Purpose
  $token = & $GhExecutable api --method POST $endpoint --jq '.token' 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) { throw "GitHub did not issue a $Purpose token for $($Instance.Id); check bootstrap permissions" }
  return $token.Trim()
}

function Test-HostGitHubLogin {
  param([Parameter(Mandatory)]$Config)
  $actual = & $Config.ghExecutable api user --jq '.login' 2>$null
  $ok = $LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($actual) -and $actual.Trim().Equals($Config.github.login, [StringComparison]::OrdinalIgnoreCase)
  return [pscustomobject]@{ Ok = $ok; Detail = if ($ok) { 'matches github.login' } else { 'does not match github.login or is unavailable' } }
}

function Get-RequiredCheckNames {
  param([Parameter(Mandatory)]$Mapping)
  return @([string]$Mapping.ciRequiredCheckName, $script:ReviewRequiredCheckName)
}

function Merge-RequiredStatusChecks {
  param([Parameter(Mandatory)]$Current, [Parameter(Mandatory)][string[]]$RequiredNames)
  $currentChecks = if ($Current.psobject.Properties.Name -contains 'checks') { @($Current.checks) } else { @() }
  $checkNames = @($currentChecks | ForEach-Object { [string]$_.context })
  $contexts = if ($Current.psobject.Properties.Name -contains 'contexts') { @($Current.contexts) } else { @() }
  $retainedContexts = @($contexts | Where-Object { $_ -notin $checkNames -and $_ -notin $RequiredNames } | Select-Object -Unique)
  $mergedChecks = [Collections.Generic.List[object]]::new()
  foreach ($check in $currentChecks) {
    if ([string]::IsNullOrWhiteSpace($check.context) -or $check.context -in $RequiredNames) { continue }
    $appId = if ($check.psobject.Properties.Name -notcontains 'app_id' -or $null -eq $check.app_id) { -1 } else { [int64]$check.app_id }
    $mergedChecks.Add([pscustomobject][ordered]@{ context = [string]$check.context; app_id = $appId })
  }
  foreach ($name in $RequiredNames) {
    $mergedChecks.Add([pscustomobject][ordered]@{ context = $name; app_id = $script:GitHubActionsAppId })
  }
  return [pscustomobject][ordered]@{ strict = $true; contexts = $retainedContexts; checks = @($mergedChecks) }
}

function Test-RequiredStatusChecks {
  param([Parameter(Mandatory)]$Current, [Parameter(Mandatory)][string[]]$RequiredNames)
  if ($Current.psobject.Properties.Name -notcontains 'strict' -or $Current.strict -ne $true -or $Current.psobject.Properties.Name -notcontains 'checks') {
    return [pscustomobject]@{ Ok = $false; Detail = 'strict mode or app-bound checks are missing' }
  }
  foreach ($name in $RequiredNames) {
    $matches = @($Current.checks | Where-Object { $_.context -ceq $name })
    if ($matches.Count -ne 1 -or $matches[0].psobject.Properties.Name -notcontains 'app_id' -or [int64]$matches[0].app_id -ne $script:GitHubActionsAppId) {
      return [pscustomobject]@{ Ok = $false; Detail = 'required checks are missing or not bound to GitHub Actions' }
    }
  }
  return [pscustomobject]@{ Ok = $true; Detail = 'strict with both checks bound to GitHub Actions app id 15368' }
}

function Get-HttpStatusCodeFromHeaders {
  param([Parameter(Mandatory)][string[]]$Headers)
  $status = @($headers | ForEach-Object { if ($_ -match '^HTTP/\S+\s+(\d{3})(?:\s|$)') { [int]$Matches[1] } })
  if (-not $status.Count) { throw 'Could not determine an HTTP status from GitHub response headers' }
  return $status[-1]
}

function Get-GhApiHttpStatus {
  param([Parameter(Mandatory)][string]$Endpoint, [Parameter(Mandatory)][string]$GhExecutable)
  $headers = @(& $GhExecutable api $Endpoint --include --silent 2>$null)
  return Get-HttpStatusCodeFromHeaders -Headers $headers
}

function New-BranchProtectionBootstrapPayload {
  param([Parameter(Mandatory)][string[]]$RequiredNames)
  $empty = [pscustomobject]@{ strict = $false; contexts = @(); checks = @() }
  return [pscustomobject][ordered]@{
    required_status_checks = Merge-RequiredStatusChecks -Current $empty -RequiredNames $RequiredNames
    enforce_admins = $true
    required_pull_request_reviews = $null
    restrictions = $null
    allow_force_pushes = $false
    allow_deletions = $false
  }
}

function Test-BootstrapBranchProtection {
  param([Parameter(Mandatory)]$Protection)
  $forcePushesDisabled = $Protection.psobject.Properties.Name -contains 'allow_force_pushes' -and $Protection.allow_force_pushes.enabled -eq $false
  $deletionsDisabled = $Protection.psobject.Properties.Name -contains 'allow_deletions' -and $Protection.allow_deletions.enabled -eq $false
  $manualApprovalsDisabled = $Protection.psobject.Properties.Name -notcontains 'required_pull_request_reviews' -or $null -eq $Protection.required_pull_request_reviews
  $ok = $forcePushesDisabled -and $deletionsDisabled -and $manualApprovalsDisabled
  return [pscustomobject]@{ Ok = $ok; Detail = if ($ok) { 'force pushes and deletions disabled; no manual approval requirement' } else { 'bootstrap safety settings did not verify' } }
}

function Get-RepositoryBranchProtection {
  param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][string]$GhExecutable)
  $raw = & $GhExecutable api $State.ProtectionEndpoint 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) { throw "Could not read full branch protection for $($State.Repository)" }
  try { return $raw | ConvertFrom-Json -Depth 24 } catch { throw "GitHub returned invalid branch protection JSON for $($State.Repository)" }
}

function Get-RepositoryRequiredStatusChecks {
  param([Parameter(Mandatory)]$Mapping, [Parameter(Mandatory)][string]$GhExecutable)
  $repository = [string]$Mapping.repository
  $defaultBranch = & $GhExecutable api "repos/$repository" --jq '.default_branch' 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($defaultBranch)) { throw "Could not read the default branch for $repository" }
  $encodedBranch = [Uri]::EscapeDataString($defaultBranch.Trim())
  $endpoint = "repos/$repository/branches/$encodedBranch/protection/required_status_checks"
  $protectionEndpoint = "repos/$repository/branches/$encodedBranch/protection"
  $raw = & $GhExecutable api $endpoint 2>$null
  if ($LASTEXITCODE -ne 0) {
    $status = Get-GhApiHttpStatus -Endpoint $endpoint -GhExecutable $GhExecutable
    if ($status -ne 404) { throw "Could not read required status checks for $repository (HTTP $status); refusing branch-protection bootstrap" }
    $protectionStatus = Get-GhApiHttpStatus -Endpoint $protectionEndpoint -GhExecutable $GhExecutable
    if ($protectionStatus -notin @(200, 404)) { throw "Could not classify branch protection for $repository (HTTP $protectionStatus); refusing bootstrap" }
    return [pscustomobject]@{
      Repository = $repository
      DefaultBranch = $defaultBranch.Trim()
      Endpoint = $endpoint
      ProtectionEndpoint = $protectionEndpoint
      Exists = $false
      ProtectionExists = $protectionStatus -eq 200
      Current = $null
    }
  }
  if ([string]::IsNullOrWhiteSpace($raw)) { throw "GitHub returned an empty required status check response for $repository" }
  try { $current = $raw | ConvertFrom-Json -Depth 16 } catch { throw "GitHub returned invalid required status check JSON for $repository" }
  return [pscustomobject]@{ Repository = $repository; DefaultBranch = $defaultBranch.Trim(); Endpoint = $endpoint; ProtectionEndpoint = $protectionEndpoint; Exists = $true; ProtectionExists = $true; Current = $current }
}

function Set-RepositoryRequiredStatusChecks {
  param([Parameter(Mandatory)]$Mapping, [Parameter(Mandatory)][string]$GhExecutable)
  $state = Get-RepositoryRequiredStatusChecks -Mapping $Mapping -GhExecutable $GhExecutable
  $requiredNames = Get-RequiredCheckNames -Mapping $Mapping
  $bootstrapped = -not $state.ProtectionExists
  if ($bootstrapped) {
    $payload = New-BranchProtectionBootstrapPayload -RequiredNames $requiredNames
    $method = 'PUT'
    $endpoint = $state.ProtectionEndpoint
  } else {
    $current = if ($state.Exists) { $state.Current } else { [pscustomobject]@{ strict = $false; contexts = @(); checks = @() } }
    $payload = Merge-RequiredStatusChecks -Current $current -RequiredNames $requiredNames
    $method = 'PATCH'
    $endpoint = $state.Endpoint
  }
  $payloadJson = $payload | ConvertTo-Json -Compress -Depth 8
  $payloadJson | & $GhExecutable api --method $method $endpoint --input - 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) {
    $operation = if ($bootstrapped) { 'bootstrap branch protection' } else { 'merge required status checks' }
    throw "Could not $operation for $($state.Repository); refusing to weaken or replace existing protection"
  }
  $verified = Get-RepositoryRequiredStatusChecks -Mapping $Mapping -GhExecutable $GhExecutable
  if (-not $verified.Exists) { throw "Required status checks are still absent after update for $($state.Repository)" }
  $result = Test-RequiredStatusChecks -Current $verified.Current -RequiredNames $requiredNames
  if (-not $result.Ok) { throw "Required status checks did not verify after update for $($state.Repository)" }
  if ($bootstrapped) {
    $fullProtection = Get-RepositoryBranchProtection -State $verified -GhExecutable $GhExecutable
    $bootstrapResult = Test-BootstrapBranchProtection -Protection $fullProtection
    if (-not $bootstrapResult.Ok) { throw "New branch protection did not verify safe bootstrap settings for $($state.Repository)" }
  }
}

function Get-DshWebTaskName { return 'DSH-Agent-Automation-dsh-web' }

function Get-OwnedProcessRecordPath {
  param([Parameter(Mandatory)]$Operations, [Parameter(Mandatory)][string]$InstanceId)
  if ($InstanceId -notmatch '^[A-Za-z0-9_.-]+$') { throw "Invalid process-record instance id: $InstanceId" }
  return Join-Path $Operations.stateRoot (Join-Path 'pids' "$InstanceId.json")
}

function Write-OwnedProcessRecord {
  param([Parameter(Mandatory)]$Operations, [Parameter(Mandatory)][string]$InstanceId, [Parameter(Mandatory)][Diagnostics.Process]$Process)
  $directory = Join-Path $Operations.stateRoot 'pids'
  Initialize-PrivateDirectory -Path $directory
  $existing = Test-OwnedProcessRecord -Operations $Operations -InstanceId $InstanceId
  if ($existing.Running) { throw "Refusing to overwrite a live owned process record for $InstanceId" }
  if (-not $existing.Ok) {
    if ($existing.Detail -notin @('stale process record', 'PID was reused by another process')) { throw "Cannot replace process record for ${InstanceId}: $($existing.Detail)" }
    Remove-OwnedProcessRecord -Operations $Operations -InstanceId $InstanceId
  }
  $path = Get-OwnedProcessRecordPath -Operations $Operations -InstanceId $InstanceId
  $record = [ordered]@{
    schemaVersion = 1
    instanceId = $InstanceId
    rootPid = $Process.Id
    rootStartTimeUtc = $Process.StartTime.ToUniversalTime().ToString('O')
    supervisorPid = $PID
    recordedAtUtc = [DateTime]::UtcNow.ToString('O')
  }
  $temporary = Join-Path $directory "$InstanceId.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $path -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

function Read-OwnedProcessRecord {
  param([Parameter(Mandatory)]$Operations, [Parameter(Mandatory)][string]$InstanceId)
  $path = Get-OwnedProcessRecordPath -Operations $Operations -InstanceId $InstanceId
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Process record is a reparse point: $path" }
  try { $record = Get-Content -LiteralPath $path -Raw -Encoding utf8 | ConvertFrom-Json } catch { throw "Invalid process record for $InstanceId" }
  if ($record.schemaVersion -ne 1 -or $record.instanceId -ne $InstanceId -or [int64]$record.rootPid -lt 1 -or [string]::IsNullOrWhiteSpace($record.rootStartTimeUtc)) {
    throw "Invalid process record fields for $InstanceId"
  }
  return $record
}

function Get-OwnedProcessStartTimeUtcText {
  param([Parameter(Mandatory)]$Record)
  if ($Record.rootStartTimeUtc -is [DateTime]) { return $Record.rootStartTimeUtc.ToUniversalTime().ToString('O') }
  return [string]$Record.rootStartTimeUtc
}

function Test-OwnedProcessIdentity {
  param([Parameter(Mandatory)]$Record, $Process)
  if (-not $Process) { return [pscustomobject]@{ Ok = $false; Running = $false; Detail = 'stale process record' } }
  $actual = $Process.StartTime.ToUniversalTime().ToString('O')
  if ($actual -ne (Get-OwnedProcessStartTimeUtcText -Record $Record)) { return [pscustomobject]@{ Ok = $false; Running = $false; Detail = 'PID was reused by another process' } }
  return [pscustomobject]@{ Ok = $true; Running = $true; Detail = "owned root PID $($Record.rootPid)" }
}

function Test-OwnedProcessRecord {
  param([Parameter(Mandatory)]$Operations, [Parameter(Mandatory)][string]$InstanceId)
  try { $record = Read-OwnedProcessRecord -Operations $Operations -InstanceId $InstanceId } catch { return [pscustomobject]@{ Ok = $false; Running = $false; Detail = $_.Exception.Message } }
  if (-not $record) { return [pscustomobject]@{ Ok = $true; Running = $false; Detail = 'no owned process record' } }
  $process = Get-Process -Id ([int]$record.rootPid) -ErrorAction SilentlyContinue
  return Test-OwnedProcessIdentity -Record $record -Process $process
}

function Remove-OwnedProcessRecord {
  param([Parameter(Mandatory)]$Operations, [Parameter(Mandatory)][string]$InstanceId, [int]$RootPid)
  $path = Get-OwnedProcessRecordPath -Operations $Operations -InstanceId $InstanceId
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Process record is a reparse point: $path" }
    if ($RootPid) {
      $record = Read-OwnedProcessRecord -Operations $Operations -InstanceId $InstanceId
      if ([int]$record.rootPid -ne $RootPid) { return }
    }
    Remove-Item -LiteralPath $path -Force
  }
}

function Stop-OwnedProcessTree {
  param(
    [Parameter(Mandatory)]$Operations,
    [Parameter(Mandatory)][string]$InstanceId,
    $Record,
    [int]$TimeoutSeconds = 20,
    [scriptblock]$ProcessResolver = { param($RootProcessId) Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue },
    [scriptblock]$TreeTerminator = { param($RootProcessId) & taskkill.exe /pid $RootProcessId /t /f 1>$null 2>$null },
    [scriptblock]$Sleeper = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds },
    [scriptblock]$RecordRemover = { param($OwnedOperations, $OwnedInstanceId, $RootProcessId) Remove-OwnedProcessRecord -Operations $OwnedOperations -InstanceId $OwnedInstanceId -RootPid $RootProcessId }
  )
  $record = if ($PSBoundParameters.ContainsKey('Record')) { $Record } else { Read-OwnedProcessRecord -Operations $Operations -InstanceId $InstanceId }
  if (-not $record) { return [pscustomobject]@{ Stopped = $true; Detail = 'no owned process record' } }
  $process = & $ProcessResolver ([int]$record.rootPid)
  if (-not $process) {
    & $RecordRemover $Operations $InstanceId ([int]$record.rootPid)
    return [pscustomobject]@{ Stopped = $true; Detail = 'owned process already exited' }
  }
  $recordedStart = Get-OwnedProcessStartTimeUtcText -Record $record
  $actual = $process.StartTime.ToUniversalTime().ToString('O')
  if ($actual -ne $recordedStart) { throw "Refusing to stop reused PID $($record.rootPid) for $InstanceId" }
  & $TreeTerminator ([int]$record.rootPid)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    & $Sleeper 200
    $remaining = & $ProcessResolver ([int]$record.rootPid)
    if (-not $remaining) { break }
    if ($remaining.StartTime.ToUniversalTime().ToString('O') -ne $recordedStart) { break }
  } while ([DateTime]::UtcNow -lt $deadline)
  $remaining = & $ProcessResolver ([int]$record.rootPid)
  if ($remaining -and $remaining.StartTime.ToUniversalTime().ToString('O') -eq $recordedStart) {
    throw "Owned process tree for $InstanceId did not exit within $TimeoutSeconds seconds"
  }
  & $RecordRemover $Operations $InstanceId ([int]$record.rootPid)
  return [pscustomobject]@{ Stopped = $true; Detail = 'owned process tree stopped' }
}

function Stop-ManagedComponent {
  param(
    [Parameter(Mandatory)]$Operations,
    [Parameter(Mandatory)][string]$InstanceId,
    [Parameter(Mandatory)][string]$TaskName,
    [int]$TimeoutSeconds = 20
  )
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $record = Read-OwnedProcessRecord -Operations $Operations -InstanceId $InstanceId
  if ($task -and $task.State -eq 'Running' -and -not $record) {
    $recordDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
      Start-Sleep -Milliseconds 200
      $record = Read-OwnedProcessRecord -Operations $Operations -InstanceId $InstanceId
    } while (-not $record -and [DateTime]::UtcNow -lt $recordDeadline)
    if (-not $record) {
      throw "Refusing to stop running task $TaskName without an owned process record"
    }
  }
  if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  }
  $result = Stop-OwnedProcessTree -Operations $Operations -InstanceId $InstanceId -Record $record -TimeoutSeconds $TimeoutSeconds
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task -or $task.State -ne 'Running') { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($task -and $task.State -eq 'Running') {
    throw "Scheduled task $TaskName did not stop within $TimeoutSeconds seconds"
  }
  $status = Test-OwnedProcessRecord -Operations $Operations -InstanceId $InstanceId
  if ($status.Running) { throw "Owned process for $InstanceId is still running after stop" }
  if (-not $status.Ok -and $status.Detail -ne 'stale process record') { throw "Cannot confirm stopped process for ${InstanceId}: $($status.Detail)" }
  return $result
}

function Start-ManagedComponent {
  param(
    [Parameter(Mandatory)]$Operations,
    [Parameter(Mandatory)][string]$InstanceId,
    [Parameter(Mandatory)][string]$TaskName,
    [int]$TimeoutSeconds = 20
  )
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { throw "Scheduled task is not installed: $TaskName" }
  $status = Test-OwnedProcessRecord -Operations $Operations -InstanceId $InstanceId
  if ($task.State -eq 'Running' -and $status.Ok -and $status.Running) {
    return [pscustomobject]@{ Started = $false; Detail = 'already running' }
  }
  if ($task.State -eq 'Running' -or $status.Running -or -not $status.Ok) {
    Stop-ManagedComponent -Operations $Operations -InstanceId $InstanceId -TaskName $TaskName -TimeoutSeconds $TimeoutSeconds | Out-Null
  }
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 200
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $status = Test-OwnedProcessRecord -Operations $Operations -InstanceId $InstanceId
    if ($task -and $task.State -eq 'Running' -and $status.Ok -and $status.Running) {
      return [pscustomobject]@{ Started = $true; Detail = $status.Detail }
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Managed component $InstanceId did not start with a verified owned process within $TimeoutSeconds seconds"
}

function New-OperationsRuntimeSnapshotDefinition {
  param([Parameter(Mandatory)][string]$InstallRoot, [Parameter(Mandatory)]$Files)
  $records = @($Files | Sort-Object name)
  $recordNames = @($records.name | Sort-Object) -join ','
  $requiredNames = @($script:OperationsRuntimeFiles | Sort-Object) -join ','
  if ($records.Count -ne $script:OperationsRuntimeFiles.Count -or $recordNames -cne $requiredNames) { throw 'Operations runtime snapshot must contain the exact supervisor runtime file set' }
  foreach ($record in $records) {
    if ($record.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw "Invalid operations runtime file hash: $($record.name)" }
  }
  $canonical = @($records | ForEach-Object { "$($_.name):$(([string]$_.sha256).ToLowerInvariant())" }) -join "`n"
  $id = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonical))).ToLowerInvariant()
  $root = Join-Path $InstallRoot (Join-Path 'operations-runtime' $id)
  Assert-PathInside -Child $root -Parent $InstallRoot -Name 'operations runtime snapshot root'
  return [pscustomobject][ordered]@{ id = $id; root = $root; files = @($records | ForEach-Object { [pscustomobject][ordered]@{ name = [string]$_.name; sha256 = ([string]$_.sha256).ToLowerInvariant() } }) }
}

function Get-OperationsRuntimeSnapshotDefinition {
  param([Parameter(Mandatory)][string]$SourceRoot, [Parameter(Mandatory)][string]$InstallRoot)
  if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) { throw "Operations runtime source directory is missing: $SourceRoot" }
  $sourceItem = Get-Item -LiteralPath $SourceRoot -Force
  if ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Operations runtime source directory is a reparse point: $SourceRoot" }
  $records = @()
  foreach ($name in $script:OperationsRuntimeFiles) {
    $path = Join-Path $SourceRoot $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Operations runtime source file is missing: $path" }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Operations runtime source file is a reparse point: $path" }
    $records += [pscustomobject]@{ name = $name; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
  }
  return New-OperationsRuntimeSnapshotDefinition -InstallRoot $InstallRoot -Files $records
}

function Test-OperationsRuntimeSnapshot {
  param([Parameter(Mandatory)]$Snapshot)
  if (-not (Test-Path -LiteralPath $Snapshot.root -PathType Container)) { return [pscustomobject]@{ Ok = $false; Detail = 'snapshot directory is missing' } }
  $rootItem = Get-Item -LiteralPath $Snapshot.root -Force
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { return [pscustomobject]@{ Ok = $false; Detail = 'snapshot directory is a reparse point' } }
  $items = @(Get-ChildItem -LiteralPath $Snapshot.root -Force)
  if ($items.Count -ne @($Snapshot.files).Count -or @($items | Where-Object { $_.PSIsContainer -or $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { return [pscustomobject]@{ Ok = $false; Detail = 'snapshot contains unexpected or unsafe entries' } }
  foreach ($file in @($Snapshot.files)) {
    $path = Join-Path $Snapshot.root $file.name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return [pscustomobject]@{ Ok = $false; Detail = "snapshot file is missing: $($file.name)" } }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if (-not $actual.Equals($file.sha256, [StringComparison]::OrdinalIgnoreCase)) { return [pscustomobject]@{ Ok = $false; Detail = "snapshot hash mismatch: $($file.name)" } }
  }
  return [pscustomobject]@{ Ok = $true; Detail = "verified content snapshot $($Snapshot.id)" }
}

function Install-OperationsRuntimeSnapshot {
  param([Parameter(Mandatory)]$Snapshot, [Parameter(Mandatory)][string]$SourceRoot)
  $existing = Test-OperationsRuntimeSnapshot -Snapshot $Snapshot
  if ($existing.Ok) { return }
  if (Test-Path -LiteralPath $Snapshot.root) { throw "Refusing to overwrite invalid operations runtime snapshot: $($Snapshot.root)" }
  $parent = Split-Path -Parent $Snapshot.root
  Initialize-PrivateDirectory -Path $parent
  $temporary = Join-Path $parent ".snapshot.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    Initialize-PrivateDirectory -Path $temporary
    foreach ($file in @($Snapshot.files)) { Copy-Item -LiteralPath (Join-Path $SourceRoot $file.name) -Destination (Join-Path $temporary $file.name) }
    $temporarySnapshot = [pscustomobject]@{ id = $Snapshot.id; root = $temporary; files = @($Snapshot.files) }
    $verified = Test-OperationsRuntimeSnapshot -Snapshot $temporarySnapshot
    if (-not $verified.Ok) { throw "Staged operations runtime snapshot failed verification: $($verified.Detail)" }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $temporary /inheritance:r /grant:r ($identity + ':(OI)(CI)RX') /grant:r 'SYSTEM:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not make the operations runtime snapshot read-only' }
    Move-Item -LiteralPath $temporary -Destination $Snapshot.root
    $final = Test-OperationsRuntimeSnapshot -Snapshot $Snapshot
    if (-not $final.Ok) { throw "Installed operations runtime snapshot failed verification: $($final.Detail)" }
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      & icacls.exe $temporary /grant:r ($identity + ':(OI)(CI)F') /grant:r 'SYSTEM:(OI)(CI)F' /t /c | Out-Null
      Remove-Item -LiteralPath $temporary -Recurse -Force
    }
  }
}

function Remove-OperationsRuntimeSnapshot {
  param([Parameter(Mandatory)]$Snapshot, [Parameter(Mandatory)][string]$InstallRoot)
  $expected = Join-Path $InstallRoot (Join-Path 'operations-runtime' $Snapshot.id)
  if (-not ([IO.Path]::GetFullPath($Snapshot.root)).Equals([IO.Path]::GetFullPath($expected), [StringComparison]::OrdinalIgnoreCase)) { throw 'Operations runtime snapshot removal path does not match its content id' }
  Assert-ManagedDirectoryForRemoval -Path $Snapshot.root -Root $InstallRoot
  if (Test-Path -LiteralPath $Snapshot.root) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $Snapshot.root /grant:r ($identity + ':(OI)(CI)F') /grant:r 'SYSTEM:(OI)(CI)F' /t /c | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not unlock the exact operations runtime snapshot for removal' }
    Remove-Item -LiteralPath $Snapshot.root -Recurse -Force
  }
}

function Test-ScheduledTaskRuntimePath {
  param([Parameter(Mandatory)]$Task, [Parameter(Mandatory)][string]$ExpectedScript)
  $actions = @($Task.Actions)
  if ($actions.Count -ne 1 -or [string]$actions[0].Execute -notmatch '(?i)(^|\\)pwsh\.exe$') { return [pscustomobject]@{ Ok = $false; Detail = 'task action is not the expected PowerShell host' } }
  $match = [regex]::Match([string]$actions[0].Arguments, '(?i)(?:^|\s)-File\s+"([^"]+)"')
  if (-not $match.Success) { return [pscustomobject]@{ Ok = $false; Detail = 'task action has no quoted runtime script path' } }
  $ok = ([IO.Path]::GetFullPath($match.Groups[1].Value)).Equals([IO.Path]::GetFullPath($ExpectedScript), [StringComparison]::OrdinalIgnoreCase)
  return [pscustomobject]@{ Ok = $ok; Detail = if ($ok) { 'task uses the managed runtime snapshot' } else { 'task references a different runtime path' } }
}

function ConvertTo-ManifestEntry {
  param([Parameter(Mandatory)]$Instance, [bool]$TaskEnabled = $true)
  return [pscustomobject][ordered]@{
    id = $Instance.Id
    role = $Instance.Role
    repository = $Instance.Repository
    registrationKind = $Instance.RegistrationKind
    registrationOwner = $Instance.RegistrationOwner
    runnerName = $Instance.RunnerName
    labels = @($Instance.Labels)
    runnerRoot = $Instance.RunnerRoot
    workDirectory = $Instance.WorkDirectory
    taskName = $Instance.TaskName
    logFile = $Instance.LogFile
    faultFile = $Instance.FaultFile
    taskEnabled = $TaskEnabled
  }
}

function Get-InstallManifestPath {
  param([Parameter(Mandatory)]$Operations)
  return Join-Path $Operations.stateRoot 'install-manifest.json'
}

function New-InstallManifest {
  param([Parameter(Mandatory)]$Loaded, [Parameter(Mandatory)]$RuntimeSnapshot)
  return [pscustomobject][ordered]@{
    schemaVersion = 1
    configPath = $Loaded.Path
    registrationScope = $Loaded.Operations.controller.registrationScope
    runnerVersion = $Loaded.Operations.runner.version
    runnerSha256 = $Loaded.Operations.runner.sha256
    installRoot = $Loaded.Operations.installRoot
    stateRoot = $Loaded.Operations.stateRoot
    logsRoot = $Loaded.Operations.logsRoot
    operationsRuntime = $RuntimeSnapshot
    instances = @()
    dshWebManaged = $false
    updatedAtUtc = [DateTime]::UtcNow.ToString('O')
  }
}

function Read-InstallManifest {
  param([Parameter(Mandatory)]$Loaded)
  $path = Get-InstallManifestPath -Operations $Loaded.Operations
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Install manifest is a reparse point: $path" }
  try { $manifest = Get-Content -LiteralPath $path -Raw -Encoding utf8 | ConvertFrom-Json -Depth 16 } catch { throw "Install manifest is invalid JSON: $path" }
  if ($manifest.schemaVersion -ne 1) { throw 'Install manifest schemaVersion must be 1' }
  if ($manifest.registrationScope -notin @('organization', 'target-repositories')) { throw 'Install manifest registrationScope is invalid' }
  if ([string]::IsNullOrWhiteSpace($manifest.runnerVersion) -or $manifest.runnerSha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Install manifest runner package identity is invalid' }
  $manifestInstallRoot = Resolve-OperationPath -Path $manifest.installRoot -Name 'manifest installRoot'
  $manifestStateRoot = Resolve-OperationPath -Path $manifest.stateRoot -Name 'manifest stateRoot'
  $manifestLogsRoot = Resolve-OperationPath -Path $manifest.logsRoot -Name 'manifest logsRoot'
  Assert-PathInside -Child $manifestLogsRoot -Parent $manifestStateRoot -Name 'manifest logsRoot'
  if (-not $manifestStateRoot.Equals($Loaded.Operations.stateRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Install manifest stateRoot does not match the configuration that located it' }
  if ($manifest.dshWebManaged -isnot [bool]) { throw 'Install manifest dshWebManaged must be boolean' }
  if ($manifest.psobject.Properties.Name -contains 'operationsRuntime' -and $null -ne $manifest.operationsRuntime) {
    $runtime = $manifest.operationsRuntime
    if ($runtime.id -notmatch '^[a-f0-9]{64}$') { throw 'Install manifest operations runtime id is invalid' }
    $expectedRuntimeRoot = Join-Path $manifestInstallRoot (Join-Path 'operations-runtime' $runtime.id)
    if (-not ([IO.Path]::GetFullPath($runtime.root)).Equals([IO.Path]::GetFullPath($expectedRuntimeRoot), [StringComparison]::OrdinalIgnoreCase)) { throw 'Install manifest operations runtime path does not match its content id' }
    $runtimeDefinition = New-OperationsRuntimeSnapshotDefinition -InstallRoot $manifestInstallRoot -Files $runtime.files
    if ($runtimeDefinition.id -cne $runtime.id) { throw 'Install manifest operations runtime id does not match its file hashes' }
  }
  $ids = @()
  foreach ($entry in @($manifest.instances)) {
    if ($entry.id -notmatch '^(?:target-[A-Za-z0-9_.-]+-(?:change|review)|organization-(?:change|review))(?:-r[2-8])?$') { throw "Invalid manifest instance id: $($entry.id)" }
    if ($entry.id -in $ids) { throw "Duplicate manifest instance id: $($entry.id)" }
    $ids += $entry.id
    if ($entry.role -notin $script:RoleNames -or $entry.registrationKind -notin @('organization', 'repository')) { throw "Invalid manifest role or registration kind for $($entry.id)" }
    if ($entry.registrationOwner -notmatch '^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?$') { throw "Invalid manifest registration owner for $($entry.id)" }
    if ($entry.registrationKind -eq 'repository') {
      if ($entry.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $entry.registrationOwner -cne $entry.repository) { throw "Invalid repository registration identity for $($entry.id)" }
      $expectedId = "target-$(Get-RepositoryKey -Repository $entry.repository)-$($entry.role)"
      if ($entry.id -notmatch "^$([regex]::Escape($expectedId))(?:-r[2-8])?$") { throw "Invalid repository registration identity for $($entry.id)" }
    } elseif (-not [string]::IsNullOrWhiteSpace($entry.repository) -or $entry.id -notmatch "^organization-$([regex]::Escape([string]$entry.role))(?:-r[2-8])?$") {
      throw "Invalid organization registration identity for $($entry.id)"
    }
    if ($entry.runnerName -notmatch '^[A-Za-z0-9_.-]+$' -or $entry.runnerName.Length -gt 64 -or -not @($entry.labels).Count -or @($entry.labels | Where-Object { $_ -notmatch '^[A-Za-z0-9_.-]+$' }).Count) { throw "Invalid manifest runner name or labels for $($entry.id)" }
    if ($entry.taskEnabled -isnot [bool]) { throw "Invalid manifest taskEnabled for $($entry.id)" }
    Assert-PathInside -Child $entry.runnerRoot -Parent $manifestInstallRoot -Name "$($entry.id) manifest runner root"
    Assert-PathInside -Child $entry.workDirectory -Parent $manifestStateRoot -Name "$($entry.id) manifest work directory"
    $expectedRunnerRoot = Join-Path $manifestInstallRoot (Join-Path 'runners' $entry.id)
    $expectedWorkDirectory = Join-Path $manifestStateRoot (Join-Path 'work' $entry.id)
    $expectedLogFile = Join-Path $manifestLogsRoot "$($entry.id)-supervisor.log"
    $expectedFaultFile = Join-Path $manifestStateRoot (Join-Path 'faults' "$($entry.id).restart")
    foreach ($pathPair in @(@($entry.runnerRoot, $expectedRunnerRoot), @($entry.workDirectory, $expectedWorkDirectory), @($entry.logFile, $expectedLogFile), @($entry.faultFile, $expectedFaultFile))) {
      if (-not ([IO.Path]::GetFullPath($pathPair[0])).Equals([IO.Path]::GetFullPath($pathPair[1]), [StringComparison]::OrdinalIgnoreCase)) { throw "Manifest path does not match instance id $($entry.id)" }
    }
    if ($entry.taskName -ne "DSH-Agent-Automation-$($entry.id)") { throw "Invalid manifest task name for $($entry.id)" }
  }
  return $manifest
}

function Write-InstallManifest {
  param([Parameter(Mandatory)]$Loaded, [Parameter(Mandatory)]$Manifest)
  Initialize-PrivateDirectory -Path $Loaded.Operations.stateRoot
  $path = Get-InstallManifestPath -Operations $Loaded.Operations
  $temporary = Join-Path $Loaded.Operations.stateRoot "install-manifest.$([Guid]::NewGuid().ToString('N')).tmp"
  $Manifest.updatedAtUtc = [DateTime]::UtcNow.ToString('O')
  try {
    $Manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $path -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

function Set-ManifestEntry {
  param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)]$Entry)
  $retained = @($Manifest.instances | Where-Object { $_.id -ne $Entry.id })
  $Manifest.instances = @($retained + $Entry)
}

function Remove-ManifestEntry {
  param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)][string]$InstanceId)
  $Manifest.instances = @($Manifest.instances | Where-Object { $_.id -ne $InstanceId })
}

function Get-ManagedArtifactState {
  param(
    [Parameter(Mandatory)]$Loaded,
    $Manifest,
    [string[]]$DiscoveredTaskIds,
    [string[]]$DiscoveredRunnerIds,
    [string[]]$DiscoveredProcessRecordIds,
    [string[]]$DiscoveredRuntimeSnapshotIds,
    [Nullable[bool]]$DshWebTaskPresent,
    [Nullable[bool]]$DshWebProcessRecordPresent,
    $RuntimeSnapshot,
    [Nullable[bool]]$RuntimeSnapshotValid
  )
  $desired = @(Get-RunnerInstances -Loaded $Loaded)
  $manifestEntries = if ($Manifest) { @($Manifest.instances) } else { @() }
  $manifestIds = @($manifestEntries | ForEach-Object { $_.id })
  $desiredIds = @($desired | ForEach-Object { $_.Id })
  if ($PSBoundParameters.ContainsKey('DiscoveredTaskIds')) {
    $taskIds = @($DiscoveredTaskIds)
  } else {
    $tasks = @(Get-ScheduledTask -TaskName 'DSH-Agent-Automation-*' -ErrorAction SilentlyContinue)
    $taskIds = @($tasks | ForEach-Object { $_.TaskName } | Where-Object { $_ -match '^DSH-Agent-Automation-(target|organization)-' } | ForEach-Object { $_.Substring('DSH-Agent-Automation-'.Length) })
  }
  if ($PSBoundParameters.ContainsKey('DiscoveredRunnerIds')) {
    $runnerIds = @($DiscoveredRunnerIds)
  } else {
    $runnerIds = @()
    $runnersRoot = Join-Path $Loaded.Operations.installRoot 'runners'
    if (Test-Path -LiteralPath $runnersRoot -PathType Container) {
      $rootItem = Get-Item -LiteralPath $runnersRoot -Force
      if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Runners root is a reparse point: $runnersRoot" }
      $runnerIds = @(Get-ChildItem -LiteralPath $runnersRoot -Directory -Force | Where-Object { $_.Name -match '^(target|organization)-' } | ForEach-Object { $_.Name })
    }
  }
  $changedEntries = @()
  foreach ($entry in $manifestEntries) {
    $wanted = @($desired | Where-Object { $_.Id -eq $entry.id })
    if ($wanted.Count -ne 1) { continue }
    $expected = ConvertTo-ManifestEntry -Instance $wanted[0] -TaskEnabled ([bool]$entry.taskEnabled)
    $fields = @('role', 'repository', 'registrationKind', 'registrationOwner', 'runnerName', 'runnerRoot', 'workDirectory', 'taskName', 'logFile', 'faultFile')
    $fieldsChanged = @($fields | Where-Object { [string]$entry.$_ -cne [string]$expected.$_ }).Count -gt 0
    $labelsChanged = (@($entry.labels) -join ',') -cne (@($expected.labels) -join ',')
    if ($fieldsChanged -or $labelsChanged) { $changedEntries += $entry }
  }
  if ($PSBoundParameters.ContainsKey('DshWebTaskPresent')) {
    $dshTaskPresent = [bool]$DshWebTaskPresent
  } else {
    $dshTaskPresent = $null -ne (Get-ScheduledTask -TaskName (Get-DshWebTaskName) -ErrorAction SilentlyContinue)
  }
  if ($PSBoundParameters.ContainsKey('DiscoveredProcessRecordIds')) {
    $processRecordIds = @($DiscoveredProcessRecordIds)
  } else {
    $processRecordIds = @()
    $pidsRoot = Join-Path $Loaded.Operations.stateRoot 'pids'
    if (Test-Path -LiteralPath $pidsRoot -PathType Container) {
      $pidsItem = Get-Item -LiteralPath $pidsRoot -Force
      if ($pidsItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "PID record root is a reparse point: $pidsRoot" }
      $processRecordIds = @(Get-ChildItem -LiteralPath $pidsRoot -File -Filter '*.json' -Force | ForEach-Object { $_.BaseName })
    }
  }
  $dshProcessRecordPresent = if ($PSBoundParameters.ContainsKey('DshWebProcessRecordPresent')) { [bool]$DshWebProcessRecordPresent } else { $processRecordIds -contains 'dsh-web' }
  $runnerProcessRecordIds = @($processRecordIds | Where-Object { $_ -match '^(target|organization)-' })
  $dshManaged = $null -ne $Manifest -and [bool]$Manifest.dshWebManaged
  $dshDesired = [bool]$Loaded.Operations.dshWebHost.enabled
  $installedRuntime = if ($Manifest -and $Manifest.psobject.Properties.Name -contains 'operationsRuntime') { $Manifest.operationsRuntime } else { $null }
  $runtimeChanged = $false
  if ($Manifest -and $RuntimeSnapshot) {
    $runtimeChanged = -not $installedRuntime -or $installedRuntime.id -cne $RuntimeSnapshot.id -or -not ([IO.Path]::GetFullPath($installedRuntime.root)).Equals([IO.Path]::GetFullPath($RuntimeSnapshot.root), [StringComparison]::OrdinalIgnoreCase)
  }
  if ($installedRuntime) {
    $runtimeValid = if ($PSBoundParameters.ContainsKey('RuntimeSnapshotValid')) { [bool]$RuntimeSnapshotValid } else { (Test-OperationsRuntimeSnapshot -Snapshot $installedRuntime).Ok }
  } else {
    $runtimeValid = $null -eq $Manifest
  }
  if ($PSBoundParameters.ContainsKey('DiscoveredRuntimeSnapshotIds')) {
    $runtimeIds = @($DiscoveredRuntimeSnapshotIds)
  } else {
    $runtimeIds = @()
    $runtimeRoot = Join-Path $Loaded.Operations.installRoot 'operations-runtime'
    if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
      $runtimeRootItem = Get-Item -LiteralPath $runtimeRoot -Force
      if ($runtimeRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Operations runtime root is a reparse point: $runtimeRoot" }
      $runtimeItems = @(Get-ChildItem -LiteralPath $runtimeRoot -Force)
      if (@($runtimeItems | Where-Object { -not $_.PSIsContainer }).Count) { throw "Operations runtime root contains an unmanaged file: $runtimeRoot" }
      $runtimeIds = @($runtimeItems | ForEach-Object { $_.Name })
    }
  }
  $installedRuntimeId = if ($installedRuntime) { [string]$installedRuntime.id } else { '' }
  return [pscustomobject]@{
    Desired = $desired
    Manifest = $Manifest
    ScopeChanged = ($null -ne $Manifest -and $Manifest.registrationScope -ne $Loaded.Operations.controller.registrationScope)
    RunnerPackageChanged = ($null -ne $Manifest -and ($Manifest.runnerVersion -cne $Loaded.Operations.runner.version -or -not ([string]$Manifest.runnerSha256).Equals([string]$Loaded.Operations.runner.sha256, [StringComparison]::OrdinalIgnoreCase)))
    RuntimeSnapshotChanged = $runtimeChanged
    RuntimeSnapshotInvalid = (-not $runtimeValid)
    StaleEntries = @($manifestEntries | Where-Object { $_.id -notin $desiredIds })
    ChangedEntries = @($changedEntries)
    MissingEntries = @($desired | Where-Object { $_.Id -notin $manifestIds })
    UnexpectedTaskIds = @($taskIds | Where-Object { $_ -notin $manifestIds })
    UnexpectedRunnerIds = @($runnerIds | Where-Object { $_ -notin $manifestIds })
    UnexpectedProcessRecordIds = @($runnerProcessRecordIds | Where-Object { $_ -notin $manifestIds })
    UnexpectedRuntimeSnapshotIds = @($runtimeIds | Where-Object { $_ -cne $installedRuntimeId })
    DshWebUnexpected = (($dshTaskPresent -or $dshProcessRecordPresent) -and -not $dshManaged)
    DshWebStale = ($dshManaged -and -not $dshDesired)
    DshWebMissing = ($dshDesired -and $dshManaged -and -not $dshTaskPresent)
    DshWebManifestMissing = ($dshDesired -and -not $dshManaged)
  }
}

function Test-DshWebHost {
  param(
    [Parameter(Mandatory)]$HostConfig,
    [scriptblock]$Invoker = {
      param($Request)
      Invoke-WebRequest @Request
    }
  )
  $rpcId = "operations-health-$([Guid]::NewGuid().ToString('N'))"
  $request = @{
    Uri = $HostConfig.baseUrl.TrimEnd('/') + $HostConfig.healthPath
    Method = 'Post'
    ContentType = 'application/json'
    Body = (@{ type = 'client-request'; rpcId = $rpcId; method = 'session.list'; payload = @{} } | ConvertTo-Json -Compress -Depth 8)
    UseBasicParsing = $true
    TimeoutSec = 5
    ErrorAction = 'Stop'
  }
  try {
    $responses = @(& $Invoker $request)
    if ($responses.Count -ne 1) { return $false }
    $response = $responses[0]
    if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) { return $false }
    if ($response.Content -isnot [string] -or [string]::IsNullOrWhiteSpace($response.Content)) { return $false }
    $envelope = $response.Content | ConvertFrom-Json -Depth 16
    if ($envelope.type -ne 'server-response' -or $envelope.rpcId -ne $rpcId -or $envelope.result.ok -ne $true) { return $false }
    if ($null -eq $envelope.result.value -or $envelope.result.value.psobject.Properties.Name -notcontains 'items') { return $false }
    return $envelope.result.value.items -is [array]
  } catch {
    return $false
  }
}

function Invoke-OperationsSelfTest {
  $selfTestRoot = Join-Path ([IO.Path]::GetPathRoot($PSScriptRoot)) 'dsh-agent-automation-selftest'
  $selfTestInstallRoot = Join-Path $selfTestRoot 'ops-runtime'
  $selfTestStateRoot = Join-Path $selfTestRoot 'ops-state'
  $selfTestConfigPath = Join-Path $selfTestStateRoot 'agent-config.json'
  $results = @()
  $results += [pscustomobject]@{ Name = 'rejects C drive'; Passed = $false }
  try { Resolve-OperationPath -Path 'C:\unsafe' -Name 'test' | Out-Null } catch { $results[-1].Passed = $true }
  $results += [pscustomobject]@{ Name = 'rejects volume root'; Passed = $false }
  try { Resolve-OperationPath -Path ([IO.Path]::GetPathRoot($PSScriptRoot)) -Name 'test' | Out-Null } catch { $results[-1].Passed = $true }
  $orgInstance = [pscustomobject]@{ RegistrationKind = 'organization'; RegistrationOwner = 'owner' }
  $repoInstance = [pscustomobject]@{ RegistrationKind = 'repository'; RegistrationOwner = 'owner/repo' }
  $results += [pscustomobject]@{ Name = 'organization endpoint'; Passed = ((Get-RegistrationEndpoint -Instance $orgInstance) -eq 'orgs/owner/actions/runners/registration-token') }
  $results += [pscustomobject]@{ Name = 'target repository endpoint'; Passed = ((Get-RegistrationEndpoint -Instance $repoInstance) -eq 'repos/owner/repo/actions/runners/registration-token') }
  $results += [pscustomobject]@{ Name = 'repository keys are stable'; Passed = ((Get-RepositoryKey 'owner/repo') -eq (Get-RepositoryKey 'owner/repo')) }
  $results += [pscustomobject]@{ Name = 'repository keys avoid normalized collision'; Passed = ((Get-RepositoryKey 'owner/a.b') -ne (Get-RepositoryKey 'owner/a-b')) }
  $validDshWorker = [pscustomobject]@{ adapter = 'dsh-web'; agentPreset = 'standard'; permissionPreset = 'danger-full-access'; provider = 'opencode-go'; model = 'deepseek-v4-flash'; reasoningEffort = 'max' }
  $results += [pscustomobject]@{ Name = 'DSH worker requires explicit session presets and model selection'; Passed = $false }
  try { Assert-AgentWorkerConfiguration -Workers ([pscustomobject]@{ dsh = $validDshWorker }); $results[-1].Passed = $true } catch {}
  $results += [pscustomobject]@{ Name = 'DSH worker rejects incomplete model selection'; Passed = $false }
  try { Assert-AgentWorkerConfiguration -Workers ([pscustomobject]@{ dsh = [pscustomobject]@{ adapter = 'dsh-web'; agentPreset = 'standard'; permissionPreset = 'danger-full-access'; provider = 'opencode-go'; model = 'deepseek-v4-flash' } }) } catch { $results[-1].Passed = $_.Exception.Message -match 'reasoningEffort' }
  $results += [pscustomobject]@{ Name = 'DSH worker rejects a missing permission preset'; Passed = $false }
  try { Assert-AgentWorkerConfiguration -Workers ([pscustomobject]@{ dsh = [pscustomobject]@{ adapter = 'dsh-web'; agentPreset = 'standard'; provider = 'opencode-go'; model = 'deepseek-v4-flash'; reasoningEffort = 'max' } }) } catch { $results[-1].Passed = $_.Exception.Message -match 'permissionPreset' }
  $validOpenCodeReview = [pscustomobject]@{ adapter = 'opencode-cli'; executable = 'opencode.exe'; gitExecutable = 'git.exe'; mode = 'review'; model = 'openai/gpt-5'; variant = 'medium' }
  $results += [pscustomobject]@{ Name = 'OpenCode review worker requires a complete CLI selection'; Passed = $false }
  try { Assert-AgentWorkerConfiguration -Workers ([pscustomobject]@{ reviewer = $validOpenCodeReview }); $results[-1].Passed = $true } catch {}
  $results += [pscustomobject]@{ Name = 'OpenCode review worker rejects a missing Git executable'; Passed = $false }
  try { Assert-AgentWorkerConfiguration -Workers ([pscustomobject]@{ reviewer = [pscustomobject]@{ adapter = 'opencode-cli'; executable = 'opencode.exe'; mode = 'review'; model = 'openai/gpt-5'; variant = 'medium' } }) } catch { $results[-1].Passed = $_.Exception.Message -match 'gitExecutable' }
  $validClaudeReview = [pscustomobject]@{ adapter = 'claude-code-cli'; executable = 'claude.exe'; gitExecutable = 'git.exe'; mode = 'review'; model = 'sonnet'; effort = 'high' }
  $results += [pscustomobject]@{ Name = 'Claude Code review worker requires a complete CLI selection'; Passed = $false }
  try { Assert-AgentWorkerConfiguration -Workers ([pscustomobject]@{ reviewer = $validClaudeReview }); $results[-1].Passed = $true } catch {}
  $results += [pscustomobject]@{ Name = 'Claude Code review worker rejects a missing Git executable'; Passed = $false }
  try { Assert-AgentWorkerConfiguration -Workers ([pscustomobject]@{ reviewer = [pscustomobject]@{ adapter = 'claude-code-cli'; executable = 'claude.exe'; mode = 'review'; model = 'sonnet'; effort = 'high' } }) } catch { $results[-1].Passed = $_.Exception.Message -match 'gitExecutable' }
  $results += [pscustomobject]@{ Name = 'Claude Code worker rejects an unsupported effort'; Passed = $false }
  try { Assert-AgentWorkerConfiguration -Workers ([pscustomobject]@{ reviewer = [pscustomobject]@{ adapter = 'claude-code-cli'; executable = 'claude.exe'; gitExecutable = 'git.exe'; mode = 'review'; model = 'sonnet'; effort = 'impossible' } }) } catch { $results[-1].Passed = $_.Exception.Message -match 'effort' }
  $fakeOps = [pscustomobject]@{
    installRoot = $selfTestInstallRoot
    stateRoot = $selfTestStateRoot
    logsRoot = (Join-Path $selfTestStateRoot 'logs')
    controller = [pscustomobject]@{ registrationScope = 'target-repositories'; organization = $null }
    dshWebHost = [pscustomobject]@{ enabled = $false }
    runner = [pscustomobject]@{ version = '1.0.0'; sha256 = ('a' * 64) }
    roles = [pscustomobject]@{
      change = [pscustomobject]@{ runnerNamePrefix = 'change'; replicas = 3; labels = @('agent-change') }
      review = [pscustomobject]@{ runnerNamePrefix = 'review'; replicas = 2; labels = @('agent-reviewer') }
    }
    repositoryMappings = @(
      [pscustomobject]@{ repository = 'owner/one' },
      [pscustomobject]@{ repository = 'owner/two' }
    )
  }
  $fakeLoaded = [pscustomobject]@{ Operations = $fakeOps; Config = [pscustomobject]@{ repositories = @('owner/one', 'owner/two') } }
  $targetInstances = @(Get-RunnerInstances -Loaded $fakeLoaded)
  $results += [pscustomobject]@{ Name = 'target mode creates configured role replicas per repository'; Passed = ($targetInstances.Count -eq 10) }
  $results += [pscustomobject]@{ Name = 'target replica task names are unique'; Passed = (@($targetInstances.TaskName | Select-Object -Unique).Count -eq 10) }
  $results += [pscustomobject]@{ Name = 'target replica runner names are unique and fit GitHub limits'; Passed = (@($targetInstances.RunnerName | Select-Object -Unique).Count -eq 10 -and -not @($targetInstances.RunnerName | Where-Object { $_.Length -gt 64 }).Count) }
  $results += [pscustomobject]@{ Name = 'replica one retains the original deterministic instance ID'; Passed = ($targetInstances.Id -contains 'target-owner-one-30fa40f53d1e-change') }
  $results += [pscustomobject]@{ Name = 'additional replicas have deterministic suffixed instance IDs'; Passed = ($targetInstances.Id -contains 'target-owner-one-30fa40f53d1e-change-r3') }
  $ownedStart = [DateTime]::SpecifyKind([DateTime]'2026-01-02T03:04:05', [DateTimeKind]::Utc)
  $ownedRecord = [pscustomobject]@{ rootPid = 42; rootStartTimeUtc = $ownedStart.ToString('O') }
  $ownedProcess = [pscustomobject]@{ Id = 42; StartTime = $ownedStart }
  $reusedProcess = [pscustomobject]@{ Id = 42; StartTime = $ownedStart.AddSeconds(1) }
  $results += [pscustomobject]@{ Name = 'owned PID identity requires exact start time'; Passed = (Test-OwnedProcessIdentity -Record $ownedRecord -Process $ownedProcess).Ok }
  $jsonRoundTripRecord = $ownedRecord | ConvertTo-Json -Compress | ConvertFrom-Json
  $results += [pscustomobject]@{ Name = 'owned PID identity accepts PowerShell date deserialization'; Passed = (Test-OwnedProcessIdentity -Record $jsonRoundTripRecord -Process $ownedProcess).Ok }
  $results += [pscustomobject]@{ Name = 'owned PID identity rejects PID reuse'; Passed = (-not (Test-OwnedProcessIdentity -Record $ownedRecord -Process $reusedProcess).Ok) }
  $terminationState = @{ Terminated = $false; TerminatedPid = 0; RemovedPid = 0 }
  $processResolver = { param($RootProcessId) if ($terminationState.Terminated) { return $null }; return $ownedProcess }
  $treeTerminator = { param($RootProcessId) $terminationState.TerminatedPid = $RootProcessId; $terminationState.Terminated = $true }
  $noSleep = { param($Milliseconds) }
  $recordRemover = { param($OwnedOperations, $OwnedInstanceId, $RootProcessId) $terminationState.RemovedPid = $RootProcessId }
  $terminationResult = Stop-OwnedProcessTree -Operations $fakeOps -InstanceId 'target-test-change' -Record $ownedRecord -TimeoutSeconds 1 -ProcessResolver $processResolver -TreeTerminator $treeTerminator -Sleeper $noSleep -RecordRemover $recordRemover
  $results += [pscustomobject]@{ Name = 'owned tree stop invokes exact recursive terminator and confirms exit'; Passed = ($terminationResult.Stopped -and $terminationState.TerminatedPid -eq 42 -and $terminationState.RemovedPid -eq 42) }

  $manifest = [pscustomobject][ordered]@{
    schemaVersion = 1
    configPath = $selfTestConfigPath
    registrationScope = 'target-repositories'
    runnerVersion = $fakeOps.runner.version
    runnerSha256 = $fakeOps.runner.sha256
    installRoot = $fakeOps.installRoot
    stateRoot = $fakeOps.stateRoot
    logsRoot = $fakeOps.logsRoot
    instances = @($targetInstances | ForEach-Object { ConvertTo-ManifestEntry -Instance $_ })
    dshWebManaged = $false
    updatedAtUtc = $ownedStart.ToString('O')
  }
  $matchedState = Get-ManagedArtifactState -Loaded $fakeLoaded -Manifest $manifest -DiscoveredTaskIds @($targetInstances.Id) -DiscoveredRunnerIds @($targetInstances.Id) -DshWebTaskPresent $false
  $results += [pscustomobject]@{ Name = 'manifest reconciliation accepts exact installed set'; Passed = (-not $matchedState.ScopeChanged -and -not $matchedState.StaleEntries.Count -and -not $matchedState.ChangedEntries.Count -and -not $matchedState.MissingEntries.Count -and -not $matchedState.UnexpectedTaskIds.Count -and -not $matchedState.UnexpectedRunnerIds.Count) }
  $fakeOps.repositoryMappings = @($fakeOps.repositoryMappings[0])
  $fakeLoaded.Config.repositories = @('owner/one')
  $removedMappingState = Get-ManagedArtifactState -Loaded $fakeLoaded -Manifest $manifest -DiscoveredTaskIds @($targetInstances.Id) -DiscoveredRunnerIds @($targetInstances.Id) -DshWebTaskPresent $false
  $results += [pscustomobject]@{ Name = 'manifest reconciliation detects removed repository instances'; Passed = ($removedMappingState.StaleEntries.Count -eq 5) }
  $fakeOps.repositoryMappings = @([pscustomobject]@{ repository = 'owner/one' }, [pscustomobject]@{ repository = 'owner/two' })
  $fakeLoaded.Config.repositories = @('owner/one', 'owner/two')
  $fakeOps.installRoot = "$selfTestInstallRoot-moved"
  $changedRootState = Get-ManagedArtifactState -Loaded $fakeLoaded -Manifest $manifest -DiscoveredTaskIds @($targetInstances.Id) -DiscoveredRunnerIds @($targetInstances.Id) -DshWebTaskPresent $false
  $results += [pscustomobject]@{ Name = 'manifest reconciliation detects changed managed paths'; Passed = ($changedRootState.ChangedEntries.Count -eq 10) }
  $fakeOps.installRoot = $selfTestInstallRoot
  $fakeOps.runner.version = '2.0.0'
  $changedPackageState = Get-ManagedArtifactState -Loaded $fakeLoaded -Manifest $manifest -DiscoveredTaskIds @($targetInstances.Id) -DiscoveredRunnerIds @($targetInstances.Id) -DshWebTaskPresent $false
  $results += [pscustomobject]@{ Name = 'manifest reconciliation detects runner package changes'; Passed = $changedPackageState.RunnerPackageChanged }
  $fakeOps.runner.version = '1.0.0'
  $unexpectedState = Get-ManagedArtifactState -Loaded $fakeLoaded -Manifest $manifest -DiscoveredTaskIds @($targetInstances.Id + 'target-orphan-change') -DiscoveredRunnerIds @($targetInstances.Id) -DiscoveredProcessRecordIds @('target-orphan-review') -DshWebTaskPresent $false -DshWebProcessRecordPresent $false
  $results += [pscustomobject]@{ Name = 'manifest reconciliation detects untracked artifacts'; Passed = ($unexpectedState.UnexpectedTaskIds -contains 'target-orphan-change' -and $unexpectedState.UnexpectedProcessRecordIds -contains 'target-orphan-review') }
  $runtimeFilesA = @(
    [pscustomobject]@{ name = 'Automation.Operations.psm1'; sha256 = ('1' * 64) },
    [pscustomobject]@{ name = 'runner-supervisor.ps1'; sha256 = ('2' * 64) },
    [pscustomobject]@{ name = 'dsh-web-host-supervisor.ps1'; sha256 = ('3' * 64) }
  )
  $runtimeFilesB = @(
    [pscustomobject]@{ name = 'Automation.Operations.psm1'; sha256 = ('1' * 64) },
    [pscustomobject]@{ name = 'runner-supervisor.ps1'; sha256 = ('4' * 64) },
    [pscustomobject]@{ name = 'dsh-web-host-supervisor.ps1'; sha256 = ('3' * 64) }
  )
  $runtimeA = New-OperationsRuntimeSnapshotDefinition -InstallRoot $fakeOps.installRoot -Files $runtimeFilesA
  $runtimeARepeat = New-OperationsRuntimeSnapshotDefinition -InstallRoot $fakeOps.installRoot -Files @($runtimeFilesA | Sort-Object name -Descending)
  $runtimeB = New-OperationsRuntimeSnapshotDefinition -InstallRoot $fakeOps.installRoot -Files $runtimeFilesB
  $results += [pscustomobject]@{ Name = 'operations runtime snapshot identity is deterministic'; Passed = ($runtimeA.id -ceq $runtimeARepeat.id -and $runtimeA.root -ceq $runtimeARepeat.root) }
  $results += [pscustomobject]@{ Name = 'operations runtime content change creates a new snapshot'; Passed = ($runtimeA.id -cne $runtimeB.id -and $runtimeA.root -cne $runtimeB.root) }
  $runtimeManifest = $manifest | ConvertTo-Json -Depth 12 | ConvertFrom-Json -Depth 12
  $runtimeManifest | Add-Member -NotePropertyName operationsRuntime -NotePropertyValue $runtimeA
  $runtimeExactState = Get-ManagedArtifactState -Loaded $fakeLoaded -Manifest $runtimeManifest -DiscoveredTaskIds @($targetInstances.Id) -DiscoveredRunnerIds @($targetInstances.Id) -DiscoveredProcessRecordIds @() -DiscoveredRuntimeSnapshotIds @($runtimeA.id) -DshWebTaskPresent $false -DshWebProcessRecordPresent $false -RuntimeSnapshot $runtimeA -RuntimeSnapshotValid $true
  $results += [pscustomobject]@{ Name = 'runtime reconciliation accepts exact manifest snapshot'; Passed = (-not $runtimeExactState.RuntimeSnapshotChanged -and -not $runtimeExactState.RuntimeSnapshotInvalid -and -not $runtimeExactState.UnexpectedRuntimeSnapshotIds.Count) }
  $runtimeChangedState = Get-ManagedArtifactState -Loaded $fakeLoaded -Manifest $runtimeManifest -DiscoveredTaskIds @($targetInstances.Id) -DiscoveredRunnerIds @($targetInstances.Id) -DiscoveredProcessRecordIds @() -DiscoveredRuntimeSnapshotIds @($runtimeA.id) -DshWebTaskPresent $false -DshWebProcessRecordPresent $false -RuntimeSnapshot $runtimeB -RuntimeSnapshotValid $true
  $results += [pscustomobject]@{ Name = 'runtime reconciliation requires migration for changed checkout content'; Passed = $runtimeChangedState.RuntimeSnapshotChanged }
  $runtimeInvalidState = Get-ManagedArtifactState -Loaded $fakeLoaded -Manifest $runtimeManifest -DiscoveredTaskIds @($targetInstances.Id) -DiscoveredRunnerIds @($targetInstances.Id) -DiscoveredProcessRecordIds @() -DiscoveredRuntimeSnapshotIds @($runtimeA.id) -DshWebTaskPresent $false -DshWebProcessRecordPresent $false -RuntimeSnapshot $runtimeA -RuntimeSnapshotValid $false
  $results += [pscustomobject]@{ Name = 'runtime reconciliation rejects failed installed hash verification'; Passed = $runtimeInvalidState.RuntimeSnapshotInvalid }
  $orphanRuntimeId = 'f' * 64
  $runtimeOrphanState = Get-ManagedArtifactState -Loaded $fakeLoaded -Manifest $runtimeManifest -DiscoveredTaskIds @($targetInstances.Id) -DiscoveredRunnerIds @($targetInstances.Id) -DiscoveredProcessRecordIds @() -DiscoveredRuntimeSnapshotIds @($runtimeA.id, $orphanRuntimeId) -DshWebTaskPresent $false -DshWebProcessRecordPresent $false -RuntimeSnapshot $runtimeA -RuntimeSnapshotValid $true
  $results += [pscustomobject]@{ Name = 'runtime reconciliation detects an orphan snapshot'; Passed = ($runtimeOrphanState.UnexpectedRuntimeSnapshotIds -contains $orphanRuntimeId) }
  $expectedRuntimeScript = Join-Path $runtimeA.root 'runner-supervisor.ps1'
  $snapshotTask = [pscustomobject]@{ Actions = @([pscustomobject]@{ Execute = 'C:\Program Files\PowerShell\7\pwsh.exe'; Arguments = "-NoProfile -File `"$expectedRuntimeScript`" -Configuration `"$selfTestConfigPath`"" }) }
  $checkoutScript = Join-Path $selfTestRoot 'checkout\ops\runner-supervisor.ps1'
  $checkoutTask = [pscustomobject]@{ Actions = @([pscustomobject]@{ Execute = 'pwsh.exe'; Arguments = "-NoProfile -File `"$checkoutScript`" -Configuration `"$selfTestConfigPath`"" }) }
  $results += [pscustomobject]@{ Name = 'task runtime validation accepts only the manifest snapshot path'; Passed = ((Test-ScheduledTaskRuntimePath -Task $snapshotTask -ExpectedScript $expectedRuntimeScript).Ok -and -not (Test-ScheduledTaskRuntimePath -Task $checkoutTask -ExpectedScript $expectedRuntimeScript).Ok) }
  $fakeOps.controller.registrationScope = 'organization'
  $fakeOps.controller.organization = 'owner'
  $organizationInstances = @(Get-RunnerInstances -Loaded $fakeLoaded)
  $results += [pscustomobject]@{ Name = 'organization mode creates configured shared role replicas'; Passed = ($organizationInstances.Count -eq 5) }
  $scopeState = Get-ManagedArtifactState -Loaded $fakeLoaded -Manifest $manifest -DiscoveredTaskIds @($targetInstances.Id) -DiscoveredRunnerIds @($targetInstances.Id) -DshWebTaskPresent $false
  $results += [pscustomobject]@{ Name = 'manifest reconciliation detects scope migration'; Passed = ($scopeState.ScopeChanged -and $scopeState.StaleEntries.Count -eq 10 -and $scopeState.MissingEntries.Count -eq 5) }
  $requiredMapping = [pscustomobject]@{ ciRequiredCheckName = 'all checks passed' }
  $requiredNames = Get-RequiredCheckNames -Mapping $requiredMapping
  $currentProtection = [pscustomobject]@{
    strict = $false
    contexts = @('legacy/status', 'all checks passed')
    checks = @(
      [pscustomobject]@{ context = 'third-party/check'; app_id = 99 },
      [pscustomobject]@{ context = 'all checks passed'; app_id = -1 }
    )
  }
  $mergedProtection = Merge-RequiredStatusChecks -Current $currentProtection -RequiredNames $requiredNames
  $mergedCheck = Test-RequiredStatusChecks -Current $mergedProtection -RequiredNames $requiredNames
  $results += [pscustomobject]@{ Name = 'required check merge preserves unrelated checks and contexts'; Passed = ($mergedCheck.Ok -and $mergedProtection.contexts -contains 'legacy/status' -and @($mergedProtection.checks | Where-Object { $_.context -eq 'third-party/check' -and $_.app_id -eq 99 }).Count -eq 1) }
  $remergedProtection = Merge-RequiredStatusChecks -Current $mergedProtection -RequiredNames $requiredNames
  $results += [pscustomobject]@{ Name = 'required check merge is idempotent'; Passed = (($mergedProtection | ConvertTo-Json -Compress -Depth 8) -ceq ($remergedProtection | ConvertTo-Json -Compress -Depth 8)) }
  $wrongAppProtection = [pscustomobject]@{ strict = $true; checks = @([pscustomobject]@{ context = 'all checks passed'; app_id = -1 }, [pscustomobject]@{ context = $script:ReviewRequiredCheckName; app_id = 15368 }) }
  $results += [pscustomobject]@{ Name = 'required check verification rejects an unbound CI check'; Passed = (-not (Test-RequiredStatusChecks -Current $wrongAppProtection -RequiredNames $requiredNames).Ok) }
  $results += [pscustomobject]@{ Name = 'GitHub status parser distinguishes explicit 404'; Passed = ((Get-HttpStatusCodeFromHeaders -Headers @('HTTP/2.0 404 Not Found')) -eq 404 -and (Get-HttpStatusCodeFromHeaders -Headers @('HTTP/2.0 403 Forbidden')) -eq 403) }
  $bootstrapPayload = New-BranchProtectionBootstrapPayload -RequiredNames $requiredNames
  $bootstrapChecks = Test-RequiredStatusChecks -Current $bootstrapPayload.required_status_checks -RequiredNames $requiredNames
  $results += [pscustomobject]@{ Name = 'branch protection bootstrap is automation compatible and destructive actions stay disabled'; Passed = ($bootstrapChecks.Ok -and $bootstrapPayload.enforce_admins -eq $true -and $null -eq $bootstrapPayload.required_pull_request_reviews -and $null -eq $bootstrapPayload.restrictions -and $bootstrapPayload.allow_force_pushes -eq $false -and $bootstrapPayload.allow_deletions -eq $false) }
  $safeBootstrapResponse = [pscustomobject]@{ allow_force_pushes = [pscustomobject]@{ enabled = $false }; allow_deletions = [pscustomobject]@{ enabled = $false }; required_pull_request_reviews = $null }
  $unsafeBootstrapResponse = [pscustomobject]@{ allow_force_pushes = [pscustomobject]@{ enabled = $true }; allow_deletions = [pscustomobject]@{ enabled = $false }; required_pull_request_reviews = $null }
  $results += [pscustomobject]@{ Name = 'branch protection bootstrap verification rejects force pushes'; Passed = ((Test-BootstrapBranchProtection -Protection $safeBootstrapResponse).Ok -and -not (Test-BootstrapBranchProtection -Protection $unsafeBootstrapResponse).Ok) }
  $healthConfig = [pscustomobject]@{ baseUrl = 'http://127.0.0.1:3080'; healthPath = '/api/session.list' }
  $validHealthInvoker = {
    param($Request)
    $sent = $Request.Body | ConvertFrom-Json
    if ($sent.type -ne 'client-request' -or $sent.method -ne 'session.list' -or $null -eq $sent.payload -or $sent.rpcId -notmatch '^operations-health-[a-f0-9]{32}$') {
      return [pscustomobject]@{ StatusCode = 422; Content = '{}' }
    }
    $content = @{
      type = 'server-response'
      rpcId = $sent.rpcId
      result = @{ ok = $true; value = @{ items = @() } }
    } | ConvertTo-Json -Compress -Depth 8
    return [pscustomobject]@{ StatusCode = 200; Content = $content }
  }
  $badStatusInvoker = {
    param($Request)
    $sent = $Request.Body | ConvertFrom-Json
    $content = @{ type = 'server-response'; rpcId = $sent.rpcId; result = @{ ok = $true; value = @{ items = @() } } } | ConvertTo-Json -Compress -Depth 8
    return [pscustomobject]@{ StatusCode = 400; Content = $content }
  }
  $wrongRpcInvoker = {
    param($Request)
    $content = @{ type = 'server-response'; rpcId = 'wrong'; result = @{ ok = $true; value = @{ items = @() } } } | ConvertTo-Json -Compress -Depth 8
    return [pscustomobject]@{ StatusCode = 200; Content = $content }
  }
  $wrongTypeInvoker = {
    param($Request)
    $sent = $Request.Body | ConvertFrom-Json
    $content = @{ type = 'other'; rpcId = $sent.rpcId; result = @{ ok = $true; value = @{ items = @() } } } | ConvertTo-Json -Compress -Depth 8
    return [pscustomobject]@{ StatusCode = 200; Content = $content }
  }
  $failedResultInvoker = {
    param($Request)
    $sent = $Request.Body | ConvertFrom-Json
    $content = @{ type = 'server-response'; rpcId = $sent.rpcId; result = @{ ok = $false; error = @{ code = 'test'; message = 'test' } } } | ConvertTo-Json -Compress -Depth 8
    return [pscustomobject]@{ StatusCode = 200; Content = $content }
  }
  $invalidItemsInvoker = {
    param($Request)
    $sent = $Request.Body | ConvertFrom-Json
    $content = @{ type = 'server-response'; rpcId = $sent.rpcId; result = @{ ok = $true; value = @{ items = @{} } } } | ConvertTo-Json -Compress -Depth 8
    return [pscustomobject]@{ StatusCode = 200; Content = $content }
  }
  $results += [pscustomobject]@{ Name = 'DSH health accepts valid session.list envelope'; Passed = (Test-DshWebHost -HostConfig $healthConfig -Invoker $validHealthInvoker) }
  $results += [pscustomobject]@{ Name = 'DSH health rejects HTTP 400'; Passed = (-not (Test-DshWebHost -HostConfig $healthConfig -Invoker $badStatusInvoker)) }
  $results += [pscustomobject]@{ Name = 'DSH health rejects mismatched rpcId'; Passed = (-not (Test-DshWebHost -HostConfig $healthConfig -Invoker $wrongRpcInvoker)) }
  $results += [pscustomobject]@{ Name = 'DSH health requires server-response type'; Passed = (-not (Test-DshWebHost -HostConfig $healthConfig -Invoker $wrongTypeInvoker)) }
  $results += [pscustomobject]@{ Name = 'DSH health requires result.ok true'; Passed = (-not (Test-DshWebHost -HostConfig $healthConfig -Invoker $failedResultInvoker)) }
  $results += [pscustomobject]@{ Name = 'DSH health requires items array'; Passed = (-not (Test-DshWebHost -HostConfig $healthConfig -Invoker $invalidItemsInvoker)) }
  return $results
}

Export-ModuleMember -Function @(
  'Write-OperationLog', 'Resolve-OperationPath', 'Assert-PathInside', 'Get-RepositoryKey',
  'Read-OperationsConfig', 'Get-RunnerInstances', 'Get-RunnerInstance',
  'Initialize-PrivateDirectory', 'Test-PrivateDirectoryAcl', 'Assert-ManagedDirectoryForRemoval',
  'Get-RegistrationEndpoint', 'Get-RegistrationUrl', 'Get-RunnerToken', 'Test-HostGitHubLogin',
  'Get-RequiredCheckNames', 'Merge-RequiredStatusChecks', 'Test-RequiredStatusChecks',
  'Get-GhApiHttpStatus', 'New-BranchProtectionBootstrapPayload', 'Test-BootstrapBranchProtection',
  'Get-RepositoryBranchProtection', 'Get-RepositoryRequiredStatusChecks', 'Set-RepositoryRequiredStatusChecks',
  'Get-DshWebTaskName', 'Get-OwnedProcessRecordPath', 'Write-OwnedProcessRecord', 'Read-OwnedProcessRecord',
  'Test-OwnedProcessIdentity', 'Test-OwnedProcessRecord', 'Remove-OwnedProcessRecord', 'Stop-OwnedProcessTree',
  'Stop-ManagedComponent', 'Start-ManagedComponent',
  'New-OperationsRuntimeSnapshotDefinition', 'Get-OperationsRuntimeSnapshotDefinition',
  'Test-OperationsRuntimeSnapshot', 'Install-OperationsRuntimeSnapshot', 'Remove-OperationsRuntimeSnapshot',
  'Test-ScheduledTaskRuntimePath',
  'ConvertTo-ManifestEntry', 'Get-InstallManifestPath', 'New-InstallManifest', 'Read-InstallManifest',
  'Write-InstallManifest', 'Set-ManifestEntry', 'Remove-ManifestEntry', 'Get-ManagedArtifactState',
  'Test-DshWebHost', 'Invoke-OperationsSelfTest'
)
