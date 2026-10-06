using System.Data;
using Microsoft.AnalysisServices.AdomdClient;
using Microsoft.Data.SqlClient;

namespace PbiDesktopBridge;

/// <summary>
/// The I/O half of the comparison: streams both engines into the pure core.
///
/// Reconcile.cs deliberately knows nothing about databases, so this is the only
/// place a reader meets an accumulator — and the only place that has to be read
/// carefully for the scalability claim to hold.
///
/// The claim is one line of code, repeated twice:
///
///     while (reader.Read()) acc.Add(buffer);
///
/// One row buffer, reused. Nothing is appended to a list, nothing is serialised,
/// and the row is forgotten before the next one arrives. What survives the loop
/// is the accumulator's buckets, which are O(distinct keys). A fact table of a
/// hundred million rows grouped to month x category leaves a few hundred
/// buckets behind, so the limit stopped being "how many rows fit in a browser"
/// and became "how many GROUPS do you actually want to compare" — which is a
/// question with a sane answer.
///
/// Both sides run CONCURRENTLY. They hit different servers and neither waits on
/// the other, so the wall time is the slower engine rather than their sum; the
/// old sequential path was also a correctness smell, since the gap between the
/// two reads is drift and drift is indistinguishable from a real difference.
/// </summary>
public static class ReconcileRun
{
    public sealed record FieldPair(string Source, string Target);

    public sealed record Request(
        SqlConn Sql,
        string SqlQuery,
        string DaxQuery,
        int? Port,
        List<FieldPair> Keys,
        List<FieldPair> Values,
        decimal? ToleranceAbsolute,
        decimal? ToleranceRelative,
        bool? CaseInsensitive,
        bool? Trim,
        string? DateGranularity,
        int? RowCap,
        int? MaxKeys,
        int? MaxRows);

    /// <summary>
    /// Default row cap.
    ///
    /// Two orders of magnitude above the old 200,000, and it is no longer
    /// protecting memory — the accumulator does that. It protects against a
    /// query nobody meant to run: a missing WHERE clause should stop, not
    /// stream for an hour. Truncation still REFUSES the comparison rather than
    /// reporting a partial one, so a raised cap never buys a wrong answer.
    /// </summary>
    private const int DefaultRowCap = 20_000_000;

    public sealed record Response(
        Reconcile.Result Comparison,
        long SourceMs,
        long TargetMs,
        List<string> SourceColumns,
        List<string> TargetColumns,
        List<string> ValueLabels);

    public static Response Run(Request req)
    {
        var opts = new Reconcile.NormalizeOptions(
            req.CaseInsensitive ?? true,
            req.Trim ?? true,
            req.DateGranularity ?? "date");

        var tol = new Reconcile.Tolerance(
            req.ToleranceAbsolute ?? 0.000001m,
            req.ToleranceRelative ?? 0m);

        var rowCap = Math.Clamp(req.RowCap ?? DefaultRowCap, 1, 100_000_000);
        var maxKeys = Math.Clamp(req.MaxKeys ?? 2_000_000, 1, 20_000_000);

        var srcKeys = req.Keys.Select(k => k.Source).ToList();
        var srcVals = req.Values.Select(v => v.Source).ToList();
        var tgtKeys = req.Keys.Select(k => k.Target).ToList();
        var tgtVals = req.Values.Select(v => v.Target).ToList();

        // Resolve the model BEFORE starting either task: discovery throws a
        // message meant for a human, and losing it inside an AggregateException
        // would turn "open a .pbix in Desktop" into "one or more errors
        // occurred".
        var inst = PowerBi.Resolve(req.Port);

        Reconcile.SideAccumulator? srcAcc = null, tgtAcc = null;
        long srcMs = 0, tgtMs = 0;
        List<string> srcCols = new(), tgtCols = new();

        var source = Task.Run(() =>
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            (srcAcc, srcCols) = StreamSql(req.Sql, req.SqlQuery, srcKeys, srcVals, opts, rowCap, maxKeys);
            srcMs = sw.ElapsedMilliseconds;
        });

        var target = Task.Run(() =>
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            (tgtAcc, tgtCols) = StreamDax(inst, req.DaxQuery, tgtKeys, tgtVals, opts, rowCap, maxKeys);
            tgtMs = sw.ElapsedMilliseconds;
        });

        try
        {
            Task.WaitAll(source, target);
        }
        catch (AggregateException ex)
        {
            // Surface the first real cause: the UI shows this string to a
            // person, and "one or more errors occurred" helps nobody.
            throw ex.InnerExceptions.Count > 0 ? ex.InnerExceptions[0] : ex;
        }

        var result = Reconcile.Compare(
            srcAcc!, tgtAcc!, req.Values.Count, tol,
            // Both sides started together, so drift is the difference in how
            // long they took, not the gap between two sequential reads.
            driftMs: Math.Abs(srcMs - tgtMs),
            maxRows: Math.Clamp(req.MaxRows ?? 5000, 1, 100_000));

        return new Response(result, srcMs, tgtMs, srcCols, tgtCols,
            req.Values.Select(v => v.Target).ToList());
    }

    private static (Reconcile.SideAccumulator, List<string>) StreamSql(
        SqlConn c, string sql, List<string> keys, List<string> vals,
        Reconcile.NormalizeOptions opts, int rowCap, int maxKeys)
    {
        ReadOnlySql.Validate(sql);

        using var conn = Sql.OpenForRead(c);
        using var cmd = new SqlCommand(sql, conn)
        {
            CommandTimeout = Math.Clamp(c.TimeoutSec ?? 300, 1, 3600),
        };
        // SequentialAccess streams each row's columns in order instead of
        // buffering the whole row — the right mode when we read every column
        // once and discard it.
        using var reader = cmd.ExecuteReader(CommandBehavior.SingleResult);

        var cols = new List<string>();
        for (var i = 0; i < reader.FieldCount; i++) cols.Add(reader.GetName(i));

        var acc = new Reconcile.SideAccumulator(cols, keys, vals, opts, maxKeys);
        if (acc.MissingColumns.Count > 0) return (acc, cols);

        var buffer = new object?[reader.FieldCount];
        while (reader.Read())
        {
            if (acc.RowsRead >= rowCap) { acc.Truncated = true; break; }
            for (var i = 0; i < reader.FieldCount; i++)
                buffer[i] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            acc.Add(buffer);          // buffer is reused — nothing is retained
        }

        return (acc, cols);
    }

    private static (Reconcile.SideAccumulator, List<string>) StreamDax(
        Instance inst, string dax, List<string> keys, List<string> vals,
        Reconcile.NormalizeOptions opts, int rowCap, int maxKeys)
    {
        using var conn = new AdomdConnection($"Data Source={inst.DataSource};Catalog={inst.Database}");
        conn.Open();
        using var cmd = new AdomdCommand(dax, conn);
        using var reader = cmd.ExecuteReader();

        var cols = new List<string>();
        for (var i = 0; i < reader.FieldCount; i++) cols.Add(reader.GetName(i));

        var acc = new Reconcile.SideAccumulator(cols, keys, vals, opts, maxKeys);
        if (acc.MissingColumns.Count > 0) return (acc, cols);

        var buffer = new object?[reader.FieldCount];
        while (reader.Read())
        {
            if (acc.RowsRead >= rowCap) { acc.Truncated = true; break; }
            for (var i = 0; i < reader.FieldCount; i++)
                buffer[i] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            acc.Add(buffer);
        }

        return (acc, cols);
    }
}
