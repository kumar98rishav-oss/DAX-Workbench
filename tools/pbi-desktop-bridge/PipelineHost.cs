using System.Diagnostics;
using System.Net.Sockets;
using System.Reflection;

namespace PbiDesktopBridge;

/// <summary>
/// Brings up the Delivery Pipeline cockpit's backing service as a child process,
/// so launching DAX Workbench from Power BI's External Tools ribbon starts the
/// WHOLE cockpit with no separate terminal.
///
/// The host is the tiny zero-dependency Node script tools/pipeline-host/server.mjs,
/// shipped INSIDE this exe as an embedded resource. On first run it is extracted
/// next to its persistent state file (%LOCALAPPDATA%\DAX Workbench\) and run with
/// the machine's Node on http://127.0.0.1:5178 — the same address the Studio UI
/// and the MCP server already look for it on.
///
/// Best-effort by design: if Node isn't installed, or the port is already taken by
/// a dev host, this does nothing and every other bridge feature is unaffected. The
/// cockpit panel then simply shows "Pipeline Host not running".
/// </summary>
internal static class PipelineHost
{
    private const int Port = 5178;
    private static Process? _proc;

    public static void Start()
    {
        try
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DAX Workbench");
            Directory.CreateDirectory(dir);
            var script = Path.Combine(dir, "pipeline-host.mjs");
            // Refresh the script BEFORE the port check: a stale/orphaned host used to both
            // hold the port AND block the refresh, so relaunches kept running old code.
            // Extracting first guarantees the on-disk script always matches this exe.
            ExtractEmbedded("pipeline-host.server.mjs", script);

            if (IsPortOpen(Port)) return;              // already up (a dev host, or a prior instance)
            var node = FindNode();
            if (node is null) return;                  // no Node → cockpit shows "host not running"
            if (!File.Exists(script)) return;

            var psi = new ProcessStartInfo
            {
                FileName = node,
                Arguments = $"\"{script}\"",
                WorkingDirectory = dir,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.Environment["DAXWB_PIPELINE_PORT"] = Port.ToString();
            psi.Environment["DAXWB_PIPELINE_FILE"] = Path.Combine(dir, "pipeline.json");
            psi.Environment["DAXWB_PROJECT"] = "Live model";
            _proc = Process.Start(psi);
            AppDomain.CurrentDomain.ProcessExit += (_, _) => Stop();
        }
        catch { /* the cockpit's helper must never take the bridge down */ }
    }

    public static void Stop()
    {
        try { if (_proc is { HasExited: false }) _proc.Kill(entireProcessTree: true); }
        catch { /* already gone */ }
    }

    private static bool IsPortOpen(int port)
    {
        try { using var c = new TcpClient(); c.Connect("127.0.0.1", port); return true; }
        catch { return false; }
    }

    /// <summary>Find node.exe on PATH, then in the usual install spots.</summary>
    private static string? FindNode()
    {
        foreach (var d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            try
            {
                var p = Path.Combine(d.Trim(), "node.exe");
                if (File.Exists(p)) return p;
            }
            catch { /* malformed PATH segment — skip */ }
        }
        string[] guesses =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
        };
        return guesses.FirstOrDefault(File.Exists);
    }

    private static void ExtractEmbedded(string logicalName, string destPath)
    {
        var asm = Assembly.GetExecutingAssembly();
        var name = asm.GetManifestResourceNames()
            .FirstOrDefault(n => n.Equals(logicalName, StringComparison.OrdinalIgnoreCase)
                              || n.EndsWith("." + logicalName, StringComparison.OrdinalIgnoreCase)
                              || n.EndsWith("server.mjs", StringComparison.OrdinalIgnoreCase));
        if (name is null) return;
        using var s = asm.GetManifestResourceStream(name);
        if (s is null) return;
        using var f = File.Create(destPath);
        s.CopyTo(f);
    }
}
