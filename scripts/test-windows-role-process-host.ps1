[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  Write-Output 'Windows Role Process Host test skipped on a non-Windows host.'
  exit 0
}

$processHost = Join-Path (Split-Path -Parent $PSScriptRoot) 'ops\windows-role-process-host.ps1'
$probe = Join-Path $PSScriptRoot 'fixtures\windows-role-process-probe.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "dsh-role-process-host-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$childPid = 0
$heldRootPid = 0
$heldChildPid = 0
try {
  $targetArguments = @('-NoProfile', '-File', $probe, '-Mode', 'root', '-OutputDirectory', $testRoot)
  $encodedArguments = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject $targetArguments)))
  & ([Environment]::ProcessPath) -NoProfile -File $processHost -TargetExecutable ([Environment]::ProcessPath) -TargetArgumentsBase64 $encodedArguments -WorkingDirectory $testRoot
  $hostExitCode = $LASTEXITCODE

  $root = Get-Content -LiteralPath (Join-Path $testRoot 'root.json') -Raw -Encoding utf8 | ConvertFrom-Json
  $child = Get-Content -LiteralPath (Join-Path $testRoot 'child.json') -Raw -Encoding utf8 | ConvertFrom-Json
  $childPid = [int]$child.pid
  $exitDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $childStillRunning = $null -ne (Get-Process -Id $childPid -ErrorAction SilentlyContinue)
    if (-not $childStillRunning) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $exitDeadline)

  $terminationRoot = Join-Path $testRoot 'termination'
  [IO.Directory]::CreateDirectory($terminationRoot) | Out-Null
  $terminationArguments = @('-NoProfile', '-File', $probe, '-Mode', 'root', '-OutputDirectory', $terminationRoot, '-HoldRoot')
  $encodedTerminationArguments = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject $terminationArguments)))
  $hostStartInfo = [Diagnostics.ProcessStartInfo]::new()
  $hostStartInfo.FileName = [Environment]::ProcessPath
  $hostStartInfo.UseShellExecute = $false
  $hostStartInfo.CreateNoWindow = $true
  foreach ($argument in @('-NoProfile', '-File', $processHost, '-TargetExecutable', [Environment]::ProcessPath, '-TargetArgumentsBase64', $encodedTerminationArguments, '-WorkingDirectory', $terminationRoot)) {
    [void]$hostStartInfo.ArgumentList.Add($argument)
  }
  $heldHost = [Diagnostics.Process]::Start($hostStartInfo)
  $readyDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while ((-not (Test-Path -LiteralPath (Join-Path $terminationRoot 'root.json') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $terminationRoot 'child.json') -PathType Leaf)) -and [DateTime]::UtcNow -lt $readyDeadline) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath (Join-Path $terminationRoot 'root.json') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $terminationRoot 'child.json') -PathType Leaf)) {
    throw 'Held process tree did not become ready'
  }
  $heldRootPid = [int](Get-Content -LiteralPath (Join-Path $terminationRoot 'root.json') -Raw -Encoding utf8 | ConvertFrom-Json).pid
  $heldChildPid = [int](Get-Content -LiteralPath (Join-Path $terminationRoot 'child.json') -Raw -Encoding utf8 | ConvertFrom-Json).pid
  $heldHost.Kill()
  if (-not $heldHost.WaitForExit(10000)) { throw 'Process Host did not exit after direct termination' }
  $terminationDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $heldRootRunning = $null -ne (Get-Process -Id $heldRootPid -ErrorAction SilentlyContinue)
    $heldChildRunning = $null -ne (Get-Process -Id $heldChildPid -ErrorAction SilentlyContinue)
    if (-not $heldRootRunning -and -not $heldChildRunning) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $terminationDeadline)

  $results = @(
    [pscustomobject]@{ Name = 'target exit code is preserved'; Passed = $hostExitCode -eq 23 },
    [pscustomobject]@{ Name = 'target root uses a private desktop'; Passed = -not [string]::IsNullOrWhiteSpace($root.desktop) -and $root.desktop -cne 'Default' },
    [pscustomobject]@{ Name = 'target child inherits the private desktop'; Passed = $child.desktop -ceq $root.desktop },
    [pscustomobject]@{ Name = 'target root has no console window'; Passed = [int64]$root.consoleWindow -eq 0 },
    [pscustomobject]@{ Name = 'target child has no console window'; Passed = [int64]$child.consoleWindow -eq 0 },
    [pscustomobject]@{ Name = 'job closes the surviving target process tree'; Passed = -not $childStillRunning },
    [pscustomobject]@{ Name = 'terminating only the host closes its target process tree'; Passed = -not $heldRootRunning -and -not $heldChildRunning }
  )
  $results | Format-Table -AutoSize
  $failed = @($results | Where-Object { -not $_.Passed })
  if ($failed.Count) { throw "Windows Role Process Host self-test failed: $(@($failed.Name) -join ', ')" }
  Write-Output 'Windows Role Process Host self-test passed.'
} finally {
  if ($childPid -gt 0 -and (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) {
    & taskkill.exe /pid $childPid /t /f 1>$null 2>$null
  }
  if ($heldRootPid -gt 0 -and (Get-Process -Id $heldRootPid -ErrorAction SilentlyContinue)) {
    & taskkill.exe /pid $heldRootPid /t /f 1>$null 2>$null
  }
  if ($heldChildPid -gt 0 -and (Get-Process -Id $heldChildPid -ErrorAction SilentlyContinue)) {
    & taskkill.exe /pid $heldChildPid /t /f 1>$null 2>$null
  }
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
