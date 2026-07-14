# Implementation Roadmap

Incremental milestones. Each is independently runnable and demoable.

| Milestone | Theme | Key deliverables | Status |
| --------- | ----- | ---------------- | ------ |
| **M0** | **Foundation** | Vite + React + TS (strict), design tokens & primitives, 5-region shell, Home launcher, Command Palette (⌘K), light/dark, Clean-Architecture rails (Command Bus, Event Bus, DI, Result), domain entities. | ✅ **done** |
| **M1** | **Data Import** | CSV/Excel/Parquet parsing in a Web Worker, schema inference & type coercion, column profiling, virtualized Data Preview grid. | ✅ **done** |
| **M2** | Auto-Model Engine | Fact/dim/date detection, PK/FK inference, interactive relationship graph. | ✅ **done** |
| **M3** | KPI + Visual Recommendation | KPI detection, join-aware query engine, one-click auto-dashboard, real SVG renderers. | ✅ **done** |
| **M4** | Wireframe Designer | Select/move/resize, snap + alignment guides, keyboard editing, undo/redo, add/duplicate/delete, properties. | ✅ **done** |
| **M5** | DAX Architect + Preview | 227-function catalog, NL→DAX, live subset evaluator, editor + searchable reference. | ✅ **done** |
| **M6** | AI Business Analyst | Grounded conversational insights, decline analysis, missing-visual suggestions; provider interface. | ✅ **done** |
| **M7** | Export | TMDL, PBIP (zip), interactive HTML, Markdown docs, Theme JSON, project JSON, Tabular Editor script. | ✅ **done** |
| **M8** | Plugin SDK + hardening | Extension-point registry + sandboxed host, built-ins register through it, model validation. | ✅ **done** |

## M0 — what's in this build

- **Design system:** `tokens.css` (color, 8pt spacing, radii, shadows, type, motion; light+dark), global reset, primitives (Button, IconButton, Kbd, Card, Badge, Segmented, Tooltip, EmptyState).
- **Command Palette:** fuzzy search, keyboard nav, grouped commands, glass surface — bound to ⌘/Ctrl+K.
- **Studio shell:** dockable/collapsible TopBar, LeftSidebar, Canvas, RightPanel, BottomPanel.
- **Home launcher:** hero, quick actions, 17-template gallery, recent empty state.
- **Canvas:** auto-generated dashboard wireframe preview (KPI row + SVG mini-charts) on a dotted design grid.
- **Architecture rails:** `CommandBus`, `EventBus`, `Container` (DI), `Result`, plus pure `domain` entities.

## M1 — what's in this build

- **Parsing worker** (`infrastructure/parsing/parse.worker.ts`): CSV (PapaParse), Excel (SheetJS), Parquet (hyparquet) decoded off the main thread. Bundles as its own 406 KB chunk — the parser libs never touch the main bundle.
- **Multi-sheet + multi-table workbooks**: every sheet imports as its own table, and sheets containing several tables laid out side-by-side (separated by blank columns) are auto-split into separate tables (`application/import/extract-tables.ts`). Verified on the Chandoo chocolate-sales workbook → 5 clean tables (Shipments · Product · Geo · Sales_person · Calendar).
- **Schema inference** (`application/import/infer-schema.ts`, pure): per-column type detection (integer / decimal / boolean / date / dateTime / string) with a 90% confidence threshold, currency/thousands-aware numeric parsing, value coercion, and basic role hints (key / measure-candidate / date / flag / dimension).
- **Profiling**: distinct & null counts, numeric min/max/mean, temporal extremes, and a distribution (histogram / categorical top-N / boolean / by-year) that drives the header mini-charts.
- **Data Preview grid** (`presentation/data/DataGrid.tsx`): windowed virtualization (≈36 DOM rows for 800+), sticky profiled headers with type badges + distribution sparks + key/measure icons, right-aligned tabular numerics.
- **Import UX**: hidden picker + drag-and-drop drop zone + "Load sample dataset", multi-file import, progress/error toasts. Wired to the Home actions, Assets panel, and ⌘K.
- **Architecture**: `ImportService` (application) behind a `FileParserPort`, implemented by the worker adapter (infrastructure), composed via the DI container (`app/services.ts`). Imported tables land in the domain `SemanticModel`.
- **Verified** on the production build: 800×12 sample parsed in-worker, every type inferred correctly, virtualization + profiling confirmed, zero console errors, strict typecheck + `vite build` green.

## Definition of done (per milestone)

1. Typechecks under `strict`.
2. Runnable via `npm run dev` with no console errors.
3. Core workflow reachable in ≤ 3 clicks or via the command palette.
4. Light + dark + keyboard paths verified.
