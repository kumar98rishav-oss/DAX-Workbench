<div align="center">

# ⚡ Power BI Studio

**A modern, local-first Design Studio for building Power BI solutions.**
Design first · Model second · Generate everything automatically.

</div>

Not a clone of Power BI Desktop — a dramatically simpler, faster creation
experience that stays compatible with the Microsoft ecosystem through open
formats (**PBIP**, **TMDL**). Runs entirely in the browser: no backend, no
cloud, no telemetry.

## Quick start

```bash
npm install
npm run dev      # → http://localhost:5173
```

```bash
npm run build      # typecheck + production build
npm run typecheck  # strict TypeScript check
```

## Highlights

- 🎨 Bespoke design system — 8pt grid, monochrome + one blue accent, light/dark.
- ⌘K command palette — keyboard-first control over every action.
- 📥 **Import** CSV/Excel/Parquet in a Web Worker — schema inference, profiling, multi-sheet + side-by-side table splitting, virtualized grid.
- 🧠 **Auto-Model** — detects primary/foreign keys, relationships, and fact/dimension/date roles into an interactive graph.
- 📊 **Auto-Dashboard** — KPI detection, join-aware query engine, visual recommendation, one-click generation with real SVG visuals.
- ✏️ **Designer** — drag/resize with snap + alignment guides, undo/redo, add/duplicate/delete, contextual properties.
- ƒ **DAX Architect** — 227-function catalog, natural-language → DAX, live preview evaluator.
- ✨ **AI Analyst** — grounded conversational insights (trends, drivers, declines); pluggable provider.
- 📤 **Export** — TMDL, PBIP (zip), interactive HTML, Markdown, theme, Tabular Editor script, JSON.
- 🧩 **Plugin SDK** — extension-point registry (Studio's own features register through it) + model validation.
- 🧱 Clean Architecture — CQRS Command Bus, Event Bus, DI, pure domain, Web Workers.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) — philosophy, layers, engines, state, plugins.
- [Roadmap](./docs/ROADMAP.md) — milestone plan (M0 → M8).

## Tech

TypeScript (strict) · React 18 · Vite · Zustand · CSS custom-property design tokens.

## Project layout

```
src/
  app/            bootstrap, store, command registry
  domain/         pure entities (model, report)
  application/    use-cases, engines, ports        (grows M1+)
  infrastructure/ parsers, engine, persistence      (grows M1+)
  presentation/   shell, home, canvas, panels
  design-system/  tokens, primitives
  shared/         Result, Event Bus, Command Bus, DI
  workers/        web worker entry points           (grows M1+)
  plugins/        built-in plugins                  (grows M8)
```
