/**
 * APPLICATION — Schema inference & profiling (pure)
 * Given raw cells, detect column data types, coerce values, and compute
 * profiles (distinct/null counts, numeric/temporal aggregates, distributions).
 *
 * Pure and framework-free so it runs identically in a Web Worker or in tests.
 */
import type { ColumnRole, DataType } from '@/domain/model'
import type {
  ColumnProfile,
  Distribution,
  ParsedDataset,
  ProfiledColumn,
} from './types'

type Cell = unknown

// ---------------------------------------------------------------------------
// Cell-level classification
// ---------------------------------------------------------------------------

const BOOL_TRUE = new Set(['true', 'yes', 't', 'y'])
const BOOL_FALSE = new Set(['false', 'no', 'f', 'n'])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/
const US_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/
const US_DATETIME = /^\d{1,2}\/\d{1,2}\/\d{4}[ T]\d{1,2}:\d{2}(:\d{2})?$/
// Optional currency symbol + thousands separators + optional decimals.
const NUMERIC = /^[-+]?[$€£¥]?\s?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/

type Category = 'integer' | 'decimal' | 'boolean' | 'date' | 'dateTime' | 'string'

export function isBlank(v: Cell): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

function stripNumber(s: string): string {
  return s.replace(/[$€£¥,%\s]/g, '')
}

/** Classify one non-blank cell into a candidate category. */
function classify(v: Cell): Category {
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'decimal'
  if (v instanceof Date) return hasTime(v) ? 'dateTime' : 'date'

  const s = String(v).trim()
  const lower = s.toLowerCase()

  if (BOOL_TRUE.has(lower) || BOOL_FALSE.has(lower)) return 'boolean'

  if (NUMERIC.test(s)) {
    const n = stripNumber(s)
    return n.includes('.') ? 'decimal' : 'integer'
  }

  if (ISO_DATETIME.test(s) || US_DATETIME.test(s)) {
    if (!Number.isNaN(parseDate(s)?.getTime() ?? NaN)) return 'dateTime'
  }
  if (ISO_DATE.test(s) || US_DATE.test(s)) {
    if (!Number.isNaN(parseDate(s)?.getTime() ?? NaN)) return 'date'
  }

  return 'string'
}

function hasTime(d: Date): boolean {
  return d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0
}

function parseDate(v: Cell): Date | null {
  if (v instanceof Date) return v
  const s = String(v).trim()
  let d: Date | null = null
  if (ISO_DATE.test(s) || ISO_DATETIME.test(s)) {
    d = new Date(s.replace(' ', 'T'))
  } else if (US_DATE.test(s) || US_DATETIME.test(s)) {
    const [datePart, timePart] = s.split(/[ T]/)
    const [mm, dd, yyyy] = datePart.split('/').map(Number)
    d = new Date(yyyy, mm - 1, dd)
    if (timePart) {
      const [h, mi, se] = timePart.split(':').map(Number)
      d.setHours(h || 0, mi || 0, se || 0)
    }
  }
  return d && !Number.isNaN(d.getTime()) ? d : null
}

// ---------------------------------------------------------------------------
// Column-level type decision
// ---------------------------------------------------------------------------

const CONFIDENCE = 0.9

function decideType(cells: Cell[]): DataType {
  const counts: Record<Category, number> = {
    integer: 0,
    decimal: 0,
    boolean: 0,
    date: 0,
    dateTime: 0,
    string: 0,
  }
  let nonBlank = 0
  for (const c of cells) {
    if (isBlank(c)) continue
    nonBlank++
    counts[classify(c)]++
  }
  if (nonBlank === 0) return 'string'

  const share = (n: number) => n / nonBlank
  const numeric = counts.integer + counts.decimal
  const temporal = counts.date + counts.dateTime

  if (share(counts.boolean) >= CONFIDENCE) return 'boolean'
  if (share(numeric) >= CONFIDENCE) return counts.decimal > 0 ? 'decimal' : 'integer'
  if (share(temporal) >= CONFIDENCE) return counts.dateTime > 0 ? 'dateTime' : 'date'
  return 'string'
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

export function coerce(v: Cell, type: DataType): unknown {
  if (isBlank(v)) return null
  switch (type) {
    case 'integer':
    case 'decimal': {
      if (typeof v === 'number') return v
      const n = Number(stripNumber(String(v)))
      return Number.isNaN(n) ? null : n
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v
      return BOOL_TRUE.has(String(v).trim().toLowerCase())
    }
    case 'date':
    case 'dateTime': {
      const d = parseDate(v)
      if (!d) return null
      return type === 'date' ? d.toISOString().slice(0, 10) : d.toISOString()
    }
    default:
      return String(v)
  }
}

// ---------------------------------------------------------------------------
// Profiling
// ---------------------------------------------------------------------------

function buildDistribution(type: DataType, values: unknown[]): Distribution {
  const present = values.filter((v) => v !== null)

  if (type === 'boolean') {
    let t = 0
    let f = 0
    for (const v of present) (v ? t++ : f++)
    return { kind: 'boolean', bins: [
      { label: 'True', count: t },
      { label: 'False', count: f },
    ] }
  }

  if (type === 'integer' || type === 'decimal') {
    const nums = present as number[]
    if (nums.length === 0) return { kind: 'histogram', bins: [] }
    const min = Math.min(...nums)
    const max = Math.max(...nums)
    const BINS = 10
    if (min === max) return { kind: 'histogram', bins: [{ label: fmtNum(min), count: nums.length }] }
    const width = (max - min) / BINS
    const bins: number[] = new Array(BINS).fill(0)
    for (const n of nums) {
      const idx = Math.min(BINS - 1, Math.floor((n - min) / width))
      bins[idx]++
    }
    return {
      kind: 'histogram',
      bins: bins.map((count, i) => ({
        label: `${fmtNum(min + i * width)}–${fmtNum(min + (i + 1) * width)}`,
        count,
      })),
    }
  }

  if (type === 'date' || type === 'dateTime') {
    const byYear = new Map<string, number>()
    for (const v of present) {
      const year = String(v).slice(0, 4)
      byYear.set(year, (byYear.get(year) ?? 0) + 1)
    }
    const bins = [...byYear.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count }))
    return { kind: 'temporal', bins }
  }

  // categorical (string): top-N by frequency
  const freq = new Map<string, number>()
  for (const v of present) {
    const key = String(v)
    freq.set(key, (freq.get(key) ?? 0) + 1)
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1])
  const TOP = 8
  const top = sorted.slice(0, TOP).map(([label, count]) => ({ label, count }))
  const truncated = sorted.length > TOP
  if (truncated) {
    const rest = sorted.slice(TOP).reduce((s, [, c]) => s + c, 0)
    top.push({ label: `+${sorted.length - TOP} more`, count: rest })
  }
  return { kind: 'categorical', bins: top, truncated }
}

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString()
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

const KEY_HINTS = /(^id$|_id$|\bid\b|key|code|number|no\.)/i
const MEASURE_HINTS =
  /(revenue|sales|amount|price|cost|total|qty|quantity|profit|margin|discount|tax|balance|value|count|units?)/i

function inferRole(
  name: string,
  type: DataType,
  distinctCount: number,
  rowCount: number,
): ColumnRole {
  if (type === 'date' || type === 'dateTime') return 'date'
  if (type === 'boolean') return 'flag'

  const unique = rowCount > 0 && distinctCount === rowCount
  if (unique && (type === 'integer' || type === 'string') && KEY_HINTS.test(name)) return 'key'

  if (type === 'integer' || type === 'decimal') {
    if (unique && KEY_HINTS.test(name)) return 'key'
    if (MEASURE_HINTS.test(name) || distinctCount > Math.min(20, rowCount * 0.5))
      return 'measureCandidate'
    return 'dimension'
  }

  // string
  if (unique && KEY_HINTS.test(name)) return 'key'
  return 'dimension'
}

function profileColumn(name: string, rawCells: Cell[], rowCount: number): ProfiledColumn {
  const dataType = decideType(rawCells)
  const values = rawCells.map((c) => coerce(c, dataType))

  let nullCount = 0
  const distinct = new Set<string>()
  const nums: number[] = []
  let minText: string | undefined
  let maxText: string | undefined

  for (const v of values) {
    if (v === null) {
      nullCount++
      continue
    }
    distinct.add(String(v))
    if (typeof v === 'number') nums.push(v)
    if (dataType === 'date' || dataType === 'dateTime' || dataType === 'string') {
      const s = String(v)
      if (minText === undefined || s < minText) minText = s
      if (maxText === undefined || s > maxText) maxText = s
    }
  }

  const profile: ColumnProfile = {
    distinctCount: distinct.size,
    nullCount,
    distribution: buildDistribution(dataType, values),
  }
  if (nums.length > 0) {
    profile.min = Math.min(...nums)
    profile.max = Math.max(...nums)
    profile.mean = nums.reduce((s, n) => s + n, 0) / nums.length
  }
  if (minText !== undefined) profile.minText = minText
  if (maxText !== undefined) profile.maxText = maxText

  const sampleValues = [...distinct].slice(0, 5)

  return {
    name,
    dataType,
    role: inferRole(name, dataType, distinct.size, rowCount),
    sampleValues,
    profile,
  }
}

// ---------------------------------------------------------------------------
// Dataset orchestration
// ---------------------------------------------------------------------------

/**
 * Build a fully profiled dataset from a header row + raw rows.
 * `rawRows` is row-major; ragged rows are padded/truncated to header length.
 */
export function inferDataset(
  name: string,
  headers: string[],
  rawRows: Cell[][],
): ParsedDataset {
  const cols = headers.map((h, i) => (h == null || h === '' ? `Column ${i + 1}` : String(h)))
  const rowCount = rawRows.length

  // Column-major raw cells for type inference.
  const columnCells: Cell[][] = cols.map((_, ci) => rawRows.map((r) => r[ci] ?? null))

  const columns = cols.map((colName, ci) => profileColumn(colName, columnCells[ci], rowCount))

  // Coerce rows to typed values, aligned to the inferred column types.
  const rows: unknown[][] = rawRows.map((r) =>
    columns.map((c, ci) => coerce(r[ci] ?? null, c.dataType)),
  )

  return { name, columns, rows, rowCount }
}
