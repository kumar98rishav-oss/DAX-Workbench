using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;
using Tom = Microsoft.AnalysisServices.Tabular;

namespace PbiMcpBridge;

/// <summary>
/// MCP tools over the live Power BI Desktop model. `port` is optional — when a
/// single model is open it's auto-selected; otherwise pass the port from
/// `discover_powerbi`.
/// </summary>
[McpServerToolType]
public static class PowerBiTools
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private static string Ok(object o) => JsonSerializer.Serialize(o, Json);
    private static string Err(Exception e) => JsonSerializer.Serialize(new { error = e.Message }, Json);

    [McpServerTool, Description("List open Power BI Desktop models (their database name + port). Call this first if several files are open.")]
    public static string discover_powerbi()
    {
        try { return Ok(PowerBi.Discover().Select(i => new { i.Port, i.Database, i.Workspace })); }
        catch (Exception e) { return Err(e); }
    }

    [McpServerTool, Description("Read the model schema: tables, columns (name + data type), measures (name + DAX), and relationships. Use this to ground any DAX you write.")]
    public static string get_model([Description("Model port; omit if only one is open")] int? port = null)
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
                    crossFilter = r.CrossFilteringBehavior.ToString(),
                }),
            };
            return Ok(model);
        }
        catch (Exception e) { return Err(e); }
    }

    [McpServerTool, Description("List every measure with its DAX expression, format string and display folder.")]
    public static string list_measures(int? port = null)
    {
        try
        {
            var inst = PowerBi.Resolve(port);
            var db = PowerBi.ConnectDatabase(inst, out var server);
            using var _ = server;
            var measures = db.Model.Tables.SelectMany(t => t.Measures.Select(m => new
            {
                table = t.Name, name = m.Name, expression = m.Expression, formatString = m.FormatString, displayFolder = m.DisplayFolder,
            }));
            return Ok(measures);
        }
        catch (Exception e) { return Err(e); }
    }

    [McpServerTool, Description("Run a DAX query against the REAL data and return the rows. Must start with EVALUATE, e.g. EVALUATE TOPN(10, 'Sales').")]
    public static string run_dax([Description("A DAX query beginning with EVALUATE")] string dax, int? port = null)
    {
        try
        {
            var inst = PowerBi.Resolve(port);
            var (columns, rows) = PowerBi.Query(inst, dax);
            return Ok(new { columns, rowCount = rows.Count, rows });
        }
        catch (Exception e) { return Err(e); }
    }

    [McpServerTool, Description("Evaluate a scalar DAX expression (or measure body) against the real data and return the single value. Great for verifying a measure before deploying it.")]
    public static string preview_measure([Description("A scalar DAX expression, e.g. SUM('Sales'[Amount]) or [Total Sales]")] string expression, int? port = null)
    {
        try
        {
            var inst = PowerBi.Resolve(port);
            var (_, rows) = PowerBi.Query(inst, $"EVALUATE ROW(\"Value\", {expression})");
            var value = rows.FirstOrDefault()?.Values.FirstOrDefault();
            return Ok(new { value });
        }
        catch (Exception e) { return Err(e); }
    }

    [McpServerTool, Description("Create or update a measure in the live model and save it — it appears in Power BI Desktop immediately.")]
    public static string create_or_update_measure(
        [Description("Home table for the measure")] string table,
        [Description("Measure name")] string name,
        [Description("DAX expression (no 'Name =' prefix)")] string dax,
        [Description("Optional format string, e.g. \\$#,0.00 or 0.0%")] string? formatString = null,
        [Description("Optional display folder")] string? displayFolder = null,
        int? port = null)
    {
        try
        {
            var inst = PowerBi.Resolve(port);
            var db = PowerBi.ConnectDatabase(inst, out var server);
            using var _ = server;
            var t = db.Model.Tables.Find(table) ?? throw new InvalidOperationException($"Table '{table}' not found.");
            var m = t.Measures.Find(name);
            var created = m is null;
            if (m is null) { m = new Tom.Measure { Name = name }; t.Measures.Add(m); }
            m.Expression = dax;
            if (formatString is not null) m.FormatString = formatString;
            if (displayFolder is not null) m.DisplayFolder = displayFolder;
            db.Model.SaveChanges();
            return Ok(new { status = created ? "created" : "updated", table, name });
        }
        catch (Exception e) { return Err(e); }
    }

    [McpServerTool, Description("Delete a measure from the live model.")]
    public static string delete_measure(string name, int? port = null)
    {
        try
        {
            var inst = PowerBi.Resolve(port);
            var db = PowerBi.ConnectDatabase(inst, out var server);
            using var _ = server;
            foreach (var t in db.Model.Tables)
            {
                var m = t.Measures.Find(name);
                if (m is not null) { t.Measures.Remove(m); db.Model.SaveChanges(); return Ok(new { status = "deleted", table = t.Name, name }); }
            }
            return Ok(new { status = "not_found", name });
        }
        catch (Exception e) { return Err(e); }
    }
}
