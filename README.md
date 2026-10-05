<div align="center">

# ⚡ DAX Workbench

**Prove the numbers before you ship them.**

A Power BI **External Tool** that reconciles your live model against the source database,
validates every measure on Microsoft's own engine, and can drive a whole report from raw
CSVs to a Git commit — with a gate at every step.

One self-contained `.exe`. Runs on your machine. No account, no telemetry.

[**Live Workbench**](https://dax-workbench.onrender.com) ·
[**Download the bridge**](https://github.com/kumar98rishav-oss/DAX-Workbench/releases/latest) ·
[Reconciliation design](./docs/RECONCILIATION_DESIGN.md) ·
[Pipeline design](./docs/PIPELINE_SYSTEM_DESIGN.md) ·
[Architecture](./docs/ARCHITECTURE.md)

![React 18](https://img.shields.io/badge/React-18-149eca?logo=react&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![.NET 8](https://img.shields.io/badge/.NET-8-512bd4?logo=dotnet&logoColor=white)
![SQL Server](https://img.shields.io/badge/SQL_Server-read--only-cc2927?logo=microsoftsqlserver&logoColor=white)
![Tests](https://img.shields.io/badge/tests-385_passing-2dd4a0)
![No telemetry](https://img.shields.io/badge/telemetry-none-2dd4a0)

</div>

---

## Why this exists

A client opens your report and says *"this number is wrong."* Now you are reconciling by
hand — exporting to Excel, pivoting the source, hunting for where the two stop agreeing.
It takes a day, and you find it was a stale refresh.

The failure that costs the most isn't the obvious one. It is the report whose **grand total
is correct and whose detail is not**: a misallocated category, an SCD that moved a product,
a join that double-counted and a filter that compensated. Every number a reviewer eyeballs
ties out. Every decision made below that level is wrong, and nothing flags it.

Checking totals cannot find that. You have to compare **at grain** — and you have to be told
honestly when the comparison itself can't be trusted.

That is what this is for.

---

## What it does

Six tabs. The first one is the point; the rest support it.

### 🔀 Reconcile — source vs model, at any grain

Two query engines side by side: **SQL Server** (the system of record) and your **live Power
BI model**. You write both queries, the tool executes them faithfully and compares the
results.

- **Checks, generated for you** — row counts, distinct values, nulls, date coverage,
  duplicate keys, value sets, orphan keys across every active relationship. *Propose checks*
  drafts a whole suite from your schema in one click.
- **Drill to the break** — pair key columns (Year → Month → Product) and the matrix shows
  where source and target diverge, with the delta per cell.
- **It refuses rather than guesses.** A truncated read, zero key overlap, or an empty side
  **blocks** the comparison instead of painting a confident green. *"Could not run"* is a
  third outcome and is never folded into *"passed"*.
- **Evidence you can hand over** — every run exports an HTML and CSV report with both
  queries, both engines' timings, and every row compared. Saved suites re-run on demand.
- **Drafting, not translating** — a SQL query can draft its DAX counterpart (and back), but
  the draft lands in an editable pane and what runs is what you approved. Nothing is
  translated behind your back; constructs it can't handle are refused **by name**.

> The traps it handles so you don't have to: `CHAR` padding, `DATE` vs `DATETIME`, float
> drift, collation, `BIT` vs boolean, and `DISTINCTCOUNT` — which counts `BLANK` in DAX but
> is ignored by `COUNT(DISTINCT)` in SQL.

### ƒ DAX — write it, verify it, prove it's fast

- **DAX Architect** — describe a measure in plain English; ranked candidates resolved
  against the live model. A column must exist and a value must appear in that column's real
  data, or the filter is dropped. It can be wrong about what you *meant*; it cannot invent a
  column or a value.
- **AI Generate** *(opt-in, your own key)* — for intent the patterns don't cover. Off until
  you supply a key, proxied through your local bridge so the key never lands in browser
  network logs, and the output is DAX you read before it goes anywhere.
- **Measure Factory** — one numeric field → its whole suite (total, average, YTD/QTD/MTD,
  prior year, YoY %, MoM %, moving average, running total, % of total, rank) in one pass.
- **Optimizer** — deterministic rewrites (whole-table `FILTER` → predicate,
  `COUNTROWS(FILTER(…))` → `CALCULATE`, `SUMX` → `SUM`, `IF(ISBLANK())` → `COALESCE`, `/` →
  `DIVIDE`), each **benchmarked cold-cache before/after on your data**. Values are compared
  too: a rewrite returning a different number is reported as a rule bug, never a speed-up.
  When the run-to-run spread is wider than the gain, it says *"too close to call"*.
- **Model Doctor** — missing format strings (text measures correctly exempted), naked
  `FILTER` inside `CALCULATE`, division that should be `DIVIDE()`, missing folders. Exports a
  Markdown data dictionary.
- **Date table builder** — a real date table over your fact table's actual range, deployed
  as a calculated table with its relationship wired up.

### 🧹 Cleanup — delete what nothing uses

Builds a usage graph across measures, columns and visuals, then shows the **cascade impact**
before you remove anything. Stage deletions, review what breaks, deploy, undo.

### 🚀 Pipeline — CSVs to a Git commit, gated

An AI-assisted delivery cockpit. Point it at a folder of CSVs and it works through **11
ordered stages**, each of which must clear a gate before the next begins. Measures are
validated on the live engine and reconciled to the control totals recorded in stage 1 — not
syntax-checked. You can pause, set breakpoints, and require sign-off on any stage.

### 📥 Data · 🧠 Model

CSV / Excel / Parquet parsed in a Web Worker with schema inference and column profiling;
automatic star-schema detection (keys, relationships, fact/dimension/date roles) with an
interactive relationship graph.

---

## How it works

### The screen — Reconcile

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  SQL Server          144 rows · 47ms  │  Power BI model     144 rows · 167ms  │
│  ┌─────────────────────────────────┐  │  ┌─────────────────────────────────┐  │
│  │ SELECT YEAR(OrderDate) AS Yr,   │  │  │ EVALUATE                        │  │
│  │        MONTH(OrderDate) AS Mo,  │  │  │ SUMMARIZE(                      │  │
│  │        Category, SUM(Amount)    │  │  │   ADDCOLUMNS(Fact_Sales, …)     │  │
│  │ FROM … GROUP BY …               │  │  │ )                               │  │
│  └─────────────────────────────────┘  │  └─────────────────────────────────┘  │
│         [▶ Run]                       │         [▶ Run]                       │
├──────────────────────────────────────────────────────────────────────────────┤
│  [▶ Run both]   back to back, so drift between reads can't look like a diff   │
│                              Draft from the other side:  [SQL→DAX] [DAX→SQL]  │
├──────────────────────────────────────────────────────────────────────────────┤
│  PAIR COLUMNS    ( Keys (grain) │ Values )              tolerance ± 0.000001  │
│   KEY  Yr ↔ [Yr]    KEY  Mo ↔ [Mo]    VALUE  Totalsales ↔ [Totalsales]        │
├──────────────────────────────────────────────────────────────────────────────┤
│  ✓ 120 match    ✗ 24 mismatch    0 only in source    0 only in target         │
│                                                                              │
│  [YR] ▸ [MO] ▸ [PRODUCT]      SOURCE          TARGET            Δ     STATUS  │
│  ─ 2024                    6,132,777.99   6,132,777.99          0   Mismatch  │ ← total
│    ▸ 7                       739,970.73     439,970.73   −300,000   Mismatch  │   ties,
│    ▸ 3                       176,608.25     476,608.25   +300,000   Mismatch  │   detail
│    ▸ 8                       549,867.08     549,867.08          0   Match     │   doesn't
└──────────────────────────────────────────────────────────────────────────────┘
```

That year row is the whole thesis: **Δ = 0 at the top, two months wrong by 300,000 each in
opposite directions underneath.** A totals-only check passes this report clean.

### The machine

Power BI Desktop already runs a private Analysis Services instance behind every open report.
The bridge finds it and speaks to it properly — the same way Tabular Editor and DAX Studio
do. Everything runs on your machine except the one call you opt into.

```
┌───────────────────────────  your computer  ────────────────────────────┐
│                                                                        │
│   ┌──────────────────┐                      ┌───────────────────────┐  │
│   │ Power BI Desktop │ ◄── TOM / ADOMD ───► │                       │  │
│   │  (msmdsrv.exe)   │   read model, run    │        BRIDGE         │  │
│   │   your open      │   DAX, write         │   .NET 8 · one .exe   │  │
│   │   report         │   measures           │   127.0.0.1:5177      │  │
│   └──────────────────┘                      │   UI embedded inside  │  │
│                                             │                       │  │
│   ┌──────────────────┐                      │   17 endpoints        │  │
│   │   SQL Server     │ ◄── ADO.NET ───────► │   loopback only       │  │
│   │  system of       │   SELECT only,       │                       │  │
│   │  record          │   ApplicationIntent  └───────────┬───────────┘  │
│   └──────────────────┘   = ReadOnly                     │ HTTP         │
│                                                         ▼              │
│                                             ┌───────────────────────┐  │
│                                             │   DAX WORKBENCH UI    │  │
│                                             │   React · in browser  │  │
│                                             └───────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ╎ only if YOU supply an API key
                              ▼
                   ┌──────────────────────┐
                   │  NVIDIA NIM  (opt-in)│   schema + your prompt.
                   │  AI Generate only    │   Never your data rows.
                   └──────────────────────┘
```

**The comparison itself is pure.** `src/application/reconcile/` does no I/O: the store runs
the queries, the core receives two result sets and returns a verdict. That is why it can be
tested exhaustively, and why *"refuses rather than guesses"* is a property of the code rather
than a promise in a README.

### The pipeline

```
   CSV folder
       │
   ┌───▼────┐  ┌────────┐  ┌──────────┐  ┌───────┐  ┌───────┐  ┌──────────┐
   │0 Boot  │─►│1 Profile│─►│2 Design  │─►│3 Shape│─►│4 Model│─►│5 Measures│
   │strap   │  │ control │  │ star     │  │ ETL   │  │ TMDL  │  │ live-    │
   │        │  │ totals  │  │ schema   │  │       │  │ /PBIP │  │ verified │
   └────────┘  └────────┘  └──────────┘  └───────┘  └───────┘  └──────────┘
        each stage must clear its GATE before the next one starts │
   ┌────────┐  ┌────────┐  ┌──────────┐  ┌────────────┐  ┌───────▼──────┐
   │10 Pack │◄─│9 QA    │◄─│8 Author  │◄─│7 Style     │◄─│6 Plan        │
   │ + GIT  │  │ re-    │  │ PBIR     │  │ theme      │  │ pages,       │
   │ COMMIT │  │ concile│  │ report   │  │            │  │ visuals      │
   └────────┘  └────────┘  └──────────┘  └────────────┘  └──────────────┘
```

Stage 1 records the control totals. Stage 5 checks every measure still returns them. Stage 9
re-runs the reconciliation against the finished report. A stage that fails its gate stops the
run — it does not carry a bad number forward. Typical run: 25–45 minutes.

---

## Getting started

**As a Power BI user — the normal path**

1. [Download the bridge](https://github.com/kumar98rishav-oss/DAX-Workbench/releases/latest)
   — one `.exe`, no installer, no .NET runtime to fetch. Windows SmartScreen will flag it as
   unsigned: *More info → Run anyway*.
2. Double-click it. From the tray icon choose **Add to Power BI ribbon** (needs one UAC
   prompt), then restart Power BI Desktop.
3. Open a report → **External Tools → DAX Workbench**. It opens already attached to your
   model, on the Reconcile tab.
4. For reconciliation, connect SQL Server from the Sources panel — Windows auth by default.

**From source**

```bash
npm install
npm run dev          # UI on http://localhost:5173
npm test             # 385 tests
npm run typecheck

# the bridge (the .NET 8 SDK is needed to BUILD only — users never install it)
cd tools/pbi-desktop-bridge
dotnet publish -c Release        # → one self-contained exe with the UI inside
dotnet run --project ../bridge-guard-tests   # read-only SQL guard tests
```

---

## Safety model

The bridge reads your model and your database. That is worth being precise about.

| | |
|---|---|
| **SQL is read-only** | One statement, `SELECT`/`WITH` only. Comments and string literals are scrubbed *before* the write-scan, so `-- DELETE` in a comment can't hide anything and `'DROP'` in a literal can't trip a false alarm. `ApplicationIntent=ReadOnly`. No `EXEC`, no stored procedures — deliberately. |
| **Loopback by default** | The bridge binds `127.0.0.1`. Remote mode is opt-in and requires a pairing token compared in constant time. `/sql/*` is refused outright for non-loopback callers unless you pass `--allow-remote-sql`. |
| **Writes are narrow** | Of 17 endpoints only `/measure`, `/table` and `/delete` mutate anything, and `/measure` returns 400 rather than ever write an empty expression — a guard added after a hand-rolled call blanked a real measure during development. |
| **Credentials** | Windows auth is the default. Passwords are redacted from every error string before it reaches the UI. |
| **Outbound calls** | The bridge calls Power BI Desktop and the SQL Server *you* configure. It makes exactly one other outbound call — to NVIDIA, only for AI Generate, only after you supply your own key. That call carries your schema and prompt, never your data rows. With no key set, nothing leaves the machine. |

No account, no sign-in, no analytics, no error reporting, no third-party scripts, no external
fonts. Your model changes only when you explicitly deploy, and every write is undoable in
Desktop.

---

## By the numbers

| | |
|---|---|
| Client | **26,900+ lines** of strict TypeScript across 132 files, Clean Architecture (`domain → application → infrastructure → presentation`) |
| Reconciliation core | **4,000 lines**, pure and I/O-free — comparison, normalisation, check generation, suites, reporting, SQL↔DAX drafting |
| Bridge | **1,900 lines** of C#, 17 endpoints, ships as one self-contained exe with the UI embedded |
| Tests | **385** TypeScript tests plus a separate C# assertion harness for the read-only SQL guard |
| DAX engine | **229-function catalog**, ranked intent patterns, deterministic rules engine, mini-DAX interpreter with row context |
| Optimizer | **5 rewrite rules + 4 advisory rules**, each proven by a cold-cache before/after benchmark with values compared |
| Runtime dependencies | **8** — react, react-dom, zustand, papaparse, xlsx, hyparquet, fflate, lucide-react |

---

## Documentation

- [Reconciliation design](./docs/RECONCILIATION_DESIGN.md) — why it refuses, how keys are
  built, what equivalence does and doesn't mean
- [Reconciliation demo](./docs/RECONCILIATION_DEMO.md) — five scenarios with verified numbers
- [Pipeline system design](./docs/PIPELINE_SYSTEM_DESIGN.md) — the 11 stages, gates, and hosts
- [Architecture](./docs/ARCHITECTURE.md) — layers, engines, state, plugins
- [Bridge internals](./tools/pbi-desktop-bridge/README.md) — endpoints, discovery, security

## Project layout

```
src/
  domain/          pure types — SemanticModel, Report (zero imports)
  application/     the engine room
    reconcile/     compare · normalize · generators · propose · suite · report · translate
    dax/           architect · intent · evaluator · factory · doctor · optimizer · usage
    import/        CSV / Excel / Parquet / PBIP / TMDL
  infrastructure/  the outside world — bridge client, sql client, worker parsing
  presentation/    React only — reconcile, data, model, cleanup, dax, pipeline, home
  app/             composition root — store, reconcile-store, commands, DI
  shared/          Result, EventBus, CommandBus, DI container
tools/
  pbi-desktop-bridge/   .NET 8 bridge — TOM + ADOMD + ADO.NET over localhost HTTP
  bridge-guard-tests/   C# assertions for the read-only SQL guard
```

---

<div align="center">

Designed with ❤️ by **Rishav K.** — love to hear about your experience.

[LinkedIn](https://www.linkedin.com/in/rishav98kumar) · [Kumar98rishav@gmail.com](mailto:Kumar98rishav@gmail.com)

© 2026 DAX Workbench. All rights reserved.
Not affiliated with or endorsed by Microsoft. Power BI is a trademark of Microsoft Corporation.

</div>
