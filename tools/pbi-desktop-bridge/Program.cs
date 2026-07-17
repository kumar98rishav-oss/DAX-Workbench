using System.Net;
using System.Security.Cryptography;
using PbiDesktopBridge;
using Tom = Microsoft.AnalysisServices.Tabular;

// PBI Desktop Bridge — a tiny LOCAL HTTP API the web Studio calls to work
// against the live Power BI Desktop model. The browser can't speak Analysis
// Services directly, so this local helper does it (TOM to read/write the model,
// ADOMD to run DAX). No cloud, no AI — just the Studio ⇄ Desktop link.
//
//   double-click it            -> asks: this machine only, or share with another
//   ...exe  --local            loopback only, no token (skip the question)
//   ...exe  --remote           answer the network, token required (skip the question)
//   --listen <ip>  --port <n>  --token <secret>

static string? Arg(string[] a, string name)
{
    var i = Array.FindIndex(a, x => string.Equals(x, name, StringComparison.OrdinalIgnoreCase));
    return i >= 0 && i + 1 < a.Length && !a[i + 1].StartsWith("--") ? a[i + 1] : null;
}
static bool Flag(string[] a, string name) => a.Any(x => string.Equals(x, name, StringComparison.OrdinalIgnoreCase));

var remoteMode = Flag(args, "--remote");

// If no mode was chosen and someone just double-clicked this (a real console,
// stdin not piped), ask in plain words instead of making them know a flag exists.
if (!remoteMode && !Flag(args, "--local") && Arg(args, "--listen") is null && !Console.IsInputRedirected)
{
    Console.WriteLine();
    Console.WriteLine("  Power BI Desktop Bridge");
    Console.WriteLine("  =======================================================");
    Console.WriteLine();
    Console.WriteLine("  Who should be able to use this bridge?");
    Console.WriteLine();
    Console.WriteLine("    [1]  Only this computer                    (default)");
    Console.WriteLine("    [2]  This computer AND someone else's Studio");
    Console.WriteLine();
    Console.Write("  Type 1 or 2, then press Enter:  ");
    remoteMode = Console.ReadLine()?.Trim() == "2";
    Console.WriteLine();
}

var listenIp = Arg(args, "--listen") ?? (remoteMode ? "0.0.0.0" : "127.0.0.1");
var listenPort = int.TryParse(Arg(args, "--port"), out var p0) ? p0 : 5177;
var isRemote = listenIp != "127.0.0.1" && listenIp != "localhost";

// A token is MANDATORY the moment this answers anything but loopback. Requests
// from loopback never need one, so the normal local flow is untouched.
var token = Arg(args, "--token")
            ?? Environment.GetEnvironmentVariable("PBI_BRIDGE_TOKEN")
            ?? (isRemote ? Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant() : null);

var builder = WebApplication.CreateBuilder(args);

// Origins allowed to drive this bridge, beyond localhost and a Tauri/Electron
// shell. On loopback there is no token, so this list is the only thing gating a
// web page from reading the model: keep it to exact origins. Never a wildcard
// suffix like "*.onrender.com" — anyone can deploy there, and any of them could
// then reach a running bridge. Drop an origin the moment it stops being yours: a
// released subdomain can be claimed by someone else. Note CORS is a BROWSER rule
// and does nothing against curl — over the network the token is the real gate,
// which is why one is mandatory there.
// Override or extend with PBI_BRIDGE_ORIGINS=https://a.example,https://b.example
var allowedOrigins = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    "https://pbi-design-studio.onrender.com", // the hosted Studio
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

// Chrome's Private Network Access: a page on a public origin reaching a private
// (loopback) address gets an extra preflight, which fails unless we opt in here.
// Not enforced for this today, but it is rolling out — without this the hosted
// Studio would break silently on a future Chrome.
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Headers.ContainsKey("Access-Control-Request-Private-Network"))
        ctx.Response.Headers["Access-Control-Allow-Private-Network"] = "true";
    await next();
});

app.UseCors();

// Auth gate. Runs AFTER UseCors so the CORS preflight — which never carries an
// Authorization header — isn't rejected before the real request is allowed to
// ask. Loopback callers are trusted (they're already on this machine); anything
// arriving over the network must present the pairing token.
app.Use(async (ctx, next) =>
{
    if (HttpMethods.IsOptions(ctx.Request.Method)) { await next(); return; }

    var ip = ctx.Connection.RemoteIpAddress;
    var loopback = ip is not null && IPAddress.IsLoopback(ip);
    if (!loopback)
    {
        if (string.IsNullOrEmpty(token))
        {
            ctx.Response.StatusCode = 403;
            await ctx.Response.WriteAsJsonAsync(new { error = "This bridge only answers the local machine. Start it with --remote to allow network access." });
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

app.MapGet("/health", () => Results.Json(new { ok = true, product = "pbi-desktop-bridge", version = "0.2.0", remote = isRemote, machine = Environment.MachineName }));

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

// What the person on the far machine reads off their screen and sends over.
if (isRemote)
{
    var lan = Dns.GetHostAddresses(Dns.GetHostName())
        .FirstOrDefault(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && !IPAddress.IsLoopback(a));
    // ASCII only: the default console code page turns box-drawing characters
    // into mojibake, and this is the one screen a stranger has to read.
    Console.WriteLine();
    Console.WriteLine("  ===========================================================");
    Console.WriteLine("    REMOTE BRIDGE - give these two lines to the Studio user");
    Console.WriteLine("  ===========================================================");
    Console.WriteLine();
    Console.WriteLine($"     Address :  {lan?.ToString() ?? "<this machine's IP>"}:{listenPort}");
    Console.WriteLine($"     Token   :  {token}");
    Console.WriteLine();
    Console.WriteLine("     Anyone with that token can read this model and write measures");
    Console.WriteLine("     into it. Send it privately, and close this window when done.");
    Console.WriteLine("     The token changes every time this starts.");
    Console.WriteLine();
    Console.WriteLine("     Traffic is plain HTTP. On an untrusted network, prefer:");
    Console.WriteLine($"       ssh -N -L {listenPort}:127.0.0.1:{listenPort} <user>@{lan?.ToString() ?? "<ip>"}");
    Console.WriteLine("     then connect to 127.0.0.1 instead — no token, and encrypted.");
    Console.WriteLine();
}
else
{
    Console.WriteLine();
    Console.WriteLine($"  Bridge listening on http://127.0.0.1:{listenPort} — this machine only.");
    Console.WriteLine("  Leave this window open. Open a .pbix in Power BI Desktop, then the Studio.");
    Console.WriteLine("  To share with another machine, close this and run it again, choosing [2].");
    Console.WriteLine();
}

app.Run($"http://{listenIp}:{listenPort}");

record DaxReq(string Dax, int? Port);
record PreviewReq(string Expression, int? Port);
record MeasureReq(string Table, string Name, string Dax, string? FormatString, string? DisplayFolder, int? Port);
