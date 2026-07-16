/**
 * APPLICATION — DAX Intent Engine
 * Parses a natural-language request into a structured intent, ranks it against
 * a declarative pattern library (adjusted by what you've picked before), and
 * returns the top few suggestions — each a full branched solution with a live
 * preview. DAX generation itself is delegated to the deterministic architect
 * engine via a canonical phrasing, so suggestions reuse proven output.
 */
import type { SemanticModel, Table } from '@/domain/model'
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
  movingSpec?: string // e.g. "3 month" (for moving average)
  iteratorCols?: [string, string] // two numeric columns for a row-by-row product
  weightCol?: string // weight column for a weighted average
  useRelationship?: { fromTable: string; fromColumn: string; toTable: string; toColumn: string; label: string }
  topN?: number
  signals: Set<string>
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
  [/\b(qtd|quarter to date|quarter-to-date)\b/, 'qtd'],
  [/\b(mtd|month to date|month-to-date)\b/, 'mtd'],
  [/\b(prior year|previous year|same period last year|sply|py value|last year value)\b/, 'priorYear'],
  [/\b(moving average|rolling average|trailing average|moving avg)\b/, 'movingAvg'],
  [/\b(weighted average|weighted avg|weighted mean)\b/, 'weightedAvg'],
  [/\b(profit margin|gross margin|net margin|margin %|margin percent)\b/, 'profitMargin'],
  [/\b(profit|gross profit|net profit|earnings)\b/, 'profit'],
  [/\b(churn|churned|attrition|lost customers)\b/, 'churn'],
  [/\b(retention|retained|repeat customers|returning customers)\b/, 'retention'],
  [/\b(new customers|new clients|customer acquisition|acquired customers|new accounts)\b/, 'newCustomers'],
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

  // Row-by-row product → SUMX iterator (e.g. "quantity times price").
  let iteratorCols: [string, string] | undefined
  const prodMatch = low.match(/\b([a-z_ ]+?)\s*(?:times|multiplied by|\*|×)\s*([a-z_ ]+)/)
  if (prodMatch) {
    const a = resolveColumn(prodMatch[1], model, num)
    const b = resolveColumn(prodMatch[2], model, num)
    if (a && b && a !== b) {
      iteratorCols = [a, b]
      signals.add('iterator')
    }
  }

  // Moving-average window: "N unit moving average" (defaults to 3 month).
  let movingSpec: string | undefined
  if (signals.has('movingAvg')) {
    const mm = low.match(/(\d+)\s*(day|week|month|quarter|year)/)
    movingSpec = mm ? `${mm[1]} ${mm[2]}` : '3 month'
  }

  // Weighted average: "weighted average A by B" → B is the weight column.
  let weightCol: string | undefined
  if (signals.has('weightedAvg')) {
    const wm = low.split(/\bby\b/)[1]
    weightCol = wm ? resolveColumn(wm, model, num) : undefined
  }

  // USERELATIONSHIP: an INACTIVE date relationship whose column the prompt names.
  let useRelationship: DaxIntent['useRelationship']
  const spaced = ` ${low.replace(/_/g, ' ')} `
  for (const r of model.relationships) {
    if (r.isActive) continue
    const fromT = model.tables.find((t) => t.id === r.fromTable)
    const fromC = fromT?.columns.find((c) => c.id === r.fromColumn)
    const toT = model.tables.find((t) => t.id === r.toTable)
    const toC = toT?.columns.find((c) => c.id === r.toColumn)
    if (!fromT || !fromC || !toT || !toC) continue
    if (fromC.dataType !== 'date' && fromC.dataType !== 'dateTime') continue
    if (spaced.includes(` ${fromC.name.toLowerCase().replace(/_/g, ' ')} `)) {
      useRelationship = { fromTable: fromT.name, fromColumn: fromC.name, toTable: toT.name, toColumn: toC.name, label: fromC.name }
      break
    }
  }
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
  let filterSource: string
  if (explicit) {
    filterSource = raw.slice((fm!.index ?? 0) + fm![0].length)
  } else {
    // Remove the measure + group-by name tokens so a word inside the field name
    // (e.g. "Direct" in the measure "Direct Revenue") can't become a filter.
    const strip = new Set<string>()
    for (const nm of [fieldName, groupName]) if (nm) for (const w of words(nm)) strip.add(w)
    filterSource = raw
      .split(/\s+/)
      .filter((tok) => !strip.has(tok.toLowerCase().replace(/[^a-z0-9]/g, '')))
      .join(' ')
  }
  const filters = resolveFilters(filterSource, model, datasets, explicit)

  return {
    raw,
    aggWord,
    fieldName,
    fieldPhrase: fieldName ? undefined : nounAfterAgg(low),
    groupName,
    filters,
    rollingPhrase,
    movingSpec,
    iteratorCols,
    weightCol,
    useRelationship,
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
  hasCost: boolean // a cost/expense column exists (enables profit / margin)
  entityCol?: string // a customer/entity column (enables churn / retention / new)
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
const FILTERABLE = new Set([
  'total', 'average', 'count', 'distinct', 'yoy-pct', 'mom-pct', 'qoq-pct',
  'ytd', 'qtd', 'mtd', 'prior-year', 'moving-avg', 'running', 'rolling-period',
])

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
    id: 'qtd',
    label: 'Quarter-to-date',
    requires: (_i, ctx) => ctx.hasDate,
    score: (i) => (i.signals.has('qtd') ? 0.94 : 0),
    canonical: (i, ctx) => `${field(i, ctx)} qtd`,
  },
  {
    id: 'mtd',
    label: 'Month-to-date',
    requires: (_i, ctx) => ctx.hasDate,
    score: (i) => (i.signals.has('mtd') ? 0.94 : 0),
    canonical: (i, ctx) => `${field(i, ctx)} mtd`,
  },
  {
    id: 'prior-year',
    label: 'Prior year (same period)',
    requires: (_i, ctx) => ctx.hasDate,
    score: (i) => (i.signals.has('priorYear') ? 0.9 : 0),
    canonical: (i, ctx) => `${field(i, ctx)} prior year`,
  },
  {
    id: 'moving-avg',
    label: 'Moving average',
    requires: (_i, ctx) => ctx.hasDate,
    score: (i) => (i.signals.has('movingAvg') ? 0.93 : 0),
    canonical: (i, ctx) => `${field(i, ctx)} ${i.movingSpec ?? '3 month'} moving average`,
  },
  {
    id: 'profit-margin',
    label: 'Profit margin %',
    requires: (_i, ctx) => ctx.hasCost,
    score: (i) => (i.signals.has('profitMargin') ? 0.94 : 0),
    canonical: () => 'profit margin',
  },
  {
    id: 'profit',
    label: 'Profit',
    requires: (_i, ctx) => ctx.hasCost,
    score: (i) => (i.signals.has('profit') && !i.signals.has('profitMargin') ? 0.9 : 0),
    canonical: () => 'total profit',
  },
  {
    id: 'churn',
    label: 'Churn rate %',
    requires: (_i, ctx) => ctx.hasDate && !!ctx.entityCol,
    score: (i) => (i.signals.has('churn') ? 0.92 : 0),
    canonical: () => 'churned customers',
  },
  {
    id: 'retention',
    label: 'Retention rate %',
    requires: (_i, ctx) => ctx.hasDate && !!ctx.entityCol,
    score: (i) => (i.signals.has('retention') ? 0.92 : 0),
    canonical: () => 'customer retention',
  },
  {
    id: 'new-customers',
    label: 'New customers',
    requires: (_i, ctx) => ctx.hasDate && !!ctx.entityCol,
    score: (i) => (i.signals.has('newCustomers') ? 0.92 : 0),
    canonical: () => 'new customers',
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

/** A DAX column reference from the fact's row context — direct if the column is
 * on the fact, RELATED('Dim'[col]) if it's on a dimension reachable by a FK. */
function colRef(colName: string, factTable: Table, model: SemanticModel): string | null {
  if (factTable.columns.some((c) => c.name === colName)) return `'${factTable.name}'[${colName}]`
  for (const t of model.tables) {
    if (t.id === factTable.id) continue
    if (!t.columns.some((c) => c.name === colName)) continue
    if (model.relationships.some((r) => r.fromTable === factTable.id && r.toTable === t.id)) {
      return `RELATED('${t.name}'[${colName}])`
    }
  }
  return null
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
  /** Pin the aggregated column (the Factory uses this so a suite can't drift to another field). */
  valueOverride?: { table: string; column: string },
): { intent: DaxIntent; suggestions: Suggestion[] } {
  const intent = parseIntent(prompt, model, datasets)
  const factTable = model.tables.find((t) => t.role === 'fact') ?? model.tables[0]
  const allCols = model.tables.flatMap((t) => t.columns)
  const ctx: PatternCtx = {
    hasDate: model.tables.some((t) => t.role === 'date' || t.columns.some((c) => c.dataType === 'date' || c.dataType === 'dateTime')),
    factName: factTable?.name ?? 'Table',
    hasCost: allCols.some((c) => /integer|decimal/.test(c.dataType) && /cost|cogs|expense|spend/i.test(c.name)),
    entityCol: allCols.find((c) => /customer|client|user|member|account|patient|guest|subscriber|donor|student/i.test(c.name))?.name,
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

  // Iterator (SUMX row-by-row product) — built directly so the exact columns
  // the user named are used (the engine picks columns heuristically).
  if (intent.iteratorCols && factTable) {
    const [a, b] = intent.iteratorCols
    const aRef = colRef(a, factTable, model)
    const bRef = colRef(b, factTable, model)
    if (aRef && bRef) {
      const name = `Total ${a} × ${b}`
      const dax = `SUMX(\n    '${ctx.factName}',\n    ${aRef} * ${bRef}\n)`
      const step: SuggestionStep = { name, dax, reason: `Row-by-row product of ${a} and ${b}, summed with SUMX${aRef.includes('RELATED') || bRef.includes('RELATED') ? ' (RELATED pulls the dimension value into the fact row)' : ''}.` }
      const preview = evaluateDax(dax, makeCtx(withTempMeasures(model, [step]), datasets))
      out.push({
        patternId: 'iterator', label: 'Row-by-row (SUMX)', canonicalPrompt: prompt, measureName: name, dax,
        plan: [step], explanation: `Sums ${a} × ${b} per row using the SUMX iterator.`, score: 0.95, signature,
        tokens: intent.tokens, preview: preview.ok ? { ok: true, value: preview.value } : { ok: false, note: preview.note },
        formatString: '#,##0', validationErrors: [], corrections,
      })
    }
  }

  // Weighted average — built directly: DIVIDE(SUMX(value × weight), SUM(weight)).
  if (intent.signals.has('weightedAvg') && intent.weightCol && factTable) {
    // The value column is named BEFORE "by"; the weight column after it.
    const byIdx = intent.raw.toLowerCase().indexOf(' by ')
    const val = resolveColumn(byIdx >= 0 ? intent.raw.slice(0, byIdx) : intent.raw, model, num) ?? intent.fieldName
    const w = intent.weightCol
    const onFact = (n: string) => factTable.columns.some((c) => c.name === n)
    if (val && val !== w && onFact(val) && onFact(w)) {
      const name = `Weighted Avg ${val}`
      const dax = `DIVIDE(\n    SUMX('${ctx.factName}', '${ctx.factName}'[${val}] * '${ctx.factName}'[${w}]),\n    SUM('${ctx.factName}'[${w}])\n)`
      const step: SuggestionStep = { name, dax, reason: `${val} weighted by ${w}: SUMX(value × weight) ÷ SUM(weight).` }
      const preview = evaluateDax(dax, makeCtx(withTempMeasures(model, [step]), datasets))
      out.push({
        patternId: 'weighted-avg', label: 'Weighted average', canonicalPrompt: prompt, measureName: name, dax,
        plan: [step], explanation: `Weighted average of ${val} using ${w} as the weight.`, score: 0.97, signature,
        tokens: intent.tokens, preview: preview.ok ? { ok: true, value: preview.value } : { ok: false, note: preview.note },
        formatString: '#,##0.00', validationErrors: [], corrections,
      })
    }
  }

  for (const { p, s } of ranked) {
    if (out.length >= limit) break
    // Canonical carries only the base aggregation/time-intelligence — never the
    // filters (the engine would split on "and", or worse, read a value-like word
    // in the measure name as a filter). We resolve + wrap filters ourselves, so
    // always skip the engine's value→column injection.
    const canonical = p.canonical(intent, ctx).replace(/\s+/g, ' ').trim()
    const sol = architectSolution(model, canonical, datasets, valueOverride ? { value: valueOverride } : undefined, true)
    if (!sol) continue
    const baseSteps: SuggestionStep[] = sol.steps
      .filter((st) => st.objectType === 'Measure')
      .map((st) => ({ name: st.name, dax: st.dax, reason: st.reason }))
    if (baseSteps.length === 0) continue
    const baseFinal = baseSteps.find((st) => st.name === sol.finalObject.name) ?? baseSteps[baseSteps.length - 1]
    const fmtStep = sol.steps.find((st) => st.name === baseFinal.name)

    // Wrap in a filtered CALCULATE when the intent carries filters.
    const applyFilters = intent.filters.length > 0 && FILTERABLE.has(p.id)
    let steps = applyFilters ? [...baseSteps, filteredStep(baseFinal.name, intent.filters)] : baseSteps
    let finalStep = steps[steps.length - 1]

    // Re-point time-intelligence to an INACTIVE relationship via USERELATIONSHIP.
    if (intent.useRelationship && FILTERABLE.has(p.id)) {
      const ur = intent.useRelationship
      const urStep: SuggestionStep = {
        name: `${finalStep.name} (by ${ur.label})`,
        dax: `CALCULATE(\n    [${finalStep.name}],\n    USERELATIONSHIP('${ur.fromTable}'[${ur.fromColumn}], '${ur.toTable}'[${ur.toColumn}])\n)`,
        reason: `Activates the inactive '${ur.fromColumn}'→'${ur.toColumn}' relationship for this calculation with USERELATIONSHIP.`,
      }
      steps = [...steps, urStep]
      finalStep = urStep
    }

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
