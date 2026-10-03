using PbiDesktopBridge;

// Tests for the bridge's read-only SQL guard — the boundary between a
// reconciliation tool and someone's production database.
//
// Two halves, and BOTH are security properties:
//   Refused — a write must never reach the server.
//   Allowed — a guard that rejects ordinary SELECTs gets switched off, and a
//             switched-off guard protects nothing. False positives are a
//             security failure with a longer fuse.
//
// Run: dotnet run --project tools/bridge-guard-tests

var passed = 0;
var failed = new List<string>();

void Refused(string name, string sql)
{
    try
    {
        ReadOnlySql.Validate(sql);
        failed.Add($"ALLOWED but must be refused — {name}\n      {sql.Replace("\n", "\\n")}");
    }
    catch (InvalidOperationException) { passed++; }
}

void Allowed(string name, string sql)
{
    try
    {
        ReadOnlySql.Validate(sql);
        passed++;
    }
    catch (InvalidOperationException e)
    {
        failed.Add($"REFUSED but must be allowed — {name}\n      {sql.Replace("\n", "\\n")}\n      → {e.Message}");
    }
}

// ── Ordinary reads must work ────────────────────────────────────────────────
Allowed("bare select", "SELECT 1");
Allowed("count with schema-qualified object", "SELECT COUNT(*) AS [RowCount] FROM [dbo].[Fact_Sales];");
Allowed("CTE", "WITH c AS (SELECT 1 AS x) SELECT * FROM c");
Allowed("lowercase", "select count(*) from dbo.orders");
Allowed("leading line comment", "-- row count\nSELECT COUNT(*) FROM t");
Allowed("leading block comment", "/* reconciliation */ SELECT COUNT(*) FROM t");
Allowed("group by with having", "SELECT a, COUNT(*) FROM t GROUP BY a HAVING COUNT(*) > 1");
Allowed("join and order by", "SELECT a.x FROM a INNER JOIN b ON a.id = b.id ORDER BY a.x DESC");
Allowed("trailing semicolon", "SELECT 1;");
Allowed("repeated semicolons", "SELECT 1;;");

// A guard that fires on these would be unusable: the words appear constantly in
// real schemas and real data.
Allowed("banned word inside a string literal", "SELECT 'DROP TABLE x' AS note FROM t");
Allowed("banned word inside a bracketed identifier", "SELECT [Delete Flag] FROM [dbo].[Create Log]");
Allowed("banned word inside a quoted identifier", "SELECT \"update\" FROM t");
Allowed("escaped quote inside a literal", "SELECT * FROM t WHERE name = 'it''s fine'");
Allowed("escaped bracket inside an identifier", "SELECT [a]]b] FROM [My]] Table]");
Allowed("column whose name merely starts with a banned word", "SELECT DeletedFlag, IntoDate, Creator FROM t");
Allowed("semicolon inside a literal is not a separator", "SELECT 'a;b' AS s FROM t");

// ── Writes must never get through ───────────────────────────────────────────
Refused("empty", "");
Refused("whitespace only", "   \n  ");
Refused("drop", "DROP TABLE Fact_Sales");
Refused("insert", "INSERT INTO t VALUES (1)");
Refused("update", "UPDATE t SET x = 1");
Refused("delete", "DELETE FROM t");
Refused("truncate", "TRUNCATE TABLE t");
Refused("alter", "ALTER TABLE t ADD c INT");
Refused("grant", "GRANT SELECT ON t TO public");
Refused("backup", "BACKUP DATABASE d TO DISK = 'x'");
Refused("shutdown", "SHUTDOWN");

// ── The ways a write disguises itself as a read ─────────────────────────────
Refused("second statement after a semicolon", "SELECT 1; DROP TABLE t");
Refused("second statement, different case", "select 1; delete from t");
Refused("comment-obfuscated prefix", "/* harmless */DROP TABLE t");
Refused("write hidden behind a leading line comment", "-- SELECT 1\nDROP TABLE t");
Refused("a comment cannot hide the separator", "SELECT 1 /*;*/ ; DROP TABLE t");
Refused("nested block comment does not swallow the statement", "/* a /* b */ */ DROP TABLE t");
// T-SQL does not require semicolons, so statement separation alone is not a
// defence — this is why the banned-word scan covers the WHOLE statement rather
// than only its first word.
Refused("second statement with no semicolon at all", "SELECT 1 DROP TABLE t");
Refused("SELECT … INTO is a write wearing a SELECT", "SELECT * INTO backup_t FROM t");
Refused("CTE that ends in an insert", "WITH c AS (SELECT 1 AS x) INSERT INTO t SELECT x FROM c");
Refused("batch separator", "SELECT 1\nGO\nDROP TABLE t");
Refused("exec", "EXEC sp_who");
Refused("exec with a quoted payload", "EXEC('drop table t')");
Refused("system stored procedure", "SELECT 1 FROM t WHERE 1 = 1 EXEC xp_cmdshell 'dir'");
Refused("openrowset reaches another server", "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')");
Refused("waitfor can hang the connection", "WAITFOR DELAY '00:00:10'");

// ── Scrub behaviour, directly ───────────────────────────────────────────────
void Equal(string name, string actual, string expectedContains)
{
    if (actual.Contains(expectedContains, StringComparison.Ordinal)) passed++;
    else failed.Add($"SCRUB — {name}\n      got: {actual}");
}
Equal("literals become inert", ReadOnlySql.Scrub("SELECT 'DROP'"), "~str~");
Equal("identifiers become inert", ReadOnlySql.Scrub("SELECT [DROP]"), "~id~");
Equal("line comments vanish", ReadOnlySql.Scrub("SELECT 1 -- DROP TABLE t"), "SELECT 1 ");
Equal("block comments vanish", ReadOnlySql.Scrub("SELECT /* DROP */ 1"), "SELECT   1");

// ── Report ──────────────────────────────────────────────────────────────────
Console.WriteLine();
foreach (var f in failed) Console.WriteLine($"  FAIL  {f}");
var total = passed + failed.Count;
Console.WriteLine(failed.Count == 0
    ? $"  read-only guard: {passed}/{total} passed"
    : $"\n  read-only guard: {passed}/{total} passed, {failed.Count} FAILED");
Console.WriteLine();
return failed.Count == 0 ? 0 : 1;
