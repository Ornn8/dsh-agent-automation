BeforeAll {
  $script:RepositoryRoot = Split-Path -Parent $PSScriptRoot
  Import-Module (Join-Path $script:RepositoryRoot 'ops\Automation.Operations.psm1') -Force
}

Describe 'Branch protection authority migration' {
  It 'replaces only the reserved legacy review authority and preserves unrelated requirements' {
    $current = [pscustomobject]@{
      strict = $false
      contexts = @('legacy/status', 'codex/review')
      checks = @(
        [pscustomobject]@{ context = 'third-party/check'; app_id = 99 },
        [pscustomobject]@{ context = 'codex/review'; app_id = 15368 },
        [pscustomobject]@{ context = 'all checks passed'; app_id = -1 }
      )
    }
    $required = @('all checks passed', 'agent/review')

    $actual = Merge-RequiredStatusChecks -Current $current -RequiredNames $required

    $actual.strict | Should -BeTrue
    @($actual.contexts) | Should -Contain 'legacy/status'
    @($actual.contexts) | Should -Not -Contain 'codex/review'
    @($actual.checks | Where-Object context -eq 'codex/review') | Should -HaveCount 0
    @($actual.checks | Where-Object { $_.context -eq 'third-party/check' -and $_.app_id -eq 99 }) | Should -HaveCount 1
    foreach ($name in $required) {
      @($actual.checks | Where-Object { $_.context -eq $name -and $_.app_id -eq 15368 }) | Should -HaveCount 1
    }
  }

  It 'is idempotent and rejects a surviving legacy authority during readback' {
    $required = @('all checks passed', 'agent/review')
    $initial = [pscustomobject]@{ strict = $false; contexts = @(); checks = @() }
    $once = Merge-RequiredStatusChecks -Current $initial -RequiredNames $required
    $twice = Merge-RequiredStatusChecks -Current $once -RequiredNames $required
    ($twice | ConvertTo-Json -Compress -Depth 8) | Should -BeExactly ($once | ConvertTo-Json -Compress -Depth 8)

    $stale = [pscustomobject]@{ strict = $true; contexts = @('codex/review'); checks = $once.checks }
    (Test-RequiredStatusChecks -Current $stale -RequiredNames $required).Ok | Should -BeFalse
  }

  It 'creates minimal branch protection without enabling destructive branch operations' {
    $payload = New-BranchProtectionBootstrapPayload -RequiredNames @('all checks passed', 'agent/review')
    $payload.enforce_admins | Should -BeTrue
    $payload.required_pull_request_reviews | Should -BeNullOrEmpty
    $payload.restrictions | Should -BeNullOrEmpty
    $payload.allow_force_pushes | Should -BeFalse
    $payload.allow_deletions | Should -BeFalse
  }
}

Describe 'Installer and uninstaller fail-closed guards' {
  It 'rejects runner versions that predate job.workflow_*' {
    $config = Get-Content (Join-Path $script:RepositoryRoot 'config.example.json') -Raw | ConvertFrom-Json -Depth 32
    $config.operations.runner.version = '2.333.0'
    $path = Join-Path $TestDrive 'old-runner.json'
    [IO.File]::WriteAllText($path, ($config | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))
    { Read-OperationsConfig -Configuration $path -AllowExamplePlaceholders } | Should -Throw '*at least 2.334.0*'
  }

  It 'requires explicit uninstall confirmation before reading configuration' {
    $missing = Join-Path $TestDrive 'missing.json'
    $output = & pwsh -NoProfile -File (Join-Path $script:RepositoryRoot 'scripts\uninstall.ps1') -Configuration $missing 2>&1
    $LASTEXITCODE | Should -Not -Be 0
    ($output | Out-String) | Should -Match 'Uninstall requires -ConfirmRemoval'
  }

  It 'rejects migration confirmation without migration mode' {
    $missing = Join-Path $TestDrive 'missing.json'
    $output = & pwsh -NoProfile -File (Join-Path $script:RepositoryRoot 'scripts\install.ps1') `
      -Configuration $missing -DryRun -ConfirmMigration 2>&1
    $LASTEXITCODE | Should -Not -Be 0
    ($output | Out-String) | Should -Match 'ConfirmMigration requires -Migrate'
  }
}
