using System.Net;
using System.Reflection;
using System.Security.Cryptography;
// Sdk.NET (needed for WinForms) doesn't inject the web implicit usings the
// old Sdk.Web project got for free — they're explicit here.
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using PbiDesktopBridge;
using Tom = Microsoft.AnalysisServices.Tabular;

// DAX Workbench bridge — now the WHOLE product in one exe: a system-tray app
// that serves the embedded Studio UI at http://127.0.0.1:5177 and speaks
// TOM/ADOMD to Power BI Desktop's embedded Analysis Services. No console, no
// separate website needed, no cloud.
//
//   double-click                 tray icon + opens the Studio (local only)
//   --local | --remote           skip straight to a mode (tray can switch too)
//   --launch "srv" "db"          how Power BI Desktop's External Tools ribbon starts us
//   --register-external-tool     write the pbitool.json (needs admin; tray offers it)
//       [--dir <path>]           ...write to a custom dir instead (testing; silent)
//   --listen <ip> --port <n> --token <secret>

static string? Arg(string[] a, string name)
{
    var i = Array.FindIndex(a, x => string.Equals(x, name, StringComparison.OrdinalIgnoreCase));
    return i >= 0 && i + 1 < a.Length && !a[i + 1].StartsWith("--") ? a[i + 1] : null;
}
static bool Flag(string[] a, string name) => a.Any(x => string.Equals(x, name, StringComparison.OrdinalIgnoreCase));

// ---- one-shot modes that never start the server ----
if (Flag(args, "--register-external-tool"))
{
    Tray.RegisterExternalTool(Arg(args, "--dir"));
    return;
}

// ---- single instance: a second launch just brings the Studio up ----
var listenPort = int.TryParse(Arg(args, "--port"), out var p0) ? p0 : 5177;
using var single = new Mutex(true, "Local\\dax-workbench-bridge", out var firstInstance);
if (!firstInstance)
{
    Tray.OpenStudio(listenPort);
    return;
}

var remoteMode = Flag(args, "--remote");
var listenIp = Arg(args, "--listen") ?? (remoteMode ? "0.0.0.0" : "127.0.0.1");
var isRemote = listenIp != "127.0.0.1" && listenIp != "localhost";

// A token is MANDATORY the moment this answers anything but loopback. Requests
// from loopback never need one, so the normal local flow is untouched.
var token = Arg(args, "--token")
            ?? Environment.GetEnvironmentVariable("PBI_BRIDGE_TOKEN")
            ?? (isRemote ? Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant() : null);

// A restart (tray mode-switch) starts the new process while the old one is
// still letting go of the port — wait for it rather than crash.
Tray.WaitForPortFree(listenPort, 8000);

var builder = WebApplication.CreateBuilder();

// Origins allowed to drive this bridge beyond its own UI and localhost dev.
// On loopback there is no token, so this list is the only thing gating a web
// page from reading the model: keep it to exact origins, never a wildcard
// suffix. CORS is a BROWSER rule and does nothing against curl — over the
// network the token is the real gate, which is why one is mandatory there.
var allowedOrigins = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    "https://dax-workbench.onrender.com", // the hosted Workbench
    // The old pbi-design-studio.onrender.com origin is deliberately NOT kept.
    // Once a Render subdomain is released anyone can claim it, and an entry here
    // is permission to read this model and write measures into it — so a name we
    // no longer control must not stay on the allowlist.
};
foreach (var o in (Environment.GetEnvironmentVariable("PBI_BRIDGE_ORIGINS") ?? "")
             .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
    allowedOrigins.Add(o.TrimEnd('/'));

builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .SetIsOriginAllowed(origin =>
    {
        if (origin.StartsWith("tauri://") || origin.StartsWith("file://")) return true;
        if (allowedOrigins.Contains(origin.TrimEnd('/'))) return true;
        return Uri.TryCreate(origin, UriKind.Absolute, out var u) && (u.Host == "localhost" || u.Host == "127.0.0.1");
    })
    .AllowAnyHeader()
    .AllowAnyMethod()));

var app = builder.Build();

// Chrome's Private Network Access preflight — a public page reaching loopback
// needs this opt-in as enforcement rolls out.
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Headers.ContainsKey("Access-Control-Request-Private-Network"))
        ctx.Response.Headers["Access-Control-Allow-Private-Network"] = "true";
    await next();
});

app.UseCors();

// ---- the embedded Studio UI ----
// The vite build is compiled INTO this exe; ManifestEmbeddedFileProvider serves
// it. Static files sit in front of the auth gate on purpose: the app shell is
// not sensitive, the API is — and remote users still need the token for data.
var assembly = Assembly.GetExecutingAssembly();
var ui = new ManifestEmbeddedFileProvider(assembly, "wwwroot");
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = ui });
app.UseStaticFiles(new StaticFileOptions { FileProvider = ui });

// Auth gate — API paths only. Runs AFTER UseCors so preflights (which never
// carry Authorization) aren't rejected before the real request can ask.
var apiPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    { "/health", "/discover", "/model", "/dax", "/time", "/preview", "/measure", "/table" };
app.Use(async (ctx, next) =>
{
    if (!apiPaths.Contains(ctx.Request.Path.Value ?? "") || HttpMethods.IsOptions(ctx.Request.Method))
    {
        await next();
        return;
    }
    var ip = ctx.Connection.RemoteIpAddress;
    var loopback = ip is not null && IPAddress.IsLoopback(ip);
    if (!loopback)
    {
        if (string.IsNullOrEmpty(token))
        {
            ctx.Response.StatusCode = 403;
            await ctx.Response.WriteAsJsonAsync(new { error = "This bridge only answers the local machine. Enable sharing from the tray icon to allow network access." });
            return;
        }
        var sent = ctx.Request.Headers.Authorization.ToString();
        var expected = $"Bearer {token}";
        // Fixed-time compare — a token check that leaks timing is not a check.
        var ok = sent.Length == expected.Length &&
                 CryptographicOperations.FixedTimeEquals(
                     System.Text.Encoding.UTF8.GetBytes(sent),
                     System.Text.Encoding.UTF8.GetBytes(expected));
        if (!ok)
        {
            ctx.Response.StatusCode = 401;
            await ctx.Response.WriteAsJsonAsync(new { error = "Missing or wrong pairing token." });
            return;
        }
    }
    await next();
});

static IResult Fail(Exception e) => Results.Json(new { error = e.Message }, statusCode: 500);

app.MapGet("/health", () => Results.Json(new { ok = true, product = "pbi-desktop-bridge", version = "0.3.0", ui = true, remote = isRemote, machine = Environment.MachineName }));

app.MapGet("/discover", () =>
{
    try { return Results.Json(PowerBi.Discover().Select(i => new { i.Port, i.Database, i.Workspace })); }
    catch (Exception e) { return Fail(e); }
});

app.MapGet("/model", (int? port) =>
{
    try
    {
        var inst = PowerBi.Resolve(port);
        var db = PowerBi.ConnectDatabase(inst, out var server);
        using var _ = server;
        var model = new
        {
            database = inst.Database,
            port = inst.Port,
            tables = db.Model.Tables.Select(t => new
            {
                name = t.Name,
                isHidden = t.IsHidden,
                columns = t.Columns.Where(c => c.Type != Tom.ColumnType.RowNumber)
                    .Select(c => new { name = c.Name, dataType = c.DataType.ToString() }),
                measures = t.Measures.Select(m => new { name = m.Name, expression = m.Expression, formatString = m.FormatString, displayFolder = m.DisplayFolder }),
            }),
            relationships = db.Model.Relationships.OfType<Tom.SingleColumnRelationship>().Select(r => new
            {
                fromTable = r.FromColumn.Table.Name,
                fromColumn = r.FromColumn.Name,
                toTable = r.ToColumn.Table.Name,
                toColumn = r.ToColumn.Name,
                isActive = r.IsActive,
            }),
        };
        return Results.Json(model);
    }
    catch (Exception e) { return Fail(e); }
});

app.MapPost("/dax", (DaxReq req) =>
{
    try { var inst = PowerBi.Resolve(req.Port); var (columns, rows) = PowerBi.Query(inst, req.Dax); return Results.Json(new { columns, rowCount = rows.Count, rows }); }
    catch (Exception e) { return Fail(e); }
});

// Benchmark a query on the real engine. Used by the Optimizer to prove — rather
// than assert — that a rewrite is faster. Timings are cold-cache by default;
// `cold:false` in the reply means the engine refused to drop its caches and the
// numbers are warm, so the caller must not present them as cold.
app.MapPost("/time", (TimeReq req) =>
{
    try
    {
        var inst = PowerBi.Resolve(req.Port);
        var runs = Math.Clamp(req.Runs ?? 3, 1, 10);
        var (ms, rowCount, first, cold) = PowerBi.Benchmark(inst, req.Dax, runs, req.ClearCache ?? true);
        var sorted = ms.OrderBy(x => x).ToList();
        return Results.Json(new
        {
            ms,
            median = sorted[sorted.Count / 2],
            min = sorted[0],
            runs = sorted.Count,
            rowCount,
            value = first,
            cold,
        });
    }
    catch (Exception e) { return Fail(e); }
});

app.MapPost("/preview", (PreviewReq req) =>
{
    try
    {
        var inst = PowerBi.Resolve(req.Port);
        var (_, rows) = PowerBi.Query(inst, $"EVALUATE ROW(\"Value\", {req.Expression})");
        return Results.Json(new { value = rows.FirstOrDefault()?.Values.FirstOrDefault() });
    }
    catch (Exception e) { return Fail(e); }
});

app.MapPost("/measure", (MeasureReq req) =>
{
    // A payload that doesn't bind Dax (wrong key, older client) used to sail
    // through and blank an existing measure's expression — a silent way to
    // destroy someone's work. Refuse instead: this endpoint never empties DAX.
    if (string.IsNullOrWhiteSpace(req.Dax))
        return Results.Json(new { error = "Missing 'dax'. Refusing to write an empty expression." }, statusCode: 400);
    if (string.IsNullOrWhiteSpace(req.Table) || string.IsNullOrWhiteSpace(req.Name))
        return Results.Json(new { error = "Both 'table' and 'name' are required." }, statusCode: 400);

    try
    {
        var inst = PowerBi.Resolve(req.Port);
        var db = PowerBi.ConnectDatabase(inst, out var server);
        using var _ = server;
        var t = db.Model.Tables.Find(req.Table) ?? throw new InvalidOperationException($"Table '{req.Table}' not found.");
        var m = t.Measures.Find(req.Name);
        var created = m is null;
        if (m is null) { m = new Tom.Measure { Name = req.Name }; t.Measures.Add(m); }
        m.Expression = req.Dax;
        if (req.FormatString is not null) m.FormatString = req.FormatString;
        if (req.DisplayFolder is not null) m.DisplayFolder = req.DisplayFolder;
        db.Model.SaveChanges();
        return Results.Json(new { status = created ? "created" : "updated", table = req.Table, name = req.Name });
    }
    catch (Exception e) { return Fail(e); }
});

// DELETE measures. The only destructive endpoint, so it is deliberately strict:
//
//   * measures only — removing a column or table can break relationships,
//     hierarchies and sort-by orders that TOM will not warn about, and cannot
//     be put back from a JSON snapshot the way a measure can.
//   * two passes — everything is located and snapshotted BEFORE anything is
//     removed, so a bad name aborts the whole batch instead of half-deleting.
//   * one commit — a single SaveChanges, and UndoLocalChanges if it throws, so
//     the outcome is all or nothing.
//   * the snapshot comes back in the response. SaveChanges cannot be undone in
//     the engine, so returning the DAX is what makes this recoverable at all.
app.MapPost("/delete", (DeleteReq req) =>
{
    if (req.Items is null || req.Items.Length == 0)
        return Results.Json(new { error = "Nothing to delete." }, statusCode: 400);

    var unsupported = req.Items
        .Where(i => !string.Equals(i.Kind, "measure", StringComparison.OrdinalIgnoreCase))
        .Select(i => $"{i.Kind} '{i.Name}'")
        .ToArray();
    if (unsupported.Length > 0)
        return Results.Json(new
        {
            error = "Only measures can be deleted from here. Refusing: " + string.Join(", ", unsupported)
                  + ". Columns and tables carry relationships and hierarchies that cannot be restored from a snapshot."
        }, statusCode: 400);

    try
    {
        var inst = PowerBi.Resolve(req.Port);
        var db = PowerBi.ConnectDatabase(inst, out var server);
        using var _ = server;

        // Pass 1 — locate and snapshot. Nothing is modified in this loop.
        var targets = new List<(Tom.Table Table, Tom.Measure Measure)>();
        var snapshot = new List<object>();
        foreach (var it in req.Items)
        {
            var t = db.Model.Tables.Find(it.Table);
            if (t is null)
                return Results.Json(new { error = $"Table '{it.Table}' not found. Nothing was deleted." }, statusCode: 400);
            var m = t.Measures.Find(it.Name);
            if (m is null)
                return Results.Json(new { error = $"Measure '{it.Name}' not found in '{it.Table}'. Nothing was deleted." }, statusCode: 400);

            snapshot.Add(new
            {
                table = it.Table,
                name = m.Name,
                dax = m.Expression,
                formatString = m.FormatString,
                displayFolder = m.DisplayFolder,
                description = m.Description,
            });
            targets.Add((t, m));
        }

        // Pass 2 — remove, then commit once.
        foreach (var (t, m) in targets) t.Measures.Remove(m);

        try
        {
            db.Model.SaveChanges();
        }
        catch (Exception commit)
        {
            // The commit failed, so nothing reached the model. Drop the pending
            // removals so the session is clean and the caller can retry.
            try { db.Model.UndoLocalChanges(); } catch { /* best effort */ }
            return Results.Json(new
            {
                error = "Delete was rolled back: " + commit.Message,
                rolledBack = true,
                snapshot,
            }, statusCode: 500);
        }

        return Results.Json(new { status = "deleted", count = targets.Count, snapshot });
    }
    catch (Exception e) { return Fail(e); }
});

// Create or update a CALCULATED TABLE (e.g. a generated date table). The DAX
// expression is the table; the engine materialises its columns on commit.
app.MapPost("/table", (TableReq req) =>
{
    if (string.IsNullOrWhiteSpace(req.Dax))
        return Results.Json(new { error = "Missing 'dax'. Refusing to write an empty table expression." }, statusCode: 400);
    if (string.IsNullOrWhiteSpace(req.Name))
        return Results.Json(new { error = "'name' is required." }, statusCode: 400);

    try
    {
        var inst = PowerBi.Resolve(req.Port);
        var db = PowerBi.ConnectDatabase(inst, out var server);
        using var _ = server;
        var t = db.Model.Tables.Find(req.Name);
        var created = t is null;
        if (t is null)
        {
            t = new Tom.Table { Name = req.Name };
            t.Partitions.Add(new Tom.Partition
            {
                Name = req.Name,
                Source = new Tom.CalculatedPartitionSource { Expression = req.Dax },
            });
            db.Model.Tables.Add(t);
        }
        else if (t.Partitions.Count == 1 && t.Partitions[0].Source is Tom.CalculatedPartitionSource cps)
        {
            cps.Expression = req.Dax;
        }
        else
        {
            // Never overwrite a real data table with a formula.
            return Results.Json(new { error = $"Table '{req.Name}' exists and is not a calculated table — choose another name." }, statusCode: 409);
        }
        db.Model.SaveChanges();

        // Best-effort second pass on a fresh connection (the calculated columns
        // only exist after the commit above): mark it as the model's date table
        // and relate it to the reference column the range came from. Failure
        // here must not undo the table — report it instead.
        string? note = null;
        try
        {
            var db2 = PowerBi.ConnectDatabase(inst, out var server2);
            using var __ = server2;
            var dt = db2.Model.Tables.Find(req.Name);
            var dateCol = dt?.Columns.Find("Date");
            if (dt is not null && dateCol is not null)
            {
                dt.DataCategory = "Time";
                dateCol.IsKey = true;

                if (!string.IsNullOrWhiteSpace(req.RelateTable) && !string.IsNullOrWhiteSpace(req.RelateColumn))
                {
                    var ft = db2.Model.Tables.Find(req.RelateTable);
                    var fc = ft?.Columns.Find(req.RelateColumn);
                    var already = db2.Model.Relationships.OfType<Tom.SingleColumnRelationship>()
                        .Any(r => r.FromColumn == fc && r.ToColumn == dateCol);
                    if (fc is not null && !already)
                    {
                        // Only one ACTIVE relationship may exist between a table
                        // pair — add inactive if one is already there.
                        var activeExists = db2.Model.Relationships.OfType<Tom.SingleColumnRelationship>()
                            .Any(r => r.IsActive &&
                                ((r.FromColumn.Table == ft && r.ToColumn.Table == dt) ||
                                 (r.FromColumn.Table == dt && r.ToColumn.Table == ft)));
                        db2.Model.Relationships.Add(new Tom.SingleColumnRelationship
                        {
                            Name = Guid.NewGuid().ToString("N"),
                            FromColumn = fc,
                            FromCardinality = Tom.RelationshipEndCardinality.Many,
                            ToColumn = dateCol,
                            ToCardinality = Tom.RelationshipEndCardinality.One,
                            IsActive = !activeExists,
                        });
                        note = activeExists
                            ? $"Related '{req.RelateTable}'[{req.RelateColumn}] as INACTIVE (an active relationship already exists between the tables)."
                            : $"Marked as date table and related '{req.RelateTable}'[{req.RelateColumn}] → '{req.Name}'[Date].";
                    }
                    else if (already) note = "Marked as date table (relationship already existed).";
                }
                else note = "Marked as date table.";
                db2.Model.SaveChanges();
            }
        }
        catch (Exception e2)
        {
            note = $"Table {(created ? "created" : "updated")}, but marking/relating failed: {e2.Message}";
        }
        return Results.Json(new { status = created ? "created" : "updated", table = req.Name, note });
    }
    catch (Exception e) { return Fail(e); }
});

// Anything that isn't a file or an API route is a client-side route — the SPA
// answers it. This is what makes deep links into the Studio work.
app.MapFallback(async ctx =>
{
    var index = ui.GetFileInfo("index.html");
    if (!index.Exists) { ctx.Response.StatusCode = 404; return; }
    ctx.Response.ContentType = "text/html; charset=utf-8";
    await using var s = index.CreateReadStream();
    await s.CopyToAsync(ctx.Response.Body);
});

// ---- NVIDIA NIM proxy ----
// Browser fetch() to integrate.api.nvidia.com is blocked by CORS in every
// browser. Proxying through here keeps the same loopback-only security model:
// the key travels only over localhost, the actual LLM call goes server-side.
app.MapPost("/nim", async (NimProxyReq req) =>
{
    if (string.IsNullOrWhiteSpace(req.ApiKey))
        return Results.Json(new { error = "API key is required." }, statusCode: 400);

    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
    client.DefaultRequestHeaders.Authorization =
        new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", req.ApiKey);

    var payload = System.Text.Json.JsonSerializer.Serialize(new
    {
        model       = req.Model,
        messages    = req.Messages,
        temperature = req.Temperature,
        max_tokens  = req.MaxTokens,
    });

    using var content = new StringContent(payload, System.Text.Encoding.UTF8, "application/json");
    HttpResponseMessage resp;
    try { resp = await client.PostAsync("https://integrate.api.nvidia.com/v1/chat/completions", content); }
    catch (Exception ex) { return Results.Json(new { error = ex.Message }, statusCode: 502); }

    var body = await resp.Content.ReadAsStringAsync();
    return Results.Text(body, "application/json", statusCode: (int)resp.StatusCode);
});

// ---- run: server in the background, tray in the foreground ----
_ = app.RunAsync($"http://{listenIp}:{listenPort}");

// What the tray's "pairing info" dialog shows when sharing is on.
string? pairingInfo = null;
if (isRemote)
{
    var candidates = System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
        .Where(n => n.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up
                    && n.NetworkInterfaceType != System.Net.NetworkInformation.NetworkInterfaceType.Loopback)
        .SelectMany(n => n.GetIPProperties().UnicastAddresses
            .Where(a => a.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
            .Select(a => (Iface: n.Name, Ip: a.Address.ToString())))
        .ToList();
    var lines = new List<string> { "Give these to the person connecting:", "" };
    if (candidates.Count == 0) lines.Add($"Address:  <this machine's IP>:{listenPort}");
    else lines.AddRange(candidates.Select(c => $"Address:  {c.Ip}:{listenPort}   ({c.Iface})"));
    lines.Add($"Token:    {token}");
    lines.Add("");
    if (candidates.Count > 1) lines.Add("Multiple addresses? Use the one on the SAME network as them.");
    lines.Add("Both machines must be on the same Wi-Fi (a phone hotspot is its own network).");
    lines.Add("When Windows Firewall asks, click Allow and tick BOTH network types.");
    lines.Add("The token changes every time sharing starts.");
    pairingInfo = string.Join(Environment.NewLine, lines);
}

// Opened from Desktop's ribbon, or plainly double-clicked → show the Studio.
if (Flag(args, "--launch") || args.Length == 0) Tray.OpenStudio(listenPort);

Tray.Run(new TrayOptions
{
    Port = listenPort,
    IsRemote = isRemote,
    PairingInfo = pairingInfo,
    ReleaseSingleInstance = () => { try { single.ReleaseMutex(); single.Dispose(); } catch { /* already gone */ } },
});

record NimMessage(string Role, string Content);
record NimProxyReq(string ApiKey, string Model, NimMessage[] Messages, double Temperature, int MaxTokens);
record DaxReq(string Dax, int? Port);
record TimeReq(string Dax, int? Runs, bool? ClearCache, int? Port);
record PreviewReq(string Expression, int? Port);
record MeasureReq(string Table, string Name, string Dax, string? FormatString, string? DisplayFolder, int? Port);
record DeleteItem(string Kind, string Table, string Name);
record DeleteReq(DeleteItem[] Items, int? Port);
record TableReq(string Name, string Dax, string? RelateTable, string? RelateColumn, int? Port);
