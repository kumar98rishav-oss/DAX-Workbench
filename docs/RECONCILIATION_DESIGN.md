# Data Reconciliation — Design

Run DAX against the live Power BI model and T-SQL against its source, side by side in DAX
Workbench, and compare the two result sets to find **where** the numbers diverge.

Status: design. Nothing below is built yet.

---

## 1. The model: two engines, one comparison layer

Power BI's DirectQuery *translates* DAX into SQL — the engine guesses the equivalent
statement. That translation is the hard problem in reconciliation: a measure's value
depends on filter context, relationships, RLS and time intelligence, and a tool that
guesses the SQL equivalent will eventually declare a correct measure wrong.

**This design does not translate.** The user writes the DAX and writes the SQL, and asserts
that the two should agree. Each runs on its own engine. The tool's only job is to execute
both faithfully, join the results on a user-defined key, and report the difference —
accurately and with full provenance.

That boundary is what makes the feature trustworthy: we are never wrong about *semantics*,
only ever about *execution and comparison*, both of which are testable.

```
┌─ ◆ MODEL ──────────────┐     ┌─ ▣ SOURCE ─────────────┐
│ EVALUATE               │     │ SELECT                 │
│   SUMMARIZECOLUMNS(…)  │     │   YEAR(OrderDate), …   │
└──────────┬─────────────┘     └──────────┬─────────────┘
           │ POST /dax                    │ POST /sql/query
           ▼                              ▼
     ResultSet(origin='model')      ResultSet(origin='sql')
           └──────────────┬───────────────┘
                          ▼
             Comparison layer (pure TypeScript)
             key pairing · normalize · full outer join · Δ
                          ▼
                  Drillable matrix
```

---

## 2. ResultSet — how ambiguity is made impossible

Two result sets that both contain a column called `Amount` is where a comparison tool
starts lying. The defence is not naming convention or UI discipline — it is **typing**.

```ts
interface ResultSet {
  id: string                      // rs_1, rs_2 …
  origin: 'model' | 'sql'         // never lost, never inferred
  label: string                   // user-editable: "PBI Sales by Month"
  query: string                   // the exact text that produced this
  connection: ModelConn | SqlConn // which model (port/db) or server/db
  executedAt: Date
  durationMs: number
  columns: { name: string; dataType: string }[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean              // see §3.3 — load-bearing
}

/** A field is NEVER referenced by bare column name. */
type FieldRef = { resultSetId: string; column: string }
```

Because every reference carries its result-set id, there is no code path in which a model
column and a SQL column can be mistaken for one another — it is a type error, not a
convention. The UI renders `◆` / `▣` from that same `origin` tag, so what the user sees and
what the comparator computes cannot drift apart.

Result sets are **immutable**. Re-running a query produces a new one; the old one stays
until evicted. This is what allows a comparison to state exactly which two executions it
compared, and when.

---

## 3. Architecture

```
Browser (React)                Bridge (.NET 8, 127.0.0.1:5177)        Engines
─────────────────              ──────────────────────────────         ───────
presentation/reconcile/   ──▶  POST /sql/query      ──▶ SqlClient ──▶ SQL Server
application/reconcile/         POST /sql/test                        (read-only)
  result-set.ts                GET  /sql/schema
  normalize.ts            ──▶  POST /dax (exists)   ──▶ ADOMD    ──▶ Power BI Desktop
  compare.ts                   GET  /sources (new)  ──▶ TOM
  generators/
```

The browser cannot open a SQL connection — but the bridge is a .NET process whose job is
already *"reach what the browser cannot."* It does this for Analysis Services (ADOMD) and
for NVIDIA NIM (`/nim` exists purely to dodge browser CORS). SQL Server is the same shape.

### 3.1 Bridge changes

**New `Sql.cs`**, mirroring `PowerBi.cs` and returning the same envelope as
`PowerBi.Query` so the client reuses one shape:

```csharp
public static (List<string> Columns, List<Dictionary<string, object?>> Rows)
    Query(string connectionString, string sql, int timeoutSec, int rowCap);
```

Add `<PackageReference Include="Microsoft.Data.SqlClient" Version="5.2.*" />`.

| Endpoint | Purpose |
|---|---|
| `POST /sql/test` | Validate a connection; return server version, database, login, collation |
| `GET  /sql/schema` | Tables, views and columns the login can read (mapping + autocomplete) |
| `POST /sql/query` | Run one read-only statement → `{columns, rowCount, rows, truncated}` |
| `GET  /sources` | **New, model side.** Per table: partition source M, storage mode, last refresh time |

`/sources` is required because `/model` today returns only tables, columns, measures and
relationships. Without partition M we cannot suggest which SQL object feeds which model
table, and we cannot show the refresh timestamp that §5.4 depends on.

### 3.2 Read-only enforcement — now the primary safety mechanism

Phase 1 lets the user type arbitrary SQL, so `DROP TABLE` is one bad paste away. The guard
is not a defensive nicety; it is the main thing standing between the tool and someone's
production database.

- Statement must begin with `SELECT` or `WITH` after comment-stripping.
- Reject batch separators and `INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|GRANT`.
- Connect with `ApplicationIntent=ReadOnly`.
- Identifiers from generators are bracket-quoted with `]` → `]]`; literals are parameterized.
- **Refuse `/sql/*` in remote mode by default**, behind an explicit opt-in. Remote mode
  already requires a token (v0.4.1), but the blast radius differs in kind: "reads your open
  PBI model" vs "reads any database this machine can reach."
- **Redact `Password=` from every error and log line.** SQL connection failures echo the
  connection string by default; that must be scrubbed before it reaches the client.

### 3.3 Row caps — the sharpest edge in the whole design

`PowerBi.Query` currently does `if (rows.Count >= 10_000) break;`. For displaying query
results that is sensible. **For comparison it is dangerous.** If the model side truncates at
10,000 and SQL returns 48,000, the comparator reports ~38,000 false *"only in source"* rows:
a confident, authoritative, completely wrong answer.

Therefore:

- Both sides take the same explicit cap (100,000 is comfortable for an in-browser hash join).
- The bridge returns `truncated: true` rather than silently stopping.
- **A comparison REFUSES to run if either side is truncated.** Not a warning — a block.
  A truncated comparison looks authoritative and lies, which is worse than no answer.

---

## 4. What is required on the SQL end

| Requirement | Detail |
|---|---|
| **Reachability** | The bridge's machine must reach the server: TCP 1433, or a named instance plus SQL Browser on UDP 1434. Firewall open. |
| **Authentication** | **Windows Integrated is the default and the recommendation** — the bridge runs as the signed-in user, so no secret is stored anywhere. SQL auth is a fallback; its password lives in bridge memory for the session only. |
| **Permissions** | `CONNECT` on the database plus **`db_datareader`**. That is sufficient. Do not ask for `db_owner`. Schema introspection reads `INFORMATION_SCHEMA`, which only surfaces objects the login can already read. |
| **The right object** | Reconcile against whatever the model actually loads from. If the partition reads a **view**, compare to the view — the view's `WHERE` clause is a legitimate reason for counts to differ. |
| **Determinism** | A source that changes between the two executions produces false mismatches. On a busy OLTP table, expect drift and read §5.4. |
| **Isolation** | Default `READ COMMITTED`. Do **not** use `NOLOCK` — dirty reads make reconciliation untrustworthy, which defeats the feature. Snapshot isolation is fine where RCSI is enabled. |
| **Indexes** | `COUNT(DISTINCT …)` and `GROUP BY` on a large fact table want an index on the grain columns. Command timeout defaults to 30s, configurable. |
| **Collation** | A case-insensitive collation folds `ABC` and `abc` into one value; the model may not. `/sql/test` returns the collation so §5.3 can default correctly. |

---

## 5. The traps

Where reconciliation tools are wrong in practice. Each gets a named regression test.

### 5.1 `DISTINCTCOUNT` counts blanks; `COUNT(DISTINCT)` does not

DAX `DISTINCTCOUNT(T[C])` counts `BLANK()` as a distinct value. SQL `COUNT(DISTINCT c)`
ignores `NULL`. On any nullable column the two differ by **exactly 1**, silently and
systematically.

**Resolution:** generators emit `DISTINCTCOUNTNOBLANK` so both engines agree, and display
the blank count alongside so nothing is hidden.

### 5.2 Composite keys must not be concatenated in-engine

`OrderID=1, Line=23` and `OrderID=12, Line=3` both concatenate to `"123"` — two rows, one
key. Duplicates get invented or missed. The engines also disagree on null concatenation:
SQL `'a' + NULL` is `NULL`; DAX `"a" & BLANK()` is `"a"`.

**Resolution: never concatenate inside SQL or DAX.** Group natively by multiple columns on
both sides (`GROUP BY a, b` / `SUMMARIZE(T, T[a], T[b])`). The composite join key is built
only in `normalize.ts`, in TypeScript, where we control delimiting and escaping on both
sides simultaneously. The trap is removed, not mitigated.

### 5.3 Join keys that look equal but are not

Every key value passes through one normalizer before joining:

- `CHAR(n)` columns are **space-padded** by SQL Server — `'ABC       '` ≠ `'ABC'`. Trim.
- `DATE` vs `DATETIME` — `2024-01-01` vs `2024-01-01T00:00:00`. Canonicalize to ISO; keep
  the time component only when the grain includes it.
- Numeric drift — `1` vs `"1"` vs `1.0`. Canonicalize to a decimal string.
- Case — SQL may be case-insensitive while JavaScript comparison is not. Case folding is a
  per-run option, defaulted from the collation returned by `/sql/test`.

One normalizer, one place, heavily tested.

### 5.4 Import mode compares a snapshot to live data

An Import model's data is frozen at the last refresh. A mismatch may mean *"the refresh is
stale,"* not *"the data is wrong"* — and reporting it as the latter is a bug.

**Resolution:** read `RefreshedTime` via `/sources` and show it permanently in the header
next to the SQL execution time. Both timestamps are always visible, so a drift explanation
is always one glance away.

### 5.5 Zero matched keys means a bad pairing, not total mismatch

If the user pairs the wrong columns, every row lands as `onlyModel` + `onlySource` and the
matrix turns entirely red — a confident wrong answer.

**Resolution:** when matched keys are 0 (or below a small threshold) while both sides have
rows, do not render the comparison. Say
*"0 of 48,210 keys matched — check your key pairing."* Surface sample key values from each
side so the mismatch in shape is obvious.

### 5.6 RLS

Active row-level security filters the DAX side while SQL returns everything. Detect active
roles and warn rather than reporting a false mismatch.

---

## 6. Composing a comparison

The user builds the comparison by dragging fields from either result set. Two slots:

**Keys (the grain).** Column *pairs*, one from each side: `◆ Year ↔ ▣ OrderYear`. Pairing is
always **explicit** — you never drag one field and let the tool guess its twin, because name
matching across a model and a warehouse is exactly where silent mis-joins come from.

**Values.** Also paired: `◆ [Total Sales] ↔ ▣ TotalAmount`. Several value pairs can be
compared in one matrix.

The comparator then runs, in pure TypeScript:

1. Normalize every key value on both sides (§5.3).
2. Build the composite key (§5.2).
3. Full outer join on the normalized key.
4. Per row, per value pair: `Δ = model − source`, classified against tolerance.

| Status | Meaning |
|---|---|
| `match` | Both present and equal within tolerance |
| `mismatch` | Both present, values differ |
| `onlyModel` | Key in the model, absent from the source |
| `onlySource` | Key in the source, absent from the model |

`onlyModel` / `onlySource` are usually the most informative — they localize missing or extra
data, which is what the user is hunting.

**Default sort is `|Δ|` descending.** Alphabetical order buries the answer.

---

## 7. Drill-down

The key slot is ordered, so `[Year, Month, Product]` defines a hierarchy. Both queries return
data at the finest grain in the list; the matrix rolls up in the browser and expands lazily.
That gives instant drill without re-querying per expansion.

This only works while the finest grain is enumerable. Before running, probe the grain
cardinality; if it exceeds the cap, refuse and say so:
*"Product has 240,000 distinct values at this grain — add a filter or drop a level."*

The tempting alternative — fetch the top N — is wrong here. A row present on only one side
may carry a tiny value and still be the entire defect, so any value-based truncation can hide
precisely what the user is looking for. Refusing is honest; truncating looks helpful and lies.

---

## 8. Checks as generators, not features

Row count, distinct, duplicates and nulls are not a separate subsystem. Each is a **button
that writes both queries into the two panes**, then runs them:

```
◆ DAX pane                               ▣ SQL pane
EVALUATE ROW(                            SELECT COUNT(*) AS [RowCount]
  "RowCount",                            FROM [dbo].[Fact_Sales];
  COUNTROWS('Fact_Sales')
)
```

The generated SQL is **visible and editable**. That is better than a black box in three ways:
it is auditable, it teaches the user what the check means, and it degrades gracefully — when
the generator cannot express a case, the user edits the SQL instead of hitting a wall.

| Generator | Model side | Source side |
|---|---|---|
| Row count | `COUNTROWS(T)` | `COUNT(*)` |
| Distinct values | `DISTINCTCOUNTNOBLANK(T[C])` | `COUNT(DISTINCT c)` |
| Nulls / blanks | `COUNTBLANK(T[C])` | `SUM(CASE WHEN c IS NULL THEN 1 ELSE 0 END)` |
| Duplicates on key | `FILTER(SUMMARIZE(T, keys…, "n", COUNTROWS(T)), [n] > 1)` | `GROUP BY keys… HAVING COUNT(*) > 1` |
| Grain compare | `SUMMARIZECOLUMNS(dims…, "v", [M])` | `SELECT dims…, SUM(x) GROUP BY dims…` |

The **business key builder** is not a check — it is a reusable key definition (e.g.
`OrderID + OrderLine`) that the duplicate and grain generators consume, and that the
comparator uses as the join key.

---

## 9. UI — provenance is never ambiguous

The existing badge philosophy (`.dax-badge--live` / `--sample`, *"sample can never
impersonate truth"*) extends directly. Two sides, two fixed design tokens
(`--prov-model`, `--prov-source`), never merged. The tint lives on headers and badges, not
on the digits, so numbers stay readable.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ◆ MODEL  Medical_Legal · Import · refreshed 09:14 (6h ago)      [Run both]  │
│ ▣ SOURCE MEDLEGAL01 · MedLegalBI · dbo.vw_CaseDetails · read 15:22          │
├──────────────────┬───────────┬───────────┬──────────┬──────────────────────┤
│ Year ▸ Month     │  ◆ Model  │ ▣ Source  │     Δ    │ Status               │
├──────────────────┼───────────┼───────────┼──────────┼──────────────────────┤
│ ▾ 2024           │   48,210  │   48,215  │      −5  │ ✗ Mismatch           │
│    ├ January     │    4,011  │    4,011  │       0  │ ✓ Match              │
│    ├ February    │    3,980  │    3,985  │      −5  │ ✗ Mismatch           │
│    └ March       │        —  │      112  │    −112  │ ⚠ Only in source     │
│ ▸ 2023           │  121,044  │  121,044  │       0  │ ✓ Match              │
└──────────────────┴───────────┴───────────┴──────────┴──────────────────────┘
```

The header strip is load-bearing, not decoration: a reconciliation screen that does not show
**what** two things are being compared and **when** each was read is misleading by omission.
`Run both` executes the two queries back to back to minimize drift.

---

## 10. Test strategy

Five of the six layers need no database at all.

**L1 — Generator golden tests (vitest, no DB).** For each generator × config, assert the
exact emitted DAX and SQL. Locks in §5.1 (`DISTINCTCOUNTNOBLANK`) and identifier escaping;
a regression surfaces as a string diff.

**L2 — Comparator tests (vitest, no DB).** Synthetic result sets → assert classification:
equal, unequal, only-model, only-source, null keys, tolerance boundaries, multi-column keys.

**L3 — Normalizer trap tests (vitest, no DB).** One named test per trap in §5: `CHAR`
padding, date vs datetime, `1` vs `"1"`, case folding, composite-key collision.

**L4 — Guard tests (vitest + C#, no DB).** Read-only rejection of every banned statement
shape, batch separators, comment-obfuscated `DROP`; identifier escaping for `My] Table`;
password redaction in error text.

**L5 — Self-reconciliation property test.** Feed the *same* dataset to both mock engines;
every generator at every grain must return zero mismatches. Any mismatch is by definition a
tool bug. One invariant covering the entire pipeline.

**L6 — Integration against real SQL Server** (LocalDB or the `mssql/server` container).
Seed a table with *known* defects — exactly 3 duplicate keys, 2 NULLs, 1 row absent from the
model — and assert the tool reports exactly those, no more and no fewer. This is the test
that proves accuracy rather than asserting it.

Plus a truncation test: cap the model side below the source side and assert the comparison
**refuses** rather than reporting false `onlySource` rows (§3.3).

---

## 11. Phasing

**Phase 1** — SQL connection and read-only guard; the two query panes with typed result
sets; drag-and-drop key/value pairing; the comparison matrix with drill; the five
generators; L1–L6 tests.

**Phase 2** — saved reconciliation definitions (query pair + pairing + tolerance) re-runnable
as a suite, with a pass/fail summary. This is what turns the tool from ad-hoc investigation
into a regression check that can be run after every refresh.

**Phase 3** — as-of reconciliation against a watermark column; scheduled runs; exportable
reconciliation report.

---

## 12. Decisions, and what building it changed

**Settled.** The panel *replaces* the KPI tab rather than becoming a 7th — which also
sidesteps the top-bar overflow. Windows Integrated is the default, so no credential storage
question arises; SQL auth keeps its password in memory for the session only. The row cap is
100,000 per side.

Four things only showed up once it ran against a real database:

**Tolerance does not default to exact.** A SQL `decimal` becomes a JS `number` through JSON,
and summing those reintroduces binary floating-point residue: two sides agreeing to the cent
still differ by ~1e-9. Comparing exactly reported all 24 months of a matching dataset as
mismatches, each with a delta rendering as `0` — precisely the confident-but-wrong answer
this tool exists to avoid. The default absolute tolerance is now **1e-6**, far below any
difference that could matter, and integer counts still differ by at least 1. The delta
formatter collapses at the same threshold, so the number never argues with the verdict
beside it.

**Pairing is click-first, drag-second.** Dragging works, but click-a-source then
click-its-target survives a mis-aimed pointer, works from the keyboard, and is testable.
The requirement that pairing be *explicit* is unchanged.

**Mapping falls back to the table name.** A model built from CSV extracts names no SQL
object in its Power Query at all — and reconciling exactly that case is the point. When the
M yields nothing, match on name and say so: *"Matched by name — this table does not load
from SQL, so check the object is the right one."*

**A scalar comparison has no key.** Row count and grand total are one value per side with
nothing to group by. Zero key pairs is a legitimate setup, not an incomplete one: both sides
collapse to a single bucket and compare directly.
