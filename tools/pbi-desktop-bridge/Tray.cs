using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Net.Sockets;
using System.Reflection;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Extensions.FileProviders;
using Microsoft.Win32;

namespace PbiDesktopBridge;

public sealed class TrayOptions
{
    public int Port { get; init; } = 5177;
    public bool IsRemote { get; init; }
    public string? PairingInfo { get; init; }
    /// <summary>Release the single-instance mutex BEFORE a mode-switch restart,
    /// or the new process would see it held and bail out.</summary>
    public Action ReleaseSingleInstance { get; init; } = () => { };
}

public static class Tray
{
    internal const string AppName = "DAX Workbench";
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValue = "DAXWorkbenchBridge";
    private const string ExternalToolsDir =
        @"C:\Program Files (x86)\Common Files\Microsoft Shared\Power BI Desktop\External Tools";

    public static void OpenStudio(int port) =>
        Process.Start(new ProcessStartInfo { FileName = $"http://127.0.0.1:{port}/", UseShellExecute = true });

    /// <summary>A restart hands the port over with a small gap — wait for it.</summary>
    public static void WaitForPortFree(int port, int timeoutMs)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            try
            {
                var probe = new TcpListener(System.Net.IPAddress.Loopback, port);
                probe.Start();
                probe.Stop();
                return;
            }
            catch (SocketException) { Thread.Sleep(250); }
        }
    }

    /// <summary>Blocking WinForms loop on an STA thread; returns when Quit.</summary>
    public static void Run(TrayOptions options)
    {
        var t = new Thread(() =>
        {
            Application.SetHighDpiMode(HighDpiMode.SystemAware);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using var ctx = new TrayContext(options);
            Application.Run(ctx);
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        Environment.Exit(0); // take Kestrel down with the tray
    }

    // ---- shared bits ----

    private static readonly ManifestEmbeddedFileProvider Resources =
        new(Assembly.GetExecutingAssembly());

    internal static Icon LoadTrayIcon()
    {
        using var s = Resources.GetFileInfo("app.ico").CreateReadStream();
        return new Icon(s);
    }

    private static string LoadIconBase64()
    {
        using var s = Resources.GetFileInfo("assets/icon.png").CreateReadStream();
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return Convert.ToBase64String(ms.ToArray());
    }

    /// <summary>Write the External Tools registration. With a dir override this
    /// is silent (test mode); against the real folder it reports via MessageBox
    /// (that path is reached elevated, from the tray's consent flow).</summary>
    public static void RegisterExternalTool(string? dirOverride)
    {
        var silent = dirOverride is not null;
        var dir = dirOverride ?? ExternalToolsDir;
        try
        {
            var exe = Environment.ProcessPath ?? Application.ExecutablePath;
            var payload = new
            {
                version = "1.0.0",
                name = AppName,
                description = "Work on this model in DAX Workbench — deterministic DAX, Measure Factory, Model Doctor, date tables. Local only; nothing leaves this machine.",
                path = exe,
                arguments = "--launch \"%server%\" \"%database%\"",
                iconData = $"data:image/png;base64,{LoadIconBase64()}",
            };
            Directory.CreateDirectory(dir);
            File.WriteAllText(
                Path.Combine(dir, "dax-workbench.pbitool.json"),
                JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }));
            // The tool used to register as "BI Design Studio" — drop the stale entry
            // so the ribbon doesn't show two buttons for the same exe.
            File.Delete(Path.Combine(dir, "bi-design-studio.pbitool.json"));
            if (!silent)
                RunStaMessageBox(
                    $"Added to Power BI Desktop.\n\nRestart Power BI Desktop and look for \"{AppName}\" in the External Tools ribbon.",
                    MessageBoxIcon.Information);
        }
        catch (Exception e)
        {
            if (silent) Environment.ExitCode = 1;
            else
                RunStaMessageBox(
                    $"Couldn't register in Power BI Desktop:\n{e.Message}\n\nThis needs administrator rights — use the tray menu item, which asks properly.",
                    MessageBoxIcon.Warning);
        }
    }

    private static void RunStaMessageBox(string text, MessageBoxIcon icon)
    {
        var t = new Thread(() => MessageBox.Show(text, AppName, MessageBoxButtons.OK, icon));
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
    }

    internal static bool IsAutoStartEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(RunValue) is not null;
    }

    internal static void SetAutoStart(bool on)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (on) key.SetValue(RunValue, $"\"{Environment.ProcessPath}\" --local");
        else key.DeleteValue(RunValue, throwOnMissingValue: false);
        key.DeleteValue("BIDesignStudioBridge", throwOnMissingValue: false); // pre-rename key
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private readonly NotifyIcon _icon;
    private readonly TrayOptions _o;

    public TrayContext(TrayOptions o)
    {
        _o = o;
        var menu = new ContextMenuStrip();

        var open = new ToolStripMenuItem("Open DAX Workbench", null, (_, _) => Tray.OpenStudio(_o.Port))
        { Font = new Font(Control.DefaultFont, FontStyle.Bold) };
        menu.Items.Add(open);
        menu.Items.Add(new ToolStripSeparator());

        var status = new ToolStripMenuItem(_o.IsRemote ? "Sharing: ON — others can connect" : "Sharing: off (this machine only)")
        { Enabled = false };
        menu.Items.Add(status);

        if (_o.IsRemote && _o.PairingInfo is not null)
        {
            menu.Items.Add(new ToolStripMenuItem("Show pairing info…", null, (_, _) =>
            {
                try { Clipboard.SetText(_o.PairingInfo); } catch { /* clipboard busy */ }
                MessageBox.Show(_o.PairingInfo + "\n\n(Copied to clipboard.)", "Pairing info",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
            }));
            menu.Items.Add(new ToolStripMenuItem("Stop sharing (restart local-only)", null, (_, _) => Restart(remote: false)));
        }
        else
        {
            menu.Items.Add(new ToolStripMenuItem("Share with another machine…", null, (_, _) =>
            {
                var yes = MessageBox.Show(
                    "This restarts the bridge so other machines on your network can connect with a pairing token.\n\n" +
                    "Their Workbench can then read this model and write measures into it — only share on a network you trust.\n\nContinue?",
                    "Share with another machine", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (yes == DialogResult.Yes) Restart(remote: true);
            }));
        }
        menu.Items.Add(new ToolStripSeparator());

        menu.Items.Add(new ToolStripMenuItem("Add to Power BI ribbon…", null, (_, _) => RegisterElevated()));

        var auto = new ToolStripMenuItem("Start with Windows") { Checked = Tray.IsAutoStartEnabled(), CheckOnClick = true };
        auto.CheckedChanged += (_, _) =>
        {
            try { Tray.SetAutoStart(auto.Checked); }
            catch (Exception ex) { MessageBox.Show(ex.Message, "Start with Windows", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        };
        menu.Items.Add(auto);

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem($"Check for updates… (v{Updates.Version})", null, async (s, _) =>
        {
            // User-initiated only — nothing contacts GitHub on a timer.
            if (s is ToolStripMenuItem mi) { mi.Enabled = false; mi.Text = "Checking…"; }
            var r = await Updates.CheckAsync();
            if (s is ToolStripMenuItem done)
            {
                done.Enabled = true;
                done.Text = $"Check for updates… (v{Updates.Version})";
            }

            if (r.Error is not null)
            {
                MessageBox.Show(
                    $"Couldn't reach GitHub to check for updates.\n\n{r.Error}",
                    Tray.AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!r.Available)
            {
                MessageBox.Show($"You're on the latest version (v{r.Current}).",
                    Tray.AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var go = MessageBox.Show(
                $"Version {r.Latest} is available — you have {r.Current}.\n\n" +
                "The Workbench is a single file: download the new exe, quit this one from the tray, " +
                "and replace it. Your settings and Power BI ribbon entry are unaffected.\n\n" +
                "Open the download page?",
                Tray.AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Information);
            if (go == DialogResult.Yes)
                Process.Start(new ProcessStartInfo { FileName = r.Url, UseShellExecute = true });
        }));

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Quit", null, (_, _) => ExitThread()));

        _icon = new NotifyIcon
        {
            Icon = Tray.LoadTrayIcon(),
            Text = _o.IsRemote ? "DAX Workbench — sharing ON" : "DAX Workbench — local",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _icon.DoubleClick += (_, _) => Tray.OpenStudio(_o.Port);
    }

    private void Restart(bool remote)
    {
        var exe = Environment.ProcessPath!;
        _icon.Visible = false;
        _o.ReleaseSingleInstance(); // let the successor claim the mutex
        Process.Start(new ProcessStartInfo { FileName = exe, Arguments = remote ? "--remote" : "--local", UseShellExecute = true });
        ExitThread();
    }

    private void RegisterElevated()
    {
        try
        {
            // Writing under Program Files needs admin — relaunch ourselves
            // elevated for just this one action; UAC is the consent screen.
            Process.Start(new ProcessStartInfo
            {
                FileName = Environment.ProcessPath!,
                Arguments = "--register-external-tool",
                Verb = "runas",
                UseShellExecute = true,
            });
        }
        catch (Win32Exception) // user said No at the UAC prompt
        {
            MessageBox.Show("Cancelled — nothing was changed.", "Add to Power BI ribbon",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _icon.Dispose();
        base.Dispose(disposing);
    }
}
