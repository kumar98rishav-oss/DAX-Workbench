/**
 * APPLICATION — Local AI Business Analyst (heuristic, offline)
 * Answers business questions by computing real facts over the model + data:
 * trends, top/bottom contributors, declines, coverage gaps, missing visuals.
 * Grounded — every number it states is computed, not invented.
 */
import type { SemanticModel, Table } from '@/domain/model'
import type { DatasetData } from '@/application/import/types'
import { makeCtx, groupBy, scalar } from '@/application/query/query-engine'
import type { CategoryRef, MeasureRef, Point } from '@/application/query/query-engine'
import { generateMeasures } from './kpi-engine'
import type { GeneratedMeasure } from './kpi-engine'

export interface AnalystTurn {
  text: string
  chips: string[]
}

function fmt(v: number, kind: string): string {
  if (kind === 'ratio') return `${(v * 100).toFixed(1)}%`
  const a = Math.abs(v)
  const short = a >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${Math.round(v)}`
  return kind === 'currency' ? `$${short}` : short
}

function factTable(model: SemanticModel): Table | undefined {
  return (
    model.tables.find((t) => t.role === 'fact') ??
    model.tables.find((t) => t.columns.some((c) => c.role === 'measureCandidate')) ??
    model.tables[0]
  )
}

function primaryMeasure(model: SemanticModel): GeneratedMeasure | undefined {
  const fact = factTable(model)
  const ms = generateMeasures(model).filter((m) => !fact || m.tableId === fact.id)
  return ms.find((m) => m.kind === 'currency') ?? ms.find((m) => m.kind === 'quantity') ?? ms[0]
}

function bestCategory(model: SemanticModel): CategoryRef & { name: string } | null {
  const fact = factTable(model)
  if (!fact) return null
  const fks = new Set(model.relationships.map((r) => r.fromColumn))
  // dimension attribute
  for (const rel of model.relationships.filter((r) => r.fromTable === fact.id && r.isActive)) {
    const dim = model.tables.find((t) => t.id === rel.toTable)
    if (!dim || dim.role === 'date') continue
    const col = dim.columns
      .filter((c) => c.dataType === 'string' && c.role !== 'key' && (c.distinctCount ?? 2) > 1)
      .sort((a, b) => (a.distinctCount ?? 99) - (b.distinctCount ?? 99))[0]
    if (col) return { tableId: dim.id, columnId: col.id, name: col.name }
  }
  const own = fact.columns.find((c) => c.dataType === 'string' && c.role !== 'key' && !fks.has(c.id) && (c.distinctCount ?? 2) > 1)
  return own ? { tableId: fact.id, columnId: own.id, name: own.name } : null
}

function dateCategory(model: SemanticModel): (CategoryRef & { name: string }) | null {
  const fact = factTable(model)
  if (!fact) return null
  const c = fact.columns.find((x) => x.dataType === 'date' || x.dataType === 'dateTime')
  return c ? { tableId: fact.id, columnId: c.id, name: c.name, bucket: 'month' } : null
}

interface Facts {
  hasData: boolean
  measure?: GeneratedMeasure
  mref?: MeasureRef
  total: number
  series: Point[]
  cat?: CategoryRef & { name: string }
  catPoints: Point[]
  ctx: ReturnType<typeof makeCtx>
}

function computeFacts(model: SemanticModel, datasets: DatasetData[]): Facts {
  const ctx = makeCtx(model, datasets)
  const measure = primaryMeasure(model)
  if (!measure || datasets.length === 0) {
    return { hasData: false, total: 0, series: [], catPoints: [], ctx }
  }
  const mref: MeasureRef = { tableId: measure.tableId, columnId: measure.columnId, agg: measure.agg }
  const total = scalar(ctx, mref)
  const date = dateCategory(model)
  const series = date ? groupBy(ctx, mref, date, { sort: 'labelAsc' }) : []
  const cat = bestCategory(model)
  const catPoints = cat ? groupBy(ctx, mref, cat, { topN: 8 }) : []
  return { hasData: true, measure, mref, total, series, cat: cat ?? undefined, catPoints, ctx }
}

/** Largest consecutive month-over-month drop in a series. */
function biggestDrop(series: Point[]): { from: Point; to: Point; pct: number } | null {
  let worst: { from: Point; to: Point; pct: number } | null = null
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]
    const cur = series[i]
    if (prev.value <= 0) continue
    const pct = (cur.value - prev.value) / prev.value
    if (pct < 0 && (!worst || pct < worst.pct)) worst = { from: prev, to: cur, pct }
  }
  return worst
}

// ---------------------------------------------------------------------------
// Intent handlers
// ---------------------------------------------------------------------------

function generalInsights(f: Facts): AnalystTurn {
  const name = f.measure!.name
  const lines: string[] = [`Here's what stands out in your data:`]
  lines.push(`• **${name}** totals **${fmt(f.total, f.measure!.kind)}** across the model.`)
  if (f.series.length >= 2) {
    const first = f.series[0]
    const last = f.series[f.series.length - 1]
    const chg = first.value ? (last.value - first.value) / first.value : 0
    const dir = chg >= 0 ? 'up' : 'down'
    lines.push(`• The trend is **${dir} ${Math.abs(chg * 100).toFixed(0)}%** from ${first.label} to ${last.label}.`)
  }
  if (f.catPoints.length > 0 && f.cat) {
    const top = f.catPoints[0]
    const share = f.total ? (top.value / f.total) * 100 : 0
    lines.push(`• **${top.label}** leads by ${f.cat.name} at **${fmt(top.value, f.measure!.kind)}** (${share.toFixed(0)}% of total).`)
  }
  return { text: lines.join('\n'), chips: ['Why is it changing?', 'What visuals am I missing?', 'Top performers'] }
}

function declineAnalysis(f: Facts): AnalystTurn {
  if (f.series.length < 2) {
    return { text: `I don't have a time series to analyze a decline. Import data with a date column and I can trace trends over time.`, chips: ['Show me insights', 'Top performers'] }
  }
  const drop = biggestDrop(f.series)
  const first = f.series[0]
  const last = f.series[f.series.length - 1]
  const overall = first.value ? (last.value - first.value) / first.value : 0
  const lines: string[] = []
  if (drop) {
    lines.push(`The steepest drop in **${f.measure!.name}** was **${(drop.pct * 100).toFixed(0)}%** from ${drop.from.label} (${fmt(drop.from.value, f.measure!.kind)}) to ${drop.to.label} (${fmt(drop.to.value, f.measure!.kind)}).`)
  }
  lines.push(overall >= 0
    ? `Overall the metric is still **up ${(overall * 100).toFixed(0)}%** across the full range, so the dip looks like volatility rather than a sustained decline.`
    : `Overall the metric is **down ${Math.abs(overall * 100).toFixed(0)}%** across the range — worth investigating.`)
  if (f.catPoints.length > 1 && f.cat) {
    const bottom = f.catPoints[f.catPoints.length - 1]
    lines.push(`By ${f.cat.name}, **${bottom.label}** is the weakest contributor (${fmt(bottom.value, f.measure!.kind)}) — a likely place to dig in.`)
  }
  return { text: lines.join('\n\n'), chips: ['What visuals am I missing?', 'Top performers', 'Show me insights'] }
}

function topPerformers(f: Facts, bottom = false): AnalystTurn {
  if (f.catPoints.length === 0 || !f.cat) {
    return { text: `I couldn't find a category to rank. Try importing a dimension table.`, chips: ['Show me insights'] }
  }
  const pts = bottom ? [...f.catPoints].reverse() : f.catPoints
  const lines = [`${bottom ? 'Weakest' : 'Top'} by **${f.cat.name}**:`]
  pts.slice(0, 5).forEach((p, i) => lines.push(`${i + 1}. **${p.label}** — ${fmt(p.value, f.measure!.kind)}`))
  return { text: lines.join('\n'), chips: bottom ? ['Top performers', 'Show me insights'] : ['Weakest performers', 'Why is it changing?'] }
}

function visualSuggestions(f: Facts, model: SemanticModel): AnalystTurn {
  const dims = model.relationships.filter((r) => r.isActive).map((r) => model.tables.find((t) => t.id === r.toTable)?.name).filter(Boolean)
  const lines = [`A few visuals would round out this report:`]
  if (dateCategory(model)) lines.push(`• A **line chart** of ${f.measure?.name ?? 'your key measure'} over time to expose seasonality.`)
  if (f.cat) lines.push(`• A **bar chart** by ${f.cat.name} to compare contributors.`)
  if (dims.length > 1) lines.push(`• A **matrix** crossing ${dims.slice(0, 2).join(' × ')} for a two-dimensional view.`)
  lines.push(`• **KPI cards** for your headline measures, plus a **slicer** for interactive filtering.`)
  lines.push(`\nWant me to build them? Use **Generate dashboard** and the Workbench lays them out automatically.`)
  return { text: lines.join('\n'), chips: ['Generate dashboard', 'Show me insights'] }
}

function kpiCoverage(model: SemanticModel): AnalystTurn {
  const measures = generateMeasures(model)
  const lines = [`Your model has **${measures.length}** measures detected:`]
  measures.slice(0, 8).forEach((m) => lines.push(`• **${m.name}** — ${m.kind}`))
  const missing: string[] = []
  if (!measures.some((m) => /margin|ratio/.test(m.name.toLowerCase()))) missing.push('a **margin %** ratio')
  if (!measures.some((m) => m.kind === 'count')) missing.push('a **count** of records')
  if (missing.length) lines.push(`\nConsider adding ${missing.join(' and ')} — the DAX Architect can generate them from a plain-language prompt.`)
  return { text: lines.join('\n'), chips: ['What visuals am I missing?', 'Show me insights'] }
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export function askLocalAnalyst(question: string, model: SemanticModel, datasets: DatasetData[]): AnalystTurn {
  const f = computeFacts(model, datasets)
  if (!f.hasData) {
    return {
      text: `Import a dataset and I'll analyze it for you — trends, top contributors, anomalies, and what visuals to build.`,
      chips: ['Import data'],
    }
  }
  const q = question.toLowerCase()
  if (/(why|drop|declin|down|fall|decreas|wrong|worried)/.test(q)) return declineAnalysis(f)
  if (/(missing|what.*visual|recommend|suggest|what.*build|chart)/.test(q)) return visualSuggestions(f, model)
  if (/(kpi|measure|metric|coverage)/.test(q)) return kpiCoverage(model)
  if (/(worst|bottom|lowest|weak)/.test(q)) return topPerformers(f, true)
  if (/(best|top|highest|winner|lead)/.test(q)) return topPerformers(f, false)
  return generalInsights(f)
}

export const STARTER_PROMPTS = [
  'What insights exist in my data?',
  'Why are sales dropping?',
  'What visuals am I missing?',
  'What KPIs should I add?',
]
