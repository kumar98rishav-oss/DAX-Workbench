using System.Globalization;
using System.Text.RegularExpressions;

namespace PbiDesktopBridge;

/// <summary>
/// The comparison layer, moved out of the browser.
///
/// WHY THIS EXISTS IN C#
/// --------------------
/// The TypeScript core (src/application/reconcile/) is correct and stays the
/// specification, but it runs in a browser, and a browser cannot reconcile real
/// data for two reasons that no amount of tuning fixes:
///
///   1. Every row had to be serialised to JSON and shipped to the client before
///      anything could be compared. That forced a row cap — 200k on the SQL
///      side, 100k in the UI — which is a rounding error against a real fact
///      table, and which turns the honest "truncated" refusal into the normal
///      outcome rather than the exception.
///
///   2. JavaScript numbers are IEEE doubles. Integers above 2^53 lose precision
///      silently, and decimal sums drift. A reconciliation tool that cannot add
///      up money exactly is not a reconciliation tool.
///
/// Here, rows stream from the reader straight into the accumulator and are
/// never materialised. Memory is O(distinct keys) — the GRAIN — not O(rows), so
/// a hundred-million-row table grouped to month x product costs a few thousand
/// buckets. Sums accumulate in `decimal`: 28-29 significant digits, exact
/// decimal arithmetic, which is what currency needs.
///
/// DELIBERATE DIVERGENCE FROM THE TS CORE
/// --------------------------------------
/// `decimal` is strictly more precise than JS `number`. Where the two would
/// disagree, this one is right — a sum of 9,007,199,254,740,993 is itself here
/// and 9,007,199,254,740,992 in the browser. Parity tests assert equal verdicts
/// on values both can represent, and assert the DIVERGENCE on values only this
/// side can. That is the point of the move, so it is tested as a feature.
///
/// Everything else — the type tags, the leading-zero rule, length-prefixed
/// keys, the three refusals, text-vs-numeric cell handling — is ported to match
/// the TS semantics exactly, because those were learned from real bugs and
/// re-deriving them would be re-earning them.
///
/// This file is PURE: no SqlClient, no ADOMD, no HTTP. The same discipline the
/// TS core keeps, and for the same reason — the accuracy claim is testable with
/// no database attached.
/// </summary>
public static class Reconcile
{
    // ── Options ─────────────────────────────────────────────────────────────

    public sealed record NormalizeOptions(bool CaseInsensitive, bool Trim, string DateGranularity)
    {
        /// Case folding defaults ON because SQL Server's default collation is
        /// case-insensitive; trimming defaults ON because CHAR(n) padding would
        /// otherwise break every join on a fixed-width column.
        public static readonly NormalizeOptions Default = new(true, true, "date");
    }

    /// Relative is measured against the SOURCE — the system of record is the
    /// denominator.
    public sealed record Tolerance(decimal Absolute, decimal Relative)
    {
        public static readonly Tolerance Exact = new(0m, 0m);
    }

    // ── Results ─────────────────────────────────────────────────────────────

    public sealed record Cell(object? SourceValue, object? TargetValue, decimal? Delta, string Status);

    public sealed record Row(
        List<string> Key,
        string CompositeKey,
        string Status,
        int SourceRowCount,
        int TargetRowCount,
        List<Cell> Cells);

    public sealed record Summary(
        int Matched,
        int Mismatched,
        int OnlySource,
        int OnlyTarget,
        int SourceKeys,
        int TargetKeys,
        int SourceDuplicateKeys,
        int TargetDuplicateKeys,
        long DriftMs,
        long SourceRowsRead,
        long TargetRowsRead);

    public sealed record Refusal(
        string Kind,
        string Message,
        string? Side = null,
        int? SourceKeys = null,
        int? TargetKeys = null,
        List<string>? SampleSource = null,
        List<string>? SampleTarget = null);

    /// <param name="RowsCapped">
    /// True when more comparison rows exist than were returned. The SUMMARY
    /// COUNTS ARE ALWAYS COMPLETE — they are computed over every key. Only the
    /// returned list is trimmed, for display. This is emphatically not the same
    /// thing as a truncated read, which invalidates the comparison; conflating
    /// the two in the UI would resurrect exactly the confusion the row cap
    /// caused in the first place.
    /// </param>
    public sealed record Result(
        List<Row> Rows,
        Summary Summary,
        Refusal? Refusal,
        bool RowsCapped,
        int TotalRows);

    // ── Normalization (the trap layer) ──────────────────────────────────────

    private static readonly Regex IsoDate = new(@"^(\d{4})-(\d{2})-(\d{2})$", RegexOptions.Compiled);

    private static readonly Regex IsoDateTime = new(
        @"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$",
        RegexOptions.Compiled);

    private static readonly Regex PlainNumber = new(@"^-?\d+(\.\d+)?$", RegexOptions.Compiled);
    private static readonly Regex LeadingZero = new(@"^-?0\d", RegexOptions.Compiled);

    /// <summary>
    /// Canonical numeric text, matching JS `String(Number(x))`.
    ///
    /// C# would render 1.0m as "1.0" and 1.50m as "1.50"; JavaScript renders
    /// both as "1" and "1.5". Keys must agree across the two engines AND across
    /// the two implementations, so trailing zeros are trimmed here rather than
    /// left to the default formatter.
    /// </summary>
    internal static string NumText(decimal d)
    {
        if (d == 0m) return "0";               // also collapses -0
        var s = d.ToString("0.#############################", CultureInfo.InvariantCulture);
        return s == "-0" ? "0" : s;
    }

    /// <summary>
    /// Canonical numeric form of text, or null when it must stay a string.
    ///
    /// A LEADING ZERO means identifier, not number: product code "007" must not
    /// collapse onto 7, or two different products reconcile as one.
    /// </summary>
    internal static string? CanonicalNumber(string text)
    {
        if (!PlainNumber.IsMatch(text)) return null;
        if (LeadingZero.IsMatch(text)) return null;
        return decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var d)
            ? NumText(d)
            : null;
    }

    private static string Two(int n) => n.ToString("00", CultureInfo.InvariantCulture);

    /// <summary>
    /// Date parts read in UTC, never local.
    ///
    /// A value that reached us with a Z and is then read with local getters
    /// shifts to the previous day in any negative-offset timezone — a whole-day
    /// reconciliation error caused purely by where the user is sitting.
    /// </summary>
    private static string CanonicalDate(DateTime d, string granularity)
    {
        var utc = d.Kind == DateTimeKind.Local ? d.ToUniversalTime() : d;
        var day = $"{utc.Year:0000}-{Two(utc.Month)}-{Two(utc.Day)}";
        return granularity == "date"
            ? day
            : $"{day}T{Two(utc.Hour)}:{Two(utc.Minute)}:{Two(utc.Second)}";
    }

    /// <summary>
    /// One key value to a tagged canonical string.
    ///
    /// Tags: `n` null · `d` number · `t` date · `s` string. The tag is what
    /// stops a null being confused with the literal string "null", and a
    /// numeric 1 with the string "1".
    /// </summary>
    public static string NormalizeKeyValue(object? value, NormalizeOptions opts)
    {
        if (value is null or DBNull) return "n:";

        // bit vs boolean: SQL hands back 1/0, the model true/false.
        if (value is bool b) return b ? "d:1" : "d:0";

        if (value is DateTime dt) return $"t:{CanonicalDate(dt, opts.DateGranularity)}";
        if (value is DateTimeOffset dto) return $"t:{CanonicalDate(dto.UtcDateTime, opts.DateGranularity)}";

        switch (value)
        {
            case decimal m: return $"d:{NumText(m)}";
            case byte or sbyte or short or ushort or int or uint or long or ulong:
                return $"d:{NumText(Convert.ToDecimal(value, CultureInfo.InvariantCulture))}";
            case double dbl:
                if (double.IsNaN(dbl) || double.IsInfinity(dbl)) return "n:";
                return $"d:{NumText(ToDecimalOrZero(dbl))}";
            case float fl:
                if (float.IsNaN(fl) || float.IsInfinity(fl)) return "n:";
                return $"d:{NumText(ToDecimalOrZero(fl))}";
        }

        var text = value as string ?? Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
        if (opts.Trim) text = text.Trim();

        // Date-shaped text from either engine's serialisation. Parts are read
        // straight out of the string when it carries no timezone — parsing a
        // naive datetime would reinterpret it as local and can move a row to
        // the adjacent day.
        if (IsoDate.IsMatch(text))
            return $"t:{(opts.DateGranularity == "date" ? text : text + "T00:00:00")}";

        var m2 = IsoDateTime.Match(text);
        if (m2.Success)
        {
            var tz = m2.Groups[8].Value;
            if (string.IsNullOrEmpty(tz))
            {
                var ymd = $"{m2.Groups[1].Value}-{m2.Groups[2].Value}-{m2.Groups[3].Value}";
                return opts.DateGranularity == "date"
                    ? $"t:{ymd}"
                    : $"t:{ymd}T{m2.Groups[4].Value}:{m2.Groups[5].Value}:{m2.Groups[6].Value}";
            }
            if (DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed))
                return $"t:{CanonicalDate(parsed.UtcDateTime, opts.DateGranularity)}";
        }

        var num = CanonicalNumber(text);
        if (num != null) return $"d:{num}";

        if (opts.CaseInsensitive) text = text.ToLowerInvariant();
        return $"s:{text}";
    }

    private static decimal ToDecimalOrZero(double d)
    {
        try { return (decimal)d; }
        catch (OverflowException) { return d > 0 ? decimal.MaxValue : decimal.MinValue; }
    }

    /// <summary>
    /// Join normalized parts into one collision-proof key.
    ///
    /// Length-prefixing is what makes this safe. A plain delimiter cannot be:
    /// OrderID=1 + Line=23 and OrderID=12 + Line=3 both concatenate to "123" —
    /// two different rows reconciling as one. With lengths the boundary is
    /// unambiguous and no escaping is needed.
    /// </summary>
    public static string CompositeKey(IReadOnlyList<string> parts)
    {
        var sb = new System.Text.StringBuilder();
        for (var i = 0; i < parts.Count; i++)
        {
            if (i > 0) sb.Append('|');
            sb.Append(parts[i].Length).Append(':').Append(parts[i]);
        }
        return sb.ToString();
    }

    /// Strip the type tag for display.
    public static string DisplayKeyPart(string normalized)
    {
        var i = normalized.IndexOf(':');
        if (i < 0) return normalized;
        return normalized[..i] == "n" ? "(blank)" : normalized[(i + 1)..];
    }

    /// <summary>
    /// A value being compared, as a decimal.
    ///
    /// Null for anything non-numeric: a value column that is not a number is a
    /// configuration mistake, and silently coercing it to 0 would manufacture a
    /// clean reconciliation out of nonsense.
    /// </summary>
    internal static decimal? ToComparableNumber(object? value)
    {
        switch (value)
        {
            case null or DBNull: return null;
            case bool b: return b ? 1m : 0m;
            case decimal m: return m;
            case byte or sbyte or short or ushort or int or uint or long or ulong:
                return Convert.ToDecimal(value, CultureInfo.InvariantCulture);
            case double d:
                if (double.IsNaN(d) || double.IsInfinity(d)) return null;
                try { return (decimal)d; } catch (OverflowException) { return null; }
            case float f:
                if (float.IsNaN(f) || float.IsInfinity(f)) return null;
                try { return (decimal)f; } catch (OverflowException) { return null; }
        }

        var text = (value as string ?? Convert.ToString(value, CultureInfo.InvariantCulture) ?? "").Trim();
        if (text.Length == 0) return null;
        return decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;
    }

    // ── Accumulation ────────────────────────────────────────────────────────

    /// <summary>
    /// What one value column accumulated inside one key bucket.
    ///
    /// Numbers are summed to the grain. Non-numeric values — dates, codes,
    /// names — cannot be summed, so the first is kept and `Multi` records that
    /// the bucket held more than one distinct value, which is itself a finding.
    /// </summary>
    internal sealed class ValueAgg
    {
        public decimal? Sum;
        public string? Text;
        public bool Multi;
        public bool NonNumeric;
    }

    internal sealed class Bucket
    {
        public int RowCount;
        public ValueAgg[] Vals = Array.Empty<ValueAgg>();
    }

    /// <summary>
    /// One side of the comparison, fed a row at a time.
    ///
    /// This is the whole scalability story: the caller streams straight from a
    /// DataReader into Add() and the rows are discarded immediately. Nothing
    /// accumulates except the buckets, which are O(distinct keys).
    /// </summary>
    public sealed class SideAccumulator
    {
        private readonly int[] _keyIdx;
        private readonly int[] _valIdx;
        private readonly NormalizeOptions _opts;
        private readonly int _valCount;

        internal readonly Dictionary<string, Bucket> Buckets = new(StringComparer.Ordinal);
        internal readonly Dictionary<string, List<string>> Display = new(StringComparer.Ordinal);

        public List<string> MissingColumns { get; } = new();
        public bool Truncated { get; set; }
        public long RowsRead { get; private set; }
        public int KeyCount => Buckets.Count;

        /// <summary>
        /// The grain produced more distinct keys than we will hold.
        ///
        /// Row count stopped being the limit once rows streamed — memory is now
        /// O(distinct keys). So the way to exhaust this engine is no longer a
        /// big table, it is a grain that is not a grain: pairing an invoice
        /// line id and asking for twenty million buckets. That is a pairing
        /// mistake with the same shape as zero key overlap, and it gets the
        /// same treatment — refuse and say why, rather than swap to death or
        /// silently drop keys and report confident nonsense.
        /// </summary>
        public bool GrainExploded { get; private set; }

        private readonly int _maxKeys;

        public SideAccumulator(
            IReadOnlyList<string> columns,
            IReadOnlyList<string> keyColumns,
            IReadOnlyList<string> valueColumns,
            NormalizeOptions opts,
            int maxKeys = 2_000_000)
        {
            _opts = opts;
            _maxKeys = maxKeys;
            _valCount = valueColumns.Count;

            int Find(string name)
            {
                for (var i = 0; i < columns.Count; i++)
                    if (string.Equals(columns[i], name, StringComparison.Ordinal)) return i;
                // Engines disagree on bracket decoration, e.g. DAX returns
                // "[Totalsales]" for what the user paired as "Totalsales".
                for (var i = 0; i < columns.Count; i++)
                    if (string.Equals(columns[i].Trim('[', ']'), name.Trim('[', ']'), StringComparison.Ordinal))
                        return i;
                MissingColumns.Add(name);
                return -1;
            }

            _keyIdx = keyColumns.Select(Find).ToArray();
            _valIdx = valueColumns.Select(Find).ToArray();
        }

        public void Add(object?[] row)
        {
            RowsRead++;
            if (MissingColumns.Count > 0) return;

            var parts = new string[_keyIdx.Length];
            for (var i = 0; i < _keyIdx.Length; i++)
                parts[i] = NormalizeKeyValue(row[_keyIdx[i]], _opts);
            var key = CompositeKey(parts);

            if (!Buckets.TryGetValue(key, out var bucket))
            {
                if (Buckets.Count >= _maxKeys) { GrainExploded = true; return; }
                bucket = new Bucket { Vals = new ValueAgg[_valCount] };
                for (var v = 0; v < _valCount; v++) bucket.Vals[v] = new ValueAgg();
                Buckets[key] = bucket;
                Display[key] = parts.Select(DisplayKeyPart).ToList();
            }
            bucket.RowCount++;

            for (var v = 0; v < _valIdx.Length; v++)
            {
                var raw = row[_valIdx[v]];
                var agg = bucket.Vals[v];
                var n = ToComparableNumber(raw);
                if (n.HasValue)
                {
                    agg.Sum = (agg.Sum ?? 0m) + n.Value;
                    continue;
                }
                // Genuinely blank — contributes nothing either way.
                if (raw is null or DBNull) continue;
                if (raw is string s && s.Length == 0) continue;
                // Present but not a number: keep it as text so it can still be
                // compared. Dropping to the numeric path here was a real false
                // green — both sides parse to null, null equals null, and
                // '2023-01-01' vs '2024-12-31' reported as a match.
                var text = NormalizeKeyValue(raw, _opts);
                if (agg.Text is null) agg.Text = text;
                else if (agg.Text != text) agg.Multi = true;
                agg.NonNumeric = true;
            }
        }
    }

    // ── Comparison ──────────────────────────────────────────────────────────

    private static bool WithinTolerance(decimal source, decimal target, Tolerance tol)
    {
        var delta = Math.Abs(target - source);
        if (delta == 0m) return true;
        if (delta <= tol.Absolute) return true;
        if (tol.Relative > 0m && source != 0m && delta / Math.Abs(source) <= tol.Relative) return true;
        return false;
    }

    private static Cell CellFor(ValueAgg? s, ValueAgg? t, Tolerance tol)
    {
        // ── Text comparison ─────────────────────────────────────────────────
        if ((s?.NonNumeric ?? false) || (t?.NonNumeric ?? false))
        {
            static object? Show(ValueAgg? a) =>
                a is null ? null
                : a.Multi ? "(multiple values)"
                : a.Text is not null ? DisplayKeyPart(a.Text)
                : a.Sum;

            // A bucket holding several different text values has no single
            // answer, so it can never be declared equal.
            var comparable = !(s?.Multi ?? false) && !(t?.Multi ?? false);
            return new Cell(
                Show(s), Show(t), null,
                comparable && (s?.Text) == (t?.Text) ? "match" : "mismatch");
        }

        // ── Numeric comparison ──────────────────────────────────────────────
        var sv = s?.Sum;
        var tv = t?.Sum;
        if (sv is null && tv is null) return new Cell(null, null, null, "match");

        // A blank on one side is a real difference, so it is compared as 0
        // rather than skipped — but both raw values are kept so the UI can show
        // "(blank)" instead of pretending the engine returned a zero.
        var a2 = sv ?? 0m;
        var b2 = tv ?? 0m;
        return new Cell(sv, tv, b2 - a2, WithinTolerance(a2, b2, tol) ? "match" : "mismatch");
    }

    private static int Worst(string status) => status switch
    {
        "match" => 0,
        "mismatch" => 2,
        _ => 3, // onlySource / onlyTarget
    };

    /// <summary>
    /// Full outer join of the two accumulators.
    /// </summary>
    /// <param name="maxRows">
    /// How many comparison rows to RETURN. Summary counts are computed over
    /// every key regardless; this only trims the payload.
    /// </param>
    public static Result Compare(
        SideAccumulator source,
        SideAccumulator target,
        int valueCount,
        Tolerance? tolerance = null,
        long driftMs = 0,
        int minKeyOverlap = 1,
        int maxRows = 5000)
    {
        var tol = tolerance ?? Tolerance.Exact;

        Result Empty(Refusal r) => new(
            new List<Row>(),
            new Summary(0, 0, 0, 0, 0, 0, 0, 0, driftMs, source.RowsRead, target.RowsRead),
            r, false, 0);

        // ── Refuse on truncation ────────────────────────────────────────────
        // A truncated side manufactures thousands of false "only in …" rows,
        // and the result looks authoritative while being completely wrong.
        if (source.Truncated || target.Truncated)
        {
            var side = source.Truncated && target.Truncated ? "both" : source.Truncated ? "source" : "target";
            return Empty(new Refusal(
                "truncated",
                side == "both"
                    ? "Both queries hit the row cap. Narrow the grain or add a filter — a truncated comparison would report differences that do not exist."
                    : $"The {side} query hit the row cap, so rows are missing from one side only. Narrow the grain or add a filter — comparing now would report differences that do not exist.",
                Side: side));
        }

        // ── Refuse on an exploded grain ─────────────────────────────────────
        if (source.GrainExploded || target.GrainExploded)
        {
            var side = source.GrainExploded && target.GrainExploded ? "both"
                : source.GrainExploded ? "source" : "target";
            return Empty(new Refusal(
                "grainTooFine",
                $"The {side} query produced more distinct key combinations than this comparison will hold. " +
                "That usually means the paired key columns identify individual rows rather than a grain — " +
                "pair fewer columns, or aggregate the query, so each key stands for a group worth comparing.",
                Side: side));
        }

        if (source.MissingColumns.Count > 0 || target.MissingColumns.Count > 0)
        {
            var missing = string.Join(", ", source.MissingColumns.Concat(target.MissingColumns));
            throw new InvalidOperationException($"Column not present in its result set: {missing}");
        }

        if (source.Buckets.Count == 0 && target.Buckets.Count == 0)
            return Empty(new Refusal("emptyBothSides", "Both queries returned no rows — there is nothing to compare."));

        // ── Refuse on zero key overlap ──────────────────────────────────────
        // Both sides have data but nothing joins: almost always a wrong
        // pairing, not a 100% mismatch. Saying so beats a wall of red.
        var overlap = 0;
        foreach (var key in source.Buckets.Keys)
            if (target.Buckets.ContainsKey(key)) overlap++;

        if (source.Buckets.Count > 0 && target.Buckets.Count > 0 && overlap < minKeyOverlap)
        {
            static List<string> Sample(Dictionary<string, List<string>> d) =>
                d.Values.Take(3).Select(p => string.Join(" · ", p)).ToList();

            return Empty(new Refusal(
                "noKeyOverlap",
                $"0 of {source.Buckets.Count:N0} source keys matched any of {target.Buckets.Count:N0} target keys. " +
                "That is almost always a key-pairing mistake rather than a total mismatch — check that the paired columns hold the same thing.",
                SourceKeys: source.Buckets.Count,
                TargetKeys: target.Buckets.Count,
                SampleSource: Sample(source.Display),
                SampleTarget: Sample(target.Display)));
        }

        // ── Full outer join ─────────────────────────────────────────────────
        var rows = new List<Row>();
        int matched = 0, mismatched = 0, onlySource = 0, onlyTarget = 0;
        int srcDupes = 0, tgtDupes = 0;

        void Emit(string key, Bucket? s, Bucket? t, List<string> display)
        {
            if (s is { RowCount: > 1 }) srcDupes++;
            if (t is { RowCount: > 1 }) tgtDupes++;

            var cells = new List<Cell>(valueCount);
            for (var i = 0; i < valueCount; i++)
                cells.Add(CellFor(s?.Vals[i], t?.Vals[i], tol));

            string status;
            if (t is null) status = "onlySource";
            else if (s is null) status = "onlyTarget";
            else status = cells.Any(c => c.Status == "mismatch") ? "mismatch" : "match";

            if (status == "match") matched++;
            else if (status == "mismatch") mismatched++;
            else if (status == "onlySource") onlySource++;
            else onlyTarget++;

            rows.Add(new Row(display, key, status, s?.RowCount ?? 0, t?.RowCount ?? 0, cells));
        }

        foreach (var (key, s) in source.Buckets)
            Emit(key, s, target.Buckets.GetValueOrDefault(key), source.Display.GetValueOrDefault(key) ?? new List<string>());
        foreach (var (key, t) in target.Buckets)
            if (!source.Buckets.ContainsKey(key))
                Emit(key, null, t, target.Display.GetValueOrDefault(key) ?? new List<string>());

        // Worst first, then largest absolute delta: the biggest problem should
        // never be buried below an alphabetical list of agreements. Ordering
        // before the cap is what makes the cap safe — what gets dropped is
        // always the agreements, never the findings.
        static decimal Magnitude(Row r)
        {
            var max = 0m;
            foreach (var c in r.Cells)
            {
                var d = c.Delta.HasValue ? Math.Abs(c.Delta.Value) : 0m;
                if (d > max) max = d;
            }
            return max;
        }

        var ordered = rows
            .OrderByDescending(r => Worst(r.Status))
            .ThenByDescending(Magnitude)
            .ToList();

        var total = ordered.Count;
        var capped = total > maxRows;
        if (capped) ordered = ordered.Take(maxRows).ToList();

        return new Result(
            ordered,
            new Summary(matched, mismatched, onlySource, onlyTarget,
                source.Buckets.Count, target.Buckets.Count, srcDupes, tgtDupes,
                driftMs, source.RowsRead, target.RowsRead),
            null, capped, total);
    }
}
