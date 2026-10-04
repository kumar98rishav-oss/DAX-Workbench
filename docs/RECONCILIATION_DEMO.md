# Reconciliation — demo playbook

A script for showing the Reconcile tab to someone who will not take your word
for anything. Every number below was measured against `SCM_Dashboard` on
`localhost\SQLEXPRESS`; nothing is illustrative.

The demo rule: **do not spend your time showing green.** Anyone can build a tool
that agrees with itself. Show it catching something, then prove independently
that it was right.

---

## Before you start

| | |
|---|---|
| Launch | Power BI Desktop → **External Tools → DAX Workbench** → **Reconcile** |
| Connect | `localhost\SQLEXPRESS` · `SCM_Dashboard` · Windows auth |
| Have open beside it | SSMS on the same database, and DAX Studio on the same model |
| Suite | 47 checks across 10 tables. If empty: **Propose checks → Add 47** |

Keep SSMS visible the whole time. The point you are making is *you can check me*,
and that lands better if the means to check is already on screen.

---

## The opening, in sixty seconds

Lead with the problem, not the tool.

> "Every BI developer gets the same message at month end: *the dashboard doesn't
> match the system.* It's vague, it costs a day, and it ends with two Excel
> exports and a VLOOKUP. Worse, you can only ever check the thing somebody
> already suspected.
>
> So I built the check into the tool. It runs the model and the database side by
> side and tells me where they diverge. Not whether — **where**."

Then run the suite. 47 checks, about 80 seconds, one green line.

Say what it is *not*: "It doesn't translate DAX into SQL. I write both queries;
the tool executes them faithfully and compares. That's deliberate — a tool that
guesses the SQL equivalent of a measure will eventually tell me a correct
measure is wrong."

---

## Scenario 1 — Show your working

**The claim being tested:** the result is evidence, not assertion.

**Do:** expand `Dim_Product` → click **row count**.

**They see:**

```
RowCount        60          60          0
SELECT COUNT(*) AS [RowCount]     EVALUATE
FROM [dbo].[Dim_Product];         ROW ( "RowCount", COUNTROWS ( 'Dim_Product' ) )
```

**Verify in front of them.** Hit **Copy evidence**, paste the SQL into SSMS:

```sql
SELECT COUNT(*) AS [RowCount] FROM [dbo].[Dim_Product];   -- 60
```

and the DAX into DAX Studio:

```
EVALUATE ROW ( "RowCount", COUNTROWS ( 'Dim_Product' ) )  -- 60
```

**The point:** every verdict carries the exact strings that produced it. Nothing
has to be believed. Say it plainly: *"A reconciliation tool that hides its own
numbers is asking for the trust it's supposed to replace."*

---

## Scenario 2 — A matching total proves nothing

**This is the centrepiece. Lead with it if you only have five minutes.**

**The claim being tested:** reconciling at the total is close to worthless,
because offsetting errors cancel.

**Do:** open the builder, paste these, **Run both**.

Source — March inflated by 50,000, September deflated by the same:

```sql
SELECT YEAR([OrderDate]) AS [Yr], MONTH([OrderDate]) AS [Mo],
       SUM([SalesAmount])
       + CASE WHEN MONTH([OrderDate]) = 3 THEN 50000
              WHEN MONTH([OrderDate]) = 9 THEN -50000 ELSE 0 END AS [Amount]
FROM [dbo].[Fact_Sales]
GROUP BY YEAR([OrderDate]), MONTH([OrderDate]);
```

Target — the honest figures:

```
EVALUATE
SUMMARIZE (
    ADDCOLUMNS ( 'Fact_Sales', "Yr", YEAR ( 'Fact_Sales'[OrderDate] ), "Mo", MONTH ( 'Fact_Sales'[OrderDate] ) ),
    [Yr], [Mo],
    "Amount", SUM ( 'Fact_Sales'[SalesAmount] )
)
```

Pair `Yr`↔`[Yr]` and `Mo`↔`[Mo]` as **Keys**, `Amount`↔`[Amount]` as a **Value**.
Compare.

**They see:** 20 match, **4 mismatch**, sorted worst-first:

| Year ▸ Month | Source | Target | Δ |
|---|---:|---:|---:|
| 2023 ▸ 03 | 479,372.37 | 429,372.37 | +50,000 |
| 2023 ▸ 09 | 450,912.81 | 500,912.81 | −50,000 |
| 2024 ▸ 03 | 526,608.25 | 476,608.25 | +50,000 |
| 2024 ▸ 09 | 443,771.58 | 493,771.58 | −50,000 |

**Now prove the trap.** In SSMS, total up the same skewed figures:

```sql
SELECT SUM([Amount]) AS [SkewedTotal] FROM (
    SELECT YEAR([OrderDate]) AS [Yr], MONTH([OrderDate]) AS [Mo],
           SUM([SalesAmount])
           + CASE WHEN MONTH([OrderDate]) = 3 THEN 50000
                  WHEN MONTH([OrderDate]) = 9 THEN -50000 ELSE 0 END AS [Amount]
    FROM [dbo].[Fact_Sales]
    GROUP BY YEAR([OrderDate]), MONTH([OrderDate])
) x;
-- 11,687,137.85

SELECT SUM([SalesAmount]) FROM [dbo].[Fact_Sales];
-- 11,687,137.85   ← identical. Difference: 0.00
```

**The point, said out loud:** *"Four months are wrong by fifty thousand each and
the grand total is correct to the penny. A total-level reconciliation signs this
off. That's why the tool drills."*

---

## Scenario 3 — Missing data, localized

**The claim being tested:** it tells you *where*, not just *that*.

**Do:** from Scenario 2's queries, replace the skew with a filter:

```sql
...
FROM [dbo].[Fact_Sales]
WHERE MONTH([OrderDate]) <> 7
GROUP BY YEAR([OrderDate]), MONTH([OrderDate]);
```

**They see:** 22 match, **2 flagged "Only in target"** — July 2023 and July 2024,
with the full month as the delta.

**Verify in SSMS:**

```sql
SELECT YEAR([OrderDate]) AS [Yr], COUNT(*) AS [Rows], SUM([SalesAmount]) AS [Total]
FROM [dbo].[Fact_Sales] WHERE MONTH([OrderDate]) = 7
GROUP BY YEAR([OrderDate]);
-- 2023: 772 rows, 437,656.26
-- 2024: 728 rows, 439,970.73
```

Those are the two numbers the tool reported as missing.

**The point:** "only in target" and "only in source" are different findings.
Missing from the model is data loss; extra in the model is duplication or a
filter you forgot. The direction is the first thing a developer needs.

---

## Scenario 4 — The failure nothing else sees

**The claim being tested:** row counts and totals can all agree while the report
is wrong.

**Do:** paste this — a dimension missing its first ten products:

```sql
SELECT COUNT(*) AS [Orphans],
       COUNT(DISTINCT f.[ProductKey]) AS [OrphanKeys]
FROM [dbo].[Fact_Sales] AS f
LEFT JOIN (SELECT * FROM [dbo].[Dim_Product] WHERE [ProductKey] > 10) AS d
       ON f.[ProductKey] = d.[ProductKey]
WHERE f.[ProductKey] IS NOT NULL AND d.[ProductKey] IS NULL;
-- Orphans 3,968   OrphanKeys 10
```

**Then show what it costs, in SSMS:**

```sql
SELECT SUM(f.[SalesAmount]) AS [HiddenRevenue]
FROM [dbo].[Fact_Sales] AS f
LEFT JOIN (SELECT * FROM [dbo].[Dim_Product] WHERE [ProductKey] > 10) AS d
       ON f.[ProductKey] = d.[ProductKey]
WHERE d.[ProductKey] IS NULL;
-- 3,125,232.36
```

**Say the important part:** *"Row count is still 19,658 on both sides. The totals
still agree. Every other check in this suite still passes. Power BI quietly
creates a blank row in the dimension and parks 3,968 rows there — slice by
product and three million pounds sits under `(Blank)`. The suite runs 14 of
these, one per active relationship."*

**Why 14 and not 21:** the model has 21 relationships, 7 inactive (role-playing
dates). `RELATED` follows the active path, so proposing a check on an inactive
one would generate DAX that quietly measures something else. Worth volunteering —
it shows the tool knows what it can and cannot assert.

---

## Scenario 5 — Refusing to answer

**The claim being tested:** it would rather say nothing than say something
confident and wrong. This is the one that separates it from a weekend project.

**Do:** clear the pairing and deliberately pair `OrderID` to `[ProductKey]`.

**They see** — no red matrix, a refusal:

> **Not comparing — the answer would be wrong.**
> 0 of 9,423 source keys matched any of 60 target keys. That is almost always a
> key-pairing mistake rather than a total mismatch.

**The point:** "Every row differs" is technically true and completely useless. A
naive implementation paints the screen red and sends someone hunting a data
problem that doesn't exist. The same applies when a side hits the row cap:
comparison is **blocked**, because a truncated comparison looks authoritative
and lies.

Then show the third outcome in the suite summary: **passed · failed · could not
run**. A check that couldn't be evaluated is never folded into "passed" — a
refusal leaves the summary zeroed, so a careless implementation reports it as
clean.

---

## The questions you will get

**"How do I know the comparison itself is right?"**
315 unit tests, plus 47 on the SQL guard. The strongest is a property test:
feed the *same* data to both sides, shaped the way each engine really shapes it
— SQL CHAR padding, `bit` 1/0, dates as `DATETIME` — and every check at every
grain must come back zero. Any mismatch there is a tool bug by definition.

**"What about SQL injection / can it damage my database?"**
Connections are read-only (`ApplicationIntent=ReadOnly`), built from components
through `SqlConnectionStringBuilder`, Windows auth by default so no password is
stored. Every statement passes a guard before a connection is even opened: one
statement, must start with `SELECT` or `WITH`, no writes. Offer to demo it —
type `DROP TABLE Fact_Sales`, get a 400, show the table still there. Mention
that `SELECT … INTO`, a CTE ending in `INSERT`, and `SELECT 1 DROP TABLE t`
(T-SQL needs no semicolon) are all caught too, because the scan covers the whole
statement, not just its first word.

**"Why not just translate the DAX to SQL automatically?"**
Because a measure's value depends on filter context, relationships, RLS and time
intelligence, and a tool that guesses will eventually declare a correct measure
wrong. The user owning both queries is what makes the result trustworthy.

**"Does it work with views / stored procedures?"**
Views yes, including indexed views — they query identically. Stored procedures
no, deliberately: the guard can't see inside a procedure, so allowing `EXEC`
would mean the read-only promise rests on a name. Copy the proc's `SELECT` into
the pane, or wrap it in a view.

**"What's the hardest bug you hit?"**
Pick one and tell it properly — this is the question that actually matters.
The best is: *non-numeric values always compared as equal.* Dates and text both
parsed to null, null equalled null, and `2023-01-01` vs `2024-12-31` reported as
a **match**. A false green in the comparator itself. Found it by checking
whether a date check would work *before* building one.

Runner-up: the default tolerance was exact-zero, so 24 perfectly matching months
reported as 24 mismatches — each with a delta that displayed as `0` — because a
SQL `decimal` picks up binary floating-point residue in transit.

---

## What not to claim

Credibility comes from the limits you volunteer, not the features you list.

- **It is not market-ready.** No code signing, so SmartScreen flags it. No run
  history, no scheduled runs, no exportable report beyond clipboard evidence.
- **It cannot mark a difference as expected.** The first table with a deliberate
  Power Query filter goes permanently red, and a suite that's always amber gets
  ignored. Name this before they find it — it shows you know how reconciliation
  programmes actually die.
- **Auto-propose guesses the mapping.** This model loads from CSV extracts, so
  every table is matched *by name* and the tool says so on every drafted check.
- **It is slower than it should be.** 47 checks take ~80 seconds, and that is
  contention — both engines share one machine — not query time. Each query runs
  in under 200ms alone.

---

## Reset between runs

```powershell
# clear the suite, then re-propose in the UI
Invoke-WebRequest "http://127.0.0.1:5177/suites" -Method Put `
  -ContentType 'application/json' -Body '[]' -UseBasicParsing
```

Nothing in this playbook modifies data. Every scenario alters a *query*, never
the database — which is worth saying out loud when you run Scenario 4.

---

## The line to close on

> "The number it reports isn't the feature. The feature is that I can prove the
> number — and that when it can't be sure, it says so instead of guessing."
