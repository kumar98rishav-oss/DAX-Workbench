using System.Data;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;

namespace PbiDesktopBridge;

/// <summary>How to reach a SQL Server. Components, not a raw connection string:
/// the string is built here with SqlConnectionStringBuilder so a value carrying
/// a semicolon cannot smuggle in extra keywords.</summary>
public record SqlConn(
    string Server,
    string? Database,
    /// <summary>"integrated" (default) or "sql".</summary>
    string? Auth,
    string? User,
    string? Password,
    bool? TrustServerCertificate,
    int? TimeoutSec);

public static class Sql
{
    /// <summary>A password must never reach a log line, an error body or the UI.
    /// SQL exceptions quote the connection string freely, so everything leaving
    /// this file goes through here first.</summary>
    public static string Redact(string text) =>
        Regex.Replace(text, @"(Password|Pwd)\s*=\s*[^;]*", "$1=***", RegexOptions.IgnoreCase);

    public static string Build(SqlConn c)
    {
        var b = new SqlConnectionStringBuilder
        {
            DataSource = c.Server,
            ConnectTimeout = Math.Clamp(c.TimeoutSec ?? 15, 1, 120),
            // Read-only intent: on an availability group this routes to a
            // readable secondary, and it states the tool's purpose to the DBA
            // reading the connection in sys.dm_exec_sessions.
            ApplicationIntent = ApplicationIntent.ReadOnly,
            ApplicationName = "DAX Workbench (reconciliation, read-only)",
            TrustServerCertificate = c.TrustServerCertificate ?? true,
            Pooling = true,
        };
        if (!string.IsNullOrWhiteSpace(c.Database)) b.InitialCatalog = c.Database;

        if (string.Equals(c.Auth, "sql", StringComparison.OrdinalIgnoreCase))
        {
            if (string.IsNullOrWhiteSpace(c.User))
                throw new InvalidOperationException("SQL authentication needs a user name.");
            b.UserID = c.User;
            b.Password = c.Password ?? "";
        }
        else
        {
            // The default, and the recommendation: the bridge runs as the
            // signed-in user, so no secret is stored or transmitted anywhere.
            b.IntegratedSecurity = true;
        }
        return b.ConnectionString;
    }

    private static SqlConnection Open(SqlConn c)
    {
        var conn = new SqlConnection(Build(c));
        conn.Open();
        return conn;
    }

    public record TestResult(string Server, string? Database, string Login, string? Collation, string Version);

    /// <summary>Prove the connection works and report what the user is actually
    /// connected to — collation included, because it decides whether key
    /// comparison should fold case.</summary>
    public static TestResult Test(SqlConn c)
    {
        using var conn = Open(c);
        using var cmd = new SqlCommand(
            "SELECT CAST(SERVERPROPERTY('ServerName') AS nvarchar(256)), DB_NAME(), SUSER_SNAME(), " +
            "CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)), " +
            "CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64))", conn);
        cmd.CommandTimeout = Math.Clamp(c.TimeoutSec ?? 15, 1, 120);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) throw new InvalidOperationException("The server answered but returned nothing.");
        return new TestResult(
            r.IsDBNull(0) ? c.Server : r.GetString(0),
            r.IsDBNull(1) ? null : r.GetString(1),
            r.IsDBNull(2) ? "(unknown)" : r.GetString(2),
            r.IsDBNull(3) ? null : r.GetString(3),
            r.IsDBNull(4) ? "(unknown)" : r.GetString(4));
    }

    public record SchemaColumn(string Name, string DataType, bool Nullable);
    /// <summary>PrimaryKey is in key order and empty when the object declares none
    /// (a view never does). It is the only trustworthy statement of a table's
    /// grain available without asking the user.</summary>
    public record SchemaObject(string Schema, string Name, string Kind, List<SchemaColumn> Columns, List<string> PrimaryKey);

    /// <summary>Every table and view the login can read, with columns. Driven by
    /// INFORMATION_SCHEMA, which only shows what the caller already has rights
    /// to — db_datareader is enough, and nothing more is requested.</summary>
    public static List<SchemaObject> Schema(SqlConn c)
    {
        using var conn = Open(c);
        var byKey = new Dictionary<string, SchemaObject>(StringComparer.OrdinalIgnoreCase);

        using (var cmd = new SqlCommand(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES " +
            "ORDER BY TABLE_SCHEMA, TABLE_NAME", conn))
        {
            cmd.CommandTimeout = 30;
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                var o = new SchemaObject(r.GetString(0), r.GetString(1),
                    r.GetString(2) == "VIEW" ? "view" : "table", new List<SchemaColumn>(), new List<string>());
                byKey[$"{o.Schema}.{o.Name}"] = o;
            }
        }

        using (var cmd = new SqlCommand(
            "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE " +
            "FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION", conn))
        {
            cmd.CommandTimeout = 30;
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                if (byKey.TryGetValue($"{r.GetString(0)}.{r.GetString(1)}", out var o))
                    o.Columns.Add(new SchemaColumn(r.GetString(2), r.GetString(3),
                        string.Equals(r.GetString(4), "YES", StringComparison.OrdinalIgnoreCase)));
            }
        }

        // Declared primary keys, in key order. This is the one authoritative
        // statement of a table's grain we can read without asking — and the
        // grain is what every duplicate check depends on getting right.
        using (var cmd = new SqlCommand(
            "SELECT tc.TABLE_SCHEMA, tc.TABLE_NAME, kcu.COLUMN_NAME " +
            "FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc " +
            "JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu " +
            "  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME " +
            " AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA " +
            "WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' " +
            "ORDER BY tc.TABLE_SCHEMA, tc.TABLE_NAME, kcu.ORDINAL_POSITION", conn))
        {
            cmd.CommandTimeout = 30;
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                if (byKey.TryGetValue($"{r.GetString(0)}.{r.GetString(1)}", out var o))
                    o.PrimaryKey.Add(r.GetString(2));
            }
        }

        return byKey.Values.ToList();
    }

    public record QueryResult(List<string> Columns, int RowCount, List<Dictionary<string, object?>> Rows, bool Truncated);

    /// <summary>
    /// Run one read-only statement.
    ///
    /// `truncated` is load-bearing, not informational: a side that silently
    /// stopped at the cap makes the comparison invent thousands of differences
    /// that do not exist, so the client refuses to compare when it is set.
    /// </summary>
    public static QueryResult Query(SqlConn c, string sql, int rowCap)
    {
        ReadOnlySql.Validate(sql);
        rowCap = Math.Clamp(rowCap, 1, 200_000);

        using var conn = Open(c);
        using var cmd = new SqlCommand(sql, conn) { CommandTimeout = Math.Clamp(c.TimeoutSec ?? 30, 1, 600) };
        using var reader = cmd.ExecuteReader(CommandBehavior.SingleResult);

        var cols = new List<string>();
        for (var i = 0; i < reader.FieldCount; i++) cols.Add(reader.GetName(i));

        var rows = new List<Dictionary<string, object?>>();
        var truncated = false;
        while (reader.Read())
        {
            if (rows.Count >= rowCap) { truncated = true; break; }
            var row = new Dictionary<string, object?>(cols.Count);
            for (var i = 0; i < reader.FieldCount; i++)
                row[cols[i]] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            rows.Add(row);
        }

        return new QueryResult(cols, rows.Count, rows, truncated);
    }
}
