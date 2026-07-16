/**
 * APPLICATION — Filter resolver for the DAX Intent Engine
 * Turns a filter phrase into structured predicates — WITHOUT inventing filters.
 * Two modes:
 *   • explicit  ("where product is bar and orderstatus dilvered") — the user
 *     signalled a filter, so fuzzy column + typo-tolerant value matching is on.
 *   • bare      (no where/for cue) — only an EXACT match of a non-keyword token
 *     to a real dimension value counts, so "Total Amount" / "YOY growth" /
 *     "previous 15 days" never fabricate a filter.
 * Key/ID/foreign-key columns are never filter targets from free text.
 */
import type { SemanticModel } from '@/domain/model'
import type { DatasetData } from '@/application/import/types'

export interface ResolvedFilter {
  table: string
  column: string
  value: string // raw canonical value (unquoted); engine adds quotes
  numeric: boolean
  corrected: boolean // value was typo-corrected to a real one
  original?: string // what the user typed, when corrected
}

const normId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** CALCULATION / structure words only — never a filter value in a bare prompt.
 * (Measure-subject nouns like "sales"/"revenue" are NOT here — those are removed
 * from the scan by subtracting the resolved field name instead, so they can still
 * be legitimate filter values.) */
const STOP = new Set([
  'total', 'sum', 'overall', 'aggregate', 'combined', 'gross', 'count', 'number', 'tally', 'distinct', 'unique',
  'average', 'avg', 'mean', 'min', 'minimum', 'max', 'maximum', 'lowest', 'highest', 'smallest', 'largest', 'greatest',
  'yoy', 'mom', 'qoq', 'wow', 'ytd', 'qtd', 'mtd', 'year', 'years', 'yearly', 'month', 'months', 'monthly',
  'quarter', 'quarters', 'quarterly', 'week', 'weeks', 'weekly', 'day', 'days', 'daily', 'date', 'time', 'period',
  'previous', 'prior', 'last', 'past', 'trailing', 'rolling', 'running', 'cumulative', 'moving',
  'growth', 'change', 'increase', 'decrease', 'variance', 'delta', 'difference', 'vs', 'versus', 'over', 'todate',
  'by', 'per', 'share', 'percent', 'percentage', 'pct', 'proportion', 'contribution',
  'rank', 'ranking', 'top', 'bottom', 'position', 'and', 'or', 'with', 'for', 'where', 'in', 'is', 'on', 'to',
  'from', 'the', 'a', 'an', 'of', 'each', 'every', 'all', 'my', 'our', 'this', 'that', 'current',
])

const isStop = (w: string) => STOP.has(w.toLowerCase())

/** Column names that identify rows rather than describe them (never filtered). */
const isIdLike = (name: string) => /(^|[_ ])(id|code|key|no|num|sk|pk|fk|guid|uuid)$/i.test(name) || /id$/i.test(name)

function lev(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  const prev = Array.from({ length: n + 1 }, (_, j) => j)
  const cur = new Array(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j]
  }
  return prev[n]
}

interface ValueCol {
  table: string
  column: string
  values: string[]
}

/** Low-cardinality descriptive string columns — excludes keys / ids / foreign keys. */
function valueColumns(model: SemanticModel, datasets: DatasetData[]): ValueCol[] {
  const byId: Record<string, DatasetData> = {}
  for (const d of datasets) byId[d.id] = d
  const fkColumnIds = new Set(model.relationships.map((r) => r.fromColumn))
  const out: ValueCol[] = []
  for (const t of model.tables) {
    const data = byId[t.id]
    if (!data) continue
    t.columns.forEach((c, idx) => {
      if (c.dataType !== 'string') return
      if (c.role === 'key' || fkColumnIds.has(c.id) || isIdLike(c.name)) return
      if ((c.distinctCount ?? 999) > 60) return
      const values: string[] = []
      const seen = new Set<string>()
      for (const row of data.rows) {
        const v = row[idx]
        if (v == null) continue
        const s = String(v)
        if (seen.has(s)) continue
        seen.add(s)
        values.push(s)
        if (seen.size > 60) break
      }
      if (values.length) out.push({ table: t.name, column: c.name, values })
    })
  }
  return out
}

function matchColumn(word: string, model: SemanticModel): { table: string; column: string } | null {
  const w = normId(word)
  if (w.length < 3) return null
  for (const t of model.tables) for (const c of t.columns) if (normId(c.name) === w) return { table: t.name, column: c.name }
  for (const t of model.tables) for (const c of t.columns) if (normId(c.name).includes(w)) return { table: t.name, column: c.name }
  return null
}

interface ValueHit {
  table: string
  column: string
  value: string
  score: number
}

/** Exact value match within a specific column, any length (explicit "Col = Value"). */
function exactInColumn(value: string, cols: ValueCol[], restrict: { table: string; column: string }): ValueHit | null {
  const p = normId(value)
  if (!p) return null
  for (const col of cols) {
    if (col.table !== restrict.table || col.column !== restrict.column) continue
    for (const v of col.values) if (normId(v) === p) return { table: col.table, column: col.column, value: v, score: 1 }
  }
  return null
}

/** Exact (case/underscore-insensitive) value match only — used for bare prompts. */
function exactValue(phrase: string, cols: ValueCol[], restrict?: { table: string; column: string }): ValueHit | null {
  const p = normId(phrase)
  if (!p) return null
  for (const col of cols) {
    if (restrict && !(col.table === restrict.table && col.column === restrict.column)) continue
    for (const v of col.values) if (normId(v) === p) return { table: col.table, column: col.column, value: v, score: 1 }
  }
  return null
}

/** Fuzzy value match (exact → contains → typo) — used only when the user was explicit. */
function fuzzyValue(phrase: string, cols: ValueCol[], restrict?: { table: string; column: string }): ValueHit | null {
  const cands = [phrase, ...phrase.split(/\s+/)].map((s) => s.trim()).filter((s) => s.length > 1 && !isStop(s))
  if (cands.length === 0) return null
  let best: ValueHit | null = null
  for (const col of cols) {
    if (restrict && !(col.table === restrict.table && col.column === restrict.column)) continue
    for (const v of col.values) {
      const nv = normId(v)
      for (const cand of cands) {
        const w = normId(cand)
        if (!w) continue
        let score = 0
        if (w === nv) score = 1
        else if (w.length > 2 && (nv.includes(w) || w.includes(nv))) score = 0.82
        else {
          const sim = 1 - lev(w, nv) / Math.max(w.length, nv.length)
          if (sim >= 0.7) score = sim * 0.78
        }
        if (score > 0 && (!best || score > best.score)) best = { table: col.table, column: col.column, value: v, score }
      }
    }
  }
  return best
}

const isNumericStr = (s: string) => /^-?\d+(\.\d+)?$/.test(s)

/** Contiguous n-grams (1–3 tokens) of a clause that aren't pure stopwords. */
function ngrams(clause: string): string[] {
  const toks = clause.split(/\s+/).filter(Boolean)
  const grams: string[] = []
  for (let n = Math.min(3, toks.length); n >= 1; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      const g = toks.slice(i, i + n)
      if (g.every(isStop)) continue
      grams.push(g.join(' '))
    }
  }
  return grams
}

/**
 * Resolve filter predicates. `explicit` = the user used a where/for cue, so we
 * allow fuzzy/typo matching; otherwise we require exact value matches.
 */
export function resolveFilters(text: string, model: SemanticModel, datasets: DatasetData[], explicit: boolean): ResolvedFilter[] {
  if (!text.trim()) return []
  const cols = valueColumns(model, datasets)
  if (cols.length === 0) return []

  const clauses = text
    .split(/\s+and\s+|\s*[,;]\s*|\s+&\s+/i)
    .map((s) => s.replace(/\bwhere\b/gi, '').trim())
    .filter(Boolean)

  const out: ResolvedFilter[] = []
  const used = new Set<string>()
  const add = (table: string, column: string, value: string, original: string) => {
    const key = `${table}|${column}`
    if (used.has(key)) return
    used.add(key)
    const corrected = normId(value) !== normId(original)
    out.push({ table, column, value, numeric: isNumericStr(value), corrected, original: corrected ? original : undefined })
  }

  for (const clause of clauses) {
    const op = clause.match(/^(.*?)\s*(?:=|:|\bis\b|\bequals?\b)\s*(.+)$/i)

    if (op) {
      // Explicit "column = value" — honor the value verbatim (even if it's a
      // word like Day / Revenue / Orders / A that we'd skip in a bare prompt).
      const colWord = op[1].trim()
      const valWord = op[2].replace(/^['"]|['"]$/g, '').trim()
      const restrict = matchColumn(colWord, model) ?? undefined
      let m = restrict ? exactInColumn(valWord, cols, restrict) : null // exact within the named column, any length
      if (!m) m = restrict ? fuzzyValue(valWord, cols, restrict) : null // then typo within it
      if (!m || m.score < 0.72) {
        const g = fuzzyValue(valWord, cols)
        if (g && (!m || g.score > m.score + 0.05)) m = g
      }
      if (m && m.score >= 0.6) add(m.table, m.column, m.value, valWord)
      else if (restrict && valWord) add(restrict.table, restrict.column, valWord, valWord) // honor the user's literal
      continue
    }

    if (explicit) {
      // "for west region" — a token may name a column; the rest is the value.
      const toks = clause.split(/\s+/)
      let restrict: { table: string; column: string } | undefined
      let rest = clause
      for (const tk of toks) {
        const c = matchColumn(tk, model)
        if (c) {
          restrict = c
          rest = toks.filter((x) => x !== tk).join(' ').trim() || clause
          break
        }
      }
      const m = (restrict ? fuzzyValue(rest, cols, restrict) : null) ?? fuzzyValue(rest, cols)
      if (m && m.score >= 0.62) add(m.table, m.column, m.value, rest)
      continue
    }

    // Bare prompt — only exact, non-stopword value matches count.
    for (const g of ngrams(clause)) {
      const m = exactValue(g, cols)
      if (m) {
        add(m.table, m.column, m.value, g)
        break
      }
    }
  }

  return out
}
