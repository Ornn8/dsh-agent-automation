[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'doctor.ps1') -SelfTest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'test-pester.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'test-installation-plan.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'test-windows-role-process-host.ps1')
$global:LASTEXITCODE = 0
Write-Output 'Run "scripts/doctor.ps1 -Configuration <path> -DryRun" to validate a real machine-local configuration without side effects.'
