using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AnalysisServices.AdomdClient;
using Tom = Microsoft.AnalysisServices.Tabular;

namespace PbiDesktopBridge;

/// <summary>A running Power BI Desktop model (local Analysis Services instance).</summary>
public record Instance(int Port, string Database, string Workspace)
{
    public string DataSource => $"localhost:{Port}";
}

/// <summary>Discovery + connection helpers for the local Power BI Desktop engine.</summary>
public static class PowerBi
{
    private static IEnumerable<string> WorkspaceRoots()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        // Classic (MSI) install
        yield return Path.Combine(local, "Microsoft", "Power BI Desktop", "AnalysisServicesWorkspaces");
        // Store (MSIX) install redirects LocalAppData into the package's LocalCache
        var packages = Path.Combine(local, "Packages");
        if (Directory.Exists(packages))
        {
            foreach (var pkg in Directory.EnumerateDirectories(packages, "Microsoft.MicrosoftPowerBIDesktop_*"))
                yield return Path.Combine(pkg, "LocalCache", "Local", "Microsoft", "Power BI Desktop", "AnalysisServicesWorkspaces");
        }
    }

    /// <summary>Every open Power BI Desktop model on this machine.</summary>
    public static List<Instance> Discover()
    {
        var found = new List<Instance>();
        foreach (var root in WorkspaceRoots())
        {
            if (!Directory.Exists(root)) continue;
            foreach (var ws in Directory.EnumerateDirectories(root))
            {
                var portFile = Path.Combine(ws, "Data", "msmdsrv.port.txt");
                if (!File.Exists(portFile)) continue;
                var raw = File.ReadAllText(portFile, Encoding.Unicode);
                var m = Regex.Match(raw, "\\d+");
                if (!m.Success) continue;
                var port = int.Parse(m.Value);
                string db;
                try
                {
                    using var server = new Tom.Server();
                    server.Connect($"localhost:{port}");
                    db = server.Databases.Count > 0 ? server.Databases[0].Name : "";
                    server.Disconnect();
                }
                catch { continue; } // port stale (Desktop closed) — skip
                found.Add(new Instance(port, db, Path.GetFileName(ws)));
            }
        }
        return found;
    }

    /// <summary>Pick an instance: the given port, or the only one open.</summary>
    public static Instance Resolve(int? port)
    {
        var all = Discover();
        if (all.Count == 0)
            throw new InvalidOperationException("No open Power BI Desktop model found. Open your .pbix in Power BI Desktop and try again.");
        if (port is int p)
            return all.FirstOrDefault(i => i.Port == p)
                   ?? throw new InvalidOperationException($"No model on port {p}. Open models: {string.Join(", ", all.Select(i => $"{i.Database}:{i.Port}"))}.");
        if (all.Count == 1) return all[0];
        throw new InvalidOperationException($"Several models are open — pass ?port=. Options: {string.Join(", ", all.Select(i => $"{i.Database}:{i.Port}"))}.");
    }

    public static Tom.Database ConnectDatabase(Instance inst, out Tom.Server server)
    {
        server = new Tom.Server();
        server.Connect(inst.DataSource);
        return server.Databases[0];
    }

    /// <summary>Run a DAX query (EVALUATE …) and return rows as dictionaries.</summary>
    public static (List<string> Columns, List<Dictionary<string, object?>> Rows) Query(Instance inst, string dax)
    {
        using var conn = new AdomdConnection($"Data Source={inst.DataSource};Catalog={inst.Database}");
        conn.Open();
        using var cmd = new AdomdCommand(dax, conn);
        using var reader = cmd.ExecuteReader();
        var cols = new List<string>();
        for (var i = 0; i < reader.FieldCount; i++) cols.Add(reader.GetName(i));
        var rows = new List<Dictionary<string, object?>>();
        while (reader.Read())
        {
            var row = new Dictionary<string, object?>();
            for (var i = 0; i < reader.FieldCount; i++)
                row[cols[i]] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            rows.Add(row);
            if (rows.Count >= 10_000) break; // safety cap
        }
        return (cols, rows);
    }
}
