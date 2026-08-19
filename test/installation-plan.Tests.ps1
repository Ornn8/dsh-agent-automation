BeforeAll {
  $script:RepositoryRoot = Split-Path -Parent $PSScriptRoot
  Import-Module (Join-Path $script:RepositoryRoot 'ops\Automation.Operations.psm1') -Force

  function New-PlanFixture {
    $operations = [pscustomobject]@{
      installRoot = '/srv/agent-automation/runtime'
      stateRoot = '/srv/agent-automation/state'
      logsRoot = '/srv/agent-automation/state/logs'
      controller = [pscustomobject]@{ repository = 'example/controller'; registrationScope = 'target-repositories' }
      runner = [pscustomobject]@{
        version = '2.336.0'
        artifacts = [pscustomobject]@{
          'windows-x64' = [pscustomobject]@{ downloadUri = 'https://example.invalid/actions-runner-win-x64.zip'; sha256 = ('b' * 64) }
          'linux-x64' = [pscustomobject]@{ downloadUri = 'https://example.invalid/actions-runner-linux-x64.tar.gz'; sha256 = ('a' * 64) }
          'macos-arm64' = [pscustomobject]@{ downloadUri = 'https://example.invalid/actions-runner-osx-arm64.tar.gz'; sha256 = ('c' * 64) }
        }
      }
      repositoryMappings = @([pscustomobject]@{
        repository = 'example/target'
        ciWorkflows = @('CI', 'Security')
        requiredChecks = @('all checks passed', 'security/gate')
      })
      roles = [pscustomobject]@{
        change = [pscustomobject]@{ runnerNamePrefix = 'change'; replicas = 2; labels = @('self-hosted', 'Windows', 'X64', 'agent-change') }
        review = [pscustomobject]@{ runnerNamePrefix = 'review'; replicas = 1; labels = @('self-hosted', 'Windows', 'X64', 'agent-reviewer') }
        maintenance = [pscustomobject]@{ runnerNamePrefix = 'maint'; replicas = 1; labels = @('self-hosted', 'Windows', 'X64', 'agent-maintenance') }
      }
      dshWebHost = [pscustomobject]@{ enabled = $false }
    }
    return [pscustomobject]@{
      Path = '/srv/agent-automation/state/config.json'
      Config = [pscustomobject]@{ repositories = @('example/target') }
      Operations = $operations
    }
  }

  function New-HostConfigPath {
    param([Parameter(Mandatory)][string]$Destination)
    $config = Get-Content (Join-Path $script:RepositoryRoot 'config.minimal.json') -Raw | ConvertFrom-Json -Depth 32
    $fixtureRoot = Join-Path $script:RepositoryRoot '.agent-automation-test'
    $config.operations | Add-Member -NotePropertyName installRoot -NotePropertyValue (Join-Path $fixtureRoot 'runtime') -Force
    $config.operations | Add-Member -NotePropertyName stateRoot -NotePropertyValue (Join-Path $fixtureRoot 'state') -Force
    $config.operations | Add-Member -NotePropertyName logsRoot -NotePropertyValue (Join-Path $fixtureRoot 'state/logs') -Force
    $config.operations.repositoryMappings[0].repository = 'example/plan-fixture'
    foreach ($platform in @('windows-arm64', 'linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64')) {
      $config.operations.runner.artifacts | Add-Member -NotePropertyName $platform -NotePropertyValue ([pscustomobject]@{
        downloadUri = "https://example.invalid/actions-runner-$platform.bin"
        sha256 = ('d' * 64)
      }) -Force
    }
    $config.operations | Add-Member -NotePropertyName dshWebHost -NotePropertyValue ([pscustomobject]@{ enabled = $false }) -Force
    [IO.File]::WriteAllText($Destination, ($config | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))
    return $Destination
  }
}

Describe 'Portable installation plan' {
  It 'loads a host-native configuration before producing the current platform plan' {
    $path = New-HostConfigPath -Destination (Join-Path $TestDrive 'host-config.json')

    $loaded = Read-OperationsConfig -Configuration $path -AllowExamplePlaceholders
    $plan = New-InstallationPlan -Loaded $loaded -HostName 'fixture-host'
    $instances = @(Get-RunnerInstances -Loaded $loaded)

    $plan.platform.id | Should -Match '^(windows|linux|macos)-(x64|arm64)$'
    [IO.Path]::GetPathRoot($loaded.Operations.installRoot) |
      Should -BeExactly ([IO.Path]::GetPathRoot($script:RepositoryRoot))
    $plan.paths[0].path | Should -BeExactly $loaded.Operations.installRoot
    $instances | Should -HaveCount 3
    foreach ($instance in $instances) {
      @($instance.Labels) | Should -Contain $plan.platform.osLabel
      @($instance.Labels) | Should -Contain $plan.platform.architectureLabel
    }
  }

  It 'loads a target-only runner artifact for cross-host planning' {
    $path = New-HostConfigPath -Destination (Join-Path $TestDrive 'target-only-config.json')
    $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -Depth 32
    $linuxArtifact = $config.operations.runner.artifacts.'linux-x64'
    $config.operations.runner.artifacts = [pscustomobject]@{ 'linux-x64' = $linuxArtifact }
    [IO.File]::WriteAllText($path, ($config | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))

    $loaded = Read-OperationsConfig -Configuration $path -AllowExamplePlaceholders -TargetPlatform 'linux-x64'
    $plan = New-InstallationPlan -Loaded $loaded -Platform 'linux-x64' -HostName 'fixture-host'

    $loaded.Operations.runner.platform | Should -BeExactly 'linux-x64'
    $plan.runnerPackage.downloadUri | Should -BeExactly 'https://example.invalid/actions-runner-linux-x64.bin'
  }

  It 'describes deterministic Linux runner, repository, path, and service intentions' {
    $loaded = New-PlanFixture
    $plan = New-InstallationPlan -Loaded $loaded -Platform 'linux-x64' -HostName 'fixture-host'

    $plan.schemaVersion | Should -Be 1
    $plan.kind | Should -BeExactly 'agent-automation-installation'
    $plan.platform.id | Should -BeExactly 'linux-x64'
    $plan.platform.serviceManager | Should -BeExactly 'systemd-user'
    $plan.runnerPackage.sha256 | Should -BeExactly ('a' * 64)
    @($plan.paths.path) | Should -Be @(
      '/srv/agent-automation/runtime',
      '/srv/agent-automation/state',
      '/srv/agent-automation/state/logs',
      '/srv/agent-automation/state/faults',
      '/srv/agent-automation/state/workspaces',
      '/srv/agent-automation/state/workspace-leases'
    )
    @($plan.runnerInstances) | Should -HaveCount 4
    foreach ($instance in @($plan.runnerInstances)) {
      @($instance.labels) | Should -Contain 'Linux'
      @($instance.labels) | Should -Contain 'X64'
      @($instance.labels) | Should -Not -Contain 'Windows'
      $instance.serviceManager | Should -BeExactly 'systemd-user'
      if ($instance.role -eq 'review') {
        $instance.workspaceSlot | Should -BeExactly "/srv/agent-automation/state/workspaces/$($instance.id)"
        $instance.workspaceLease | Should -BeExactly "/srv/agent-automation/state/workspace-leases/$($instance.id).json"
      } else {
        $instance.workspaceSlot | Should -BeNullOrEmpty
        $instance.workspaceLease | Should -BeNullOrEmpty
      }
    }
    $plan.repositories[0].variables.DSH_AUTOMATION_CI_WORKFLOWS | Should -BeExactly '["CI","Security"]'
    $plan.repositories[0].variables.DSH_AUTOMATION_REQUIRED_CHECKS | Should -BeExactly '["all checks passed","security/gate"]'
    $plan.repositories[0].variables.AGENT_AUTOMATION_CONTROLLER_LOGIN | Should -BeExactly 'REPLACE_WITH_GITHUB_LOGIN'
    @($plan.repositories[0].branchProtection.requiredChecks.name) | Should -Be @('agent/review', 'all checks passed', 'security/gate')
    $plan.repositories[0].branchProtection.removeLegacyCheck | Should -BeExactly 'codex/review'

    $again = New-InstallationPlan -Loaded $loaded -Platform 'linux-x64' -HostName 'fixture-host'
    (ConvertTo-InstallationPlanJson -Plan $again) | Should -BeExactly (ConvertTo-InstallationPlanJson -Plan $plan)
  }

  It 'normalizes the same role configuration for a Windows host' {
    $plan = New-InstallationPlan -Loaded (New-PlanFixture) -Platform 'windows-x64' -HostName 'fixture-host'

    $plan.platform.serviceManager | Should -BeExactly 'scheduled-task'
    $plan.runnerPackage.downloadUri | Should -BeExactly 'https://example.invalid/actions-runner-win-x64.zip'
    foreach ($instance in @($plan.runnerInstances)) {
      @($instance.labels) | Should -Contain 'Windows'
      @($instance.labels) | Should -Contain 'X64'
      @($instance.labels) | Should -Not -Contain 'Linux'
      $instance.serviceManager | Should -BeExactly 'scheduled-task'
    }
  }

  It 'includes the optional DSH Web Host in the service plan' {
    $loaded = New-PlanFixture
    $loaded.Operations.dshWebHost.enabled = $true
    $plan = New-InstallationPlan -Loaded $loaded -Platform 'macos-arm64' -HostName 'fixture-host' -NoStart

    $service = @($plan.services | Where-Object id -eq 'dsh-web')
    $service | Should -HaveCount 1
    $service[0].kind | Should -BeExactly 'dsh-web-host'
    $service[0].manager | Should -BeExactly 'launchd-user'
    $service[0].start | Should -BeFalse
    $plan.runnerPackage.sha256 | Should -BeExactly ('c' * 64)
  }

  It 'fails closed when the target platform has no runner artifact' {
    { New-InstallationPlan -Loaded (New-PlanFixture) -Platform 'linux-arm64' -HostName 'fixture-host' } |
      Should -Throw '*runner artifact*linux-arm64*'
  }

  It 'emits the same versioned plan from doctor and install dry runs' {
    $configPath = New-HostConfigPath -Destination (Join-Path $TestDrive 'dry-run-config.json')
    $doctorOutput = & pwsh -NoProfile -File (Join-Path $script:RepositoryRoot 'scripts\doctor.ps1') `
      -Configuration $configPath -DryRun -TargetPlatform linux-x64 2>&1
    $LASTEXITCODE | Should -Be 0 -Because ($doctorOutput -join ' | ')
    $installOutput = & pwsh -NoProfile -File (Join-Path $script:RepositoryRoot 'scripts\install.ps1') `
      -Configuration $configPath -DryRun -TargetPlatform linux-x64 2>&1
    $LASTEXITCODE | Should -Be 0 -Because ($installOutput -join ' | ')

    $doctorLine = @($doctorOutput | Where-Object { $_ -is [string] -and $_.StartsWith('AUTOMATION_INSTALLATION_PLAN_JSON=') })
    $installLine = @($installOutput | Where-Object { $_ -is [string] -and $_.StartsWith('AUTOMATION_INSTALLATION_PLAN_JSON=') })
    $doctorLine | Should -HaveCount 1
    $installLine | Should -HaveCount 1
    $doctorJson = $doctorLine[0].Substring('AUTOMATION_INSTALLATION_PLAN_JSON='.Length)
    $installJson = $installLine[0].Substring('AUTOMATION_INSTALLATION_PLAN_JSON='.Length)
    $doctorJson | Should -BeExactly $installJson
    ($doctorJson | ConvertFrom-Json -Depth 32).platform.id | Should -BeExactly 'linux-x64'
  }

}
