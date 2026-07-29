using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AnalysisServices.AdomdClient;
using Tom = Microsoft.AnalysisServices.Tabular;

namespace PbiDesktopBridge;

/// <summary>A running Power BI Desktop model (local Analysis Services instance).</summary>
public record Instance(int Port, string Database, string Workspace)
{
    public string DataSource => $"localhost:{Port}";

    // Cheap shape metadata, read once during discovery — lets the client tell
    // several open models apart, and pin a report across a restart (which
    // changes both the port and the database GUID, but not the shape).
    public int TableCount { get; init; }
    public int MeasureCount { get; init; }
    public IReadOnlyList<string> Tables { get; init; } = System.Array.Empty<string>();
}

/// <summary>Discovery + connection helpers for the local Power BI Desktop engine.</summary>
public static class PowerBi
{
    /// <summary>Shape metadata per open model, keyed by port + database id.
    ///
    /// Reading `database.Model.Tables` makes TOM load the model's full metadata,
    /// which costs seconds on a real model — and /discover is POLLED every few
    /// seconds by the UI. Without this cache discovery took 4.2s against the
    /// client's 2.5s deadline, so every poll timed out and the app reported
    /// "Bridge not running" while the bridge was in fact healthy.
    ///
    /// A model's shape does not change without a reload, and the key includes
    /// the database id, which Desktop regenerates per session — so a reopened
    /// or swapped report misses the cache and is re-read.</summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<
        string, (int TableCount, int MeasureCount, List<string> Tables)> ShapeCache = new();

    private static IEnumerable<string> WorkspaceRoots()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        // Classic (MSI / .exe) install
        yield return Path.Combine(local, "Microsoft", "Power BI Desktop", "AnalysisServicesWorkspaces");
        // Store (MSIX) install — puts workspaces under the user-profile root
        yield return Path.Combine(profile, "Microsoft", "Power BI Desktop Store App", "AnalysisServicesWorkspaces");
        // Store (MSIX) install — some versions redirect LocalAppData into LocalCache
        var packages = Path.Combine(local, "Packages");
        if (Directory.Exists(packages))
        {
            foreach (var pkg in Directory.EnumerateDirectories(packages, "Microsoft.MicrosoftPowerBIDesktop_*"))
                yield return Path.Combine(pkg, "LocalCache", "Local", "Microsoft", "Power BI Desktop", "AnalysisServicesWorkspaces");
        }
    }

    /// <summary>Is anything actually listening on this loopback port?
    ///
    /// A workspace's port file OUTLIVES the Desktop session that wrote it, so
    /// most machines accumulate stale entries pointing at dead ports. TOM takes
    /// roughly two seconds to give up on one, and /discover is polled every few
    /// seconds — so a single leftover workspace was costing 2s on every poll.
    /// A 200ms TCP probe rejects a dead port immediately.</summary>
    private static bool PortIsLive(int port)
    {
        try
        {
            using var client = new System.Net.Sockets.TcpClient();
            return client.ConnectAsync(System.Net.IPAddress.Loopback, port).Wait(200) && client.Connected;
        }
        catch { return false; }
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
                if (!PortIsLive(port)) continue; // stale workspace — skip before TOM stalls on it
                string db;
                var tableCount = 0;
                var measureCount = 0;
                var tableNames = new List<string>();
                try
                {
                    using var server = new Tom.Server();
                    server.Connect($"localhost:{port}");
                    if (server.Databases.Count == 0) { server.Disconnect(); continue; }
                    var database = server.Databases[0];
                    db = database.Name;

                    // Cached after the first read — see ShapeCache. This is the
                    // difference between a poll that costs milliseconds and one
                    // that costs seconds.
                    if (ShapeCache.TryGetValue($"{port}:{db}", out var cached))
                    {
                        tableCount = cached.TableCount;
                        measureCount = cached.MeasureCount;
                        tableNames = cached.Tables;
                    }
                    else
                    {
                        // Metadata only — no data scanned. Wrapped separately so a model
                        // whose shape can't be read still appears in the list (with zero
                        // counts) rather than vanishing.
                        try
                        {
                            var model = database.Model;
                            foreach (var t in model.Tables)
                            {
                                measureCount += t.Measures.Count;
                                // User-facing tables only: skip hidden ones and pure
                                // measure/parameter holders (they have no real columns).
                                var hasRealColumn = t.Columns.Any(c => c.Type != Tom.ColumnType.RowNumber);
                                if (!t.IsHidden && hasRealColumn)
                                {
                                    tableCount++;
                                    if (tableNames.Count < 12) tableNames.Add(t.Name);
                                }
                            }
                            ShapeCache[$"{port}:{db}"] = (tableCount, measureCount, tableNames);
                        }
                        catch { /* keep the model in the list with zero shape metadata */ }
                    }
                    server.Disconnect();
                }
                catch { continue; } // port stale (Desktop closed) — skip
                found.Add(new Instance(port, db, Path.GetFileName(ws))
                {
                    TableCount = tableCount,
                    MeasureCount = measureCount,
                    Tables = tableNames,
                });
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

    /// <summary>Time a query the way DAX Studio does: clear the engine's caches
    /// first, then run it N times and keep every timing. A warm cache serves the
    /// second run of ANY formulation equally well, which is exactly how a slow
    /// measure gets to look fast — so cold is the default. Rows are drained but
    /// not kept: we are measuring the engine, not our own allocations.</summary>
    public static (List<double> Ms, int RowCount, object? FirstValue, bool Cold) Benchmark(
        Instance inst, string dax, int runs, bool clearCache)
    {
        using var conn = new AdomdConnection($"Data Source={inst.DataSource};Catalog={inst.Database}");
        conn.Open();

        var ms = new List<double>();
        var rowCount = 0;
        object? first = null;
        var cold = clearCache;

        // One untimed pass first. The opening execution on a fresh connection
        // also pays ADOMD setup and query-plan compilation — costs that belong
        // to us, not to the DAX, and that would otherwise swamp run 1 and skew
        // the median. Every TIMED run still clears the cache, so all of them
        // remain cold.
        try
        {
            using var warm = new AdomdCommand(dax, conn);
            using var wr = warm.ExecuteReader();
            while (wr.Read()) { }
        }
        catch { /* a genuinely broken query will surface on the timed run */ }

        for (var run = 0; run < Math.Max(1, runs); run++)
        {
            if (clearCache && !ClearCache(conn, inst.Database)) cold = false;

            var sw = System.Diagnostics.Stopwatch.StartNew();
            using (var cmd = new AdomdCommand(dax, conn))
            using (var reader = cmd.ExecuteReader())
            {
                var n = 0;
                while (reader.Read())
                {
                    if (run == 0 && n == 0 && reader.FieldCount > 0)
                        first = reader.IsDBNull(0) ? null : reader.GetValue(0);
                    n++;
                    if (n >= 10_000) break;
                }
                rowCount = n;
            }
            sw.Stop();
            ms.Add(sw.Elapsed.TotalMilliseconds);
        }
        return (ms, rowCount, first, cold);
    }

    /// <summary>Drop the storage- and formula-engine caches for this database.
    /// Caches only — it touches no data and no model metadata. Returns false if
    /// the engine refused, so the caller can report warm timings as warm instead
    /// of passing them off as cold.</summary>
    private static bool ClearCache(AdomdConnection conn, string databaseId)
    {
        var xmla =
            "<ClearCache xmlns=\"http://schemas.microsoft.com/analysisservices/2003/engine\">" +
            "<Object><DatabaseID>" + System.Security.SecurityElement.Escape(databaseId) + "</DatabaseID></Object>" +
            "</ClearCache>";
        try
        {
            using var cmd = new AdomdCommand(xmla, conn);
            cmd.ExecuteNonQuery();
            return true;
        }
        catch { return false; }
    }
}
