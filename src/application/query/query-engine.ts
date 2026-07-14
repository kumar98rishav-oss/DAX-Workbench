/**
 * APPLICATION — Query / Aggregation engine (pure)
 * Evaluates measures grouped by a category, resolving one-hop relationships
 * (fact → dimension) and time buckets. This is what backs every rendered
 * visual. In-memory today; the same interface can move to DuckDB-WASM later.
 */
import type { SemanticModel } from '@/domain/model'
import type { DatasetData } from '@/application/import/types'

export type Agg = 'sum' | 'avg' | 'count' | 'distinctCount' | 'min' | 'max'
export type Bucket = 'month' | 'quarter' | 'year'

export interface MeasureRef {
  tableId: string
  columnId: string
  agg: Agg
}

export interface CategoryRef {
  tableId: string
  columnId: string
  bucket?: Bucket
}

export interface Point {
  label: string
  value: number
}

export interface QueryCtx {
  model: SemanticModel
  byId: Record<string, DatasetData>
}

export function makeCtx(model: SemanticModel, datasets: DatasetData[]): QueryCtx {
  const byId: Record<string, DatasetData> = {}
  for (const d of datasets) byId[d.id] = d
  return { model, byId }
}

function colIndex(ctx: QueryCtx, tableId: string, columnId: string): number {
  const t = ctx.model.tables.find((x) => x.id === tableId)
  if (!t) return -1
  return t.columns.findIndex((c) => c.id === columnId)
}

const key = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

function bucketKey(v: unknown, bucket?: Bucket): string {
  if (v === null || v === undefined) return '—'
  const s = String(v)
  if (!bucket) return s
  const y = s.slice(0, 4)
  if (bucket === 'year') return y
  if (bucket === 'month') return s.slice(0, 7)
  // quarter
  const m = Number(s.slice(5, 7))
  const q = Number.isFinite(m) ? Math.floor((m - 1) / 3) + 1 : 0
  return `${y}-Q${q}`
}

function aggregate(values: number[], agg: Agg): number {
  if (agg === 'count') return values.length
  if (values.length === 0) return 0
  switch (agg) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0)
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
    case 'distinctCount':
      return new Set(values).size
    default:
      return 0
  }
}

/** Build a fact-row → group-label function, resolving a dimension join if needed. */
function categoryResolver(
  ctx: QueryCtx,
  factId: string,
  category: CategoryRef | undefined,
): ((row: unknown[]) => string) | null {
  if (!category) return () => 'Total'

  if (category.tableId === factId) {
    const cIdx = colIndex(ctx, factId, category.columnId)
    if (cIdx < 0) return null
    return (row) => bucketKey(row[cIdx], category.bucket)
  }

  // Dimension attribute — resolve via an active fact→dim relationship.
  const rel = ctx.model.relationships.find(
    (r) => r.fromTable === factId && r.toTable === category.tableId && r.isActive,
  )
  if (!rel) return null
  const fkIdx = colIndex(ctx, factId, rel.fromColumn)
  const dim = ctx.byId[category.tableId]
  const pkIdx = colIndex(ctx, category.tableId, rel.toColumn)
  const catIdx = colIndex(ctx, category.tableId, category.columnId)
  if (fkIdx < 0 || pkIdx < 0 || catIdx < 0 || !dim) return null

  const lut = new Map<string, string>()
  for (const drow of dim.rows) lut.set(key(drow[pkIdx]), bucketKey(drow[catIdx], category.bucket))
  return (row) => lut.get(key(row[fkIdx])) ?? '—'
}

export interface GroupOpts {
  topN?: number
  sort?: 'valueDesc' | 'labelAsc'
}

/** Group a measure by an optional category. */
export function groupBy(
  ctx: QueryCtx,
  measure: MeasureRef,
  category?: CategoryRef,
  opts: GroupOpts = {},
): Point[] {
  const fact = ctx.byId[measure.tableId]
  if (!fact) return []
  const mIdx = colIndex(ctx, measure.tableId, measure.columnId)
  // 'count' can work without a numeric column.
  if (mIdx < 0 && measure.agg !== 'count') return []

  const resolve = categoryResolver(ctx, measure.tableId, category)
  if (!resolve) return []

  const groups = new Map<string, number[]>()
  for (const row of fact.rows) {
    const label = resolve(row)
    let arr = groups.get(label)
    if (!arr) {
      arr = []
      groups.set(label, arr)
    }
    if (measure.agg === 'count') {
      arr.push(1)
    } else {
      const v = Number(row[mIdx])
      if (!Number.isNaN(v)) arr.push(v)
    }
  }

  let out: Point[] = [...groups.entries()].map(([label, vals]) => ({
    label,
    value: aggregate(vals, measure.agg),
  }))

  const sort = opts.sort ?? (category?.bucket ? 'labelAsc' : 'valueDesc')
  out.sort((a, b) => (sort === 'labelAsc' ? a.label.localeCompare(b.label) : b.value - a.value))
  if (opts.topN && out.length > opts.topN) out = out.slice(0, opts.topN)
  return out
}

/** A single scalar value (KPI cards). */
export function scalar(ctx: QueryCtx, measure: MeasureRef): number {
  const pts = groupBy(ctx, measure)
  return pts[0]?.value ?? 0
}
