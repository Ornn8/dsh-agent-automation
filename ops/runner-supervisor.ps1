[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Configuration,
  [Parameter(Mandatory)][string]$InstanceId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Automation.Operations.psm1') -Force
$loaded = Read-OperationsConfig -Configuration $Configuration
$instance = Get-RunnerInstance -Loaded $loaded -InstanceId $InstanceId
$env:DSH_AGENT_CONFIG = $loaded.Path
$env:AGENT_REPLICA_ID = $instance.Id
$restartAttempt = 0

while ($true) {
  if ($instance.Role -eq 'review') {
    $leaseState = Remove-StaleReviewWorkspaceLease -Instance $instance -StateRoot $loaded.Operations.stateRoot
    if ($leaseState.State -eq 'reclaimed') {
      Write-OperationLog -Message "$($instance.Id) reclaimed stale review workspace lease: $($leaseState.Detail)" -Level WARN -LogFile $instance.LogFile
    }
  }
  $startedAt = [DateTime]::UtcNow
  if (-not (Test-Path -LiteralPath (Join-Path $instance.RunnerRoot 'run.cmd'))) { throw "Runner is not installed for $($instance.Id)" }
  if (Test-Path -LiteralPath $instance.FaultFile) {
    Remove-Item -LiteralPath $instance.FaultFile -Force
    Write-OperationLog -Message "$($instance.Id) fault marker consumed before launch" -Level WARN -LogFile $instance.LogFile
  }
  Write-OperationLog -Message "Starting runner $($instance.Id)" -LogFile $instance.LogFile
  $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', 'run.cmd') -WorkingDirectory $instance.RunnerRoot -WindowStyle Hidden -PassThru
  $processStartTimeUtc = $process.StartTime.ToUniversalTime().ToString('O')
  try {
    Write-OwnedProcessRecord -Operations $loaded.Operations -InstanceId $instance.Id -Process $process
  } catch {
    & taskkill.exe /pid $process.Id /t /f 1>$null 2>$null
    if (-not $process.WaitForExit(20000)) { throw "Could not stop unrecorded runner process $($process.Id) for $($instance.Id)" }
    throw
  }
  try {
    while (-not $process.HasExited) {
      if ($instance.Role -eq 'review') {
        $leaseState = Remove-StaleReviewWorkspaceLease -Instance $instance -StateRoot $loaded.Operations.stateRoot
        if ($leaseState.State -eq 'reclaimed') {
          Write-OperationLog -Message "$($instance.Id) reclaimed stale review workspace lease: $($leaseState.Detail)" -Level WARN -LogFile $instance.LogFile
        }
      }
      Write-OperationHeartbeat -Operations $loaded.Operations -InstanceId $instance.Id -RootPid $process.Id
      Start-Sleep -Seconds 5
      if (Test-Path -LiteralPath $instance.FaultFile) {
        Remove-Item -LiteralPath $instance.FaultFile -Force
        Write-OperationLog -Message "$($instance.Id) fault marker consumed; restarting owned runner" -Level WARN -LogFile $instance.LogFile
        & taskkill.exe /pid $process.Id /t /f | Out-Null
      }
    }
  } finally {
    try { $process.Refresh() } catch { }
    if ($process.HasExited) { Remove-OwnedProcessRecord -Operations $loaded.Operations -InstanceId $instance.Id -RootPid $process.Id -RootStartTimeUtc $processStartTimeUtc }
  }
  $restartAttempt = if (([DateTime]::UtcNow - $startedAt).TotalMinutes -ge 5) { 1 } else { $restartAttempt + 1 }
  $delaySeconds = [Math]::Min(300, 10 * [Math]::Pow(2, [Math]::Min(5, $restartAttempt - 1)))
  Write-OperationLog -Message "Runner $($instance.Id) exited with code $($process.ExitCode); retrying in $delaySeconds seconds" -Level WARN -LogFile $instance.LogFile
  Start-Sleep -Seconds $delaySeconds
}
