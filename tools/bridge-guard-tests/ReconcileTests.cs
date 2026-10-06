using PbiDesktopBridge;
using N = PbiDesktopBridge.Reconcile.NormalizeOptions;

/// <summary>
/// Parity + precision tests for the C# comparison engine.
///
/// The TypeScript suite (src/application/reconcile/*.test.ts) is the
/// SPECIFICATION. Every trap case there is restated here, because the move off
/// the browser is only safe if the verdicts are identical — a reconciliation
/// engine that changes its mind when you change where it runs is worse than the
/// row cap it was built to remove.
///
/// The exceptions are deliberate and are asserted AS divergences at the bottom:
/// values that JavaScript cannot represent exactly. Those are the entire reason
/// for the move, so they are pinned as features rather than tolerated as drift.
/// </summary>
internal static class ReconcileTests
{
    private static int _passed;
    private static readonly List<string> _failed = new();

    private static readonly N Def = N.Default;
    private static string Norm(object? v, N? o = null) => Reconcile.NormalizeKeyValue(v, o ?? Def);

    private static void Same(string name, object? a, object? b, N? o = null)
    {
        var (x, y) = (Norm(a, o), Norm(b, o));
        if (x == y) _passed++;
        else _failed.Add($"{name}\n      expected same key, got {x} vs {y}");
    }

    private static void Differ(string name, object? a, object? b, N? o = null)
    {
        var (x, y) = (Norm(a, o), Norm(b, o));
        if (x != y) _passed++;
        else _failed.Add($"{name}\n      expected DIFFERENT keys, both were {x}");
    }

    private static void Is(string name, string actual, string expected)
    {
        if (actual == expected) _passed++;
        else _failed.Add($"{name}\n      expected {expected}, got {actual}");
    }

    private static void True(string name, bool cond)
    {
        if (cond) _passed++; else _failed.Add(name);
    }

    // Build one side from literal rows — the pure core needs no database.
    private static Reconcile.SideAccumulator Side(
        string[] columns, string[] keys, string[] vals, params object?[][] rows)
    {
        var acc = new Reconcile.SideAccumulator(columns, keys, vals, Def);
        foreach (var r in rows) acc.Add(r);
        return acc;
    }

    public static (int passed, List<string> failed) Run()
    {
        // ── trap: CHAR(n) padding ───────────────────────────────────────────
        Same("CHAR padding: space-padded joins to trimmed", "ABC       ", "ABC");
        Same("CHAR padding: leading whitespace too", "  ABC", "ABC");
        Differ("CHAR padding: kept when trimming is off", "ABC  ", "ABC",
            Def with { Trim = false });

        // ── trap: DATE vs DATETIME ──────────────────────────────────────────
        Same("date: bare date joins midnight datetime", "2024-01-01", "2024-01-01T00:00:00");
        Same("date: time ignored at date granularity", "2024-01-01T13:45:00", "2024-01-01");
        Differ("date: time significant at datetime granularity",
            "2024-01-01T13:45:00", "2024-01-01T09:00:00", Def with { DateGranularity = "datetime" });
        // A naive datetime parsed as local time lands on the previous day in
        // any negative-offset zone — a whole-day error caused by geography.
        Is("date: naive datetime is NOT timezone-shifted", Norm("2024-01-01T00:00:00"), "t:2024-01-01");
        Is("date: UTC DateTime keeps its UTC day",
            Norm(new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc)), "t:2024-01-01");
        Is("date: offset datetime is converted to UTC",
            Norm("2023-12-31T23:00:00-02:00"), "t:2024-01-01");

        // ── trap: numeric drift ─────────────────────────────────────────────
        Same("numeric: 1 and \"1\"", 1, "1");
        Same("numeric: \"1.0\" and 1", "1.0", 1);
        Same("numeric: \"1.50\" and 1.5", "1.50", 1.5m);
        Same("numeric: SQL decimal and model int", 42m, 42);
        Same("numeric: long and its text", 42L, "42");
        // Product code "007" collapsing onto 7 would reconcile two different
        // products as one — the costliest possible silent success.
        Differ("numeric: leading zero stays an identifier", "007", 7);
        Is("numeric: \"007\" is a string", Norm("007"), "s:007");
        Is("canonicalNumber: 1.0", Reconcile.CanonicalNumber("1.0") ?? "null", "1");
        Is("canonicalNumber: -2.50", Reconcile.CanonicalNumber("-2.50") ?? "null", "-2.5");
        Is("canonicalNumber: 007 rejected", Reconcile.CanonicalNumber("007") ?? "null", "null");
        Is("canonicalNumber: -012 rejected", Reconcile.CanonicalNumber("-012") ?? "null", "null");
        Is("canonicalNumber: 1,000 rejected", Reconcile.CanonicalNumber("1,000") ?? "null", "null");
        Is("canonicalNumber: abc rejected", Reconcile.CanonicalNumber("abc") ?? "null", "null");
        // C# would render these as "1.0" / "1.50" without the canonical
        // formatter, which would break the join across the two engines.
        Is("numText trims trailing zeros", Reconcile.NumText(1.50m), "1.5");
        Is("numText renders integers bare", Reconcile.NumText(1.0m), "1");
        Is("numText collapses negative zero", Reconcile.NumText(-0.0m), "0");

        // ── trap: collation / case ──────────────────────────────────────────
        Same("collation: case folded by default", "ABC", "abc");
        Differ("collation: case significant when CS", "ABC", "abc", Def with { CaseInsensitive = false });

        // ── trap: bit vs boolean ────────────────────────────────────────────
        Same("bit: true joins 1", true, 1);
        Same("bit: false joins 0", false, 0);

        // ── blank handling ──────────────────────────────────────────────────
        Same("blank: null and DBNull", null, DBNull.Value);
        Differ("blank: blank is not the text \"null\"", null, "null");
        Differ("blank: blank is not an empty string", null, "");
        Is("blank: NaN is blank, never 0", Norm(double.NaN), "n:");
        Is("blank: Infinity is blank, never 0", Norm(double.PositiveInfinity), "n:");

        // ── trap: composite key collision ───────────────────────────────────
        string Key(params object?[] parts) =>
            Reconcile.CompositeKey(parts.Select(p => Norm(p)).ToList());

        True("composite: (1,23) differs from (12,3)", Key(1, 23) != Key(12, 3));
        True("composite: delimiter cannot forge a key", Key("a|b", "c") != Key("a", "b|c"));
        True("composite: length prefix cannot forge a key", Key("3:x", "y") != Key("x", "3:y"));
        // Found by mutation testing in the TS suite: the type tags make plain
        // concatenation LOOK safe for ordinary data, so the cases above passed
        // even against a naive join. This pair collides under concatenation
        // (both "s:as:bs:c") and is what makes length-prefixing necessary.
        True("composite: TYPE TAG cannot forge a key", Key("as:b", "c") != Key("a", "bs:c"));
        Is("composite: length-prefixes each part",
            Reconcile.CompositeKey(new[] { "d:1", "d:23" }), "3:d:1|4:d:23");
        True("composite: stable for equivalent input", Key("ABC ", 1) == Key("abc", "1"));

        // ── displayKeyPart ──────────────────────────────────────────────────
        Is("display: strips string tag", Reconcile.DisplayKeyPart("s:east"), "east");
        Is("display: strips number tag", Reconcile.DisplayKeyPart("d:42"), "42");
        Is("display: renders blank readably", Reconcile.DisplayKeyPart("n:"), "(blank)");

        // ── toComparableNumber ──────────────────────────────────────────────
        True("comparable: passes numbers through", Reconcile.ToComparableNumber(42) == 42m);
        True("comparable: parses numeric text", Reconcile.ToComparableNumber("42.5") == 42.5m);
        True("comparable: null for blank", Reconcile.ToComparableNumber(null) is null);
        True("comparable: null for empty string", Reconcile.ToComparableNumber("") is null);
        // Coercing a text column to 0 would manufacture a clean reconciliation
        // out of a configuration mistake.
        True("comparable: null for text, never 0", Reconcile.ToComparableNumber("East") is null);

        // ── comparison: the core verdicts ───────────────────────────────────
        var cols = new[] { "Mo", "Amt" };
        var keys = new[] { "Mo" };
        var vals = new[] { "Amt" };

        var r1 = Reconcile.Compare(
            Side(cols, keys, vals, new object?[] { 1, 100m }, new object?[] { 2, 200m }),
            Side(cols, keys, vals, new object?[] { 1, 100m }, new object?[] { 2, 200m }),
            1);
        True("compare: identical sides all match",
            r1.Summary.Matched == 2 && r1.Summary.Mismatched == 0 && r1.Refusal is null);

        var r2 = Reconcile.Compare(
            Side(cols, keys, vals, new object?[] { 1, 100m }),
            Side(cols, keys, vals, new object?[] { 1, 150m }),
            1);
        True("compare: a difference is a mismatch", r2.Summary.Mismatched == 1);
        True("compare: delta is target minus source", r2.Rows[0].Cells[0].Delta == 50m);

        var r3 = Reconcile.Compare(
            Side(cols, keys, vals, new object?[] { 1, 100m }, new object?[] { 2, 50m }),
            Side(cols, keys, vals, new object?[] { 1, 100m }),
            1);
        True("compare: a key missing on the right is onlySource", r3.Summary.OnlySource == 1);

        // Rows are summed to the grain, and a non-unique key is reported rather
        // than silently aggregated away.
        var r4 = Reconcile.Compare(
            Side(cols, keys, vals, new object?[] { 1, 60m }, new object?[] { 1, 40m }),
            Side(cols, keys, vals, new object?[] { 1, 100m }),
            1);
        True("compare: rows aggregate to the grain", r4.Summary.Matched == 1);
        True("compare: a duplicated key is reported", r4.Summary.SourceDuplicateKeys == 1);

        // The false green that shipped once: both sides parse to null, null
        // equals null, and two different dates reported as a match.
        var txt = new[] { "K", "D" };
        var r5 = Reconcile.Compare(
            Side(txt, new[] { "K" }, new[] { "D" }, new object?[] { 1, "2023-01-01" }),
            Side(txt, new[] { "K" }, new[] { "D" }, new object?[] { 1, "2024-12-31" }),
            1);
        True("compare: different dates are NOT a match", r5.Summary.Mismatched == 1);

        var r6 = Reconcile.Compare(
            Side(txt, new[] { "K" }, new[] { "D" }, new object?[] { 1, "Acme" }),
            Side(txt, new[] { "K" }, new[] { "D" }, new object?[] { 1, "Acme" }),
            1);
        True("compare: identical text IS a match", r6.Summary.Matched == 1);

        // ── the three refusals ──────────────────────────────────────────────
        var trunc = Side(cols, keys, vals, new object?[] { 1, 100m });
        trunc.Truncated = true;
        var r7 = Reconcile.Compare(trunc, Side(cols, keys, vals, new object?[] { 1, 100m }), 1);
        True("refuse: truncation blocks the comparison", r7.Refusal?.Kind == "truncated");
        True("refuse: truncation names the side", r7.Refusal?.Side == "source");
        True("refuse: a refusal returns no rows", r7.Rows.Count == 0);

        var r8 = Reconcile.Compare(
            Side(cols, keys, vals), Side(cols, keys, vals), 1);
        True("refuse: both sides empty", r8.Refusal?.Kind == "emptyBothSides");

        var r9 = Reconcile.Compare(
            Side(cols, keys, vals, new object?[] { 1, 100m }),
            Side(cols, keys, vals, new object?[] { 99, 100m }),
            1);
        True("refuse: zero key overlap is a pairing mistake, not 100% mismatch",
            r9.Refusal?.Kind == "noKeyOverlap");

        // ── tolerance ───────────────────────────────────────────────────────
        var r10 = Reconcile.Compare(
            Side(cols, keys, vals, new object?[] { 1, 100m }),
            Side(cols, keys, vals, new object?[] { 1, 100.0000005m }),
            1, new Reconcile.Tolerance(0.000001m, 0m));
        True("tolerance: inside absolute tolerance is a match", r10.Summary.Matched == 1);

        var r11 = Reconcile.Compare(
            Side(cols, keys, vals, new object?[] { 1, 100m }),
            Side(cols, keys, vals, new object?[] { 1, 101m }),
            1, new Reconcile.Tolerance(0m, 0.02m));
        True("tolerance: inside relative tolerance is a match", r11.Summary.Matched == 1);

        // ── ordering and the display cap ────────────────────────────────────
        var many = new List<object?[]>();
        for (var i = 0; i < 100; i++) many.Add(new object?[] { i, 10m });
        var tgt = new List<object?[]>();
        for (var i = 0; i < 100; i++) tgt.Add(new object?[] { i, i == 42 ? 9999m : 10m });

        var r12 = Reconcile.Compare(
            Side(cols, keys, vals, many.ToArray()),
            Side(cols, keys, vals, tgt.ToArray()),
            1, maxRows: 5);
        // Ordering before capping is what makes capping safe: what gets dropped
        // is always the agreements, never the findings.
        True("cap: the mismatch survives a 5-row cap", r12.Rows[0].Status == "mismatch");
        True("cap: only maxRows are returned", r12.Rows.Count == 5);
        True("cap: capping is flagged", r12.RowsCapped);
        // The counts must cover every key even though the list was trimmed —
        // conflating a display cap with a truncated READ would resurrect the
        // exact confusion this engine was built to remove.
        True("cap: summary counts remain complete over ALL keys",
            r12.Summary.Matched == 99 && r12.Summary.Mismatched == 1);
        True("cap: total row count is reported", r12.TotalRows == 100);

        // ── the reason this moved out of the browser ────────────────────────
        // Above 2^53 JavaScript cannot hold consecutive integers, so these two
        // sums are the SAME number in the browser and the comparison reports a
        // false match. decimal holds both exactly.
        const decimal big = 9007199254740993m;   // 2^53 + 1
        const decimal bigMinus = 9007199254740992m; // 2^53
        var r13 = Reconcile.Compare(
            Side(cols, keys, vals, new object?[] { 1, big }),
            Side(cols, keys, vals, new object?[] { 1, bigMinus }),
            1);
        True("precision: integers past 2^53 are distinguished (browser cannot)",
            r13.Summary.Mismatched == 1 && r13.Rows[0].Cells[0].Delta == -1m);

        // Ten small postings against a large balance — the shape of every real
        // ledger, and the case a browser silently reconciles.
        //
        // This asserts a MISMATCH on purpose. An earlier version asserted a
        // match and had no teeth at all: mutation testing showed it still
        // passed with sums routed through double, because .NET rounds
        // decimal->double at 15 significant digits and BOTH sides collapsed to
        // the same wrong number. Precision loss is symmetric, so only a
        // difference a lossy engine would MISS can prove precision is kept.
        var ledger = new List<object?[]> { new object?[] { 1, 10_000_000_000_000_000m } };
        for (var i = 0; i < 10; i++) ledger.Add(new object?[] { 1, 1m });
        var r14 = Reconcile.Compare(
            Side(cols, keys, vals, ledger.ToArray()),            // 10^16 + 10
            Side(cols, keys, vals, new object?[] { 1, 10_000_000_000_000_000m }), // 10^16
            1); // EXACT tolerance — no fudge factor
        True("precision: small postings against a large balance are not lost",
            r14.Summary.Mismatched == 1 && r14.Rows[0].Cells[0].Delta == -10m);

        // ── streaming shape ─────────────────────────────────────────────────
        // Memory is O(distinct keys), not O(rows): 50,000 rows over 12 months
        // must leave 12 buckets behind, which is what lets this run against a
        // fact table instead of a sample of one.
        var wide = new Reconcile.SideAccumulator(cols, keys, vals, Def);
        for (var i = 0; i < 50_000; i++) wide.Add(new object?[] { i % 12, 1m });
        True("streaming: 50,000 rows collapse to 12 buckets", wide.KeyCount == 12);
        True("streaming: rows read is tracked for the report", wide.RowsRead == 50_000);

        // The grain guard: memory is O(keys), so a key that identifies rows
        // rather than groups is the way to exhaust this engine. It must refuse,
        // not thrash and not silently drop keys.
        var fine = new Reconcile.SideAccumulator(cols, keys, vals, Def, maxKeys: 100);
        for (var i = 0; i < 500; i++) fine.Add(new object?[] { i, 1m });
        True("grain: an exploded grain is flagged", fine.GrainExploded);
        True("grain: buckets stop at the cap", fine.KeyCount == 100);
        var r15 = Reconcile.Compare(fine, Side(cols, keys, vals, new object?[] { 1, 1m }), 1);
        True("grain: an exploded grain REFUSES rather than compares",
            r15.Refusal?.Kind == "grainTooFine" && r15.Rows.Count == 0);

        // DAX returns "[Totalsales]" for what the user paired as "Totalsales".
        var bracketed = new Reconcile.SideAccumulator(
            new[] { "[Mo]", "[Amt]" }, keys, vals, Def);
        True("columns: bracket decoration is resolved", bracketed.MissingColumns.Count == 0);

        return (_passed, _failed);
    }
}
