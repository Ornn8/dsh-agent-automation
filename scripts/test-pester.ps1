[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$minimum = [Version]'5.7.1'
$pester = Get-Module -ListAvailable Pester |
  Where-Object { $_.Version -ge $minimum } |
  Sort-Object Version -Descending |
  Select-Object -First 1
if (-not $pester) {
  throw "Pester $minimum or newer is required. Install-Module Pester -RequiredVersion $minimum -Scope CurrentUser"
}
Import-Module $pester.Path -Force
$configuration = New-PesterConfiguration
$configuration.Run.Path = Join-Path (Split-Path -Parent $PSScriptRoot) 'test\operations.Tests.ps1'
$configuration.Run.PassThru = $true
$configuration.Output.Verbosity = 'Detailed'
$result = Invoke-Pester -Configuration $configuration
if ($result.FailedCount -or $result.Result -ne 'Passed') { exit 1 }
