[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Invoke-Bootstrap {
  param([string[]]$Arguments, [int]$ExpectedExitCode = 0)
  if ($ExpectedExitCode -eq 0) {
    & $script:PowerShell -NoProfile -File $script:Bootstrap @Arguments
  } else {
    & $script:PowerShell -NoProfile -File $script:Bootstrap @Arguments 2>$null
  }
  if ($LASTEXITCODE -ne $ExpectedExitCode) {
    throw "bootstrap-repository.ps1 returned $LASTEXITCODE, expected $ExpectedExitCode."
  }
}

$PowerShell = (Get-Command pwsh -CommandType Application -ErrorAction Stop).Source
$Bootstrap = Join-Path $PSScriptRoot 'bootstrap-repository.ps1'
$TemplateRoot = Join-Path $PSScriptRoot '..\templates\target\.github\workflows'
$TemplateRoot = (Resolve-Path -LiteralPath $TemplateRoot).Path
$sha = '0123456789abcdef0123456789abcdef01234567'
$repository = 'Ornn8/dsh-agent-automation'
$ciWorkflow = 'Target CI'
$names = @(
  'agent-health.yml',
  'agent-issues.yml',
  'agent-pr-ci-repair.yml',
  'agent-pr-land.yml',
  'agent-pr-review.yml',
  'agent-pr-rework.yml',
  'agent-recovery.yml'
)
$temp = Join-Path ([IO.Path]::GetTempPath()) "dsh-bootstrap-$([Guid]::NewGuid().ToString('N'))"

try {
  [IO.Directory]::CreateDirectory($temp) | Out-Null
  & git -C $temp init -q
  if ($LASTEXITCODE -ne 0) { throw 'git init failed.' }

  $arguments = @(
    '-TargetCheckout', $temp,
    '-ControllerRepository', $repository,
    '-ControllerSha', $sha,
    '-CiWorkflowName', $ciWorkflow
  )
  Invoke-Bootstrap -Arguments ($arguments + '-DryRun')
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $temp '.github\workflows\agent-health.yml'))) 'Dry run wrote a target workflow.'
  Invoke-Bootstrap -Arguments $arguments

  foreach ($name in $names) {
    $actual = Get-Content -LiteralPath (Join-Path $temp ".github\workflows\$name") -Raw
    $expected = Get-Content -LiteralPath (Join-Path $TemplateRoot $name) -Raw
    $expected = $expected.Replace('{{CONTROLLER_REPOSITORY}}', $repository)
    $expected = $expected.Replace('{{CONTROLLER_SHA}}', $sha)
    $expected = $expected.Replace('{{CI_WORKFLOW_NAME}}', $ciWorkflow)
    Assert-True ($actual -ceq $expected) "First render of $name did not exactly match its template."
  }

  $rendered = ($names | ForEach-Object {
    Get-Content -LiteralPath (Join-Path $temp ".github\workflows\$_") -Raw
  }) -join "`n"
  Assert-True ($rendered -match [Regex]::Escape("$repository/.github/workflows/")) 'Generated YAML omitted the controller repository.'
  $immutablePin = "@$([Regex]::Escape($sha))"
  Assert-True ($rendered -match $immutablePin) 'Generated YAML omitted the immutable controller SHA.'
  Assert-True ($rendered -notmatch 'controller_sha|worker_id|runner_labels_json') 'Generated YAML exposes controller or runner selection to callers.'
  Assert-True ($rendered -notmatch 'with:\s*\r?\n\s*repository:') 'Generated YAML exposes a reusable repository input.'
  Assert-True ($rendered -match 'role: review' -and $rendered -match 'role: change') 'Health workflow did not keep separate roles.'
  Assert-True ($rendered -match 'ci_workflow_name: \$\{\{ vars\.DSH_AUTOMATION_CI_WORKFLOW \}\}') 'CI repair or rework did not pass DSH_AUTOMATION_CI_WORKFLOW.'
  Assert-True ($rendered -match 'recover-backlog\.yml') 'Generated YAML omitted recovery.'
  $issuesWorkflow = Get-Content -LiteralPath (Join-Path $temp '.github\workflows\agent-issues.yml') -Raw
  foreach ($permission in @('actions: read', 'checks: read', 'contents: write', 'issues: write', 'pull-requests: write')) {
    Assert-True ($issuesWorkflow -match "(?m)^  $([Regex]::Escape($permission))\r?$") "Agent Issues omitted caller permission $permission."
  }
  $landingWorkflow = Get-Content -LiteralPath (Join-Path $temp '.github\workflows\agent-pr-land.yml') -Raw
  foreach ($permission in @('actions: read', 'checks: read', 'contents: write', 'issues: read', 'pull-requests: write')) {
    Assert-True ($landingWorkflow -match "(?m)^  $([Regex]::Escape($permission))\r?$") "Agent PR Landing omitted caller permission $permission."
  }
  $reviewWorkflow = Get-Content -LiteralPath (Join-Path $temp '.github\workflows\agent-pr-review.yml') -Raw
  Assert-True ($reviewWorkflow -match '(?m)^  checks: write\r?$') 'Agent PR Review cannot create its exact-head CheckRun.'
  Assert-True ($reviewWorkflow -notmatch 'repository_dispatch|statuses: write|dsh-review') 'Agent PR Review retained a mutable or obsolete review trigger.'
  $recoveryWorkflow = Get-Content -LiteralPath (Join-Path $temp '.github\workflows\agent-recovery.yml') -Raw
  Assert-True ($recoveryWorkflow -match '(?m)^    workflows: \[Agent Issues, Agent PR Rework, Agent PR Review\]\r?$') 'Agent Recovery listens beyond the three trusted agent entry workflows.'

  & git -C $temp add .github/workflows
  & git -C $temp -c user.name=Bootstrap -c user.email=bootstrap@example.invalid commit -qm 'bootstrap fixtures'
  if ($LASTEXITCODE -ne 0) { throw 'Could not commit bootstrap fixtures.' }
  Invoke-Bootstrap -Arguments $arguments
  $status = (& git -C $temp status --porcelain)
  Assert-True ([string]::IsNullOrWhiteSpace(($status -join "`n"))) 'Idempotent rerun changed a generated workflow.'

  Add-Content -LiteralPath (Join-Path $temp '.github\workflows\agent-health.yml') -Value '# local edit'
  Invoke-Bootstrap -Arguments $arguments -ExpectedExitCode 1
  Invoke-Bootstrap -Arguments ($arguments + '-Update')
  & git -C $temp diff --exit-code
  if ($LASTEXITCODE -ne 0) { throw 'Explicit update did not restore the exact generated workflow.' }

  Invoke-Bootstrap -Arguments @(
    '-TargetCheckout', $temp,
    '-ControllerRepository', $repository,
    '-ControllerSha', 'main',
    '-CiWorkflowName', $ciWorkflow
  ) -ExpectedExitCode 1
  Invoke-Bootstrap -Arguments @(
    '-TargetCheckout', (Join-Path $temp '.github'),
    '-ControllerRepository', $repository,
    '-ControllerSha', $sha,
    '-CiWorkflowName', $ciWorkflow
  ) -ExpectedExitCode 1

  Write-Output 'bootstrap-repository tests passed.'
} finally {
  if (Test-Path -LiteralPath $temp) {
    Remove-Item -LiteralPath $temp -Recurse -Force
  }
}
