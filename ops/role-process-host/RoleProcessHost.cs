using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class RoleProcessHost
{
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const short SW_HIDE = 0;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint OPEN_EXISTING = 3;
    private const uint DESKTOP_ALL_ACCESS = 0x000F01FF;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint INFINITE = 0xFFFFFFFF;
    private static readonly object LogLock = new object();

    private sealed class Options
    {
        public string Executable;
        public string WorkingDirectory;
        public string LogFile;
        public int TimeoutSeconds;
        public int MaxLogBytes;
        public string[] Arguments;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
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
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr attributes);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    private static Options Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var child = new List<string>();
        bool afterSeparator = false;
        for (int index = 0; index < args.Length; index++)
        {
            if (afterSeparator) { child.Add(args[index]); continue; }
            if (args[index] == "--") { afterSeparator = true; continue; }
            if (!args[index].StartsWith("--", StringComparison.Ordinal) || index + 1 >= args.Length) throw new ArgumentException("Role Process Host options must be name/value pairs followed by --.");
            values[args[index]] = args[++index];
        }
        string executable;
        string workingDirectory;
        string logFile;
        if (!values.TryGetValue("--executable", out executable) || String.IsNullOrWhiteSpace(executable)) throw new ArgumentException("--executable is required.");
        if (!values.TryGetValue("--cwd", out workingDirectory) || String.IsNullOrWhiteSpace(workingDirectory)) throw new ArgumentException("--cwd is required.");
        if (!values.TryGetValue("--log", out logFile) || String.IsNullOrWhiteSpace(logFile)) throw new ArgumentException("--log is required.");
        int timeout = 0;
        string timeoutText;
        if (values.TryGetValue("--timeout-seconds", out timeoutText) && (!Int32.TryParse(timeoutText, out timeout) || timeout < 0)) throw new ArgumentException("--timeout-seconds must be non-negative.");
        int maxLogBytes = 10 * 1024 * 1024;
        string maxLogText;
        if (values.TryGetValue("--max-log-bytes", out maxLogText) && (!Int32.TryParse(maxLogText, out maxLogBytes) || maxLogBytes < 1024 || maxLogBytes > 100 * 1024 * 1024)) throw new ArgumentException("--max-log-bytes must be from 1024 to 104857600.");
        return new Options { Executable = Path.GetFullPath(executable), WorkingDirectory = Path.GetFullPath(workingDirectory), LogFile = Path.GetFullPath(logFile), TimeoutSeconds = timeout, MaxLogBytes = maxLogBytes, Arguments = child.ToArray() };
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(character);
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }

    private static void RotateLog(string path, long incomingBytes, int maximumBytes)
    {
        if (!File.Exists(path) || new FileInfo(path).Length + incomingBytes <= maximumBytes) return;
        string oldest = path + ".5";
        if (File.Exists(oldest)) File.Delete(oldest);
        for (int index = 4; index >= 1; index--)
        {
            string source = path + "." + index;
            if (File.Exists(source)) File.Move(source, path + "." + (index + 1));
        }
        File.Move(path, path + ".1");
    }

    private static void CopyPipe(IntPtr handle, string logFile, string stream, int maxLogBytes)
    {
        using (var safe = new Microsoft.Win32.SafeHandles.SafeFileHandle(handle, true))
        using (var input = new FileStream(safe, FileAccess.Read, 4096, false))
        {
            var buffer = new byte[8192];
            int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                lock (LogLock)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(logFile));
                    byte[] prefix = Encoding.UTF8.GetBytes(DateTime.UtcNow.ToString("O") + " [" + stream + "] ");
                    int writable = Math.Min(count, Math.Max(0, maxLogBytes - prefix.Length));
                    RotateLog(logFile, prefix.Length + writable, maxLogBytes);
                    using (var output = new FileStream(logFile, FileMode.Append, FileAccess.Write, FileShare.Read))
                    {
                        output.Write(prefix, 0, prefix.Length);
                        output.Write(buffer, count - writable, writable);
                    }
                }
            }
        }
    }

    private static void ConfigureKillOnClose(IntPtr job)
    {
        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    private static int Run(Options options)
    {
        string desktopName = "agent-role-" + Guid.NewGuid().ToString("N");
        IntPtr desktop = CreateDesktop(desktopName, IntPtr.Zero, IntPtr.Zero, 0, DESKTOP_ALL_ACCESS, IntPtr.Zero);
        if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the private desktop.");
        IntPtr job = IntPtr.Zero;
        IntPtr nullInput = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            ConfigureKillOnClose(job);
            var security = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
            if (!CreatePipe(out stdoutRead, out stdoutWrite, ref security, 0) || !CreatePipe(out stderrRead, out stderrWrite, ref security, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            nullInput = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (nullInput == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var startup = new STARTUPINFO
            {
                cb = Marshal.SizeOf(typeof(STARTUPINFO)), lpDesktop = desktopName,
                dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES, wShowWindow = SW_HIDE,
                hStdInput = nullInput, hStdOutput = stdoutWrite, hStdError = stderrWrite,
            };
            var commandLine = new StringBuilder(Quote(options.Executable));
            foreach (string argument in options.Arguments) commandLine.Append(' ').Append(Quote(argument));
            if (!CreateProcess(options.Executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, options.WorkingDirectory, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.hProcess, 70);
                throw new Win32Exception(error);
            }
            if (ResumeThread(process.hThread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(process.hThread); process.hThread = IntPtr.Zero;
            CloseHandle(stdoutWrite); stdoutWrite = IntPtr.Zero;
            CloseHandle(stderrWrite); stderrWrite = IntPtr.Zero;
            IntPtr ownedStdoutRead = stdoutRead; stdoutRead = IntPtr.Zero;
            IntPtr ownedStderrRead = stderrRead; stderrRead = IntPtr.Zero;
            var stdoutThread = new Thread(() => CopyPipe(ownedStdoutRead, options.LogFile, "stdout", options.MaxLogBytes));
            var stderrThread = new Thread(() => CopyPipe(ownedStderrRead, options.LogFile, "stderr", options.MaxLogBytes));
            stdoutThread.IsBackground = true; stderrThread.IsBackground = true; stdoutThread.Start(); stderrThread.Start();
            uint wait = WaitForSingleObject(process.hProcess, options.TimeoutSeconds == 0 ? INFINITE : checked((uint)options.TimeoutSeconds * 1000U));
            if (wait == WAIT_TIMEOUT) { TerminateJobObject(job, 124); WaitForSingleObject(process.hProcess, 10000); return 124; }
            if (wait != WAIT_OBJECT_0) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
            stdoutThread.Join(5000); stderrThread.Join(5000);
            return unchecked((int)exitCode);
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (nullInput != IntPtr.Zero && nullInput != new IntPtr(-1)) CloseHandle(nullInput);
            if (stdoutRead != IntPtr.Zero) CloseHandle(stdoutRead);
            if (stdoutWrite != IntPtr.Zero) CloseHandle(stdoutWrite);
            if (stderrRead != IntPtr.Zero) CloseHandle(stderrRead);
            if (stderrWrite != IntPtr.Zero) CloseHandle(stderrWrite);
            CloseDesktop(desktop);
        }
    }

    public static int Main(string[] args)
    {
        try { return Run(Parse(args)); }
        catch (Exception error)
        {
            try
            {
                string log = null;
                for (int index = 0; index + 1 < args.Length; index++) if (args[index] == "--log") log = args[index + 1];
                if (!String.IsNullOrWhiteSpace(log)) File.AppendAllText(log, DateTime.UtcNow.ToString("O") + " [host] " + error + Environment.NewLine);
            }
            catch { }
            return 70;
        }
    }
}
