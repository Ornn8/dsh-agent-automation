[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$TargetCheckout,

  [Parameter(Mandatory)]
  [string]$ControllerRepository,

  [Parameter(Mandatory)]
  [string]$ControllerSha,

  [Parameter(Mandatory)]
  [string]$CiWorkflowName,

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
Require-Value -Name 'CiWorkflowName' -Value $CiWorkflowName
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
if ($CiWorkflowName -match '[\r\n\x00]') {
  throw 'CiWorkflowName must be one line without NUL.'
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
  '{{CI_WORKFLOW_NAME}}' = $CiWorkflowName
  '{{CI_WORKFLOW_NAME_JSON}}' = ($CiWorkflowName | ConvertTo-Json -Compress)
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

if (-not $DryRun -and @($plan | Where-Object { $_.Action -eq 'write' }).Count) {
  [IO.Directory]::CreateDirectory($outputRoot) | Out-Null
}
foreach ($item in $plan) {
  if ($item.Action -eq 'unchanged') {
    Write-Output "unchanged $($item.RelativePath)"
  } elseif ($item.Action -eq 'would write') {
    Write-Output "would write $($item.RelativePath)"
  } else {
    [IO.File]::WriteAllText($item.Destination, $item.Content, $utf8)
    Write-Output "wrote $($item.RelativePath)"
  }
}
