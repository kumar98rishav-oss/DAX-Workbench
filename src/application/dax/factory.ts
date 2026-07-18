/**
 * APPLICATION — Measure Factory
 * Builds a whole analytical suite for one field in a single pass: each entry is
 * produced by the Intent Engine (so it's the same deterministic, branched DAX),
 * de-duplicated, and ready to verify + deploy together.
 */
import type { SemanticModel } from '@/domain/model'
import type { DatasetData } from '@/application/import/types'
import { suggest } from './intent/suggest'

export interface SuiteStep {
  name: string
  dax: string
  reason: string
}

export interface SuiteMeasure {
  kindId: string
  label: string
  name: string
  dax: string
  plan: SuiteStep[]
  formatString: string
  preview: { ok: boolean; value?: number; note?: string }
  /** True once the value came from the real engine, not the sample. */
  live?: boolean
  selected: boolean
}

export interface SuiteKind {
  id: string
  label: string
  group: 'Core' | 'Time intelligence' | 'Share & rank'
  needsDate: boolean
  prompt: (field: string) => string
}

/** The catalogue the factory can build for any numeric field. */
export const SUITE_KINDS: SuiteKind[] = [
  { id: 'total', label: 'Total', group: 'Core', needsDate: false, prompt: (f) => `total ${f}` },
  { id: 'average', label: 'Average', group: 'Core', needsDate: false, prompt: (f) => `average ${f}` },
  { id: 'ytd', label: 'Year-to-date', group: 'Time intelligence', needsDate: true, prompt: (f) => `${f} ytd` },
  { id: 'qtd', label: 'Quarter-to-date', group: 'Time intelligence', needsDate: true, prompt: (f) => `${f} qtd` },
  { id: 'mtd', label: 'Month-to-date', group: 'Time intelligence', needsDate: true, prompt: (f) => `${f} mtd` },
  { id: 'prior-year', label: 'Prior year', group: 'Time intelligence', needsDate: true, prompt: (f) => `${f} prior year` },
  { id: 'yoy-pct', label: 'Year-over-year %', group: 'Time intelligence', needsDate: true, prompt: (f) => `${f} year over year growth %` },
  { id: 'mom-pct', label: 'Month-over-month %', group: 'Time intelligence', needsDate: true, prompt: (f) => `${f} month over month growth %` },
  { id: 'moving-avg', label: '3-month moving average', group: 'Time intelligence', needsDate: true, prompt: (f) => `${f} 3 month moving average` },
  { id: 'running', label: 'Running total', group: 'Time intelligence', needsDate: true, prompt: (f) => `${f} running total` },
  { id: 'pct-total', label: '% of total', group: 'Share & rank', needsDate: false, prompt: (f) => `${f} % of total` },
  { id: 'rank', label: 'Rank', group: 'Share & rank', needsDate: false, prompt: (f) => `rank by ${f}` },
]

export const modelHasDate = (model: SemanticModel): boolean =>
  model.tables.some((t) => t.role === 'date' || t.columns.some((c) => c.dataType === 'date' || c.dataType === 'dateTime'))

/** Numeric fields the factory can build a suite for. */
export function suiteFields(model: SemanticModel): string[] {
  const out: string[] = []
  for (const t of model.tables) {
    for (const c of t.columns) {
      if (!/integer|decimal/.test(c.dataType) || c.role === 'key') continue
      if (/(^id$|_id$|id$|key$|code$|year|month|quarter|day|week)/i.test(c.name)) continue
      if (!out.includes(c.name)) out.push(c.name)
    }
  }
  return out
}

/** Build the selected suite for a field. Each entry carries its branched plan. */
export function buildSuite(
  field: string,
  model: SemanticModel,
  datasets: DatasetData[],
  kindIds: string[],
): SuiteMeasure[] {
  // Pin the aggregated column so every entry is about THIS field — without this
  // the engine can drift to another numeric column on time-intelligence kinds.
  const home = model.tables.find((t) => t.columns.some((c) => c.name === field))
  const valueOverride = home ? { table: home.name, column: field } : undefined

  const out: SuiteMeasure[] = []
  const seen = new Set<string>()
  for (const kind of SUITE_KINDS) {
    if (!kindIds.includes(kind.id)) continue
    let picked
    try {
      const { suggestions } = suggest(kind.prompt(field), model, datasets, 4, valueOverride)
      picked = suggestions.find((s) => s.patternId === kind.id) ?? suggestions[0]
    } catch {
      continue
    }
    if (!picked) continue
    // Guard: the entry must actually reference the requested field.
    const touchesField = picked.plan.some((st) => st.dax.includes(`[${field}]`)) || picked.dax.includes(`[${field}]`)
    if (!touchesField) continue

    // Some patterns name the measure generically ("3-Month Moving Avg"). Two suites
    // over different fields would then collide and overwrite each other on deploy,
    // so qualify the final step with the field. Nothing references it downstream.
    let { measureName, plan } = picked
    if (!measureName.toLowerCase().includes(field.toLowerCase())) {
      measureName = `${field} ${measureName}`
      plan = [...plan.slice(0, -1), { ...plan[plan.length - 1], name: measureName }]
    }

    const key = measureName.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      kindId: kind.id,
      label: kind.label,
      name: measureName,
      dax: picked.dax,
      plan,
      formatString: picked.formatString,
      preview: picked.preview,
      selected: true,
    })
  }
  return out
}

/** Every unique measure (base + branches) the selected suite needs, in order. */
export function suitePlan(suite: SuiteMeasure[]): SuiteStep[] {
  const steps: SuiteStep[] = []
  const seen = new Set<string>()
  for (const m of suite.filter((x) => x.selected)) {
    for (const st of m.plan) {
      const k = st.name.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      steps.push(st)
    }
  }
  return steps
}
