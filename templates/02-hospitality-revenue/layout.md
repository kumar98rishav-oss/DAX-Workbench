# Template 02 — Hotel Revenue & Booking Velocity · Wireframe Logic

Canvas: **1280 × 720** logical px · 8pt grid · 24px gutters · warm luxe neon (gold accent).

```
┌──────┬──────────────────────────────────────────────────────────────────────┐
│ NAV  │  TOP BAR (y 0–64)  title · [Date][Property][Channel] pill slicers      │
│ 0–72 ├──────────────────────────────────────────────────────────────────────┤
│      │  KPI ROW (y 88–204)                                                    │
│ glass│  ┌ Direct Revenue ┐┌ Booking Pace ┐┌ Web Conversion ┐┌ ADR / RevPAR ┐ │
│ rail ├───────────────────────────────────────────┬──────────────────────────┤
│      │  BOOKING PACE — this yr vs last yr (area)  │  WEB FUNNEL               │
│ page │  (y 220–470, wide 2/3)                     │  Visit→Search→Select→Book │
│ icons├───────────────────────────────────────────┼──────────────────────────┤
│      │  REVENUE BY CHANNEL (stacked bar)          │  RATE CALENDAR (heatmap)  │
│ user │  Direct / OTA / GDS / Wholesale            │  ADR by day-of-month      │
└──────┴───────────────────────────────────────────┴──────────────────────────┘
```

Exact rects (x, y, w, h):

| Zone | Rect | Notes |
|---|---|---|
| Left nav rail | 0, 0, 72, 720 | Glass; property switcher at top. |
| Top bar | 72, 0, 1208, 64 | Pill slicers, radius 999. |
| KPI cards ×4 | 96 / 392 / 688 / 984 · y 88 · 272 × 116 | Gold `callout`; sparkline under value. |
| Booking pace (area) | 96, 220, 760, 250 | 2 series (this yr solid, last yr 40% opacity). |
| Web funnel | 880, 220, 304, 250 | 4 stages, conversion % between. |
| Revenue by channel | 96, 486, 460, 210 | Stacked bar, gold→bronze ramp. |
| Rate calendar heatmap | 576, 486, 608, 210 | ADR intensity, day-of-month grid. |

Interaction: channel slicer recolours pace + funnel; funnel stage → filters rate calendar; hover glass tooltip with pace delta.
