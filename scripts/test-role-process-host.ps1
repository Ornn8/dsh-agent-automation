[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) "role-process-host-$([Guid]::NewGuid().ToString('N'))"
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
try {
  [IO.Directory]::CreateDirectory($root) | Out-Null
  $hostPath = Join-Path $root 'RoleProcessHost.exe'
  $probePath = Join-Path $root 'RoleProcessProbe.exe'
  & (Join-Path $PSScriptRoot 'build-role-process-host.ps1') -OutputPath $hostPath | Out-Null
  & $compiler /nologo /target:exe /optimize+ /platform:x64 "/out:$probePath" (Join-Path $PSScriptRoot '..\test\fixtures\RoleProcessProbe.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Role Process Probe compilation failed.' }

  $normalFile = Join-Path $root 'normal.txt'
  $normalLog = Join-Path $root 'normal.log'
  $normal = Start-Process -FilePath $hostPath -WindowStyle Hidden -Wait -PassThru -ArgumentList @(
    '--executable', $probePath, '--cwd', $root, '--log', $normalLog, '--max-log-bytes', '1024', '--',
    '--depth', '0', '--file', $normalFile, '--sleep', '0'
  )
  if ($normal.ExitCode -ne 0) { throw "Role Process Host normal probe exited $($normal.ExitCode)." }
  $records = @(Get-Content -LiteralPath $normalFile | ForEach-Object { $parts = $_ -split '\|'; [pscustomobject]@{ Pid = [int]$parts[0]; Desktop = $parts[1]; Console = [int64]$parts[2] } })
  if ($records.Count -ne 3 -or @($records | Where-Object { $_.Desktop -notmatch '^agent-role-[0-9a-f]{32}$' -or $_.Console -ne 0 }).Count) { throw 'Parent, child, and grandchild did not remain on one hidden private desktop.' }
  if (@($records.Desktop | Select-Object -Unique).Count -ne 1) { throw 'The process tree did not inherit one private desktop.' }
  if (@(Get-ChildItem -LiteralPath $root -Filter 'normal.log*' | Where-Object Length -gt 1024).Count) { throw 'Role Process Host exceeded its per-file output limit.' }

  $cancelFile = Join-Path $root 'cancel.txt'
  $cancelLog = Join-Path $root 'cancel.log'
  $hostProcess = Start-Process -FilePath $hostPath -WindowStyle Hidden -PassThru -ArgumentList @(
    '--executable', $probePath, '--cwd', $root, '--log', $cancelLog, '--',
    '--depth', '0', '--file', $cancelFile, '--sleep', '30'
  )
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 100
    $cancelRecords = if (Test-Path -LiteralPath $cancelFile) { @(Get-Content -LiteralPath $cancelFile) } else { @() }
  } while ($cancelRecords.Count -lt 3 -and [DateTime]::UtcNow -lt $deadline)
  if ($cancelRecords.Count -ne 3) { throw 'The cancellation probe did not start its complete process tree.' }
  $pids = @($cancelRecords | ForEach-Object { [int](($_ -split '\|')[0]) })
  Stop-Process -Id $hostProcess.Id -Force
  $hostProcess.WaitForExit()
  Start-Sleep -Milliseconds 500
  if (@($pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count) { throw 'Closing Role Process Host did not terminate its complete Job Object tree.' }

  $timeoutFile = Join-Path $root 'timeout.txt'
  $timeout = Start-Process -FilePath $hostPath -WindowStyle Hidden -Wait -PassThru -ArgumentList @(
    '--executable', $probePath, '--cwd', $root, '--log', (Join-Path $root 'timeout.log'), '--timeout-seconds', '1', '--',
    '--depth', '0', '--file', $timeoutFile, '--sleep', '30'
  )
  if ($timeout.ExitCode -ne 124) { throw "Role Process Host timeout returned $($timeout.ExitCode), expected 124." }
  Write-Output 'Role Process Host parent/child/grandchild, private desktop, hidden console, cancellation, timeout, and Job Object tests passed.'
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
