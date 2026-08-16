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
$ProfileTemplate = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\profiles\github-pr-cycle\profile.json')).Path
$sha = '0123456789abcdef0123456789abcdef01234567'
$repository = 'Ornn8/dsh-agent-automation'
$upstreamRepository = 'deepseek-ai/deepseek-harness'
$ciWorkflows = @('Target CI', 'Security')
$names = @(
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
$temp = Join-Path ([IO.Path]::GetTempPath()) "dsh-bootstrap-$([Guid]::NewGuid().ToString('N'))"
$promotionRecord = Join-Path ([IO.Path]::GetTempPath()) "dsh-controller-release-$([Guid]::NewGuid().ToString('N')).json"
$faultRecord = Join-Path ([IO.Path]::GetTempPath()) "dsh-controller-fault-$([Guid]::NewGuid().ToString('N')).json"

try {
  [IO.Directory]::CreateDirectory($temp) | Out-Null
  & git -C $temp init -q
  if ($LASTEXITCODE -ne 0) { throw 'git init failed.' }

  [IO.File]::WriteAllText($promotionRecord, (ConvertTo-Json -InputObject @{
    version = 1
    stableRevision = $sha
    pendingRevisions = @()
  }), [Text.UTF8Encoding]::new($false))
  $arguments = @(
    '-TargetCheckout', $temp,
    '-ControllerRepository', $repository,
    '-ControllerSha', $sha,
    '-CiWorkflowNamesJson', (ConvertTo-Json -InputObject @($ciWorkflows) -Compress),
    '-UpstreamRepository', $upstreamRepository,
    '-PromotionRecordPath', $promotionRecord
  )
  $dryRunOutput = @(Invoke-Bootstrap -Arguments ($arguments + '-DryRun'))
  $planLine = @($dryRunOutput | Where-Object { $_ -is [string] -and $_.StartsWith('AUTOMATION_BOOTSTRAP_PLAN_JSON=') })
  Assert-True ($planLine.Count -eq 1) 'Dry run did not emit exactly one versioned bootstrap plan.'
  $plan = $planLine[0].Substring('AUTOMATION_BOOTSTRAP_PLAN_JSON='.Length) | ConvertFrom-Json -Depth 16
  Assert-True ($plan.schemaVersion -eq 1 -and $plan.kind -ceq 'agent-automation-bootstrap') 'Bootstrap plan identity is invalid.'
  Assert-True (@($plan.workflows).Count -eq $names.Count) 'Bootstrap plan does not cover every target workflow.'
  Assert-True (@($plan.workflows | Where-Object action -eq 'would-write').Count -eq $names.Count) 'Bootstrap plan actions do not match an empty target checkout.'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $temp '.github\workflows\agent-health.yml'))) 'Dry run wrote a target workflow.'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $temp '.github\agent-automation\profiles\github-pr-cycle.json'))) 'Dry run wrote a target Profile.'
  Invoke-Bootstrap -Arguments $arguments

  $templateNames = @(Get-ChildItem -LiteralPath $TemplateRoot -File | ForEach-Object Name | Sort-Object)
  Assert-True ((@($names | Sort-Object) -join ',') -ceq ($templateNames -join ',')) 'Bootstrap workflow manifest does not exactly match target templates.'

  foreach ($name in $names) {
    $actual = Get-Content -LiteralPath (Join-Path $temp ".github\workflows\$name") -Raw
    $expected = Get-Content -LiteralPath (Join-Path $TemplateRoot $name) -Raw
    $expected = $expected.Replace('{{CONTROLLER_REPOSITORY}}', $repository)
    $expected = $expected.Replace('{{CONTROLLER_SHA}}', $sha)
    $expected = $expected.Replace('{{CI_WORKFLOW_NAMES_JSON}}', (ConvertTo-Json -InputObject @($ciWorkflows) -Compress))
    $expected = $expected.Replace('{{UPSTREAM_REPOSITORY}}', $upstreamRepository)
    Assert-True ($actual -ceq $expected) "First render of $name did not exactly match its template."
  }
  $renderedProfile = Get-Content -LiteralPath (Join-Path $temp '.github\agent-automation\profiles\github-pr-cycle.json') -Raw
  $expectedProfile = Get-Content -LiteralPath $ProfileTemplate -Raw
  Assert-True ($renderedProfile -ceq $expectedProfile) 'Rendered target Profile did not exactly match the bundled default Profile.'

  $rendered = ($names | ForEach-Object {
    Get-Content -LiteralPath (Join-Path $temp ".github\workflows\$_") -Raw
  }) -join "`n"
  Assert-True ($rendered -match [Regex]::Escape("$repository/.github/workflows/")) 'Generated YAML omitted the controller repository.'
  $immutablePin = "@$([Regex]::Escape($sha))"
  Assert-True ($rendered -match $immutablePin) 'Generated YAML omitted the immutable controller SHA.'
  Assert-True ($rendered -notmatch 'controller_sha|worker_id|runner_labels_json') 'Generated YAML exposes controller or runner selection to callers.'
  Assert-True ($rendered -notmatch 'with:\s*\r?\n\s*repository:') 'Generated YAML exposes a reusable repository input.'
  Assert-True ($rendered -match 'role: review' -and $rendered -match 'role: change') 'Health workflow did not keep separate roles.'
  $healthWorkflow = Get-Content -LiteralPath (Join-Path $temp '.github\workflows\agent-health.yml') -Raw
  Assert-True ($healthWorkflow -match 'runner-watchdog\.yml') 'Health workflow omitted the GitHub-hosted queue watchdog.'
  Assert-True ($healthWorkflow -match "(?m)^    - cron: '29 3 \* \* \*'\r?$") 'Health workflow omitted the daily provider canary.'
  Assert-True ($rendered -match 'ci_workflow_name: \$\{\{ github\.event\.workflow_run\.name \}\}') 'CI repair did not pass the exact failed workflow name.'
  foreach ($name in @('agent-pr-ci-repair.yml', 'agent-pr-land.yml')) {
    $workflow = Get-Content -LiteralPath (Join-Path $temp ".github\workflows\$name") -Raw
    $workflowList = ConvertTo-Json -InputObject @($ciWorkflows) -Compress
    Assert-True ($workflow -match "(?m)^    workflows: $([Regex]::Escape($workflowList))\r?$") "$name does not subscribe workflow_run to the rendered CI workflow names."
    Assert-True ($workflow -match 'contains\(fromJSON\(vars\.DSH_AUTOMATION_CI_WORKFLOWS\), github\.event\.workflow_run\.name\)') "$name does not retain its configured CI workflow membership check."
  }
  $landingReconcileWorkflow = Get-Content -LiteralPath (Join-Path $temp '.github\workflows\agent-landing-reconcile.yml') -Raw
  Assert-True ($landingReconcileWorkflow -match "(?m)^    - cron: '8-59/15 \* \* \* \*'\r?$") 'Landing reconciliation omitted its hosted 15-minute schedule.'
  Assert-True ($landingReconcileWorkflow -match [Regex]::Escape("uses: $repository/.github/workflows/reconcile-landing.yml@$sha")) 'Landing reconciliation omitted the immutable controller workflow.'
  Assert-True ($landingReconcileWorkflow -notmatch 'self-hosted') 'Landing reconciliation must stay GitHub-hosted.'
  Assert-True ($rendered -match 'recover-backlog\.yml') 'Generated YAML omitted recovery.'
  $supervisionWorkflow = Get-Content -LiteralPath (Join-Path $temp '.github\workflows\agent-repository-supervision.yml') -Raw
  Assert-True ($supervisionWorkflow -match '(?m)^    - cron: ''17 \*/6 \* \* \*''\r?$') 'Repository supervision omitted its offset six-hour schedule.'
  Assert-True ($supervisionWorkflow -match [Regex]::Escape("upstream_repository: $upstreamRepository")) 'Repository supervision omitted the rendered upstream repository.'
  Assert-True ($supervisionWorkflow -match [Regex]::Escape("uses: $repository/.github/workflows/repository-supervisor.yml@$sha")) 'Repository supervision omitted the immutable controller workflow.'
  Assert-True ($supervisionWorkflow -match [Regex]::Escape("apply_changes: `${{ github.event_name == 'schedule' || inputs.apply_changes }}")) 'Repository supervision did not keep manual dry-run and scheduled apply behavior separate.'
  Assert-True ($supervisionWorkflow -match '(?m)^  contents: write\r?$') 'Repository supervision cannot emit the deterministic Issue dispatch.'
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
  Assert-True ($reviewWorkflow -match '(?m)^  repository_dispatch:\r?$') 'Agent PR Review lacks the GitHub-token recursion-safe review trigger.'
  Assert-True ($reviewWorkflow -match '(?m)^    types: \[agent-review\]\r?$') 'Agent PR Review lacks the exact agent-review dispatch type.'
  Assert-True ($reviewWorkflow -notmatch 'statuses: write|dsh-review') 'Agent PR Review retained an obsolete review trigger or permission.'
  Assert-True ($issuesWorkflow -match '(?m)^    types: \[agent_work_requested, agent_backlog_reconcile, automation_fault_recovered\]\r?$') 'Agent Issues lacks the generic WorkRequest, reconciliation, and fault-resume triggers.'
  $recoveryWorkflow = Get-Content -LiteralPath (Join-Path $temp '.github\workflows\agent-recovery.yml') -Raw
  Assert-True ($recoveryWorkflow -match '(?m)^    workflows: \[Agent Issues, Agent PR Rework, Agent PR CI Repair, Agent PR Review\]\r?$') 'Agent Recovery must include each trusted model-backed entry workflow.'
  Assert-True ($recoveryWorkflow -match [Regex]::Escape('contains(fromJSON(''["failure", "cancelled", "timed_out", "startup_failure", "stale"]''), github.event.workflow_run.conclusion)')) 'Agent Recovery must retain every terminal infrastructure conclusion.'

  & git -C $temp add .github
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

  Add-Content -LiteralPath (Join-Path $temp '.github\workflows\agent-health.yml') -Value '# committed stale render'
  & git -C $temp add .github/workflows/agent-health.yml
  & git -C $temp -c user.name=Bootstrap -c user.email=bootstrap@example.invalid commit -qm 'stale health fixture'
  if ($LASTEXITCODE -ne 0) { throw 'Could not commit stale health fixture.' }
  Add-Content -LiteralPath (Join-Path $temp '.github\workflows\agent-recovery.yml') -Value '# later local edit'
  $beforeFailedPreflight = @{}
  foreach ($name in $names) {
    $path = Join-Path $temp ".github\workflows\$name"
    $beforeFailedPreflight[$name] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
  }
  Invoke-Bootstrap -Arguments $arguments -ExpectedExitCode 1
  foreach ($name in $names) {
    $path = Join-Path $temp ".github\workflows\$name"
    $actual = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
    Assert-True ($actual -ceq $beforeFailedPreflight[$name]) "Failed dirty-overlap preflight changed $name."
  }

  Invoke-Bootstrap -Arguments @(
    '-TargetCheckout', $temp,
    '-ControllerRepository', $repository,
    '-ControllerSha', 'main',
    '-CiWorkflowNamesJson', (ConvertTo-Json -InputObject @($ciWorkflows) -Compress),
    '-UpstreamRepository', $upstreamRepository
  ) -ExpectedExitCode 1
  Invoke-Bootstrap -Arguments @(
    '-TargetCheckout', (Join-Path $temp '.github'),
    '-ControllerRepository', $repository,
    '-ControllerSha', $sha,
    '-CiWorkflowNamesJson', (ConvertTo-Json -InputObject @($ciWorkflows) -Compress),
    '-UpstreamRepository', $upstreamRepository
  ) -ExpectedExitCode 1
  Invoke-Bootstrap -Arguments @(
    '-TargetCheckout', $temp,
    '-ControllerRepository', $repository,
    '-ControllerSha', $sha,
    '-CiWorkflowNamesJson', (ConvertTo-Json -InputObject @($ciWorkflows) -Compress),
    '-UpstreamRepository', 'not-a-repository'
  ) -ExpectedExitCode 1
  Invoke-Bootstrap -Arguments @(
    '-TargetCheckout', $temp,
    '-ControllerRepository', $repository,
    '-ControllerSha', $sha,
    '-CiWorkflowNamesJson', '{not-json}',
    '-UpstreamRepository', $upstreamRepository
  ) -ExpectedExitCode 1
  Invoke-Bootstrap -Arguments @(
    '-TargetCheckout', $temp,
    '-ControllerRepository', $repository,
    '-ControllerSha', $sha,
    '-CiWorkflowNamesJson', '["CI","CI"]',
    '-UpstreamRepository', $upstreamRepository
  ) -ExpectedExitCode 1
  $faultBoundSha = '1' * 40
  [IO.File]::WriteAllText($faultRecord, (ConvertTo-Json -Depth 8 -InputObject @{
    version = 1
    status = 'verifying'
    publishedSha = $faultBoundSha
    repairPullRequest = 17
    epochs = @(@{ number = 1 })
    attempts = @(
      @{ epoch = 1; kind = 'review'; outcome = 'succeeded' },
      @{ epoch = 1; kind = 'ci'; outcome = 'succeeded' },
      @{ epoch = 1; kind = 'promotion'; outcome = 'succeeded' }
    )
  }), [Text.UTF8Encoding]::new($false))
  Invoke-Bootstrap -Arguments @(
    '-TargetCheckout', $temp,
    '-ControllerRepository', $repository,
    '-ControllerSha', $faultBoundSha,
    '-CiWorkflowNamesJson', (ConvertTo-Json -InputObject @($ciWorkflows) -Compress),
    '-UpstreamRepository', $upstreamRepository,
    '-PromotionRecordPath', $promotionRecord,
    '-FaultRecordPath', $faultRecord,
    '-Update',
    '-DryRun'
  )
  [IO.File]::WriteAllText($faultRecord, (Get-Content -LiteralPath $faultRecord -Raw).Replace('"status": "verifying"', '"status": "circuit-open"'), [Text.UTF8Encoding]::new($false))
  Invoke-Bootstrap -Arguments @(
    '-TargetCheckout', $temp,
    '-ControllerRepository', $repository,
    '-ControllerSha', $faultBoundSha,
    '-CiWorkflowNamesJson', (ConvertTo-Json -InputObject @($ciWorkflows) -Compress),
    '-UpstreamRepository', $upstreamRepository,
    '-PromotionRecordPath', $promotionRecord,
    '-FaultRecordPath', $faultRecord,
    '-Update',
    '-DryRun'
  ) -ExpectedExitCode 1
  Invoke-Bootstrap -Arguments @(
    '-TargetCheckout', $temp,
    '-ControllerRepository', $repository,
    '-ControllerSha', ('1' * 40),
    '-CiWorkflowNamesJson', (ConvertTo-Json -InputObject @($ciWorkflows) -Compress),
    '-UpstreamRepository', $upstreamRepository,
    '-PromotionRecordPath', $promotionRecord
  ) -ExpectedExitCode 1
  [IO.File]::WriteAllText($promotionRecord, (ConvertTo-Json -InputObject @{
    version = 1
    stableRevision = $sha
    pendingRevisions = @()
    unexpected = $true
  }), [Text.UTF8Encoding]::new($false))
  Invoke-Bootstrap -Arguments $arguments -ExpectedExitCode 1

  Write-Output 'bootstrap-repository tests passed.'
} finally {
  if (Test-Path -LiteralPath $temp) {
    Remove-Item -LiteralPath $temp -Recurse -Force
  }
  if (Test-Path -LiteralPath $promotionRecord) {
    Remove-Item -LiteralPath $promotionRecord -Force
  }
  if (Test-Path -LiteralPath $faultRecord) {
    Remove-Item -LiteralPath $faultRecord -Force
  }
}
