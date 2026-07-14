/**
 * APPLICATION — Visual recommendation + layout recipes (pure)
 * Extracts measures/categories from the model, then arranges them via one of
 * several LAYOUT RECIPES (Executive, Right-filter, Top-filter, KPI-focus,
 * Chart-grid, Table-report). Each recipe uses a different mix of Power BI
 * visuals and structure so the user can pick how the dashboard reads.
 */
import type { Column, SemanticModel, Table } from '@/domain/model'
import type { Page, Rect, Visual, VisualKind } from '@/domain/report'
import type { Agg, Bucket, CategoryRef, MeasureRef } from '@/application/query/query-engine'
import { generateMeasures } from './kpi-engine'
import type { GeneratedMeasure, MeasureKind } from './kpi-engine'

// ---- specs stored on visual.style.spec ----
export interface MeasureSpec extends MeasureRef {
  name: string
  kind: MeasureKind
  format: string
}
export interface CategorySpec extends CategoryRef {
  name: string
}
export interface CardSpec { type: 'card'; measure: MeasureSpec }
export interface MultiSpec { type: 'multi'; measures: MeasureSpec[] }
export interface SeriesSpec { type: 'series'; measure: MeasureSpec; category: CategorySpec; topN?: number }
export interface RankSpec { type: 'rank'; measure: MeasureSpec; category: CategorySpec; topN: number }
export interface MatrixSpec { type: 'matrix'; category: CategorySpec; measures: MeasureSpec[]; topN: number }
export interface ScatterSpec { type: 'scatter'; category: CategorySpec; x: MeasureSpec; y: MeasureSpec; topN?: number }
export interface ComboSpec { type: 'combo'; category: CategorySpec; bar: MeasureSpec; line: MeasureSpec; topN?: number }
export interface SlicerSpec { type: 'slicer'; category: CategorySpec }
export interface TextSpec { type: 'text'; title: string; subtitle?: string }
export type VisualSpec =
  | CardSpec | MultiSpec | SeriesSpec | RankSpec | MatrixSpec
  | ScatterSpec | ComboSpec | SlicerSpec | TextSpec

const PAGE_W = 1280
const PAGE_H = 760

const measureSpec = (m: GeneratedMeasure): MeasureSpec => ({
  tableId: m.tableId,
  columnId: m.columnId,
  agg: m.agg as Agg,
  name: m.name,
  kind: m.kind,
  format: m.formatString,
})

const kindPriority: Record<MeasureKind, number> = { currency: 0, quantity: 1, ratio: 2, count: 3, generic: 4 }

function groupByColumn(table: Table, excludeIds: Set<string>): Column | null {
  const c = table.columns.filter(
    (x) => x.dataType === 'string' && x.role !== 'key' && !excludeIds.has(x.id) && (x.distinctCount ?? 2) > 1,
  )
  if (c.length === 0) return null
  c.sort((a, b) => (a.distinctCount ?? 99) - (b.distinctCount ?? 99))
  return c[0]
}
const factDateColumn = (t: Table): Column | null =>
  t.columns.find((c) => c.dataType === 'date' || c.dataType === 'dateTime') ?? null

// ---------------------------------------------------------------------------
// Model picks — everything a recipe needs
// ---------------------------------------------------------------------------
export interface Picks {
  measures: MeasureSpec[]
  cards: MeasureSpec[]
  primary: MeasureSpec
  secondary: MeasureSpec
  ratio: MeasureSpec | null
  categories: CategorySpec[]
  smallCats: CategorySpec[]
  date: CategorySpec | null
}

function pickModel(model: SemanticModel): Picks | null {
  const measures = generateMeasures(model)
  const fact =
    model.tables.find((t) => t.role === 'fact') ??
    model.tables.find((t) => t.columns.some((c) => c.role === 'measureCandidate')) ??
    model.tables[0]
  if (!fact) return null

  const fk = new Set(model.relationships.map((r) => r.fromColumn))
  const sorted = measures
    .filter((m) => m.tableId === fact.id)
    .sort((a, b) => kindPriority[a.kind] - kindPriority[b.kind] || b.confidence - a.confidence)
  if (sorted.length === 0) return null

  const specs = sorted.map(measureSpec)
  const seen = new Set<string>()
  const cards = specs.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true))).slice(0, 6)
  const primary = specs[0]
  const secondary = specs.find((s) => s.name !== primary.name && (s.kind === 'currency' || s.kind === 'quantity')) ?? specs[1] ?? primary
  const ratio = specs.find((s) => s.kind === 'ratio') ?? null

  const cats: { spec: CategorySpec; card: number }[] = []
  for (const c of fact.columns) {
    if (c.dataType !== 'string' || c.role === 'key' || fk.has(c.id)) continue
    const card = c.distinctCount ?? 8
    if (card > 1 && card <= 40) cats.push({ spec: { tableId: fact.id, columnId: c.id, name: c.name }, card })
  }
  for (const rel of model.relationships.filter((r) => r.fromTable === fact.id && r.isActive)) {
    const dim = model.tables.find((t) => t.id === rel.toTable)
    if (!dim || dim.role === 'date') continue
    const col = groupByColumn(dim, fk)
    if (col) cats.push({ spec: { tableId: dim.id, columnId: col.id, name: col.name }, card: col.distinctCount ?? 8 })
  }
  cats.sort((a, b) => a.card - b.card)
  const categories = cats.map((c) => c.spec)
  const smallCats = cats.filter((c) => c.card <= 6).map((c) => c.spec)

  const dc = factDateColumn(fact)
  const date: CategorySpec | null = dc
    ? { tableId: fact.id, columnId: dc.id, name: dc.name, bucket: 'month' as Bucket }
    : null

  return { measures: specs, cards, primary, secondary, ratio, categories, smallCats, date }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
let vseq = 0
const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })
function V(kind: VisualKind, title: string, r: Rect, spec: VisualSpec): Visual {
  return { id: `v_${++vseq}`, kind, title, rect: r, bindings: [], style: { spec }, isAutoGenerated: true }
}

// card row x positions
const cols4 = [24, 336, 648, 960]
const cols3 = [24, 440, 856]

function catAt(p: Picks, i: number): CategorySpec | null {
  return p.categories[i] ?? p.categories[0] ?? null
}
function smallCat(p: Picks): CategorySpec | null {
  return p.smallCats[0] ?? p.categories[0] ?? null
}

// ---------------------------------------------------------------------------
// Layout recipes
// ---------------------------------------------------------------------------
export interface LayoutRecipe {
  id: string
  name: string
  description: string
  build: (p: Picks) => Visual[]
}

const timeOrCat = (p: Picks): CategorySpec | null => p.date ?? catAt(p, 0)

export const LAYOUTS: LayoutRecipe[] = [
  {
    id: 'executive',
    name: 'Executive',
    description: 'KPI row · trend line · donut · bars · ranked table',
    build: (p) => {
      const vs: Visual[] = []
      p.cards.slice(0, 4).forEach((m, i) => vs.push(V('card', m.name, rect(cols4[i], 24, 296, 116), { type: 'card', measure: m })))
      const t = timeOrCat(p)
      if (t) vs.push(V(p.date ? 'line' : 'bar', `${p.primary.name} over time`, rect(24, 156, 764, 286), { type: 'series', measure: p.primary, category: t }))
      const sc = smallCat(p)
      if (sc) vs.push(V('donut', `${p.primary.name} by ${sc.name}`, rect(804, 156, 452, 286), { type: 'series', measure: p.primary, category: sc }))
      const c0 = catAt(p, 0), c1 = catAt(p, 1)
      if (c0) vs.push(V('bar', `${p.primary.name} by ${c0.name}`, rect(24, 458, 400, 278), { type: 'series', measure: p.primary, category: c0, topN: 10 }))
      if (c1) vs.push(V('column', `${p.primary.name} by ${c1.name}`, rect(440, 458, 400, 278), { type: 'series', measure: p.primary, category: c1, topN: 8 }))
      if (c0) vs.push(V('table', `Top ${c0.name}`, rect(856, 458, 400, 278), { type: 'rank', measure: p.primary, category: c0, topN: 12 }))
      return vs
    },
  },
  {
    id: 'right-filter',
    name: 'Right Filter Panel',
    description: 'Slicer panel on the right · KPIs · line · gauge · matrix',
    build: (p) => {
      const vs: Visual[] = []
      // right slicer panel
      const slicerCats = [p.date ? { ...p.date, bucket: 'year' as Bucket } : null, catAt(p, 0), catAt(p, 1)].filter(Boolean) as CategorySpec[]
      slicerCats.slice(0, 3).forEach((c, i) => vs.push(V('slicer', c.name, rect(1048, 24 + i * 238, 208, 222), { type: 'slicer', category: c })))
      // main
      p.cards.slice(0, 3).forEach((m, i) => vs.push(V('card', m.name, rect(24 + i * 336, 24, 320, 116), { type: 'card', measure: m })))
      const t = timeOrCat(p)
      if (t) vs.push(V(p.date ? 'area' : 'bar', `${p.primary.name} trend`, rect(24, 156, 640, 286), { type: 'series', measure: p.primary, category: t }))
      const g = p.ratio ?? p.primary
      vs.push(V('gauge', g.name, rect(680, 156, 336, 286), { type: 'card', measure: g }))
      const c0 = catAt(p, 0)
      if (c0) vs.push(V('matrix', `${c0.name} breakdown`, rect(24, 458, 640, 278), { type: 'matrix', category: c0, measures: p.cards.slice(0, 3), topN: 8 }))
      const c1 = catAt(p, 1)
      if (c1) vs.push(V('bar', `${p.primary.name} by ${c1.name}`, rect(680, 458, 336, 278), { type: 'series', measure: p.primary, category: c1, topN: 8 }))
      return vs
    },
  },
  {
    id: 'top-filter',
    name: 'Top Filter Bar',
    description: 'Title + year/filters on top · KPIs · line · donut · waterfall',
    build: (p) => {
      const vs: Visual[] = []
      vs.push(V('text', p.primary.name, rect(24, 24, 360, 56), { type: 'text', title: 'Overview', subtitle: 'Filtered report' }))
      const filters = [p.date ? { ...p.date, bucket: 'year' as Bucket } : null, catAt(p, 0), catAt(p, 1)].filter(Boolean) as CategorySpec[]
      const fx = [420, 696, 972]
      filters.slice(0, 3).forEach((c, i) => vs.push(V('slicer', c.name, rect(fx[i], 24, 260, 56), { type: 'slicer', category: c })))
      p.cards.slice(0, 4).forEach((m, i) => vs.push(V('card', m.name, rect(cols4[i], 96, 296, 112), { type: 'card', measure: m })))
      const t = timeOrCat(p)
      if (t) vs.push(V(p.date ? 'line' : 'bar', `${p.primary.name} over time`, rect(24, 224, 764, 240), { type: 'series', measure: p.primary, category: t }))
      const sc = smallCat(p)
      if (sc) vs.push(V('donut', `${p.primary.name} by ${sc.name}`, rect(804, 224, 452, 240), { type: 'series', measure: p.primary, category: sc }))
      const c0 = catAt(p, 0), c1 = catAt(p, 1)
      if (c0) vs.push(V('waterfall', `${p.primary.name} by ${c0.name}`, rect(24, 480, 616, 256), { type: 'series', measure: p.primary, category: c0, topN: 8 }))
      if (c1) vs.push(V('table', `Top ${c1.name}`, rect(664, 480, 592, 256), { type: 'rank', measure: p.primary, category: c1, topN: 10 }))
      return vs
    },
  },
  {
    id: 'kpi-focus',
    name: 'KPI Focus',
    description: 'Six KPI cards · large area + column',
    build: (p) => {
      const vs: Visual[] = []
      const src = p.cards.length >= 4 ? p.cards : [...p.cards, ...p.cards].slice(0, 6)
      src.slice(0, 6).forEach((m, i) => vs.push(V('card', m.name, rect(cols3[i % 3], 24 + Math.floor(i / 3) * 132, 400, 116), { type: 'card', measure: m })))
      const t = timeOrCat(p)
      if (t) vs.push(V(p.date ? 'area' : 'bar', `${p.primary.name} trend`, rect(24, 300, 616, 436), { type: 'series', measure: p.primary, category: t }))
      const c0 = catAt(p, 0)
      if (c0) vs.push(V('column', `${p.primary.name} by ${c0.name}`, rect(664, 300, 592, 436), { type: 'series', measure: p.primary, category: c0, topN: 10 }))
      return vs
    },
  },
  {
    id: 'chart-grid',
    name: 'Chart Grid',
    description: 'No KPIs — six varied charts in a grid',
    build: (p) => {
      const vs: Visual[] = []
      const gx = [24, 440, 856], gy = [24, 388]
      const slot = (i: number): Rect => rect(gx[i % 3], gy[Math.floor(i / 3)], 400, 348)
      const c0 = catAt(p, 0), c1 = catAt(p, 1), sc = smallCat(p), t = timeOrCat(p)
      if (c0) vs.push(V('column', `${p.primary.name} by ${c0.name}`, slot(0), { type: 'series', measure: p.primary, category: c0, topN: 10 }))
      if (t) vs.push(V(p.date ? 'line' : 'bar', `${p.primary.name} trend`, slot(1), { type: 'series', measure: p.primary, category: t }))
      if (sc) vs.push(V('donut', `${p.primary.name} by ${sc.name}`, slot(2), { type: 'series', measure: p.primary, category: sc }))
      if (c1) vs.push(V('treemap', `${p.primary.name} by ${c1.name}`, slot(3), { type: 'series', measure: p.primary, category: c1, topN: 10 }))
      if (c0) vs.push(V('funnel', `${p.primary.name} funnel`, slot(4), { type: 'series', measure: p.primary, category: c0, topN: 6 }))
      if (c0) vs.push(V('scatter', `${p.primary.name} vs ${p.secondary.name}`, slot(5), { type: 'scatter', category: c0, x: p.primary, y: p.secondary, topN: 20 }))
      return vs
    },
  },
  {
    id: 'table-report',
    name: 'Table Report',
    description: 'KPI row · large matrix · donut · detail card',
    build: (p) => {
      const vs: Visual[] = []
      p.cards.slice(0, 4).forEach((m, i) => vs.push(V('card', m.name, rect(cols4[i], 24, 296, 116), { type: 'card', measure: m })))
      const c0 = catAt(p, 0)
      if (c0) vs.push(V('matrix', `${c0.name} detail`, rect(24, 156, 764, 580), { type: 'matrix', category: c0, measures: p.cards.slice(0, 4), topN: 14 }))
      const sc = smallCat(p)
      if (sc) vs.push(V('donut', `${p.primary.name} by ${sc.name}`, rect(804, 156, 452, 282), { type: 'series', measure: p.primary, category: sc }))
      vs.push(V('multiRowCard', 'Key metrics', rect(804, 454, 452, 282), { type: 'multi', measures: p.cards.slice(0, 5) }))
      return vs
    },
  },
]

export const DEFAULT_LAYOUT = 'executive'

export interface GeneratedDashboard {
  page: Page
  measures: GeneratedMeasure[]
}

export function generateLayout(model: SemanticModel, layoutId: string, pageName = 'Executive Overview'): GeneratedDashboard {
  const measures = generateMeasures(model)
  const picks = pickModel(model)
  const recipe = LAYOUTS.find((l) => l.id === layoutId) ?? LAYOUTS[0]
  const visuals = picks ? recipe.build(picks) : []
  return { page: { id: 'page_1', name: pageName, visuals, width: PAGE_W, height: PAGE_H }, measures }
}

export function generateDashboard(model: SemanticModel, pageName = 'Executive Overview'): GeneratedDashboard {
  return generateLayout(model, DEFAULT_LAYOUT, pageName)
}

// ---------------------------------------------------------------------------
// Single-visual builder for the designer's "Add visual" menu
// ---------------------------------------------------------------------------
export type InsertKind =
  | 'card' | 'multiRowCard' | 'line' | 'area' | 'bar' | 'column' | 'donut'
  | 'pie' | 'funnel' | 'gauge' | 'treemap' | 'waterfall' | 'scatter'
  | 'table' | 'matrix' | 'slicer'

export function buildVisual(model: SemanticModel, kind: InsertKind): Visual | null {
  const p = pickModel(model)
  if (!p) return null
  const c0 = catAt(p, 0)
  const sc = smallCat(p)
  const t = timeOrCat(p)
  const r = rect(80, 80, 520, 320)

  switch (kind) {
    case 'card': return V('card', p.primary.name, rect(40, 40, 296, 116), { type: 'card', measure: p.primary })
    case 'multiRowCard': return V('multiRowCard', 'Key metrics', rect(40, 40, 320, 300), { type: 'multi', measures: p.cards })
    case 'slicer': return c0 ? V('slicer', c0.name, rect(40, 40, 240, 300), { type: 'slicer', category: c0 }) : null
    case 'gauge': return V('gauge', (p.ratio ?? p.primary).name, r, { type: 'card', measure: p.ratio ?? p.primary })
    case 'scatter': return c0 ? V('scatter', `${p.primary.name} vs ${p.secondary.name}`, r, { type: 'scatter', category: c0, x: p.primary, y: p.secondary, topN: 20 }) : null
    case 'matrix': return c0 ? V('matrix', `${c0.name} detail`, r, { type: 'matrix', category: c0, measures: p.cards.slice(0, 4), topN: 12 }) : null
    case 'table': return c0 ? V('table', `Top ${c0.name}`, r, { type: 'rank', measure: p.primary, category: c0, topN: 12 }) : null
    case 'donut':
    case 'pie': return sc ? V(kind, `${p.primary.name} by ${sc.name}`, r, { type: 'series', measure: p.primary, category: sc }) : null
    case 'line':
    case 'area': return t ? V(kind, `${p.primary.name} trend`, r, { type: 'series', measure: p.primary, category: t }) : null
    default: {
      const cat = c0 ?? t
      return cat ? V(kind, `${p.primary.name} by ${cat.name}`, r, { type: 'series', measure: p.primary, category: cat, topN: 10 }) : null
    }
  }
}
