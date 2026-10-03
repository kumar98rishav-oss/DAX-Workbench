using System.Text;
using System.Text.RegularExpressions;

namespace PbiDesktopBridge;

/// <summary>
/// Rejects anything that is not a single read-only statement.
///
/// This is the main thing standing between the tool and someone's production
/// database: the user types SQL by hand, so a destructive statement is one bad
/// paste away. The guard runs BEFORE a connection is opened, and it is the
/// reason `/sql/query` can exist at all.
///
/// Deliberately dependency-free so it can be compiled on its own and tested
/// without a database or a driver — see tools/bridge-guard-tests.
/// </summary>
public static class ReadOnlySql
{
    /// <summary>Statements that write, execute, or change the server. INTO is
    /// here because SELECT … INTO creates a table — a write wearing a SELECT.</summary>
    private static readonly string[] Banned =
    {
        "INSERT", "UPDATE", "DELETE", "MERGE", "DROP", "ALTER", "CREATE", "TRUNCATE",
        "EXEC", "EXECUTE", "GRANT", "REVOKE", "DENY", "BACKUP", "RESTORE", "SHUTDOWN",
        "RECONFIGURE", "WAITFOR", "INTO", "OPENROWSET", "OPENDATASOURCE", "OPENQUERY",
    };

    /// <summary>
    /// Replace comments, string literals and quoted identifiers with inert
    /// placeholders.
    ///
    /// Both halves matter. Without comment stripping, `/*x*/DROP TABLE t` hides
    /// from a naive prefix check. Without literal stripping, the harmless
    /// `SELECT 'DROP'` is refused — and a guard that cries wolf gets switched
    /// off, which is its own kind of security failure. One pass handles both,
    /// because a `--` inside a literal is not a comment and a quote inside a
    /// comment does not open a literal.
    /// </summary>
    internal static string Scrub(string sql)
    {
        var sb = new StringBuilder(sql.Length);
        int i = 0, n = sql.Length;
        while (i < n)
        {
            var c = sql[i];

            if (c == '\'') // string literal; '' is an escaped quote
            {
                i++;
                while (i < n)
                {
                    if (sql[i] == '\'' && i + 1 < n && sql[i + 1] == '\'') { i += 2; continue; }
                    if (sql[i] == '\'') { i++; break; }
                    i++;
                }
                sb.Append(" ~str~ ");
                continue;
            }

            if (c == '[') // bracketed identifier; ]] is an escaped bracket
            {
                i++;
                while (i < n)
                {
                    if (sql[i] == ']' && i + 1 < n && sql[i + 1] == ']') { i += 2; continue; }
                    if (sql[i] == ']') { i++; break; }
                    i++;
                }
                sb.Append(" ~id~ ");
                continue;
            }

            if (c == '"') // quoted identifier under QUOTED_IDENTIFIER ON
            {
                i++;
                while (i < n)
                {
                    if (sql[i] == '"' && i + 1 < n && sql[i + 1] == '"') { i += 2; continue; }
                    if (sql[i] == '"') { i++; break; }
                    i++;
                }
                sb.Append(" ~id~ ");
                continue;
            }

            if (c == '-' && i + 1 < n && sql[i + 1] == '-')
            {
                while (i < n && sql[i] != '\n') i++;
                sb.Append(' ');
                continue;
            }

            if (c == '/' && i + 1 < n && sql[i + 1] == '*') // T-SQL block comments nest
            {
                var depth = 1;
                i += 2;
                while (i < n && depth > 0)
                {
                    if (sql[i] == '/' && i + 1 < n && sql[i + 1] == '*') { depth++; i += 2; continue; }
                    if (sql[i] == '*' && i + 1 < n && sql[i + 1] == '/') { depth--; i += 2; continue; }
                    i++;
                }
                sb.Append(' ');
                continue;
            }

            sb.Append(c);
            i++;
        }
        return sb.ToString();
    }

    /// <summary>Throws with a readable reason when the statement is not a single
    /// read. Returns normally when it is safe to run.</summary>
    public static void Validate(string sql)
    {
        if (string.IsNullOrWhiteSpace(sql))
            throw new InvalidOperationException("No SQL to run.");

        var scrubbed = Scrub(sql);

        // One statement only. A trailing semicolon is fine; anything after it
        // is a second statement, which is how a read becomes a write.
        var statements = scrubbed.Split(';').Count(s => !string.IsNullOrWhiteSpace(s));
        if (statements > 1)
            throw new InvalidOperationException(
                "Only one statement can be run at a time. Remove the extra statement after the semicolon.");

        if (Regex.IsMatch(scrubbed, @"(^|\s)GO(\s|$)", RegexOptions.IgnoreCase))
            throw new InvalidOperationException("Batch separators (GO) are not allowed — run one statement.");

        if (!Regex.IsMatch(scrubbed.TrimStart(), @"^(SELECT|WITH)\b", RegexOptions.IgnoreCase))
            throw new InvalidOperationException(
                "Only SELECT (or a WITH … SELECT) can be run here. DAX Workbench never writes to your source database.");

        foreach (var word in Banned)
        {
            if (Regex.IsMatch(scrubbed, $@"(^|[^\w]){word}([^\w]|$)", RegexOptions.IgnoreCase))
                throw new InvalidOperationException(
                    word == "INTO"
                        ? "SELECT … INTO creates a table, so it is not allowed. Remove the INTO clause."
                        : $"'{word}' is not allowed — this connection is read-only.");
        }

        // Stored procedures can do anything; the name alone is enough to refuse.
        if (Regex.IsMatch(scrubbed, @"(^|[^\w])(sp_|xp_)\w+", RegexOptions.IgnoreCase))
            throw new InvalidOperationException("Stored procedures are not allowed — this connection is read-only.");
    }
}
