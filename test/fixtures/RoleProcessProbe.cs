using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class RoleProcessProbe
{
    private const int UOI_NAME = 2;
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();

    private static string DesktopName()
    {
        var value = new StringBuilder(256);
        int needed;
        if (!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, value, value.Capacity * 2, out needed)) return "<unknown>";
        return value.ToString();
    }

    public static int Main(string[] args)
    {
        int depth = Int32.Parse(args[1]);
        string file = args[3];
        int sleepSeconds = Int32.Parse(args[5]);
        File.AppendAllText(file, String.Format("{0}|{1}|{2}\n", Process.GetCurrentProcess().Id, DesktopName(), GetConsoleWindow().ToInt64()));
        Console.WriteLine(new String('x', 4096));
        if (depth < 2)
        {
            var start = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
                "--depth " + (depth + 1) + " --file \"" + file + "\" --sleep " + sleepSeconds);
            start.UseShellExecute = false;
            start.CreateNoWindow = false;
            using (Process child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
        }
        if (sleepSeconds > 0) Thread.Sleep(sleepSeconds * 1000);
        return 0;
    }
}
