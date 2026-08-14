[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'doctor.ps1') -SelfTest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'Run "scripts/doctor.ps1 -Configuration <path> -DryRun" to validate a real machine-local configuration without side effects.'
