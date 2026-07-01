// Tiny launcher compiled into PhotoSync Server.exe. Double-clicking it starts the
// bundled Node runtime on the app (which opens the dashboard, shows the tray
// icon, and runs the backup server in the background) and then exits - Node
// keeps running on its own. Built as /target:winexe so no console flashes.
//
// System.Windows.Forms is intentionally NOT referenced here - WinForms registers
// a hidden message-pump window on startup which causes a brief white flash even
// when no form is ever shown. P/Invoke MessageBox is used for errors instead.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

class Launcher
{
    // MB_OK | MB_ICONERROR
    const uint MB_ICONERROR = 0x00000010;

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    static void Error(string text)
    {
        MessageBox(IntPtr.Zero, text, "PhotoSync Server", MB_ICONERROR);
    }

    static void Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(dir, "node.exe");
        string main = Path.Combine(dir, "desktop", "src", "main.js");

        if (!File.Exists(node) || !File.Exists(main))
        {
            Error("PhotoSync Server files are missing. Please keep PhotoSync Server.exe inside its folder.");
            return;
        }

        // --minimized (start in tray, no dashboard) if launched at login.
        bool minimized = Array.IndexOf(args, "--minimized") >= 0;
        string arg = "\"" + main + "\"" + (minimized ? " --minimized" : "");

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = node,
                Arguments = arg,
                WorkingDirectory = dir,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            Error("Could not start PhotoSync Server:\n" + ex.Message);
        }
    }
}
