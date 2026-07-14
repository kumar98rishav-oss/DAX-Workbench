# Template 01 — Provider Data Parsing · Wireframe Logic

Canvas: **1280 × 720** logical px · 8pt grid · 24px page gutters · dark neon.

```
┌──────┬──────────────────────────────────────────────────────────────────────┐
│ NAV  │  TOP BAR  (y 0–64)                                                     │
│ 0–72 │  title · ●live-refresh chip · [Date range][Provider][Doc Type] slicers│
│      ├──────────────────────────────────────────────────────────────────────┤
│ icon │  KPI ROW  (y 88–204)                                                   │
│ rail │  ┌ Parse Accuracy ┐┌ Throughput ┐┌ Manual Review ┐┌ Docs Processed ┐  │
│ glass│  └────────────────┘└────────────┘└───────────────┘└────────────────┘  │
│ 6    ├───────────────────────────────────┬──────────────────────────────────┤
│ page │  PIPELINE FUNNEL (y 220–470)      │  LATENCY / THROUGHPUT LINE        │
│ icons│  Ingested→OCR→Validated→Published │  P50 / P95 / P99 over time        │
│      ├───────────────────────────────────┼──────────────────────────────────┤
│ user │  ERROR HEATMAP (y 486–696)        │  PROVIDER LEADERBOARD (table)     │
│ btm  │  DocType × PipelineStage          │  rank · accuracy · review rate    │
└──────┴───────────────────────────────────┴──────────────────────────────────┘
```

Exact rects (x, y, w, h):

| Zone | Rect | Notes |
|---|---|---|
| Left nav rail | 0, 0, 72, 720 | Glass; logo top, 6 page icons, avatar bottom. Collapsible → 240. |
| Top bar | 72, 0, 1208, 64 | Page title left; pill slicers right (radius 999). |
| KPI cards ×4 | 96 / 392 / 688 / 984 · y 88 · 272 × 116 | `callout` = DIN 30; delta chip top-right. |
| Pipeline funnel | 96, 220, 568, 250 | Neon teal gradient bars. |
| Latency line | 688, 220, 496, 250 | 3 series, no markers, dotted gridlines. |
| Error heatmap | 96, 486, 568, 210 | Sequential teal→magenta. |
| Provider table | 688, 486, 496, 210 | Data-bar accuracy column. |

Interaction: top slicers cross-filter all cards; funnel stage click drills the heatmap; hover = glass tooltip.
