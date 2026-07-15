/**
 * APPLICATION — Fuzzy filter resolver for the DAX Intent Engine
 * Turns a natural filter tail ("where product is bar and orderstatus dilvered")
 * into structured predicates, tolerating: multiple AND-conditions, column names
 * written without underscores/spacing ("orderstatus" → Order_Status), and
 * mistyped values matched against the real data ("dilvered" → "Delivered").
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

function stringColumns(model: SemanticModel, datasets: DatasetData[]): ValueCol[] {
  const byId: Record<string, DatasetData> = {}
  for (const d of datasets) byId[d.id] = d
  const out: ValueCol[] = []
  for (const t of model.tables) {
    const data = byId[t.id]
    if (!data) continue
    t.columns.forEach((c, idx) => {
      if (c.dataType !== 'string' || c.role === 'key' || (c.distinctCount ?? 999) > 60) return
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
      out.push({ table: t.name, column: c.name, values })
    })
  }
  return out
}

/** Similarity 0..1 between a typed word and a real value (typo tolerant). */
function similarity(word: string, value: string): number {
  const w = normId(word)
  const v = normId(value)
  if (!w || !v) return 0
  if (w === v) return 1
  if (v.includes(w) || w.includes(v)) return 0.82
  const d = lev(w, v)
  const sim = 1 - d / Math.max(w.length, v.length)
  return sim >= 0.68 ? sim * 0.78 : 0 // only near-misses count (typos)
}

function matchColumn(word: string, model: SemanticModel): { table: string; column: string } | null {
  const w = normId(word)
  if (w.length < 2) return null
  for (const t of model.tables) for (const c of t.columns) if (normId(c.name) === w) return { table: t.name, column: c.name }
  for (const t of model.tables) for (const c of t.columns) if (w.length > 2 && normId(c.name).includes(w)) return { table: t.name, column: c.name }
  return null
}

/** Best (value, column) match for a phrase, optionally restricted to one column. */
function bestValue(
  phrase: string,
  cols: ValueCol[],
  restrict?: { table: string; column: string },
): { table: string; column: string; value: string; score: number } | null {
  const candidates = [phrase, ...phrase.split(/\s+/)].filter((s) => s.length > 1)
  let best: { table: string; column: string; value: string; score: number } | null = null
  for (const col of cols) {
    if (restrict && !(col.table === restrict.table && col.column === restrict.column)) continue
    for (const v of col.values) {
      for (const cand of candidates) {
        const s = similarity(cand, v)
        if (s > 0 && (!best || s > best.score)) best = { table: col.table, column: col.column, value: v, score: s }
      }
    }
  }
  return best
}

const isNumericStr = (s: string) => /^-?\d+(\.\d+)?$/.test(s)

/** Resolve a natural-language filter tail into structured predicates. */
export function resolveFilters(text: string, model: SemanticModel, datasets: DatasetData[]): ResolvedFilter[] {
  if (!text.trim()) return []
  const cols = stringColumns(model, datasets)
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
    out.push({
      table,
      column,
      value,
      numeric: isNumericStr(value),
      corrected: normId(value) !== normId(original),
      original: normId(value) !== normId(original) ? original : undefined,
    })
  }

  for (const clause of clauses) {
    const op = clause.match(/^(.*?)\s*(?:=|:|\bis\b|\bequals?\b|\bin\b)\s*(.+)$/i)
    const colWord = op ? op[1].trim() : ''
    let valWord = (op ? op[2] : clause).replace(/^['"]|['"]$/g, '').trim()
    let restrict = colWord ? matchColumn(colWord, model) ?? undefined : undefined

    // No "col = value" operator: a token may still name a column ("orderstatus delivered").
    if (!restrict && !op) {
      const toks = clause.split(/\s+/)
      for (const tk of toks) {
        const c = matchColumn(tk, model)
        if (c) {
          restrict = c
          const rest = toks.filter((x) => x !== tk).join(' ').trim()
          if (rest) valWord = rest
          break
        }
      }
    }

    // Numeric literal against a resolved (or any numeric) column.
    if (isNumericStr(valWord) && restrict) {
      add(restrict.table, restrict.column, valWord, valWord)
      continue
    }

    // Prefer a value in the named column; fall back to the best value anywhere.
    let m = restrict ? bestValue(valWord, cols, restrict) : null
    if (!m || m.score < 0.72) {
      const global = bestValue(valWord, cols)
      if (global && (!m || global.score > m.score + 0.05)) m = global
    }

    if (m && m.score >= 0.6) {
      add(m.table, m.column, m.value, valWord)
    } else if (restrict) {
      add(restrict.table, restrict.column, valWord, valWord) // honor the column with a literal value
    }
  }

  return out
}
