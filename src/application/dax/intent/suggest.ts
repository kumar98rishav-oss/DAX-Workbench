/**
 * APPLICATION — DAX Intent Engine
 * Parses a natural-language request into a structured intent, ranks it against
 * a declarative pattern library (adjusted by what you've picked before), and
 * returns the top few suggestions — each a full branched solution with a live
 * preview. DAX generation itself is delegated to the deterministic architect
 * engine via a canonical phrasing, so suggestions reuse proven output.
 */
import type { SemanticModel } from '@/domain/model'
import { emptyModel } from '@/domain/model'
import type { DatasetData } from '@/application/import/types'
import { architectSolution } from '@/application/dax/architect/architect'
import { evaluateDax } from '@/application/dax/evaluator'
import { makeCtx } from '@/application/query/query-engine'
import { memoryBonus } from './memory'
import { resolveFilters } from './filters'
import type { ResolvedFilter } from './filters'

// ---- intent --------------------------------------------------------------

export interface DaxIntent {
  raw: string
  aggWord?: 'sum' | 'average' | 'count' | 'distinct' | 'min' | 'max'
  fieldName?: string // resolved numeric column (e.g. "Amount")
  fieldPhrase?: string // fallback noun if unresolved
  groupName?: string // resolved categorical column (e.g. "Category")
  filters: ResolvedFilter[] // structured, fuzzy-resolved predicates
  rollingPhrase?: string // e.g. "previous 15 days"
  topN?: number
  signals: Set<string> // yoy · ytd · mom · running · pctOfTotal · rank · topN · ratio · distinct
  tokens: string[] // descriptive tokens (for synonym learning)
}

const num = (s: string) => /integer|decimal/.test(s)

function words(s: string): string[] {
  return s.toLowerCase().replace(/_/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 1)
}

/** Best column whose name overlaps the prompt, restricted by a type test. */
function resolveColumn(prompt: string, model: SemanticModel, typeTest: (t: string) => boolean): string | undefined {
  const p = ` ${prompt.toLowerCase().replace(/_/g, ' ')} `
  let best: { name: string; score: number } | null = null
  for (const t of model.tables) {
    for (const c of t.columns) {
      if (!typeTest(c.dataType) || c.role === 'key') continue
      const cw = words(c.name)
      if (cw.length === 0) continue
      const hit = cw.filter((w) => p.includes(` ${w} `)).length
      if (hit === 0) continue
      const score = hit / cw.length + (p.includes(` ${c.name.toLowerCase().replace(/_/g, ' ')} `) ? 1 : 0)
      if (!best || score > best.score) best = { name: c.name, score }
    }
  }
  return best?.name
}

const AGG: [RegExp, DaxIntent['aggWord']][] = [
  [/\b(distinct|unique|nunique)\b/, 'distinct'],
  [/\b(average|avg|mean)\b/, 'average'],
  [/\b(count|number of|how many|tally)\b/, 'count'],
  [/\b(max|maximum|highest|peak)\b/, 'max'],
  [/\b(min|minimum|lowest)\b/, 'min'],
  [/\b(sum|total|amount of)\b/, 'sum'],
]

const SIGNALS: [RegExp, string][] = [
  [/\b(yoy|year over year|year-over-year|vs last year|versus last year|annual growth|growth vs)\b/, 'yoy'],
  [/\b(ytd|year to date|year-to-date)\b/, 'ytd'],
  [/\b(mom|month over month|month-over-month|vs last month)\b/, 'mom'],
  [/\b(qoq|quarter over quarter|quarter-over-quarter|vs last quarter)\b/, 'qoq'],
  [/\b(running|cumulative|running total|to date)\b/, 'running'],
  [/\b(% of total|percent of total|share of|proportion|contribution)\b/, 'pctOfTotal'],
  [/\b(rank|ranking|position|rank by)\b/, 'rank'],
  [/\b(top\s*\d+|top n|bottom\s*\d+)\b/, 'topN'],
  [/\b(ratio|per\b|divide|rate of)\b/, 'ratio'],
]

const FILTER_RE = /\b(where|for|with|filtered by|only|containing|in)\b/i

export function parseIntent(prompt: string, model: SemanticModel, datasets: DatasetData[]): DaxIntent {
  const raw = prompt.trim()
  const low = raw.toLowerCase()

  const aggWord = AGG.find(([re]) => re.test(low))?.[1]
  const signals = new Set<string>()
  for (const [re, s] of SIGNALS) if (re.test(low)) signals.add(s)

  const topMatch = low.match(/\btop\s*(\d+)\b/)
  const topN = topMatch ? Number(topMatch[1]) : undefined
  if (topN) signals.add('topN')

  // "previous/last/rolling N days|weeks|months" → a rolling-window request.
  const rollingMatch = low.match(/\b(?:previous|prior|last|past|trailing|rolling)\s+(\d+)\s*(day|week|month|quarter|year)s?\b/)
  const rollingPhrase = rollingMatch ? rollingMatch[0] : undefined
  if (rollingPhrase) signals.add('rolling')

  const fieldName = resolveColumn(raw, model, num)
  // group: prefer a categorical column named after "by …"
  const byPart = low.split(/\bby\b/)[1]
  const groupName =
    (byPart ? resolveColumn(byPart, model, (t) => t === 'string') : undefined) ??
    resolveColumn(raw, model, (t) => t === 'string')

  // A where/for cue = explicit filter intent (allow fuzzy/typo matching).
  // Otherwise scan the prompt but require EXACT matches so calculation words
  // ("Total", "YOY growth", "previous 15 days") never fabricate a filter.
  const fm = raw.match(FILTER_RE)
  const explicit = !!fm
  const filterSource = fm ? raw.slice((fm.index ?? 0) + fm[0].length) : raw
  const filters = resolveFilters(filterSource, model, datasets, explicit)

  return {
    raw,
    aggWord,
    fieldName,
    fieldPhrase: fieldName ? undefined : nounAfterAgg(low),
    groupName,
    filters,
    rollingPhrase,
    topN,
    signals,
    tokens: words(raw),
  }
}

function nounAfterAgg(low: string): string | undefined {
  const m = low.match(/\b(?:sum|total|average|avg|count|distinct|min|max|of)\s+([a-z_]+)/)
  return m?.[1]
}

// ---- pattern library -----------------------------------------------------

interface PatternCtx {
  hasDate: boolean
  factName: string
}

interface DaxPattern {
  id: string
  label: string
  requires?: (i: DaxIntent, ctx: PatternCtx) => boolean
  score: (i: DaxIntent, ctx: PatternCtx) => number
  canonical: (i: DaxIntent, ctx: PatternCtx) => string
}

const field = (i: DaxIntent, ctx: PatternCtx) => i.fieldName ?? i.fieldPhrase ?? ctx.factName

/** Which patterns accept a filtered CALCULATE wrapper. */
const FILTERABLE = new Set(['total', 'average', 'count', 'distinct', 'yoy-pct', 'ytd', 'running'])

/** Wrap a base measure in a multi-predicate CALCULATE (we build the filter DAX
 * ourselves so all conditions land in ONE measure, correctly). */
function filteredStep(finalName: string, filters: ResolvedFilter[]): SuggestionStep {
  const args = filters.map((f) => `'${f.table}'[${f.column}] = ${f.numeric ? f.value : `"${f.value}"`}`)
  const label = filters.map((f) => f.value).join(', ')
  return {
    name: `${finalName} (${label})`,
    dax: `CALCULATE(\n    [${finalName}],\n    ${args.join(',\n    ')}\n)`,
    reason: `Evaluates [${finalName}] with fixed filter(s): ${args.join(', ')}.`,
  }
}

const PATTERNS: DaxPattern[] = [
  {
    id: 'total',
    label: 'Total',
    score: (i) => (i.signals.size === 0 && i.aggWord !== 'average' && i.aggWord !== 'distinct' ? 0.72 : 0.42),
    canonical: (i, ctx) => `total ${field(i, ctx)}`,
  },
  {
    id: 'average',
    label: 'Average',
    score: (i) => (i.aggWord === 'average' ? 0.92 : 0.28),
    canonical: (i, ctx) => `average ${field(i, ctx)}`,
  },
  {
    id: 'count',
    label: 'Count',
    score: (i) => (i.aggWord === 'count' ? 0.9 : 0.22),
    canonical: (i, ctx) => `count ${i.fieldName ? ctx.factName : field(i, ctx)}`,
  },
  {
    id: 'distinct',
    label: 'Distinct count',
    score: (i) => (i.signals.has('distinct') || i.aggWord === 'distinct' ? 0.9 : 0.12),
    canonical: (i, ctx) => `distinct ${i.groupName ?? field(i, ctx)}`,
  },
  {
    id: 'yoy-pct',
    label: 'Year-over-year %',
    requires: (_i, ctx) => ctx.hasDate,
    score: (i) => (i.signals.has('yoy') ? 0.95 : 0.16),
    canonical: (i, ctx) => `${field(i, ctx)} year over year growth %`,
  },
  {
    id: 'mom-pct',
    label: 'Month-over-month %',
    requires: (_i, ctx) => ctx.hasDate,
    score: (i) => (i.signals.has('mom') ? 0.95 : 0),
    canonical: (i, ctx) => `${field(i, ctx)} month over month growth %`,
  },
  {
    id: 'qoq-pct',
    label: 'Quarter-over-quarter %',
    requires: (_i, ctx) => ctx.hasDate,
    score: (i) => (i.signals.has('qoq') ? 0.95 : 0),
    canonical: (i, ctx) => `${field(i, ctx)} quarter over quarter growth %`,
  },
  {
    id: 'ytd',
    label: 'Year-to-date',
    requires: (_i, ctx) => ctx.hasDate,
    score: (i) => (i.signals.has('ytd') ? 0.94 : 0.16),
    canonical: (i, ctx) => `${field(i, ctx)} ytd`,
  },
  {
    id: 'running',
    label: 'Running total',
    requires: (_i, ctx) => ctx.hasDate,
    score: (i) => (i.signals.has('running') ? 0.9 : 0.12),
    canonical: (i, ctx) => `${field(i, ctx)} running total`,
  },
  {
    id: 'rolling-period',
    label: 'Rolling window',
    requires: (i, ctx) => ctx.hasDate && !!i.rollingPhrase,
    score: (i) => (i.signals.has('rolling') ? 0.93 : 0),
    canonical: (i, ctx) => `${field(i, ctx)} ${i.rollingPhrase}`,
  },
  {
    id: 'pct-total',
    label: '% of total',
    score: (i) => (i.signals.has('pctOfTotal') ? 0.9 : 0.2),
    canonical: (i, ctx) => `${field(i, ctx)} % of total${i.groupName ? ` by ${i.groupName}` : ''}`,
  },
  {
    id: 'rank',
    label: 'Rank',
    score: (i) => (i.signals.has('rank') ? 0.9 : 0.12),
    canonical: (i, ctx) => `rank ${i.groupName ?? 'category'} by ${field(i, ctx)}`,
  },
  {
    id: 'topn',
    label: 'Top N',
    score: (i) => (i.signals.has('topN') ? 0.9 : 0.1),
    canonical: (i, ctx) => `top ${i.topN ?? 5} ${i.groupName ?? 'category'} by ${field(i, ctx)}`,
  },
]

// ---- ranking + build -----------------------------------------------------

export interface SuggestionStep {
  name: string
  dax: string
  reason: string
}

export interface Suggestion {
  patternId: string
  label: string
  canonicalPrompt: string
  measureName: string
  dax: string
  plan: SuggestionStep[]
  explanation: string
  score: number
  signature: string
  tokens: string[]
  preview: { ok: boolean; value?: number; note?: string }
  formatString: string
  validationErrors: string[]
  corrections: string[] // e.g. ["“dilvered” → Delivered"]
}

/** Signature of an intent — its structural shape, used as the learning key. */
export function signatureOf(i: DaxIntent): string {
  const parts = [...i.signals].sort()
  if (i.aggWord) parts.push(`agg:${i.aggWord}`)
  if (i.groupName) parts.push('grouped')
  return parts.join('+') || 'plain'
}

function withTempMeasures(model: SemanticModel, steps: SuggestionStep[]): SemanticModel {
  const tables = model.tables.map((t) => ({ ...t, measures: [...t.measures] }))
  const home = tables.find((t) => t.role === 'fact') ?? tables[0]
  if (home) {
    steps.forEach((s, k) => {
      if (!tables.some((t) => t.measures.some((m) => m.name.toLowerCase() === s.name.toLowerCase()))) {
        home.measures.push({ id: `__prev_${k}_${s.name}`, name: s.name, expression: s.dax, isAutoGenerated: true })
      }
    })
  }
  return { ...emptyModel(model.id, model.name), tables, relationships: model.relationships }
}

/** Produce the top ranked DAX suggestions for a request. */
export function suggest(
  prompt: string,
  model: SemanticModel,
  datasets: DatasetData[],
  limit = 4,
): { intent: DaxIntent; suggestions: Suggestion[] } {
  const intent = parseIntent(prompt, model, datasets)
  const ctx: PatternCtx = {
    hasDate: model.tables.some((t) => t.role === 'date' || t.columns.some((c) => c.dataType === 'date' || c.dataType === 'dateTime')),
    factName: (model.tables.find((t) => t.role === 'fact') ?? model.tables[0])?.name ?? 'Table',
  }
  const signature = signatureOf(intent)
  const corrections = intent.filters
    .filter((f) => f.corrected && f.original)
    .map((f) => `“${f.original}” → ${f.value}`)

  const ranked = PATTERNS.filter((p) => !p.requires || p.requires(intent, ctx))
    .map((p) => ({ p, s: Math.min(1, p.score(intent, ctx) + memoryBonus(signature, p.id, intent.tokens)) }))
    .sort((a, b) => b.s - a.s)

  const out: Suggestion[] = []
  const seenDax = new Set<string>()

  for (const { p, s } of ranked) {
    if (out.length >= limit) break
    // Canonical carries only the base aggregation/time-intelligence — never the
    // filters (the engine would split on "and"). We wrap filters ourselves.
    const canonical = p.canonical(intent, ctx).replace(/\s+/g, ' ').trim()
    const sol = architectSolution(model, canonical, datasets)
    if (!sol) continue
    const baseSteps: SuggestionStep[] = sol.steps
      .filter((st) => st.objectType === 'Measure')
      .map((st) => ({ name: st.name, dax: st.dax, reason: st.reason }))
    if (baseSteps.length === 0) continue
    const baseFinal = baseSteps.find((st) => st.name === sol.finalObject.name) ?? baseSteps[baseSteps.length - 1]
    const fmtStep = sol.steps.find((st) => st.name === baseFinal.name)

    // Wrap in a filtered CALCULATE when the intent carries filters.
    const applyFilters = intent.filters.length > 0 && FILTERABLE.has(p.id)
    const steps = applyFilters ? [...baseSteps, filteredStep(baseFinal.name, intent.filters)] : baseSteps
    const finalStep = steps[steps.length - 1]

    const key = `${finalStep.name}=${finalStep.dax}`.toLowerCase().replace(/\s+/g, '')
    if (seenDax.has(key)) continue
    seenDax.add(key)

    const preview = evaluateDax(finalStep.dax, makeCtx(withTempMeasures(model, steps), datasets))

    out.push({
      patternId: p.id,
      label: p.label,
      canonicalPrompt: canonical,
      measureName: finalStep.name,
      dax: finalStep.dax,
      plan: steps,
      explanation: sol.goalRestatement,
      score: s,
      signature,
      tokens: intent.tokens,
      preview: preview.ok ? { ok: true, value: preview.value } : { ok: false, note: preview.note },
      formatString: fmtStep?.formatString ?? '#,##0',
      validationErrors: sol.validationErrors ?? [],
      corrections,
    })
  }

  return { intent, suggestions: out }
}
