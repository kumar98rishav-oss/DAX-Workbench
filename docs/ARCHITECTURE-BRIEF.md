# DAX Workbench — Architecture Brief

> Context for an LLM with no access to the repository. Everything below is verified
> against the running system (rev `6847a82`, July 2026), not inferred.

---

## 0. One-paragraph thesis

DAX Workbench is a **local-first measure workbench for Power BI**. It attaches to the
Analysis Services instance that Power BI Desktop already runs, reads the live model,
generates DAX deterministically, verifies it on the real engine over full data, rewrites
it for performance, and deploys it straight back into the open report. Architecturally it
is **not** a data platform: it is a *query compiler, a term-rewriting engine, and a
benchmark harness* wrapped around somebody else's execution engine. Every design decision
follows from that.

**Scale:** 17,138 LOC strict TypeScript (98 files) + 835 LOC C#. 8 HTTP endpoints.
3 processes. **0 databases, 0 queues, 0 schedulers, 0 servers of its own.**

---

## 1. Process topology

```
┌──────────────────────── one Windows machine ────────────────────────┐
│                                                                     │
│  React 18 SPA  ──HTTP──►  .NET 8 bridge  ──XMLA/TCP──►  msmdsrv.exe │
│  (browser)                (127.0.0.1:5177)              (SSAS       │
│                                                          Tabular,   │
│                                                          VertiPaq)  │
│                                                              ▲      │
│                                                              │owns  │
│                                                     Power BI Desktop│
└─────────────────────────────────────────────────────────────────────┘
```

- **msmdsrv.exe** is SQL Server Analysis Services in Tabular/workspace mode with the
  VertiPaq columnar store. It is spawned and owned by Power BI Desktop. We do not own it,
  cannot embed it, cannot replace it. **This is the governing constraint of the system.**
- The SPA can be served two ways: from inside the bridge exe (embedded build,
  `127.0.0.1:5177`) or from a static host (`https://dax-workbench.onrender.com`). Both
  drive the same local bridge.

### Client layering (Clean Architecture, acyclic by import direction)

```
domain/         pure types (SemanticModel, Report). Imports nothing.
application/    deterministic engines. Pure, zero I/O:
                  - intent resolver + 22 ranked DAX patterns
                  - DEFINE query compiler (dependency closure)
                  - optimizer rewrite rules
                  - 624-line mini-DAX interpreter (row context aware)
                  - 229-function DAX catalog
infrastructure/ bridge HTTP client; Web Worker for CSV/XLSX/Parquet parsing
presentation/   React only. Zustand single store.
```

The application layer being **pure and I/O-free** is load-bearing: the optimizer rules and
the query compiler are testable without a browser, an engine, or a network.

---

## 2. How the bridge works

The browser cannot speak the engine's wire protocol, and the engine's port changes on
every launch. The bridge solves exactly those two problems.

### 2.1 Discovery — filesystem rendezvous

Power BI Desktop starts SSAS on an **ephemeral port** and writes it into a file. There is
no registry key, no service name, no advertised endpoint. The port file *is* the discovery
mechanism.

```
Workspace roots probed (install channel differs):
  %LOCALAPPDATA%\Microsoft\Power BI Desktop\AnalysisServicesWorkspaces          # MSI
  %USERPROFILE%\Microsoft\Power BI Desktop Store App\AnalysisServicesWorkspaces # MSIX
  %LOCALAPPDATA%\Packages\Microsoft.MicrosoftPowerBIDesktop_*\LocalCache\...    # MSIX redirected

Each workspace: <ws>\Data\msmdsrv.port.txt
  - encoded UTF-16LE  (a naive ReadAllText returns mojibake)
  - regex \d+ to extract the port
  - THEN probe-validate: TOM Server.Connect(localhost:port)
    → on failure `continue` (port files outlive the process that wrote them)
```

Discovery returns a **list**, not a singleton — several reports can be open. The client
always pins `?port=` rather than letting the bridge guess; relying on "the only open model"
was a real bug.

### 2.2 Two protocols, two jobs

| Concern | Library | Used for |
|---|---|---|
| Metadata (DDL) | `Microsoft.AnalysisServices.Tabular` (**TOM**) | read tables/columns/measures/relationships; create/update measure; create calculated table; commits via `Model.SaveChanges()` |
| Query (DML) | `Microsoft.AnalysisServices.AdomdClient` (**ADOMD.NET**) | execute `EVALUATE`, stream reader, run XMLA commands (`ClearCache`) |

Both ride **XMLA over TCP**. These are the same libraries Tabular Editor and DAX Studio
use; writing measures this way is standard external-tool behaviour and is undoable in
Desktop.

### 2.3 Packaging — the exe *is* the product

One self-contained `WinExe` (~83 MB, .NET 8, `net8.0-windows`, `UseWindowsForms`) hosts:

- **Kestrel** minimal API (8 endpoints)
- the built SPA as **embedded resources** via `ManifestEmbeddedFileProvider`; static
  middleware is mounted **before** the auth gate so assets never 401
- `MapFallback` → `index.html` (SPA fallback routing)
- a **WinForms tray** message loop on an STA thread, alongside Kestrel
- **single-instance** enforcement via named mutex `Local\dax-workbench-bridge`
  (second launch focuses the browser and exits)
- **External Tools registration**: writes `dax-workbench.pbitool.json` into
  `C:\Program Files (x86)\Common Files\Microsoft Shared\Power BI Desktop\External Tools`,
  receiving `--launch "%server%" "%database%"` — so Power BI's own ribbon launches the tool
  already attached to the open report

Collapsing website + agent into one binary **structurally eliminates version skew**: the
embedded UI and the API it calls are by construction the same build.

### 2.4 Endpoints

| Method | Path | Purpose | Mutates |
|---|---|---|---|
| GET | `/health` | liveness, machine name, version | no |
| GET | `/discover` | open models (db GUID + port) | no |
| GET | `/model` | tables, columns, measures, relationships | no |
| POST | `/dax` | run `EVALUATE …`; caps at 10,000 rows returned | no |
| POST | `/time` | benchmark: per-run ms, median, min, value, `cold` flag | no |
| POST | `/preview` | scalar value of one expression | no |
| POST | `/measure` | create/update a measure via TOM | **yes** |
| POST | `/table` | create/update a calculated table | **yes** |

`/measure` refuses to write an empty expression (a payload that failed to bind used to
blank someone's DAX silently).

---

## 3. Request lifecycle (the hot path)

1. Keystroke mutates the Zustand store; the **in-browser interpreter** renders an
   immediate approximate value from the synced sample. No network.
2. **Debounce 500 ms** — backpressure, so fast typing cannot queue N engine round-trips.
3. `dependencyClosure()` walks the measure DAG; emits a `DEFINE MEASURE` preamble carrying
   the whole chain.
4. `POST /dax` with `AbortSignal.timeout(15s)` — **deadline propagation** from the caller.
5. Bridge: origin allowlist → auth gate (skipped on loopback) → `PowerBi.Resolve(port)`.
6. Bridge opens an `AdomdConnection`, executes, streams the reader.
7. Engine: query-scoped measures shadow deployed ones. VertiPaq scans, formula engine
   finishes. **Full data — no sampling.**
8. UI replaces the approximate value with the exact one; badge flips to `live · full data`.
   On failure the local value simply remains.

### Two data planes, deliberately asymmetric

| Plane | Moves | Volume | Exactness |
|---|---|---|---|
| **Sync** (`EVALUATE 'Table'`) | raw rows into browser memory | capped **10k rows/table** | approximate if truncated |
| **Evaluate** (`DEFINE … EVALUATE ROW()`) | formula text out, one scalar back | a few hundred **bytes** | **always exact** |

This is **"ship the formula to the data"**. The 10k cap bounds rows *returned*, never rows
*computed over* — one row comes back whether the fact table holds 600 rows or 60 million.

---

## 4. DAGs and orchestration (the question people ask first)

### 4.1 Orchestration engine: **none, deliberately**

No Airflow, Dagster, Prefect, Temporal, Celery, or cron. An orchestrator solves recurring
multi-step batch work with durable retry, backfill, and fan-out across workers. This
system has **none of those properties**: every trigger is a human gesture, all work is
interactive and sub-second, nothing needs to survive a restart, and there is no schedule.
Adding one would be resume-driven architecture.

### 4.2 DAGs: **three, none of which is a task graph**

**(a) Measure dependency DAG — runtime, load-bearing.**
DAX measures reference each other by bracket name (`[Other Measure]`), forming a directed
acyclic graph. To evaluate a measure that exists only in the editor, the engine must
receive its entire transitive dependency chain. `dependencyClosure(pool, target)` computes
the **reachability set** and returns the **induced subgraph**.

Real example from a connected model (a diamond):

```
Billed YoY%  ──► Billed YTD ──┐
      │                       ├──► Total_Bill   (leaf: SUM over fact)
      └──────► Billed PY   ───┘
```
Closure emits 4 `MEASURE` definitions. Dumping the whole model would emit 45 — and would
fail if any *unrelated* measure were broken.

Two subtleties that are easy to get wrong:

- **Edges are resolved against the candidate pool, not the deployed model.** A
  suggestion's unsaved plan steps do not exist in Desktop yet. An earlier version parsed
  dependencies from the model, missed them, emitted an incomplete `DEFINE`, and produced a
  *wrong preview*. The scan now walks the pool's own bracket references.
- **The closure is computed but never topologically sorted.** A `DEFINE` block is
  order-independent — the engine resolves declarations itself. Kahn's algorithm would be
  wasted work; reachability is the entire requirement.

**(b) Module dependency DAG — compile time.** `domain → application → infrastructure →
presentation`, acyclic by construction.

**(c) Build-plan DAG — per generation.** "Give me YoY" expands into a branched plan
(base total → prior year → growth), a topologically ordered node list committed in order
so each measure exists before its dependant references it.

### 4.3 What actually plays the orchestrator's role

**Analysis Services itself.** Given a `DEFINE` statement it builds the query plan, decides
what the **storage engine** (VertiPaq: compressed, multi-threaded, columnar) can answer
versus what the **formula engine** (row-by-row, single-threaded per operation) must
iterate, parallelises segment scans, and manages its own caches.

The Workbench hands it a declarative statement and gets out of the way. **Every
"optimization" in this product is an attempt to give that planner a better statement** —
that is what predicate pushdown means here.

---

## 5. The query compiler (most reused component)

```dax
DEFINE
  MEASURE 'Fact_Cases'[Total_Bill]  = SUM('Fact_Cases'[TotalBilled])
  MEASURE 'Fact_Cases'[Billed YTD]  = TOTALYTD([Total_Bill], 'Dim_Date'[Date])
  MEASURE 'Fact_Cases'[Billed PY]   = CALCULATE([Total_Bill], SAMEPERIODLASTYEAR('Dim_Date'[Date]))
  MEASURE 'Fact_Cases'[Billed YoY%] = DIVIDE([Billed YTD] - [Billed PY], [Billed PY])
EVALUATE ROW("v", [Billed YoY%])
```

Three properties make this the backbone:

1. **Non-persisting.** Query-scoped measures live for one statement. Verified empirically:
   a scoped `SUM(...)/2` returned exactly half the known total (23,428,012.855 vs
   46,856,025.71) and the model still held 45 measures afterwards — nothing was written.
2. **Shadowing.** A scoped measure overrides a deployed one of the same name, so the
   editor's current text always wins over what is saved.
3. **Reused verbatim** by: live preview, the 12-card KPI board (one `EVALUATE ROW()` with
   positional `k0…kN` aliases fills all cards in a single round-trip), Matrix/Table pages
   (`SUMMARIZECOLUMNS`), and **both sides** of the optimizer benchmark. One code path, so
   those surfaces cannot disagree with each other.

`SUMMARIZECOLUMNS` is chosen because it is the query shape Power BI's own visuals emit —
so the KPI surface agrees with a real report *by construction*. Verified: four quarterly
cells summed to 2,761,557, exactly the flat total.

---

## 6. The optimizer pipeline

The only genuine multi-stage pipeline in the system, and the one place the architecture
makes a falsifiable claim.

```
[1] MASK        string literals → control-char sentinels
                (so "A/B" is never parsed as division)
        ↓
[2] MATCH       depth-aware paren scanner splits call arguments
                5 rewrite rules + 4 advisory rules
        ↓
[3] REWRITE     fixpoint loop, capped at 12 passes
                (two instances of one anti-pattern both get fixed)
        ↓
[4] DIFFERENTIAL TEST   run BOTH variants on the engine, compare values
                        with relative tolerance
        ↓
[5] BENCHMARK   cold cache, warm-up discarded, min-of-5, jitter-gated verdict
```

Stages 1–3 alone would be a linter. Stages 4–5 are what make it trustworthy.

### Rewrite rules (auto-applied, semantics-preserving)

| Rewrite | Engine-level reason |
|---|---|
| `CALCULATE(x, FILTER(T, T[c]=v))` → `CALCULATE(x, T[c]=v)` | **Predicate pushdown.** `FILTER` materialises the table and evaluates row-by-row in the formula engine; a bare predicate is applied by the storage engine during a compressed multi-threaded scan. |
| `COUNTROWS(FILTER(T, p))` → `CALCULATE(COUNTROWS(T), p)` | same pushdown; count answered from the scan without an intermediate table |
| `SUMX(T, T[c])` → `SUM(T[c])` (also AVERAGEX/MINX/MAXX) | removes a formula-engine row context; becomes a pure columnar aggregation |
| `IF(ISBLANK(x), y, x)` → `COALESCE(x, y)` | evaluates `x` once instead of twice |
| `a / b` → `DIVIDE(a, b)` | branch the engine optimises for; returns BLANK rather than an error a visual must trap |

### Advisory findings (flagged, never auto-rewritten)

- **measure referenced inside `FILTER`** — forces a **context transition** per row; the
  row-by-row semantics may be exactly what was intended, so rewriting could change results
- **`IFERROR`** — evaluates in a protected mode that disables optimizations, and hides real errors
- **`EARLIER`** — works, but a `VAR` is the modern equivalent
- **nested `CALCULATE`** — often redundant filter contexts

Refusing to rewrite where semantics could shift is a correctness decision, not a gap.

### Benchmark harness

- **Cold cache**: XMLA `ClearCache` before every timed run. A warm cache serves a bad
  formulation as fast as a good one — this is precisely how slow DAX looks fine in casual
  testing.
- **Warm-up discarded**: one untimed pass absorbs ADOMD connection setup and query-plan
  compilation. Without it, run 1 measured **117 ms** against a true ~33 ms and dragged the
  median.
- **Min-of-N, not mean**: noise only ever *adds* time, so the minimum is the cleanest
  estimator of true cost.
- **Jitter gate**: a winner is declared only when the gap exceeds `max(12%, observed
  spread)`. On a small model this correctly reports *"too close to call — spread ±57%
  against a 0% difference"* rather than inventing a speed-up.
- **Honest degradation**: if the engine refuses `ClearCache`, the response carries
  `cold: false` and the UI labels the numbers "warm cache".

**The key inversion:** a rewrite that returns a *different value* is reported as a **rule
bug**, never as an optimization. The tool treats its own output as the thing under test.

Measured example (real model): whole-table `FILTER` 31.4 ms vs pushed-down predicate
22.6 ms, identical values.

---

## 7. Consistency and the truth model

The in-browser model is an **eventually-consistent replica** of Desktop's model with
**manual invalidation** — there is no change feed from Desktop, so re-sync is the refresh.
Writes are **write-through**: `POST /measure` commits via TOM immediately, and the local
store updates optimistically.

Rather than hide that split, the UI **encodes provenance in the pixel**:

| Badge | Source | Guarantee |
|---|---|---|
| `live · full data` | Analysis Services | **exact**, at any model size |
| `sample` | local mini-DAX interpreter over ≤10k rows | indicative; may be truncated |
| `local` | same, no engine attached | indicative, and says so |

**Governing rule: a sample can never impersonate truth.** Matrix and Table pages refuse to
render at all without an engine rather than showing plausible sample numbers. When Desktop
switched models mid-session during testing, the tool surfaced the raw engine error
`Cannot find table 'Sales_Fact'` instead of silently falling back — correct behaviour, even
though it looks worse.

**Known weakness:** nothing detects that Desktop opened a different `.pbix`; the user finds
out via an engine error. The discovery poll already returns the database GUID every 4 s, so
comparing it against the synced one would turn a confusing error into "this model changed,
re-sync".

---

## 8. Concurrency, backpressure, failure

| Mechanism | Implementation | Assessment |
|---|---|---|
| CPU offload | Web Worker for CSV/XLSX/Parquet | correct — main thread stays responsive |
| Backpressure | 400–500 ms debounce on keystroke-triggered queries | adequate; no cancellation of superseded in-flight requests |
| Deadlines | `AbortSignal.timeout()`, 2.5 s probe → 120 s benchmark | good — tier-appropriate, not one global value |
| Liveness | 4 s poll on Home, 15 s in DAX view | polling not eventing; fine for a local socket |
| Connections | new `AdomdConnection` per request, disposed | **weak** — no pooling |
| Sync | sequential `await` per table | **weak** — N+1 serial round-trips |
| Cancellation | client aborts; server keeps executing | **weak** — no `CancellationToken` reaches ADOMD |
| Degradation | `probeDesktop()` never throws | excellent — a missing bridge is a normal state, not an error path |

**Failure philosophy: fail soft on infrastructure, fail loud on truth.** A missing bridge
degrades quietly to sample mode; a wrong number is never smoothed over.

---

## 9. Security model

The bridge can read your model and write measures into it. That is the protected asset.

- **Loopback bind by default**; invisible to the network; makes no outbound call of its own.
- **Exact-origin CORS allowlist**, never a wildcard suffix — `*.onrender.com` would hand
  every tenant of a shared host access to a running bridge.
- **Released names are removed.** When the site moved to `dax-workbench.onrender.com`, the
  old origin was *deleted*, not kept: a released subdomain can be re-registered by someone
  else and would inherit its allowlist entry.
- **Bearer token, constant-time** (`CryptographicOperations.FixedTimeEquals`), mandatory
  over the network, regenerated per start.
- **Auth gate scoped to API paths** so static assets serve openly.
- **Private Network Access** preflight answered (`Access-Control-Allow-Private-Network`).
- **Writes are explicit** — nothing on a timer or in the background; undoable in Desktop.

**Honest threat-model note:** on loopback the bridge is **unauthenticated by design** — any
process already on the machine can call it, and CORS is a browser rule that `curl` ignores
entirely. Over the network the *token* is the real gate; CORS protects nothing there. The
binary is unsigned and shipped without a published checksum, so "Run anyway" is
load-bearing trust.

---

## 10. Scorecard — 7.0 / 10 overall

Graded against what a production-grade version of *this specific product* should be, not
against a distributed platform it never tried to be.

| Component | Score | Assessment |
|---|---|---|
| Truth model & provenance | **10** | Best decision in the system. Two tiers, badged at every render; a sample is structurally forbidden from impersonating an exact value. Most BI tooling silently blends these. |
| Query compilation (DEFINE closure) | **9** | Correct algorithm, correctly scoped — closure without topological sort because the engine resolves declaration order. Reused across five surfaces so they cannot disagree. |
| Engine attach & discovery | **9** | Three workspace roots incl. both MSIX layouts, UTF-16 handling, probe-validated against stale port files, multi-instance aware with a pinned port. |
| Benchmark harness | **8** | Cold-cache, warm-up discard, min-of-N, jitter-gated verdicts — more rigorous than most commercial tooling. Missing: server-timings breakdown (SE vs FE ms, scan counts). |
| Packaging & distribution | **8** | One exe carrying API + UI + tray + ribbon registration eliminates version skew. Held back by 83 MB, no signature, binary committed to git. |
| Security posture | **8** | Right primitives, right defaults; allowlist discipline documented *and* followed. Deducted for unsigned binary / no checksum. |
| Frontend architecture | **8** | Clean layering with a pure I/O-free core, worker offload, strict TS. Deducted for a 531 KB single bundle, no code splitting. |
| Optimizer rewrite engine | **6** | Sound rules, honest advisory boundary, differential-tested — but it is **regex + a paren scanner, not an AST**. Comments, `VAR`/`RETURN` bodies and multi-line formatting each need special-casing until a real parser exists. |
| State & cache coherence | **6** | Write-through works, optimistic updates correct, but nothing invalidates the replica when Desktop switches file. |
| Bridge concurrency & throughput | **5** | No connection pooling, sequential N+1 sync, no cancellation reaching ADOMD. Invisible on a 21-table model; the first thing to hurt on an enterprise one. |
| Observability | **3** | No structured logging, no local diagnostics buffer, no way to hand a maintainer a trace. Zero telemetry is a deliberate privacy stance and correct — but that argues for *local* logs, not none. |
| Automated testing & CI | **3** | **The real gap.** Optimizer rules were validated by a hand-written scratch script that was then deleted. The rules engine is pure and dependency-free — the cheapest high-value tests available — and a rewrite bug silently changes someone's numbers. No CI gate on `tsc` or build. |

---

## 11. What it solves in a real analyst workflow

| Daily friction | What this removes |
|---|---|
| **The write–verify loop is broken** — write a measure, drop it in a card, look, adjust, repeat | The number appears beside the formula as you type, computed on full data, before anything is committed |
| **AI-written DAX is confidently wrong** — a filter on a value that doesn't exist returns a number, not an error | Intent is resolved against the live model: the column must exist and the value must appear in that column's real data, or the filter is dropped. It can misread intent; it cannot invent a column. |
| **"The report is slow" with no next step** | Names the mechanism (formula-engine iteration vs storage-engine scan), rewrites it, and proves the delta cold-cache — or admits the difference is noise |
| **Boilerplate suites typed by hand** — YTD, PY, YoY %, moving average, running total, rank, per field | One pass per field, including the base measures the chain branches from, previewed before deploy |
| **Model hygiene drifts silently** — missing format strings, `/` instead of `DIVIDE`, whole-table `FILTER` copied around | Audited across the live model with one-click fixes that write through to Desktop |
| **No date table, or a hand-rolled one** | Built over a real fact column's `MIN`/`MAX` with fiscal-year support, deployed as a calculated table with the relationship wired |
| **Inheriting someone's model** — 45 measures, no docs | All DAX in one searchable list, per-measure dependency graph, relationship graph, exportable Markdown data dictionary |
| **Checking a number costs a chart** | A 12-card KPI board fills itself from the measures you create, using the same query shape Power BI's own visuals emit |

### What it deliberately does NOT solve

No refresh/ETL scheduling. No deployment to the Power BI Service, workspaces, or pipelines.
No source control / TMDL diffing for measures. No RLS testing. No report layout or visual
design (that is a sibling tool). No multi-user collaboration. Nothing works against a
published dataset over an XMLA endpoint. It is a **modelling-time desktop tool**, and every
absence follows from that scope.

---

## 12. Prioritised technical debt

1. **A test suite and a CI gate.** The rules engine is pure and dependency-free — the
   cheapest high-value tests available. A rewrite bug corrupts numbers silently, which is
   the exact failure this product exists to prevent.
2. **Model-identity checking.** Compare the discovery poll's database GUID against the
   synced one; prompt to re-sync. Turns a confusing engine error into an instruction.
3. **Parallelise sync with bounded concurrency** (4–6 in flight) and **pool ADOMD
   connections.** The difference between usable and unusable on a large model.
4. **Replace the regex matcher with a real DAX parser.** Everything ambitious in the
   optimizer is blocked behind this.
5. **Sign the binary, publish a checksum, move it out of git into Releases** (it already
   triggers GitHub's 83 MB warning on every push).
6. **Surface server timings** (SE vs FE ms, scan counts) from the benchmark — one XMLA
   trace away, and it would make the Optimizer diagnostic rather than only comparative.

---

## 13. Glossary of terms used above

- **VertiPaq / storage engine (SE)** — compressed columnar store; multi-threaded scans; fast
- **Formula engine (FE)** — evaluates DAX expressions row-by-row; single-threaded per op; slow
- **Predicate pushdown** — moving a filter condition down so SE applies it during the scan
- **Context transition** — `CALCULATE`/measure reference converting row context to filter
  context; expensive when it happens per row
- **Query-scoped measure** — `DEFINE MEASURE`, exists for one statement, shadows deployed
  measures of the same name, never persisted
- **TOM** — Tabular Object Model; metadata read/write
- **ADOMD.NET** — query execution client
- **XMLA** — the wire protocol both ride
- **Reachability set / induced subgraph** — the transitive-dependency closure of a node
- **Fixpoint rewriting** — apply rules repeatedly until no rule fires
- **Differential testing** — run two implementations, compare outputs, treat divergence as a bug
