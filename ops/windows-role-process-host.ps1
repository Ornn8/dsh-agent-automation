[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$TargetExecutable,
  [Parameter(Mandatory)][string]$TargetArgumentsBase64,
  [Parameter(Mandatory)][string]$WorkingDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$targetPath = [IO.Path]::GetFullPath($TargetExecutable)
if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) { throw "Target executable is missing: $targetPath" }
$workingPath = [IO.Path]::GetFullPath($WorkingDirectory)
if (-not (Test-Path -LiteralPath $workingPath -PathType Container)) { throw "Working directory is missing: $workingPath" }

$argumentDocument = $null
try {
  $argumentJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TargetArgumentsBase64))
  $argumentDocument = [Text.Json.JsonDocument]::Parse($argumentJson)
  if ($argumentDocument.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Array) { throw 'not an array' }
  $targetArguments = @($argumentDocument.RootElement.EnumerateArray() | ForEach-Object {
    if ($_.ValueKind -ne [Text.Json.JsonValueKind]::String) { throw 'not a string array' }
    $_.GetString()
  })
} catch {
  throw 'TargetArgumentsBase64 must encode a JSON string array'
} finally {
  if ($argumentDocument) { $argumentDocument.Dispose() }
}

function ConvertTo-WindowsCommandLineArgument {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ($Value.Length -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes++
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes) { [void]$builder.Append(('\' * $backslashes)); $backslashes = 0 }
    [void]$builder.Append($character)
  }
  if ($backslashes) { [void]$builder.Append(('\' * ($backslashes * 2))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WindowsRoleProcessNative {
  public const uint CREATE_SUSPENDED = 0x00000004;
  public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  public const uint CREATE_NO_WINDOW = 0x08000000;
  public const uint STARTF_USESHOWWINDOW = 0x00000001;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  public const int JobObjectExtendedLimitInformation = 9;
  public const uint INFINITE = 0xffffffff;
  public const uint WAIT_OBJECT_0 = 0x00000000;
  public const uint WAIT_FAILED = 0xffffffff;
  public const uint GENERIC_ALL = 0x10000000;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public uint dwX;
    public uint dwY;
    public uint dwXSize;
    public uint dwYSize;
    public uint dwXCountChars;
    public uint dwYCountChars;
    public uint dwFillAttribute;
    public uint dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr deviceMode, uint flags, uint desiredAccess, IntPtr securityAttributes);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr desktop);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint informationLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@

$desktopHandle = [IntPtr]::Zero
$jobHandle = [IntPtr]::Zero
$processInformation = [WindowsRoleProcessNative+PROCESS_INFORMATION]::new()
$processCreated = $false
$processAssigned = $false
try {
  $desktopName = "AgentRoleHost-$([Guid]::NewGuid().ToString('N'))"
  $desktopHandle = [WindowsRoleProcessNative]::CreateDesktopW($desktopName, [IntPtr]::Zero, [IntPtr]::Zero, 0, [WindowsRoleProcessNative]::GENERIC_ALL, [IntPtr]::Zero)
  if ($desktopHandle -eq [IntPtr]::Zero) { throw "CreateDesktopW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

  $jobHandle = [WindowsRoleProcessNative]::CreateJobObjectW([IntPtr]::Zero, $null)
  if ($jobHandle -eq [IntPtr]::Zero) { throw "CreateJobObjectW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $limits = [WindowsRoleProcessNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION]::new()
  $basicLimits = [WindowsRoleProcessNative+JOBOBJECT_BASIC_LIMIT_INFORMATION]::new()
  $basicLimits.LimitFlags = [WindowsRoleProcessNative]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  $limits.BasicLimitInformation = $basicLimits
  $limitSize = [Runtime.InteropServices.Marshal]::SizeOf([type][WindowsRoleProcessNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
  if (-not [WindowsRoleProcessNative]::SetInformationJobObject($jobHandle, [WindowsRoleProcessNative]::JobObjectExtendedLimitInformation, [ref]$limits, $limitSize)) {
    throw "SetInformationJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }

  $commandLine = @((ConvertTo-WindowsCommandLineArgument -Value $targetPath)) + @($targetArguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument -Value $_ })
  $commandLineBuffer = [Text.StringBuilder]::new(($commandLine -join ' '))
  $startupInfo = [WindowsRoleProcessNative+STARTUPINFO]::new()
  $startupInfo.cb = [Runtime.InteropServices.Marshal]::SizeOf([type][WindowsRoleProcessNative+STARTUPINFO])
  $startupInfo.lpDesktop = $desktopName
  $startupInfo.dwFlags = [WindowsRoleProcessNative]::STARTF_USESHOWWINDOW
  $startupInfo.wShowWindow = 0
  $creationFlags = [WindowsRoleProcessNative]::CREATE_SUSPENDED -bor [WindowsRoleProcessNative]::CREATE_UNICODE_ENVIRONMENT -bor [WindowsRoleProcessNative]::CREATE_NO_WINDOW
  if (-not [WindowsRoleProcessNative]::CreateProcessW($targetPath, $commandLineBuffer, [IntPtr]::Zero, [IntPtr]::Zero, $false, $creationFlags, [IntPtr]::Zero, $workingPath, [ref]$startupInfo, [ref]$processInformation)) {
    throw "CreateProcessW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $processCreated = $true
  if (-not [WindowsRoleProcessNative]::AssignProcessToJobObject($jobHandle, $processInformation.hProcess)) {
    throw "AssignProcessToJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $processAssigned = $true
  if ([WindowsRoleProcessNative]::ResumeThread($processInformation.hThread) -eq [WindowsRoleProcessNative]::WAIT_FAILED) {
    throw "ResumeThread failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $waitResult = [WindowsRoleProcessNative]::WaitForSingleObject($processInformation.hProcess, [WindowsRoleProcessNative]::INFINITE)
  if ($waitResult -ne [WindowsRoleProcessNative]::WAIT_OBJECT_0) { throw "WaitForSingleObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $exitCode = 0
  if (-not [WindowsRoleProcessNative]::GetExitCodeProcess($processInformation.hProcess, [ref]$exitCode)) {
    throw "GetExitCodeProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
} finally {
  if ($processCreated -and -not $processAssigned) { [void][WindowsRoleProcessNative]::TerminateProcess($processInformation.hProcess, 1) }
  if ($processInformation.hThread -ne [IntPtr]::Zero) { [void][WindowsRoleProcessNative]::CloseHandle($processInformation.hThread) }
  if ($processInformation.hProcess -ne [IntPtr]::Zero) { [void][WindowsRoleProcessNative]::CloseHandle($processInformation.hProcess) }
  if ($jobHandle -ne [IntPtr]::Zero) { [void][WindowsRoleProcessNative]::CloseHandle($jobHandle) }
  if ($desktopHandle -ne [IntPtr]::Zero) { [void][WindowsRoleProcessNative]::CloseDesktop($desktopHandle) }
}
exit [int]$exitCode
