/**
 * PRESENTATION — resolve a Visual's spec into render-ready data using the
 * query engine.
 */
import type { Visual } from '@/domain/report'
import type { MeasureKind } from '@/application/insights/kpi-engine'
import type { VisualSpec } from '@/application/insights/dashboard-generator'
import { groupBy, scalar } from '@/application/query/query-engine'
import type { Point, QueryCtx } from '@/application/query/query-engine'

export type VisualData =
  | { type: 'card'; value: number; kind: MeasureKind }
  | { type: 'series'; points: Point[]; kind: MeasureKind; catName: string }
  | { type: 'rank'; points: Point[]; kind: MeasureKind; catName: string; total: number }
  | { type: 'slicer'; items: string[]; name: string }
  | { type: 'empty'; reason: string }

function getSpec(visual: Visual): VisualSpec | null {
  const spec = (visual.style as { spec?: VisualSpec } | undefined)?.spec
  return spec ?? null
}

export function resolveVisual(visual: Visual, ctx: QueryCtx): VisualData {
  const spec = getSpec(visual)
  if (!spec) return { type: 'empty', reason: 'No binding' }

  if (spec.type === 'card') {
    return { type: 'card', value: scalar(ctx, spec.measure), kind: spec.measure.kind }
  }

  if (spec.type === 'series') {
    const points = groupBy(ctx, spec.measure, spec.category, { topN: spec.topN })
    if (points.length === 0) return { type: 'empty', reason: 'No data' }
    return { type: 'series', points, kind: spec.measure.kind, catName: spec.category.name }
  }

  if (spec.type === 'rank') {
    const points = groupBy(ctx, spec.measure, spec.category, { topN: spec.topN })
    if (points.length === 0) return { type: 'empty', reason: 'No data' }
    const total = points.reduce((s, p) => s + p.value, 0)
    return { type: 'rank', points, kind: spec.measure.kind, catName: spec.category.name, total }
  }

  // slicer
  const points = groupBy(ctx, { tableId: spec.category.tableId, columnId: spec.category.columnId, agg: 'count' }, spec.category)
  return { type: 'slicer', items: points.map((p) => p.label).slice(0, 50), name: spec.category.name }
}
