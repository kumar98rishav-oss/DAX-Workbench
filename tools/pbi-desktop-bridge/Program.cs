using PbiDesktopBridge;
using Tom = Microsoft.AnalysisServices.Tabular;

// PBI Desktop Bridge — a tiny LOCAL HTTP API the web Studio calls to work
// against the live Power BI Desktop model. The browser can't speak Analysis
// Services directly, so this local helper does it (TOM to read/write the model,
// ADOMD to run DAX). No cloud, no AI — just the Studio ⇄ Desktop link.

var builder = WebApplication.CreateBuilder(args);

// Origins allowed to drive this bridge, beyond localhost and a Tauri/Electron
// shell. This bridge is UNAUTHENTICATED and can read the whole model and write
// measures into it, so this list is the only thing gating that: keep it to exact
// origins. Never a wildcard suffix like "*.onrender.com" — anyone can deploy
// there, and any of them could then reach a running bridge. Drop an origin the
// moment it stops being yours: a released subdomain can be claimed by someone
// else. Override or extend with PBI_BRIDGE_ORIGINS=https://a.example,https://b.example
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

static IResult Fail(Exception e) => Results.Json(new { error = e.Message }, statusCode: 500);

app.MapGet("/health", () => Results.Json(new { ok = true, product = "pbi-desktop-bridge", version = "0.1.0" }));

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

app.Run("http://127.0.0.1:5177");

record DaxReq(string Dax, int? Port);
record PreviewReq(string Expression, int? Port);
record MeasureReq(string Table, string Name, string Dax, string? FormatString, string? DisplayFolder, int? Port);
