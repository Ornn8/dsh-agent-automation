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

  [Parameter(Mandatory)]
  [string]$UpstreamRepository,

  [switch]$Update,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

function Require-Value {
  param([string]$Name, [string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Name must not be empty." }
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
Require-Value -Name 'UpstreamRepository' -Value $UpstreamRepository
if ($ControllerRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw 'ControllerRepository must be an owner/repository name.'
}
if ($UpstreamRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw 'UpstreamRepository must be an owner/repository name.'
}
if ($ControllerSha -notmatch '^[0-9a-f]{40}$') {
  throw 'ControllerSha must be a lowercase full 40-character commit SHA.'
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
  '{{UPSTREAM_REPOSITORY}}' = $UpstreamRepository
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
  $workflowPlan = @($plan | ForEach-Object {
    $hashBytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($_.Content))
    [pscustomobject][ordered]@{
      path = $_.RelativePath
      destination = $_.Destination
      action = ([string]$_.Action).Replace(' ', '-').ToLowerInvariant()
      sha256 = [Convert]::ToHexString($hashBytes).ToLowerInvariant()
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
  } else {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $item.Destination)) | Out-Null
    [IO.File]::WriteAllText($item.Destination, $item.Content, $utf8)
    Write-Output "wrote $($item.RelativePath)"
  }
}
