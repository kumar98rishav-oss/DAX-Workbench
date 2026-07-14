# Power BI Studio — Template Library (2030 Design System)

30 Dribbble-grade, PBIP-native templates. Figma aesthetics: 8pt grid, glassmorphism,
soft shadows, monochrome baseline + one neon accent, card-based segregation.
Each template ships a **theme.json**, **model.tmdl** (folding-optimised), and a **layout** spec.

## Phase 1 — Master Directory (30 templates × 5 verticals)

### A · Medical Operations & Provider Data Parsing
| # | Template | Primary 3 KPIs | Core Visuals | Aesthetic |
|---|---|---|---|---|
| 01 | Provider Data Parsing Command Center | Parse Accuracy % · Throughput (pages/min) · Manual Review Rate % | Pipeline funnel · P50/P95 latency line · error heatmap | Dark Neon (teal/lime) |
| 02 | Clinical Throughput & Bed Flow | Avg Length of Stay · Bed Occupancy % · Median ED Wait | Sankey flow · occupancy gauge · admits/discharge line | Light Minimal (clinical blue) |
| 03 | Revenue Cycle & Claims Denial | Denial Rate % · Days in A/R · Clean Claim Rate % | Waterfall · denial-reason bar · KPI cards | Dark Neon (magenta) |
| 04 | Referral Network & Credentialing | Referral Leakage % · Credentialing TAT · Active Providers | Network graph · provider×specialty matrix · bar | Light Glass (indigo) |
| 05 | Telehealth Utilization | Virtual Visit % · No-Show Rate % · Avg Session Min | Area · modality donut · geo map | Dark Neon (cyan) |

### B · Hospitality Revenue Management
| # | Template | Primary 3 KPIs | Core Visuals | Aesthetic |
|---|---|---|---|---|
| 06 | Hotel Revenue & Booking Velocity | Website Conversion % · Booking Pace (YoY) · Direct Revenue | Pace area · web funnel · channel stacked bar | Dark Neon (gold luxe) |
| 07 | RevPAR & Rate Optimization | RevPAR · ADR · Occupancy % | ADR/occupancy combo · rate calendar heatmap · gauge | Light Minimal (emerald) |
| 08 | Guest Experience & Reputation | NPS · Avg Review Score · Response Rate % | NPS gauge · sentiment bar · review treemap | Light Glass (rose) |
| 09 | F&B & Event Sales | Covers · Avg Check · Banquet Revenue | Bar · trend line · outlet matrix | Dark Neon (copper) |
| 10 | Channel Manager — OTA vs Direct | Direct Mix % · OTA Commission Cost · CPA | Channel stacked bar · donut · commission waterfall | Dark Neon (violet) |

### C · Higher Education & MBA Admissions
| # | Template | Primary 3 KPIs | Core Visuals | Aesthetic |
|---|---|---|---|---|
| 11 | MBA Admissions Funnel & Scoring | Yield % · Avg GMAT Percentile · Admit % (Selectivity) | Admissions funnel · score box-plot · GMAT×GPA scatter | Light Minimal (navy/ivory) |
| 12 | Enrollment & Retention | Enrollment · Retention % · Time-to-Degree | Cohort heatmap · trend line · program bar | Light Glass (teal) |
| 13 | Bursar — Tuition & Fee Tracking | Collected % · Outstanding Balance · Scholarship $ | Billing waterfall · A/R aging bar · KPI cards | Dark Neon (lime) |
| 14 | Faculty Research & Grants | Grant $ Awarded · Publications · Citation Index | Grant bar · impact bubble · funding line | Light Minimal (plum) |

### D · Data Engineering & Pipeline Performance
| # | Template | Primary 3 KPIs | Core Visuals | Aesthetic |
|---|---|---|---|---|
| 15 | Fabric Pipeline Performance | Pipeline Success % · P95 Load Time · Rows/Sec | Run Gantt · P50/P95/P99 line · job×hour heatmap | Dark Neon (electric blue/lime) |
| 16 | Data Quality & Observability | Freshness SLA % · Anomaly Rate · Schema-Drift Events | Status grid · freshness line · failed-check bar | Dark Neon (amber) |
| 17 | Warehouse Cost & FinOps | Compute $/Day · Cost per Query · Idle Warehouse % | Spend area · cost treemap · workload bar | Dark Neon (green) |
| 18 | dbt Model Lineage & Freshness | Models Built · Avg Build Time · Test Pass % | Lineage DAG · build-time line · test matrix | Light Minimal (slate) |
| 19 | Streaming Ingestion Monitor | Events/Sec · Consumer Lag · Error Rate | Real-time line · lag gauge · sparkline grid | Dark Neon (cyan) |

### E · Standard Enterprise
| # | Template | Primary 3 KPIs | Core Visuals | Aesthetic |
|---|---|---|---|---|
| 20 | SaaS MRR & Churn | MRR · Net Revenue Retention % · Logo Churn % | MRR waterfall · cohort · trend line | Dark Neon (indigo) |
| 21 | E-Commerce Conversion | Conversion % · AOV · Cart Abandonment % | Funnel · revenue line · category bar | Light Minimal (coral) |
| 22 | Supply Chain & Logistics | OTIF % · Inventory Turns · Freight Cost/Unit | Route map · lane bar · service gauge | Dark Neon (teal) |
| 23 | HR / People Analytics | Headcount · Attrition % · Time-to-Fill | Headcount waterfall · diversity donut · tenure bar | Light Glass (violet) |
| 24 | Executive KPI Cockpit | Revenue · EBITDA % · Cash Runway | KPI cards · sparklines · bullet bars | Dark Neon (platinum/blue) |
| 25 | Financial P&L / FP&A | Gross Margin % · OpEx Ratio · Budget Variance | P&L waterfall · variance bars · trend line | Light Minimal (forest) |
| 26 | Marketing Attribution (CAC/LTV) | CAC · LTV:CAC · Blended ROAS | Attribution Sankey · channel bar · payback line | Dark Neon (magenta) |
| 27 | Sales Pipeline / CRM | Pipeline Coverage · Win Rate % · Avg Deal Cycle | Stage funnel · rep bar · size×age scatter | Light Glass (blue) |
| 28 | Inventory & Demand Planning | Stockout Rate % · Forecast Accuracy (MAPE) · Days of Supply | Forecast-vs-actual line · SKU heatmap · aging bar | Dark Neon (orange) |
| 29 | Customer Support (CSAT/SLA) | CSAT · First Response Time · SLA Attainment % | CSAT gauge · volume line · queue bar | Light Minimal (sky) |
| 30 | Manufacturing OEE / IoT | OEE % · Downtime (min) · Scrap Rate % | OEE gauge · downtime Pareto · sensor line | Dark Neon (lime/black) |

---

## Phase 2 — Technical Architecture

### 2.1 Query Folding (backend optimisation — *not* RLS/security)

**Principle: thin M, fat SQL.** Every fact/dimension partition must keep its M expression
**foldable end-to-end**, so the whole transformation collapses into a *single native SQL
statement* the warehouse executes. The mashup engine receives shaped rows, never raw tables.

How the TMDL structure enforces it:
- **Parameterised foldable source.** Partitions start from `Sql.Database(ServerParam, DatabaseParam)`
  (Fabric SQL endpoint / Azure SQL / Snowflake) — parameters keep it portable and foldable.
- **Foldable steps only** — each maps 1:1 to SQL: `Table.SelectRows`→WHERE, `Table.SelectColumns`→SELECT,
  `Table.TransformColumnTypes`→CAST, `Table.Group`→GROUP BY, merges→JOIN, `Table.Sort`→ORDER BY.
- **Push heavy work to a VIEW / native query.** Big joins + pre-aggregation live in a DB view or
  `Value.NativeQuery(src, "SELECT …", null, [EnableFolding=true])`; the flag keeps later steps folding.
- **Step order:** selection + filters first (shrink at source) → type changes → any unavoidable
  non-foldable step **last** (or isolated in a downstream referencing query).
- **Incremental refresh:** the fact filter on `RangeStart`/`RangeEnd` folds to
  `WHERE Date >= @p1 AND Date < @p2`, letting Fabric partition-eliminate.
- **Fold-breakers banned in templates:** `Table.Buffer`, `Table.AddIndexColumn`, custom-function
  `Table.AddColumn` bodies, function-based `Table.ReplaceValue`, mixing a foldable query with a
  non-foldable one, `Csv/Excel.Workbook` mid-stream — anything after which *View Native Query* greys out.
- **Design-time gate:** the engine requests the native query per partition; if it can't, it flags the
  offending step before publish.

✅ Foldable:
```m
let
    Source   = Sql.Database(ServerParam, DatabaseParam),
    View     = Source{[Schema="rev", Item="vw_Booking"]}[Data],
    Windowed = Table.SelectRows(View, each [BookedDate] >= RangeStart and [BookedDate] < RangeEnd),
    Pruned   = Table.SelectColumns(Windowed, {"BookingKey","NetRevenue","ChannelGroup"}),
    Typed    = Table.TransformColumnTypes(Pruned, {{"NetRevenue", type number}})
in Typed          // → one SELECT … WHERE … ; fold intact
```
❌ Fold-breaking (do **not** ship):
```m
    Buffered = Table.Buffer(View),                       // materialises → fold dies here
    Indexed  = Table.AddIndexColumn(Buffered, "Row", 1), // no SQL equivalent
    Custom   = Table.AddColumn(Indexed, "Clean", each MyCleanser([Raw]))  // custom fn → local eval
```

### 2.2 Star-Schema Auto-Detection

The model is assembled by Studio's auto-model engine (grain-first):
- **Fact** = highest-cardinality table whose numeric columns are additive events, holding ≥1 FK.
  Grain = one row per event (parse job, booking, pipeline run, transaction).
- **Dimension** = low/medium-cardinality descriptive table with exactly one unique key referenced by facts.
- **Key inference:** PK = `distinctCount == rowCount` and 0 nulls, prefer `*ID/*Key` + integer.
  FK = fact column matching a dim PK by **name affinity × value containment ≥ threshold**.
- **Date dimension:** always a dedicated `Dim_Date` (contiguous, 1 row/day, `dataCategory: Time`,
  marked as date). Facts relate on an **integer `DateKey` (yyyymmdd)** surrogate for compression;
  raw datetime hidden.
- **Relationship shape:** many(fact) → one(dim), single cross-filter, single active path
  (extra date paths inactive → `USERELATIONSHIP`). Snowflakes flattened to star at load.
- **Modeling hygiene baked in:** integer surrogate keys, hidden key columns, fact numerics hidden
  behind measures, display folders, `summarizeBy: none` on keys.

See `templates/01-medical-provider-parsing/` and `templates/02-hospitality-revenue/` for the
first two fully-engineered templates (theme.json + model.tmdl + layout.md).
