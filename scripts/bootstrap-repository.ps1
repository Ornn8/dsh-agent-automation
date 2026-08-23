[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$TargetCheckout,

  [Parameter(Mandatory)]
  [string]$ControllerRepository,

  [Parameter(Mandatory)]
  [string]$ControllerSha,

  [Parameter(Mandatory)]
  [string]$CiWorkflowNamesJson,

  [string]$UpstreamRepository,

  [string]$PromotionRecordPath = (Join-Path $PSScriptRoot '..\controller-release.json'),

  [string]$FaultRecordPath,

  [switch]$Update,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$hasUpstreamRepository = -not [string]::IsNullOrWhiteSpace($UpstreamRepository)
$workflowNames = @(
  'agent-health.yml',
  'agent-issues.yml',
  'agent-pr-ci-repair.yml',
  'agent-pr-land.yml',
  'agent-landing-reconcile.yml',
  'agent-pr-review.yml',
  'agent-pr-rework.yml',
  'agent-repository-supervision.yml',
  'agent-recovery.yml'
)
if (-not $hasUpstreamRepository) {
  $workflowNames = @($workflowNames | Where-Object { $_ -ne 'agent-repository-supervision.yml' })
}
$supervisionWorkflowRelativePath = '.github/workflows/agent-repository-supervision.yml'

function Require-Value {
  param([string]$Name, [string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Name must not be empty." }
}

function Test-UtcDay {
  param([object]$Value)
  if ($Value -isnot [string] -or $Value -notmatch '^\d{4}-\d{2}-\d{2}$') { return $false }
  try {
    $date = [DateTime]::ParseExact($Value, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None)
    return $date.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) -ceq $Value
  } catch { return $false }
}

Require-Value -Name 'ControllerRepository' -Value $ControllerRepository
Require-Value -Name 'ControllerSha' -Value $ControllerSha
Require-Value -Name 'CiWorkflowNamesJson' -Value $CiWorkflowNamesJson
try { $CiWorkflowNames = @($CiWorkflowNamesJson | ConvertFrom-Json -ErrorAction Stop) } catch {
  throw 'CiWorkflowNamesJson must be a JSON array of workflow names.'
}
if (-not $CiWorkflowNames.Count -or @($CiWorkflowNames | Select-Object -Unique).Count -ne $CiWorkflowNames.Count) {
  throw 'CiWorkflowNamesJson must contain unique workflow names.'
}
foreach ($name in $CiWorkflowNames) {
  if ($name -isnot [string]) { throw 'CiWorkflowNamesJson must contain only strings.' }
  Require-Value -Name 'CiWorkflowNamesJson' -Value $name
}
if ($ControllerRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw 'ControllerRepository must be an owner/repository name.'
}
if ($hasUpstreamRepository -and $UpstreamRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw 'UpstreamRepository must be an owner/repository name.'
}
if ($ControllerSha -notmatch '^[0-9a-f]{40}$') {
  throw 'ControllerSha must be a lowercase full 40-character commit SHA.'
}
if (-not (Test-Path -LiteralPath $PromotionRecordPath -PathType Leaf)) {
  throw 'PromotionRecordPath must identify a controller release record.'
}
try { $promotion = Get-Content -LiteralPath $PromotionRecordPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch {
  throw 'PromotionRecordPath must contain valid controller release JSON.'
}
if ((@($promotion.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'lastPromotionDay,pendingRevisions,stableRevision,version' `
  -or ($promotion.version -ne 2) `
  -or -not (Test-UtcDay -Value $promotion.lastPromotionDay) `
  -or ($promotion.stableRevision -notmatch '^[0-9a-f]{40}$') `
  -or ($promotion.pendingRevisions -isnot [System.Array]) `
  -or @($promotion.pendingRevisions | Where-Object { $_ -notmatch '^[0-9a-f]{40}$' }).Count `
  -or @($promotion.pendingRevisions | Select-Object -Unique).Count -ne @($promotion.pendingRevisions).Count `
  -or @($promotion.pendingRevisions | Where-Object { $_ -ceq $promotion.stableRevision }).Count) {
  throw 'Controller release record is invalid.'
}
if ($ControllerSha -cne $promotion.stableRevision) {
  if ([string]::IsNullOrWhiteSpace($FaultRecordPath) -or -not (Test-Path -LiteralPath $FaultRecordPath -PathType Leaf)) {
    throw "ControllerSha is not the explicitly promoted stable revision $($promotion.stableRevision), and no fault-bound release record was supplied."
  }
  try { $fault = Get-Content -LiteralPath $FaultRecordPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch {
    throw 'FaultRecordPath must contain valid FaultRecord JSON.'
  }
  $activeEpoch = @($fault.epochs)[-1].number
  $activeAttempts = @($fault.attempts | Where-Object epoch -eq $activeEpoch)
  $validFaultRelease = $fault.version -eq 1 `
    -and $fault.status -in @('verifying', 'recovered') `
    -and $fault.publishedSha -ceq $ControllerSha `
    -and [int]$fault.repairPullRequest -ge 1 `
    -and @($activeAttempts | Where-Object { $_.kind -eq 'review' -and $_.outcome -eq 'succeeded' }).Count -eq 1 `
    -and @($activeAttempts | Where-Object { $_.kind -eq 'ci' -and $_.outcome -eq 'succeeded' }).Count -eq 1 `
    -and @($activeAttempts | Where-Object { $_.kind -eq 'promotion' -and $_.outcome -eq 'succeeded' }).Count -eq 1
  if (-not $validFaultRelease) { throw 'FaultRecordPath does not authorize this one fault-bound Controller revision.' }
} elseif (-not [string]::IsNullOrWhiteSpace($FaultRecordPath)) {
  throw 'FaultRecordPath is only valid when rendering a fault-bound revision outside the stable release record.'
}
if (@($CiWorkflowNames | Where-Object { $_ -match '[\r\n\x00]' }).Count) {
  throw 'CiWorkflowNamesJson must contain one-line names without NUL.'
}

$git = Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1
$target = (Resolve-Path -LiteralPath $TargetCheckout -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $target -PathType Container)) {
  throw 'TargetCheckout must resolve to a directory.'
}
$gitRoot = (& $git.Source -C $target rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitRoot)) {
  throw 'TargetCheckout must be inside a local Git checkout.'
}
$resolvedRoot = (Resolve-Path -LiteralPath $gitRoot -ErrorAction Stop).Path
if (-not [string]::Equals(
    [IO.Path]::GetFullPath($target),
    [IO.Path]::GetFullPath($resolvedRoot),
    [StringComparison]::OrdinalIgnoreCase
  )) {
  throw 'TargetCheckout must name the checkout root literally, not a descendant.'
}

$templateRoot = Join-Path $PSScriptRoot '..\templates\target\.github\workflows'
$templateRoot = (Resolve-Path -LiteralPath $templateRoot -ErrorAction Stop).Path
$outputRoot = Join-Path $resolvedRoot '.github\workflows'
$replacements = @{
  '{{CONTROLLER_REPOSITORY}}' = $ControllerRepository
  '{{CONTROLLER_SHA}}' = $ControllerSha
  '{{CI_WORKFLOW_NAMES_JSON}}' = (ConvertTo-Json -InputObject @($CiWorkflowNames) -Compress)
  '{{ADVANCEMENT_WORKFLOW_NAMES_JSON}}' = (ConvertTo-Json -InputObject @($CiWorkflowNames) -Compress)
}
if ($hasUpstreamRepository) {
  $replacements['{{UPSTREAM_REPOSITORY}}'] = $UpstreamRepository
}
$utf8 = [Text.UTF8Encoding]::new($false)
$plan = @()

foreach ($name in $workflowNames) {
  $relativePath = ".github/workflows/$name"
  $templatePath = Join-Path $templateRoot $name
  if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
    throw "Missing bootstrap template: $templatePath"
  }
  $content = Get-Content -LiteralPath $templatePath -Raw
  foreach ($placeholder in $replacements.Keys) {
    $content = $content.Replace($placeholder, $replacements[$placeholder])
  }
  if ($content -match '{{[A-Z_]+}}') {
    throw "Unresolved template placeholder in $name"
  }

  $existing = Join-Path $outputRoot $name
  $dirty = (& $git.Source -C $resolvedRoot status --porcelain -- $relativePath)
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect $relativePath in the target checkout." }
  if ($dirty -and -not $Update) {
    throw "$relativePath has local changes. Re-run with -Update to replace this exact generated workflow."
  }

  $current = if (Test-Path -LiteralPath $existing -PathType Leaf) {
    Get-Content -LiteralPath $existing -Raw
  } else {
    $null
  }
  if ($current -ceq $content) {
    $action = 'unchanged'
  } elseif ($DryRun) {
    $action = 'would write'
  } else {
    $action = 'write'
  }
  $plan += [pscustomobject]@{
    RelativePath = $relativePath
    Destination = $existing
    Content = $content
    Action = $action
  }
}

if (-not $hasUpstreamRepository) {
  $supervisionWorkflowDestination = Join-Path $outputRoot 'agent-repository-supervision.yml'
  if (Test-Path -LiteralPath $supervisionWorkflowDestination -PathType Leaf) {
    $supervisionWorkflowDirty = & $git.Source -C $resolvedRoot status --porcelain -- $supervisionWorkflowRelativePath
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect $supervisionWorkflowRelativePath in the target checkout." }
    if ($supervisionWorkflowDirty -and -not $Update) {
      throw "$supervisionWorkflowRelativePath has local changes. Re-run with -Update to remove this exact generated workflow."
    }
    if (-not $Update) {
      throw "$supervisionWorkflowRelativePath is installed but no upstream is configured. Re-run with -Update to remove this exact generated workflow."
    }
    $plan += [pscustomobject]@{
      RelativePath = $supervisionWorkflowRelativePath
      Destination = $supervisionWorkflowDestination
      Content = $null
      Action = if ($DryRun) { 'would delete' } else { 'delete' }
    }
  }
}

$profileRelativePath = '.github/agent-automation/profiles/github-pr-cycle.json'
$profileTemplatePath = Join-Path $PSScriptRoot '..\profiles\github-pr-cycle\profile.json'
if (-not (Test-Path -LiteralPath $profileTemplatePath -PathType Leaf)) {
  throw "Missing bootstrap Profile: $profileTemplatePath"
}
$profileContent = Get-Content -LiteralPath $profileTemplatePath -Raw
$profileDestination = Join-Path $resolvedRoot $profileRelativePath
$profileDirty = ''
if (Test-Path -LiteralPath $profileDestination) {
  $profileDirty = & $git.Source -C $resolvedRoot status --porcelain -- $profileRelativePath
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect $profileRelativePath in the target checkout." }
}
if ($profileDirty -and -not $Update) {
  throw "$profileRelativePath has local changes. Re-run with -Update to replace this exact generated Profile."
}
$profileCurrent = if (Test-Path -LiteralPath $profileDestination -PathType Leaf) {
  Get-Content -LiteralPath $profileDestination -Raw
} else {
  $null
}
$plan += [pscustomobject]@{
  RelativePath = $profileRelativePath
  Destination = $profileDestination
  Content = $profileContent
  Action = if ($profileCurrent -ceq $profileContent) { 'unchanged' } elseif ($DryRun) { 'would write' } else { 'write' }
}

if ($DryRun) {
  $hostOs = if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
    'windows'
  } elseif ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Linux)) {
    'linux'
  } elseif ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::OSX)) {
    'macos'
  } else {
    'unknown'
  }
  $hostArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  $workflowPlan = @($plan | Where-Object { $_.RelativePath -like '.github/workflows/*' } | ForEach-Object {
    $hashBytes = if ($_.Action -in @('delete', 'would delete')) {
      $null
    } else {
      [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($_.Content))
    }
    [pscustomobject][ordered]@{
      path = $_.RelativePath
      destination = $_.Destination
      action = ([string]$_.Action).Replace(' ', '-').ToLowerInvariant()
      sha256 = if ($null -eq $hashBytes) { $null } else { [Convert]::ToHexString($hashBytes).ToLowerInvariant() }
    }
  })
  $document = [pscustomobject][ordered]@{
    schemaVersion = 1
    kind = 'agent-automation-bootstrap'
    hostPlatform = "$hostOs-$hostArchitecture"
    targetCheckout = $resolvedRoot
    controllerRepository = $ControllerRepository
    controllerSha = $ControllerSha
    ciWorkflowNames = @($CiWorkflowNames)
    upstreamRepository = $UpstreamRepository
    update = [bool]$Update
    workflows = $workflowPlan
  }
  Write-Output "AUTOMATION_BOOTSTRAP_PLAN_JSON=$(ConvertTo-Json -InputObject $document -Depth 16 -Compress)"
}

foreach ($item in $plan) {
  if ($item.Action -eq 'unchanged') {
    Write-Output "unchanged $($item.RelativePath)"
  } elseif ($item.Action -eq 'would write') {
    Write-Output "would write $($item.RelativePath)"
  } elseif ($item.Action -eq 'would delete') {
    Write-Output "would delete $($item.RelativePath)"
  } elseif ($item.Action -eq 'delete') {
    Remove-Item -LiteralPath $item.Destination -Force
    Write-Output "deleted $($item.RelativePath)"
  } else {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $item.Destination)) | Out-Null
    [IO.File]::WriteAllText($item.Destination, $item.Content, $utf8)
    Write-Output "wrote $($item.RelativePath)"
  }
}
