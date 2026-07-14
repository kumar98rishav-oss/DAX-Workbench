/**
 * PRESENTATION — resolve a Visual's spec into render-ready data.
 */
import type { Visual } from '@/domain/report'
import type { MeasureKind } from '@/application/insights/kpi-engine'
import type { VisualSpec } from '@/application/insights/dashboard-generator'
import { groupBy, scalar } from '@/application/query/query-engine'
import type { Point, QueryCtx } from '@/application/query/query-engine'

export interface MultiItem { name: string; value: number; kind: MeasureKind }
export interface MatrixCol { name: string; kind: MeasureKind }
export interface MatrixRow { label: string; values: number[] }
export interface XYPoint { label: string; x: number; y: number }
export interface ComboPoint { label: string; bar: number; line: number }

export type VisualData =
  | { type: 'card'; value: number; kind: MeasureKind }
  | { type: 'multi'; items: MultiItem[] }
  | { type: 'series'; points: Point[]; kind: MeasureKind; catName: string }
  | { type: 'rank'; points: Point[]; kind: MeasureKind; catName: string; total: number }
  | { type: 'matrix'; catName: string; columns: MatrixCol[]; rows: MatrixRow[] }
  | { type: 'scatter'; points: XYPoint[]; xName: string; yName: string; xKind: MeasureKind; yKind: MeasureKind }
  | { type: 'combo'; points: ComboPoint[]; barName: string; lineName: string; barKind: MeasureKind; lineKind: MeasureKind }
  | { type: 'slicer'; items: string[]; name: string }
  | { type: 'text'; title: string; subtitle?: string }
  | { type: 'empty'; reason: string }

function getSpec(visual: Visual): VisualSpec | null {
  return (visual.style as { spec?: VisualSpec } | undefined)?.spec ?? null
}

export function resolveVisual(visual: Visual, ctx: QueryCtx): VisualData {
  const spec = getSpec(visual)
  if (!spec) return { type: 'empty', reason: 'No binding' }

  switch (spec.type) {
    case 'text':
      return { type: 'text', title: spec.title, subtitle: spec.subtitle }

    case 'card':
      return { type: 'card', value: scalar(ctx, spec.measure), kind: spec.measure.kind }

    case 'multi':
      return {
        type: 'multi',
        items: spec.measures.map((m) => ({ name: m.name, value: scalar(ctx, m), kind: m.kind })),
      }

    case 'series': {
      const points = groupBy(ctx, spec.measure, spec.category, { topN: spec.topN })
      if (points.length === 0) return { type: 'empty', reason: 'No data' }
      return { type: 'series', points, kind: spec.measure.kind, catName: spec.category.name }
    }

    case 'rank': {
      const points = groupBy(ctx, spec.measure, spec.category, { topN: spec.topN })
      if (points.length === 0) return { type: 'empty', reason: 'No data' }
      return { type: 'rank', points, kind: spec.measure.kind, catName: spec.category.name, total: points.reduce((s, p) => s + p.value, 0) }
    }

    case 'matrix': {
      const base = groupBy(ctx, spec.measures[0], spec.category, { topN: spec.topN })
      if (base.length === 0) return { type: 'empty', reason: 'No data' }
      const maps = spec.measures.map((m) => new Map(groupBy(ctx, m, spec.category).map((p) => [p.label, p.value])))
      const rows: MatrixRow[] = base.map((b) => ({ label: b.label, values: maps.map((mp) => mp.get(b.label) ?? 0) }))
      return { type: 'matrix', catName: spec.category.name, columns: spec.measures.map((m) => ({ name: m.name, kind: m.kind })), rows }
    }

    case 'scatter': {
      const xs = groupBy(ctx, spec.x, spec.category, { topN: spec.topN })
      if (xs.length === 0) return { type: 'empty', reason: 'No data' }
      const ymap = new Map(groupBy(ctx, spec.y, spec.category).map((p) => [p.label, p.value]))
      return {
        type: 'scatter',
        points: xs.map((p) => ({ label: p.label, x: p.value, y: ymap.get(p.label) ?? 0 })),
        xName: spec.x.name, yName: spec.y.name, xKind: spec.x.kind, yKind: spec.y.kind,
      }
    }

    case 'combo': {
      const bars = groupBy(ctx, spec.bar, spec.category, { topN: spec.topN })
      if (bars.length === 0) return { type: 'empty', reason: 'No data' }
      const lmap = new Map(groupBy(ctx, spec.line, spec.category).map((p) => [p.label, p.value]))
      return {
        type: 'combo',
        points: bars.map((b) => ({ label: b.label, bar: b.value, line: lmap.get(b.label) ?? 0 })),
        barName: spec.bar.name, lineName: spec.line.name, barKind: spec.bar.kind, lineKind: spec.line.kind,
      }
    }

    case 'slicer': {
      const pts = groupBy(ctx, { tableId: spec.category.tableId, columnId: spec.category.columnId, agg: 'count' }, spec.category)
      return { type: 'slicer', items: pts.map((p) => p.label).slice(0, 60), name: spec.category.name }
    }
  }
}
