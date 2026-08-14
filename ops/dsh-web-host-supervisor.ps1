[CmdletBinding()]
param([Parameter(Mandatory)][string]$Configuration)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Automation.Operations.psm1') -Force
$loaded = Read-OperationsConfig -Configuration $Configuration
$ops = $loaded.Operations
$hostConfig = $ops.dshWebHost
if (-not $hostConfig.enabled) { exit 0 }
$logFile = Join-Path $ops.logsRoot 'dsh-web-host.log'
$faultFile = Join-Path $ops.stateRoot (Join-Path 'faults' 'dsh-web.restart')
$failures = 0

while ($true) {
  Write-OperationLog -Message 'Starting managed DSH Web Host' -LogFile $logFile
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $hostConfig.executable
  $startInfo.WorkingDirectory = $hostConfig.workingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  foreach ($argument in @($hostConfig.arguments)) { [void]$startInfo.ArgumentList.Add([string]$argument) }
  $process = [Diagnostics.Process]::Start($startInfo)
  try {
    Write-OwnedProcessRecord -Operations $ops -InstanceId 'dsh-web' -Process $process
  } catch {
    & taskkill.exe /pid $process.Id /t /f 1>$null 2>$null
    if (-not $process.WaitForExit(20000)) { throw "Could not stop unrecorded DSH Web Host process $($process.Id)" }
    throw
  }
  try {
    while (-not $process.HasExited) {
      Start-Sleep -Seconds 10
      $restart = Test-Path -LiteralPath $faultFile
      if ($restart) { Remove-Item -LiteralPath $faultFile -Force; Write-OperationLog -Message 'DSH Web Host fault marker consumed' -Level WARN -LogFile $logFile }
      $healthy = Test-DshWebHost -HostConfig $hostConfig
      $failures = if ($healthy) { 0 } else { $failures + 1 }
      if ($restart -or $failures -ge [int]$hostConfig.restartAfterFailures) {
        Write-OperationLog -Message 'Restarting owned DSH Web Host after health/fault condition' -Level WARN -LogFile $logFile
        & taskkill.exe /pid $process.Id /t /f 1>$null 2>$null
      }
    }
  } finally {
    try { $process.Refresh() } catch { }
    if ($process.HasExited) { Remove-OwnedProcessRecord -Operations $ops -InstanceId 'dsh-web' -RootPid $process.Id }
  }
  Write-OperationLog -Message "DSH Web Host exited with code $($process.ExitCode); retrying in 5 seconds" -Level WARN -LogFile $logFile
  $failures = 0
  Start-Sleep -Seconds 5
}
