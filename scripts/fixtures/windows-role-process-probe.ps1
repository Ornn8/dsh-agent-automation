[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('root', 'child')][string]$Mode,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [switch]$HoldRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DesktopProbeNative {
  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  [DllImport("kernel32.dll")]
  public static extern IntPtr GetConsoleWindow();

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr GetThreadDesktop(uint threadId);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
}
'@

function Get-DesktopProbe {
  $desktop = [DesktopProbeNative]::GetThreadDesktop([DesktopProbeNative]::GetCurrentThreadId())
  $needed = 0
  [void][DesktopProbeNative]::GetUserObjectInformationW($desktop, 2, $null, 0, [ref]$needed)
  $name = [Text.StringBuilder]::new([int]($needed / 2))
  if (-not [DesktopProbeNative]::GetUserObjectInformationW($desktop, 2, $name, $needed, [ref]$needed)) {
    throw "Could not read process desktop: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  return [pscustomobject]@{
    mode = $Mode
    pid = $PID
    desktop = $name.ToString()
    consoleWindow = [DesktopProbeNative]::GetConsoleWindow().ToInt64()
  }
}

[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$probePath = Join-Path $OutputDirectory "$Mode.json"
[IO.File]::WriteAllText($probePath, ((Get-DesktopProbe) | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))

if ($Mode -eq 'child') {
  Start-Sleep -Seconds 60
  exit 0
}

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = [Environment]::ProcessPath
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
foreach ($argument in @('-NoProfile', '-File', $PSCommandPath, '-Mode', 'child', '-OutputDirectory', $OutputDirectory)) {
  [void]$startInfo.ArgumentList.Add($argument)
}
$child = [Diagnostics.Process]::Start($startInfo)
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while (-not (Test-Path -LiteralPath (Join-Path $OutputDirectory 'child.json') -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath (Join-Path $OutputDirectory 'child.json') -PathType Leaf)) {
  try { $child.Kill($true) } catch { }
  throw 'Child process did not report its desktop'
}
if ($HoldRoot) { Start-Sleep -Seconds 60 }
exit 23
