/**
 * APPLICATION — Visual recommendation + Auto-dashboard generator (pure)
 * Turns the model + measures into a laid-out report page: KPI cards, a time
 * series, category bars, a donut, and a ranked table — chosen from column
 * types, cardinality, roles, and time-intelligence.
 */
import type { Column, SemanticModel, Table } from '@/domain/model'
import type { Page, Rect, Visual, VisualKind } from '@/domain/report'
import type { Agg, Bucket, CategoryRef, MeasureRef } from '@/application/query/query-engine'
import { generateMeasures } from './kpi-engine'
import type { GeneratedMeasure, MeasureKind } from './kpi-engine'

// ---- Specs stored on visual.style.spec, consumed by the renderer/resolver ----
export interface MeasureSpec extends MeasureRef {
  name: string
  kind: MeasureKind
  format: string
}
export interface CategorySpec extends CategoryRef {
  name: string
}
export interface CardSpec {
  type: 'card'
  measure: MeasureSpec
}
export interface SeriesSpec {
  type: 'series'
  measure: MeasureSpec
  category: CategorySpec
  topN?: number
}
export interface RankSpec {
  type: 'rank'
  measure: MeasureSpec
  category: CategorySpec
  topN: number
}
export interface SlicerSpec {
  type: 'slicer'
  category: CategorySpec
}
export type VisualSpec = CardSpec | SeriesSpec | RankSpec | SlicerSpec

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

const kindPriority: Record<MeasureKind, number> = {
  currency: 0,
  quantity: 1,
  ratio: 2,
  count: 3,
  generic: 4,
}

/** Best low-cardinality string column of a table to group by (excludes keys). */
function groupByColumn(table: Table, excludeIds: Set<string>): Column | null {
  const candidates = table.columns.filter(
    (c) =>
      c.dataType === 'string' &&
      c.role !== 'key' &&
      !excludeIds.has(c.id) &&
      (c.distinctCount ?? 2) > 1,
  )
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (a.distinctCount ?? 99) - (b.distinctCount ?? 99))
  return candidates[0]
}

function factDateColumn(table: Table): Column | null {
  return table.columns.find((c) => c.dataType === 'date' || c.dataType === 'dateTime') ?? null
}

interface CategoryCandidate {
  spec: CategorySpec
  cardinality: number
}

export interface GeneratedDashboard {
  page: Page
  measures: GeneratedMeasure[]
}

/** Generate a dashboard page from the model. */
export function generateDashboard(model: SemanticModel, pageName = 'Executive Overview'): GeneratedDashboard {
  const measures = generateMeasures(model)
  const fkColumns = new Set(model.relationships.map((r) => r.fromColumn))

  const facts = model.tables.filter((t) => t.role === 'fact')
  const fact = facts[0] ?? model.tables.find((t) => t.columns.some((c) => c.role === 'measureCandidate')) ?? model.tables[0]

  const visuals: Visual[] = []
  if (!fact) {
    return { page: { id: 'page_1', name: pageName, visuals, width: PAGE_W, height: PAGE_H }, measures }
  }

  // ---- pick measures ----
  const sorted = [...measures]
    .filter((m) => m.tableId === fact.id)
    .sort((a, b) => kindPriority[a.kind] - kindPriority[b.kind] || b.confidence - a.confidence)
  const primary = sorted[0]
  const cardMeasures = dedupe(sorted).slice(0, 4)

  // ---- gather category candidates (fact's own + related dimensions') ----
  const categories: CategoryCandidate[] = []
  const excludeFromGroup = new Set<string>([...fkColumns])

  // fact's own low-card dimensions (e.g., Order_Status)
  for (const c of fact.columns) {
    if (c.dataType !== 'string' || c.role === 'key' || fkColumns.has(c.id)) continue
    const card = c.distinctCount ?? 8
    if (card > 1 && card <= 30) {
      categories.push({ spec: { tableId: fact.id, columnId: c.id, name: c.name }, cardinality: card })
    }
  }
  // related dimensions
  for (const rel of model.relationships.filter((r) => r.fromTable === fact.id && r.isActive)) {
    const dim = model.tables.find((t) => t.id === rel.toTable)
    if (!dim || dim.role === 'date') continue
    const col = groupByColumn(dim, excludeFromGroup)
    if (col) {
      categories.push({
        spec: { tableId: dim.id, columnId: col.id, name: col.name },
        cardinality: col.distinctCount ?? 8,
      })
    }
  }
  categories.sort((a, b) => a.cardinality - b.cardinality)

  const dateCol = factDateColumn(fact)
  const dateCategory: CategorySpec | null = dateCol
    ? { tableId: fact.id, columnId: dateCol.id, name: dateCol.name, bucket: 'month' as Bucket }
    : null

  // ---- KPI cards ----
  let x = 24
  const cardW = (PAGE_W - 48 - 3 * 16) / 4
  for (const m of cardMeasures) {
    visuals.push(makeVisual('card', 'kpi', m.name, rect(x, 24, cardW, 116), { type: 'card', measure: measureSpec(m) }))
    x += cardW + 16
  }

  // ---- charts ----
  if (primary) {
    const pm = measureSpec(primary)

    // Slots: [wide row2, right row2, row3-1, row3-2, row3-3]
    const slots: Rect[] = [
      rect(24, 156, 764, 286),
      rect(804, 156, 452, 286),
      rect(24, 458, 400, 278),
      rect(440, 458, 400, 278),
      rect(856, 458, 400, 278),
    ]
    let s = 0

    // 1) time series
    if (dateCategory && s < slots.length) {
      visuals.push(
        makeVisual('line', 'line', `${pm.name} over time`, slots[s++], {
          type: 'series',
          measure: pm,
          category: dateCategory,
        }),
      )
    }

    // 2) donut for the lowest-cardinality category
    const donutCat = categories.find((c) => c.cardinality <= 6)
    if (donutCat && s < slots.length) {
      visuals.push(
        makeVisual('donut', 'donut', `${pm.name} by ${donutCat.spec.name}`, slots[s++], {
          type: 'series',
          measure: pm,
          category: donutCat.spec,
        }),
      )
    }

    // 3-4) bar charts by next categories
    for (const cat of categories) {
      if (donutCat && cat.spec.columnId === donutCat.spec.columnId) continue
      if (s >= slots.length - 1) break
      visuals.push(
        makeVisual('bar', 'bar', `${pm.name} by ${cat.spec.name}`, slots[s++], {
          type: 'series',
          measure: pm,
          category: cat.spec,
          topN: 10,
        }),
      )
    }

    // 5) ranked table using best category
    const rankCat = categories[0]
    if (rankCat && s < slots.length) {
      visuals.push(
        makeVisual('table', 'table', `Top ${rankCat.spec.name}`, slots[s++], {
          type: 'rank',
          measure: pm,
          category: rankCat.spec,
          topN: 12,
        }),
      )
    }
  }

  return {
    page: { id: 'page_1', name: pageName, visuals, width: PAGE_W, height: PAGE_H },
    measures,
  }
}

function dedupe(ms: GeneratedMeasure[]): GeneratedMeasure[] {
  const seen = new Set<string>()
  const out: GeneratedMeasure[] = []
  for (const m of ms) {
    if (seen.has(m.name)) continue
    seen.add(m.name)
    out.push(m)
  }
  return out
}

function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h }
}

let vseq = 0
function makeVisual(
  kind: VisualKind,
  _tag: string,
  title: string,
  r: Rect,
  spec: VisualSpec,
): Visual {
  return {
    id: `v_${++vseq}`,
    kind,
    title,
    rect: r,
    bindings: [],
    style: { spec },
    isAutoGenerated: true,
  }
}

export type InsertKind = 'card' | 'line' | 'bar' | 'donut' | 'table' | 'slicer'

/** Build a single visual of a given kind from the model (for the designer). */
export function buildVisual(model: SemanticModel, kind: InsertKind): Visual | null {
  const measures = generateMeasures(model)
  const fact =
    model.tables.find((t) => t.role === 'fact') ??
    model.tables.find((t) => t.columns.some((c) => c.role === 'measureCandidate')) ??
    model.tables[0]
  if (!fact) return null
  const fkColumns = new Set(model.relationships.map((r) => r.fromColumn))

  const factMeasures = measures.filter((m) => m.tableId === fact.id)
  const primary = factMeasures[0]
  const pm = primary ? measureSpec(primary) : null

  // pick a category (dimension or fact's own low-card string)
  let category: CategorySpec | null = null
  for (const rel of model.relationships.filter((r) => r.fromTable === fact.id && r.isActive)) {
    const dim = model.tables.find((t) => t.id === rel.toTable)
    if (!dim || dim.role === 'date') continue
    const col = groupByColumn(dim, fkColumns)
    if (col) {
      category = { tableId: dim.id, columnId: col.id, name: col.name }
      break
    }
  }
  if (!category) {
    const own = fact.columns.find(
      (c) => c.dataType === 'string' && c.role !== 'key' && !fkColumns.has(c.id) && (c.distinctCount ?? 2) > 1,
    )
    if (own) category = { tableId: fact.id, columnId: own.id, name: own.name }
  }
  const dateCol = factDateColumn(fact)
  const dateCategory: CategorySpec | null = dateCol
    ? { tableId: fact.id, columnId: dateCol.id, name: dateCol.name, bucket: 'month' }
    : null

  if (kind === 'card') {
    if (!pm) return null
    return makeVisual('card', 'kpi', pm.name, rect(40, 40, 296, 116), { type: 'card', measure: pm })
  }
  if (kind === 'slicer') {
    if (!category) return null
    return makeVisual('slicer', 'slicer', category.name, rect(40, 40, 240, 300), { type: 'slicer', category })
  }
  if (!pm) return null
  const cat = kind === 'line' ? dateCategory ?? category : category
  if (!cat) return null
  const r = rect(80, 80, 560, 340)
  if (kind === 'table')
    return makeVisual('table', 'table', `Top ${cat.name}`, r, { type: 'rank', measure: pm, category: cat, topN: 12 })
  if (kind === 'donut')
    return makeVisual('donut', 'donut', `${pm.name} by ${cat.name}`, r, { type: 'series', measure: pm, category: cat })
  if (kind === 'line')
    return makeVisual('line', 'line', `${pm.name} over time`, r, { type: 'series', measure: pm, category: cat })
  return makeVisual('bar', 'bar', `${pm.name} by ${cat.name}`, r, { type: 'series', measure: pm, category: cat, topN: 10 })
}
