BeforeAll {
  $script:RepositoryRoot = Split-Path -Parent $PSScriptRoot
  Import-Module (Join-Path $script:RepositoryRoot 'ops\Automation.Operations.psm1') -Force
}

Describe 'Branch protection authority migration' {
  It 'keeps every configured required check distinct from review authority' {
    $names = Get-RequiredCheckNames -Mapping ([pscustomobject]@{ requiredChecks = @('lint', 'unit', 'e2e') })

    ($names -join '|') | Should -BeExactly 'lint|unit|e2e|agent/review'
  }

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
    $required = @('all checks passed', 'agent/review')
    $payload = New-BranchProtectionBootstrapPayload -RequiredNames $required
    $payload.required_status_checks.strict | Should -BeTrue
    @($payload.required_status_checks.contexts) | Should -Be $required
    $payload.required_status_checks.psobject.Properties.Name | Should -Not -Contain 'checks'
    $payload.enforce_admins | Should -BeTrue
    $payload.required_pull_request_reviews | Should -BeNullOrEmpty
    $payload.restrictions | Should -BeNullOrEmpty
    $payload.allow_force_pushes | Should -BeFalse
    $payload.allow_deletions | Should -BeFalse
  }

  It 'reads final HTTP status from headers and GitHub CLI stderr without accepting body numbers' -Skip:(-not $IsWindows) {
    $fakeGh = Join-Path $TestDrive 'fake-gh-http-error.cmd'
    [IO.File]::WriteAllText($fakeGh, "@echo off`r`n1>&2 echo HTTP/2.0 301 Moved Permanently`r`n1>&2 echo gh: Not Found (HTTP 404)`r`nexit /b 1`r`n", [Text.Encoding]::ASCII)

    Get-GhApiHttpStatus -Endpoint 'repos/owner/repository/branches/main/protection' -GhExecutable $fakeGh | Should -Be 404

    [IO.File]::WriteAllText($fakeGh, "@echo off`r`n1>&2 echo gh: Forbidden (HTTP 403)`r`nexit /b 1`r`n", [Text.Encoding]::ASCII)

    Get-GhApiHttpStatus -Endpoint 'repos/owner/repository/branches/main/protection' -GhExecutable $fakeGh | Should -Be 403

    [IO.File]::WriteAllText($fakeGh, "@echo off`r`n1>&2 echo response body 404`r`n1>&2 echo other (HTTP 403)`r`nexit /b 1`r`n", [Text.Encoding]::ASCII)

    { Get-GhApiHttpStatus -Endpoint 'repos/owner/repository/branches/main/protection' -GhExecutable $fakeGh } | Should -Throw 'Could not determine an HTTP status*'
  }
}

Describe 'Installer and uninstaller fail-closed guards' {
  It 'accepts the exact legacy runtime manifest only during explicit migration' {
    $config = Get-Content (Join-Path $script:RepositoryRoot 'config.minimal.json') -Raw | ConvertFrom-Json -Depth 32
    $dataRoot = Join-Path (Split-Path -Parent $script:RepositoryRoot) "dsh-agent-automation-pester-$([Guid]::NewGuid().ToString('N'))"
    $stateRoot = Join-Path $dataRoot 'state'
    $installRoot = Join-Path $dataRoot 'runtime'
    $config.operations | Add-Member -NotePropertyName installRoot -NotePropertyValue $installRoot
    $config.operations | Add-Member -NotePropertyName stateRoot -NotePropertyValue $stateRoot
    $config.operations | Add-Member -NotePropertyName logsRoot -NotePropertyValue (Join-Path $stateRoot 'logs')
    $configuration = Join-Path $TestDrive 'legacy-runtime-config.json'
    [IO.File]::WriteAllText($configuration, ($config | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))
    $loaded = Read-OperationsConfig -Configuration $configuration -AllowExamplePlaceholders
    [IO.Directory]::CreateDirectory($stateRoot) | Out-Null
    $runtimeId = 'a' * 64
    $runtimeRoot = Join-Path $installRoot (Join-Path 'operations-runtime' $runtimeId)
    $manifest = [ordered]@{
      schemaVersion = 1
      configPath = $configuration
      registrationScope = 'target-repositories'
      runnerVersion = '2.336.0'
      runnerSha256 = 'B' * 64
      installRoot = $installRoot
      stateRoot = $stateRoot
      logsRoot = (Join-Path $stateRoot 'logs')
      operationsRuntime = [ordered]@{
        id = $runtimeId
        root = $runtimeRoot
        files = @(
          [ordered]@{ name = 'Automation.Operations.psm1'; sha256 = '1' * 64 },
          [ordered]@{ name = 'dsh-web-host-supervisor.ps1'; sha256 = '2' * 64 },
          [ordered]@{ name = 'runner-supervisor.ps1'; sha256 = '3' * 64 }
        )
      }
      instances = @()
      dshWebManaged = $false
      updatedAtUtc = '2026-08-16T00:00:00Z'
    }
    [IO.File]::WriteAllText((Join-Path $stateRoot 'install-manifest.json'), ($manifest | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))

    { Read-InstallManifest -Loaded $loaded } | Should -Throw '*operations runtime fields are invalid*'
    (Read-InstallManifest -Loaded $loaded -AllowLegacyRuntime).operationsRuntime.id | Should -BeExactly $runtimeId
    Remove-Item -LiteralPath $dataRoot -Recurse -Force
  }

  It 'rejects runner versions that predate job.workflow_*' {
    $config = Get-Content (Join-Path $script:RepositoryRoot 'config.minimal.json') -Raw | ConvertFrom-Json -Depth 32
    $config.operations.runner.version = '2.333.0'
    $config.operations | Add-Member -NotePropertyName installRoot -NotePropertyValue 'F:\test-agent-automation\runtime'
    $config.operations | Add-Member -NotePropertyName stateRoot -NotePropertyValue 'F:\test-agent-automation\state'
    $config.operations | Add-Member -NotePropertyName logsRoot -NotePropertyValue 'F:\test-agent-automation\state\logs'
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

Describe 'Effective configuration explanation' {
  It 'resolves maintenance workers from the role binding used by online doctor' {
    $doctor = Get-Content -LiteralPath (Join-Path $script:RepositoryRoot 'scripts\doctor.ps1') -Raw

    $doctor | Should -Match '\$loaded\.Config\.operations\.roles\.maintenance\.workers'
    $doctor | Should -Not -Match '\$loaded\.Config\.maintenanceWorkers'
  }

  It 'emits one structured offline explanation through doctor' {
    $configuration = Join-Path $script:RepositoryRoot 'config.minimal.json'
    (Get-Content -LiteralPath $configuration -Raw | Test-Json -SchemaFile (Join-Path $script:RepositoryRoot 'ops\config.schema.json')) | Should -BeTrue

    $output = @(& pwsh -NoProfile -File (Join-Path $script:RepositoryRoot 'scripts\doctor.ps1') `
      -Configuration $configuration -Explain -DryRun)

    $LASTEXITCODE | Should -Be 0
    $structured = @($output | Where-Object { $_ -like 'AUTOMATION_CONFIGURATION_EXPLAIN_JSON=*' })
    $structured | Should -HaveCount 1
    $records = @($structured[0].Substring('AUTOMATION_CONFIGURATION_EXPLAIN_JSON='.Length) | ConvertFrom-Json -Depth 16)
    @($records | Where-Object { $_.Path -eq 'configurationHash' -and $_.SourceType -eq 'derived' }) | Should -HaveCount 1
  }

  It 'reports configuration, default, derived, and repository-variable sources' {
    $configuration = Join-Path $script:RepositoryRoot 'config.minimal.json'
    $loaded = Read-OperationsConfig -Configuration $configuration -AllowExamplePlaceholders
    $resolver = {
      param($Repository, $Name)
      switch ($Name) {
        'DSH_AUTOMATION_CI_WORKFLOWS' { return [pscustomobject]@{ Found = $true; Value = '["Remote CI"]' } }
        'DSH_AUTOMATION_REQUIRED_CHECKS' { return [pscustomobject]@{ Found = $true; Value = '["remote/gate"]' } }
        default { return [pscustomobject]@{ Found = $true; Value = 'maintenance-replica' } }
      }
    }

    $rows = @(Get-ConfigurationExplanation -Loaded $loaded -RepositoryVariableResolver $resolver)
    $configured = @($rows | Where-Object Path -CEQ 'operations.repositoryMappings[0].repository')
    $configured | Should -HaveCount 1
    $configured[0].SourceType | Should -BeExactly 'configuration'
    $configured[0].Source | Should -BeExactly ([IO.Path]::GetFullPath($configuration))
    $configured[0].Line | Should -Be 22

    $defaulted = @($rows | Where-Object Path -CEQ 'ghExecutable')
    $defaulted | Should -HaveCount 1
    $defaulted[0].SourceType | Should -BeExactly 'default'
    $defaulted[0].Line | Should -Be 3

    $derived = @($rows | Where-Object Path -CEQ 'workers.change.mode')
    $derived | Should -HaveCount 1
    $derived[0].SourceType | Should -BeExactly 'derived'
    $derived[0].Line | Should -BeNullOrEmpty

    $nodeHash = & node --input-type=module -e "import { readMachineConfig } from './src/machine-config.mjs'; console.log((await readMachineConfig(process.argv[1])).configurationHash)" $configuration
    $LASTEXITCODE | Should -Be 0
    $loaded.Config.configurationHash | Should -BeExactly $nodeHash.Trim()
    @($rows | Where-Object Path -CEQ 'configurationHash').SourceType | Should -BeExactly 'derived'

    $overridden = @($rows | Where-Object Path -CEQ 'operations.repositoryMappings[0].ciWorkflows')
    $overridden | Should -HaveCount 1
    $overridden[0].DeclaredValue | Should -BeExactly '["CI"]'
    $overridden[0].Value | Should -BeExactly '["Remote CI"]'
    $overridden[0].SourceType | Should -BeExactly 'repository-variable'
    $overridden[0].Override | Should -BeTrue
    $overridden[0].Source | Should -BeExactly 'github:REPLACE/target:DSH_AUTOMATION_CI_WORKFLOWS'
  }

  It 'reports a missing required repository variable without treating it as an override' {
    $loaded = Read-OperationsConfig -Configuration (Join-Path $script:RepositoryRoot 'config.minimal.json') -AllowExamplePlaceholders
    $resolver = { param($Repository, $Name) [pscustomobject]@{ Found = $false; Value = $null } }

    $rows = @(Get-ConfigurationExplanation -Loaded $loaded -RepositoryVariableResolver $resolver)
    $missing = @($rows | Where-Object Status -CEQ 'missing')

    $missing | Should -HaveCount 3
    @($missing | Where-Object Override) | Should -HaveCount 0
  }
}
