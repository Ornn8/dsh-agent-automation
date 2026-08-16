[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\ops\role-process-host\RoleProcessHost.cs'
Import-Module (Join-Path $PSScriptRoot '..\ops\Automation.Operations.psm1') -Force
Build-RoleProcessHost -SourcePath $source -OutputPath $OutputPath
