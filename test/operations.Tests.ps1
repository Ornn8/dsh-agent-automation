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
  It 'rejects a repository mapping that selects the Controller itself, regardless of case' {
    $config = Get-Content (Join-Path $script:RepositoryRoot 'config.minimal.json') -Raw | ConvertFrom-Json -Depth 32
    $config.operations.controller.repository = 'Ornn8/dsh-agent-automation'
    $config.operations.repositoryMappings[0].repository = 'ornn8/DSH-AGENT-AUTOMATION'
    $config.operations | Add-Member -NotePropertyName installRoot -NotePropertyValue (Join-Path $script:RepositoryRoot '.test-controller-self-target-runtime')
    $config.operations | Add-Member -NotePropertyName stateRoot -NotePropertyValue (Join-Path $script:RepositoryRoot '.test-controller-self-target-state')
    $config.operations | Add-Member -NotePropertyName logsRoot -NotePropertyValue (Join-Path $config.operations.stateRoot 'logs')
    $path = Join-Path $TestDrive 'controller-self-target.json'
    [IO.File]::WriteAllText($path, ($config | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))

    { Read-OperationsConfig -Configuration $path -AllowExamplePlaceholders } | Should -Throw '*repositoryMappings must not target the controller repository*'
  }

  It 'accepts an ordinary product repository mapping' {
    $config = Get-Content (Join-Path $script:RepositoryRoot 'config.minimal.json') -Raw | ConvertFrom-Json -Depth 32
    $config.operations.controller.repository = 'Ornn8/dsh-agent-automation'
    $config.operations.repositoryMappings[0].repository = 'Ornn8/shanyin-tea-commerce'
    $config.operations | Add-Member -NotePropertyName installRoot -NotePropertyValue (Join-Path $script:RepositoryRoot '.test-product-target-runtime')
    $config.operations | Add-Member -NotePropertyName stateRoot -NotePropertyValue (Join-Path $script:RepositoryRoot '.test-product-target-state')
    $config.operations | Add-Member -NotePropertyName logsRoot -NotePropertyValue (Join-Path $config.operations.stateRoot 'logs')
    $path = Join-Path $TestDrive 'product-target.json'
    [IO.File]::WriteAllText($path, ($config | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))

    $loaded = Read-OperationsConfig -Configuration $path -AllowExamplePlaceholders
    @($loaded.Config.repositories) | Should -BeExactly @('Ornn8/shanyin-tea-commerce')
  }

  It 'authorizes destructive review cleanup only for a registered review workspace' {
    $stateRoot = Join-Path $TestDrive 'state'
    $registered = Join-Path $stateRoot 'workspaces\target-owner-repository-a1b2c3d4e5f6-review'
    $instance = [pscustomobject]@{
      Id = 'target-owner-repository-a1b2c3d4e5f6-review'
      Role = 'review'
      WorkspaceSlot = $registered
    }

    (Assert-RegisteredReviewWorkspace -Path $registered -StateRoot $stateRoot -Instances @($instance)) | Should -BeExactly ([IO.Path]::GetFullPath($registered))
    { Assert-RegisteredReviewWorkspace -Path (Join-Path $stateRoot 'projects\owner\repository') -StateRoot $stateRoot -Instances @($instance) } | Should -Throw '*registered review workspace*'
    { Assert-RegisteredReviewWorkspace -Path (Join-Path $stateRoot '..\outside') -StateRoot $stateRoot -Instances @($instance) } | Should -Throw '*inside*'
  }

  It 'reclaims a dead review lease without touching the registered workspace' {
    $stateRoot = Join-Path $TestDrive 'lease-state'
    $paths = Get-ReviewWorkspacePaths -StateRoot $stateRoot -InstanceId 'target-owner-repository-a1b2c3d4e5f6-review'
    [IO.Directory]::CreateDirectory($paths.Directory) | Out-Null
    [IO.Directory]::CreateDirectory((Split-Path -Parent $paths.LeaseFile)) | Out-Null
    $instance = [pscustomobject]@{ Id = $paths.SlotId; Role = 'review'; WorkspaceSlot = $paths.Directory; WorkspaceLease = $paths.LeaseFile }
    $lease = [ordered]@{
      slotId = $paths.SlotId
      pid = 2147483647
      workRequestId = 'review-pr-1-base-head'
      repository = 'owner/repository'
      acquiredAt = '2026-08-17T00:00:00.000Z'
      expiresAt = '2026-08-17T01:00:00.000Z'
    }
    [IO.File]::WriteAllText($paths.LeaseFile, ($lease | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))

    $result = Remove-StaleReviewWorkspaceLease -Instance $instance -StateRoot $stateRoot -Now ([DateTimeOffset]'2026-08-17T00:30:00Z')

    $result.State | Should -BeExactly 'reclaimed'
    Test-Path -LiteralPath $paths.LeaseFile | Should -BeFalse
    Test-Path -LiteralPath $paths.Directory -PathType Container | Should -BeTrue
  }

  It 'reports the repository currently bound to an available review workspace' {
    $stateRoot = Join-Path $TestDrive 'binding-state'
    $paths = Get-ReviewWorkspacePaths -StateRoot $stateRoot -InstanceId 'target-owner-repository-a1b2c3d4e5f6-review'
    [IO.Directory]::CreateDirectory($paths.Directory) | Out-Null
    [IO.Directory]::CreateDirectory((Split-Path -Parent $paths.LeaseFile)) | Out-Null
    & git -C $paths.Directory init --quiet
    $LASTEXITCODE | Should -Be 0
    & git -C $paths.Directory remote add origin https://github.com/owner/repository.git
    $LASTEXITCODE | Should -Be 0
    $instance = [pscustomobject]@{ Id = $paths.SlotId; Role = 'review'; WorkspaceSlot = $paths.Directory; WorkspaceLease = $paths.LeaseFile }

    $rows = @(Get-ReviewWorkspaceExplanation -Instances @($instance) -StateRoot $stateRoot -GitExecutable git)

    $rows | Should -HaveCount 1
    $rows[0].Status | Should -BeExactly 'available'
    $rows[0].Repository | Should -BeExactly 'owner/repository'
  }

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

Describe 'Worker routing foundation' {
  It 'accepts bounded review pools and resolves deterministic tag candidates' {
    $config = Get-Content (Join-Path $script:RepositoryRoot 'config.minimal.json') -Raw | ConvertFrom-Json -Depth 32
    $secondary = $config.workers.review | ConvertTo-Json -Depth 32 | ConvertFrom-Json -Depth 32
    $secondary | Add-Member -NotePropertyName routingTags -NotePropertyValue @('fast')
    $config.workers | Add-Member -NotePropertyName reviewSecondary -NotePropertyValue $secondary
    $config.operations.roles.review.workers = @('review', 'reviewSecondary')
    $config.operations | Add-Member -NotePropertyName routing -NotePropertyValue ([pscustomobject]@{
        review = [pscustomobject]@{ routes = [pscustomobject]@{
            default = [pscustomobject]@{ selectors = @([pscustomobject]@{ worker = 'review' }) }
            fast = [pscustomobject]@{ selectors = @([pscustomobject]@{ allTags = @('fast') }, [pscustomobject]@{ route = 'default' }) }
        } }
      })
    $fixtureRoot = Join-Path $script:RepositoryRoot '.test-worker-routing'
    $config.operations | Add-Member -NotePropertyName installRoot -NotePropertyValue (Join-Path $fixtureRoot 'runtime') -Force
    $config.operations | Add-Member -NotePropertyName stateRoot -NotePropertyValue (Join-Path $fixtureRoot 'state') -Force
    $config.operations | Add-Member -NotePropertyName logsRoot -NotePropertyValue (Join-Path $fixtureRoot 'state/logs') -Force
    $path = Join-Path $TestDrive 'worker-routing.json'
    [IO.File]::WriteAllText($path, ($config | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))

    $loaded = Read-OperationsConfig -Configuration $path -AllowExamplePlaceholders
    @($loaded.Config.operations.roles.review.workers) | Should -BeExactly @('review', 'reviewSecondary')
    $loaded.Config.workers.review.capacityGroup | Should -BeExactly 'review'
    @((Resolve-WorkerCandidates -Config $loaded.Config -Role review -Route fast)) | Should -BeExactly @('reviewSecondary', 'review')
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
  }

  It 'rejects cyclic routes before installation planning' {
    $config = Get-Content (Join-Path $script:RepositoryRoot 'config.minimal.json') -Raw | ConvertFrom-Json -Depth 32
    $config.operations | Add-Member -NotePropertyName routing -NotePropertyValue ([pscustomobject]@{
        change = [pscustomobject]@{ routes = [pscustomobject]@{
            default = [pscustomobject]@{ selectors = @([pscustomobject]@{ route = 'loop' }) }
            loop = [pscustomobject]@{ selectors = @([pscustomobject]@{ route = 'default' }) }
        } }
      })
    $fixtureRoot = Join-Path $script:RepositoryRoot '.test-worker-routing-cycle'
    $config.operations | Add-Member -NotePropertyName installRoot -NotePropertyValue (Join-Path $fixtureRoot 'runtime') -Force
    $config.operations | Add-Member -NotePropertyName stateRoot -NotePropertyValue (Join-Path $fixtureRoot 'state') -Force
    $config.operations | Add-Member -NotePropertyName logsRoot -NotePropertyValue (Join-Path $fixtureRoot 'state/logs') -Force
    $path = Join-Path $TestDrive 'worker-routing-cycle.json'
    [IO.File]::WriteAllText($path, ($config | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))

    { Read-OperationsConfig -Configuration $path -AllowExamplePlaceholders } | Should -Throw '*contains a cycle*'
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
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
    $reviewWorkspaces = @($records | Where-Object { $_.Path -like 'operations.reviewWorkspaces.*' })
    $reviewWorkspaces | Should -HaveCount 1
    $reviewWorkspaces[0].Status | Should -BeExactly 'planned'
    $reviewWorkspaces[0].Repository | Should -BeExactly '<unbound>'
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

    $missing | Should -HaveCount 4
    @($missing | Where-Object Override) | Should -HaveCount 0
  }
}

Describe 'Owned process record removal races' {
  It 'runs compare and delete under the same record lock' {
    $operations = [pscustomobject]@{ stateRoot = (Join-Path $TestDrive 'process-record-state-locked') }
    New-Item -ItemType Directory -Path (Join-Path $operations.stateRoot 'pids') -Force | Out-Null
    $path = Get-OwnedProcessRecordPath -Operations $operations -InstanceId 'race'
    [IO.File]::WriteAllText($path, '{"schemaVersion":1,"instanceId":"race","rootPid":42,"rootStartTimeUtc":"2026-01-02T03:04:05.0000000Z"}', [Text.UTF8Encoding]::new($false))
    $state = @{ locked = $false; comparedUnderLock = $false; deletedUnderLock = $false }
    $lock = {
      param($Operations, $InstanceId, $Action)
      $state.locked = $true
      try { & $Action } finally { $state.locked = $false }
    }.GetNewClosure()
    $reader = {
      param($Operations, $InstanceId)
      $state.comparedUnderLock = $state.locked
      [pscustomobject]@{ schemaVersion = 1; instanceId = 'race'; rootPid = 42; rootStartTimeUtc = '2026-01-02T03:04:05.0000000Z' }
    }.GetNewClosure()
    $remover = {
      param($Path)
      $state.deletedUnderLock = $state.locked
      Remove-Item -LiteralPath $Path -Force
    }.GetNewClosure()

    { Remove-OwnedProcessRecord -Operations $operations -InstanceId 'race' -RootPid 42 -RecordReader $reader -RecordRemover $remover -LockInvoker $lock } | Should -Not -Throw
    $state.comparedUnderLock | Should -BeTrue
    $state.deletedUnderLock | Should -BeTrue
    Test-Path -LiteralPath $path | Should -BeFalse
  }

  It 'passes the complete process identity to supervisor cleanup' {
    foreach ($scriptName in @('runner-supervisor.ps1', 'dsh-web-host-supervisor.ps1')) {
      $scriptPath = Join-Path $script:RepositoryRoot "ops\$scriptName"
      $source = Get-Content -LiteralPath $scriptPath -Raw
      $source | Should -Match '\$processStartTimeUtc = \$process\.StartTime\.ToUniversalTime\(\)\.ToString\('\''O'\''\)'
      $source | Should -Match 'Remove-OwnedProcessRecord[^\r\n]+-RootPid \$process\.Id -RootStartTimeUtc \$processStartTimeUtc'
    }
  }

  It 'serializes stale record replacement with the new owner identity' {
    $operations = [pscustomobject]@{ stateRoot = (Join-Path $TestDrive 'process-record-state-write') }
    New-Item -ItemType Directory -Path (Join-Path $operations.stateRoot 'pids') -Force | Out-Null
    $path = Get-OwnedProcessRecordPath -Operations $operations -InstanceId 'stale'
    [IO.File]::WriteAllText($path, '{"schemaVersion":1,"instanceId":"stale","rootPid":1,"rootStartTimeUtc":"2000-01-01T00:00:00.0000000Z"}', [Text.UTF8Encoding]::new($false))

    { Write-OwnedProcessRecord -Operations $operations -InstanceId 'stale' -Process ([Diagnostics.Process]::GetCurrentProcess()) } | Should -Not -Throw
    (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).rootPid | Should -Be ([Diagnostics.Process]::GetCurrentProcess().Id)
  }

  It 'treats a record removed during identity read as successful' {
    $operations = [pscustomobject]@{ stateRoot = (Join-Path $TestDrive 'process-record-state-missing') }
    New-Item -ItemType Directory -Path (Join-Path $operations.stateRoot 'pids') -Force | Out-Null
    $path = Get-OwnedProcessRecordPath -Operations $operations -InstanceId 'race'
    [IO.File]::WriteAllText($path, '{"schemaVersion":1,"instanceId":"race","rootPid":42,"rootStartTimeUtc":"2026-01-02T03:04:05.0000000Z"}', [Text.UTF8Encoding]::new($false))
    $state = @{ removed = $false }
    $reader = {
      param($Operations, $InstanceId)
      Remove-Item -LiteralPath $path -Force
      return $null
    }.GetNewClosure()
    $remover = {
      param($Path)
      $state.removed = $true
      Remove-Item -LiteralPath $Path -Force
    }.GetNewClosure()

    { Remove-OwnedProcessRecord -Operations $operations -InstanceId 'race' -RootPid 42 -RootStartTimeUtc '2026-01-02T03:04:05.0000000Z' -RecordReader $reader -RecordRemover $remover } | Should -Not -Throw
    $state.removed | Should -BeFalse
    Test-Path -LiteralPath $path | Should -BeFalse
  }

  It 'does not remove a replacement record with a different PID' {
    $operations = [pscustomobject]@{ stateRoot = (Join-Path $TestDrive 'process-record-state-replaced') }
    New-Item -ItemType Directory -Path (Join-Path $operations.stateRoot 'pids') -Force | Out-Null
    $path = Get-OwnedProcessRecordPath -Operations $operations -InstanceId 'race'
    [IO.File]::WriteAllText($path, '{"schemaVersion":1,"instanceId":"race","rootPid":42,"rootStartTimeUtc":"2026-01-02T03:04:05.0000000Z"}', [Text.UTF8Encoding]::new($false))
    $state = @{ removed = $false }
    $replacement = [ordered]@{
      schemaVersion = 1
      instanceId = 'race'
      rootPid = 99
      rootStartTimeUtc = '2026-01-02T03:04:06.0000000Z'
    }
    $reader = {
      param($Operations, $InstanceId)
      [IO.File]::WriteAllText($path, ($replacement | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
      return [pscustomobject]$replacement
    }.GetNewClosure()
    $remover = {
      param($Path)
      $state.removed = $true
      Remove-Item -LiteralPath $Path -Force
    }.GetNewClosure()

    { Remove-OwnedProcessRecord -Operations $operations -InstanceId 'race' -RootPid 42 -RecordReader $reader -RecordRemover $remover } | Should -Not -Throw
    $state.removed | Should -BeFalse
    (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).rootPid | Should -Be 99
  }

  It 'does not remove a replacement record with a different process start time' {
    $operations = [pscustomobject]@{ stateRoot = (Join-Path $TestDrive 'process-record-state-restarted') }
    New-Item -ItemType Directory -Path (Join-Path $operations.stateRoot 'pids') -Force | Out-Null
    $path = Get-OwnedProcessRecordPath -Operations $operations -InstanceId 'race'
    [IO.File]::WriteAllText($path, '{"schemaVersion":1,"instanceId":"race","rootPid":42,"rootStartTimeUtc":"2026-01-02T03:04:05.0000000Z"}', [Text.UTF8Encoding]::new($false))
    $state = @{ removed = $false }
    $replacement = [ordered]@{
      schemaVersion = 1
      instanceId = 'race'
      rootPid = 42
      rootStartTimeUtc = '2026-01-02T03:04:06.0000000Z'
    }
    $reader = {
      param($Operations, $InstanceId)
      [IO.File]::WriteAllText($path, ($replacement | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
      return [pscustomobject]$replacement
    }.GetNewClosure()
    $remover = {
      param($Path)
      $state.removed = $true
      Remove-Item -LiteralPath $Path -Force
    }.GetNewClosure()

    { Remove-OwnedProcessRecord -Operations $operations -InstanceId 'race' -RootPid 42 -RootStartTimeUtc '2026-01-02T03:04:05.0000000Z' -RecordReader $reader -RecordRemover $remover } | Should -Not -Throw
    $state.removed | Should -BeFalse
    (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).rootStartTimeUtc.ToUniversalTime().ToString('O') | Should -Be '2026-01-02T03:04:06.0000000Z'
  }

  It 'fails closed when a replacement record is invalid' {
    $operations = [pscustomobject]@{ stateRoot = (Join-Path $TestDrive 'process-record-state-invalid') }
    New-Item -ItemType Directory -Path (Join-Path $operations.stateRoot 'pids') -Force | Out-Null
    $path = Get-OwnedProcessRecordPath -Operations $operations -InstanceId 'race'
    [IO.File]::WriteAllText($path, '{"schemaVersion":1,"instanceId":"race","rootPid":42,"rootStartTimeUtc":"2026-01-02T03:04:05.0000000Z"}', [Text.UTF8Encoding]::new($false))
    $state = @{ removed = $false }
    $reader = {
      param($Operations, $InstanceId)
      [IO.File]::WriteAllText($path, '{"invalid":true}', [Text.UTF8Encoding]::new($false))
      throw 'invalid replacement record'
    }.GetNewClosure()
    $remover = {
      param($Path)
      $state.removed = $true
      Remove-Item -LiteralPath $Path -Force
    }.GetNewClosure()

    { Remove-OwnedProcessRecord -Operations $operations -InstanceId 'race' -RootPid 42 -RecordReader $reader -RecordRemover $remover } | Should -Throw 'invalid replacement record'
    $state.removed | Should -BeFalse
    Test-Path -LiteralPath $path | Should -BeTrue
  }
}
