# Power BI Studio — Product & Technical Architecture

> A modern, local-first **Design Studio** for building Power BI solutions.
> Not a clone of Power BI Desktop — a dramatically simpler creation experience
> that stays 100% compatible with the Microsoft ecosystem via open formats
> (**PBIP**, **TMDL**).

---

## 1. Product Philosophy

**Design first · Model second · Generate everything automatically.**

| Principle       | What it means in the product                                           |
| --------------- | ---------------------------------------------------------------------- |
| Local-first     | Everything runs in the browser. No backend, no cloud, no telemetry.    |
| Privacy-first   | Your data never leaves the device. Persistence via OPFS/IndexedDB.     |
| Offline-first   | Full functionality with the network off. Heavy work in Web Workers.    |
| Automation-first| Import → schema → facts/dims → KPIs → visuals → dashboard, hands-free.  |
| Zero onboarding | Any core workflow ≤ 3 clicks. Command palette for everything else.     |

---

## 2. Design System & Visual Language

- **Baseline:** monochromatic (white / charcoal / neutral gray) + one purposeful blue accent.
- **Grid:** strict 8pt spacing scale (4px half-step).
- **Type:** Inter / Segoe UI Variable, large & legible, tight tracking on headings.
- **Surfaces:** soft layered shadows, rounded corners, glassmorphism only on floating panels (command palette, canvas toolbar).
- **Motion:** subtle, `cubic-bezier(0.22, 1, 0.36, 1)`, 120–260ms. Honors `prefers-reduced-motion`.
- **Theming:** full light + dark via CSS custom properties (`data-theme` on `<html>`), no flash on load.
- **A11y:** keyboard-first, visible focus rings, high-contrast tokens, semantic roles, screen-reader labels.

All tokens live in [`src/design-system/tokens.css`](../src/design-system/tokens.css) — the single source of visual truth.

---

## 3. Screen Hierarchy

```
App
├── Home / Launcher
│   ├── Hero + global search (⌘K)
│   ├── Quick actions  → Import · New · Open PBIP · Open PBIX
│   ├── Template gallery (17 industry templates)
│   └── Recent projects
└── Studio (workspace shell)
    ├── TopBar        — brand · project · ⌘K · mode switch · panel + theme toggles
    ├── LeftSidebar   — Assets: Data, Measures, Pages, Visuals
    ├── Canvas        — Design ⇆ Preview ⇆ Model ⇆ DAX (wireframe designer)
    ├── RightPanel    — contextual Properties + Assistant suggestions
    └── BottomPanel   — Insights · DAX · Data Preview
```

Every panel is **dockable & collapsible**; state lives in the app store.

---

## 4. Clean Architecture (layers)

```
Presentation   React UI — shell, panels, canvas, design-system. Depends inward only.
     │
Application    Use-cases (CQRS commands/queries), engine services, ports (interfaces).
     │
Domain         Pure entities & rules: SemanticModel, Table, Column, Relationship,
     │         Measure, Report, Page, Visual. Zero framework imports.
     │
Infrastructure Adapters: file parsers, analytics engine, persistence, exporters,
               importers, plugin host. Implements the Application's ports.
```

Cross-cutting rails (in `src/shared`):

- **Command Bus** (`command-bus.ts`) — CQRS dispatch + middleware pipeline (undo capture, logging, validation).
- **Event Bus** (`event-bus.ts`) — typed pub/sub decoupling domain ↔ presentation.
- **DI Container** (`di.ts`) — token-based composition root; swappable for tests/plugins.
- **Result<T,E>** (`result.ts`) — explicit success/failure, no throwing across use-cases.

---

## 5. State Management Strategy

- **UI/session state:** Zustand store (`src/app/store.ts`) — view routing, theme, panels, palette, active project. Fine-grained selectors keep re-renders minimal.
- **Domain/document state (roadmap):** a **normalized entity graph** (`Record<Id, Entity>`) mutated exclusively through the Command Bus.
- **Undo/Redo:** Command Bus middleware captures inverse patches (Immer) onto an undo stack — every mutation is reversible.
- **Read models (CQRS query side):** memoized selectors derive view models (e.g. relationship graph, recommended visuals) without touching the write model.
- **Persistence:** autosave the serialized graph to OPFS/IndexedDB; a project ⇆ a portable JSON document that maps losslessly to PBIP/TMDL.

---

## 6. Core Engines (Application services)

| Engine                     | Responsibility                                                                 |
| -------------------------- | ------------------------------------------------------------------------------ |
| **Auto-Model Engine**      | Detect fact/dimension/date tables, PK/FK candidates, relationships, hierarchies.|
| **Smart KPI Engine**       | Detect Revenue, Margin, Growth, Churn, NPS… and generate measures above a confidence threshold. |
| **Visual Recommendation**  | Map (column types × cardinality × business meaning × time) → best visual.       |
| **DAX Architect**          | Natural language → best-practice, branched DAX with format strings & folders.    |
| **DAX Preview Engine**     | Evaluate DAX on local sample data; show result, dependency graph, filter context.|
| **AI Business Analyst**    | Conversational insights, missing-visual detection, storytelling annotations.     |

Engines are **pure services** behind ports; they run in Web Workers for large inputs and are individually testable and pluggable.

---

## 7. Data, Compatibility & Export

- **Import:** Excel, CSV, Parquet, SQL, Snowflake, Fabric Lakehouse, Semantic Model, TMDL, PBIP, BIM, best-effort PBIX.
- **Analytics engine:** a pluggable `QueryEngine` port. Default target: **DuckDB-WASM** in a Worker for OLAP-grade local evaluation ("query-folding"-like offload) — the UI thread never blocks.
- **Export (open formats only):** PBIP, TMDL, Interactive HTML, JSON, Markdown docs, Theme JSON, Tabular Editor scripts, PNG/PDF. No proprietary PBIX generation dependency.

---

## 8. Plugin SDK

A registry with typed **extension points**: `visual`, `importer`, `exporter`, `theme`, `aiProvider`, `validationRule`, `template`, `command`. Plugins declare a manifest and receive a sandboxed host API (read model, register renderer, add command). Built-in features are themselves plugins — dogfooding the SDK.

---

## 9. Performance Budget

Target: **1,000+ measures · 100+ pages · 500+ visuals** with no UI lag.

- Heavy parsing/eval/auto-modeling → **Web Workers** (Comlink RPC).
- Canvas & long lists → **virtualization**; transform-based pan/zoom.
- Lazy-loaded feature modules & code-splitting per route.
- Normalized store + granular selectors to avoid render storms.

---

## 10. Folder Structure

```
src/
  app/            Bootstrap, store, command registry, composition root
  domain/         Entities, value objects, domain events (pure)
  application/    Use-cases, engine services, ports (interfaces)
  infrastructure/ Parsers, query engine, persistence, exporters, plugin host
  presentation/   UI: shell, home, canvas, panels
  design-system/  Tokens, global styles, component primitives
  shared/         Result, Event Bus, Command Bus, DI
  workers/        Web Worker entry points
  plugins/        Built-in plugins (visuals, importers, exporters, themes)
```

See [ROADMAP.md](./ROADMAP.md) for the milestone plan.
