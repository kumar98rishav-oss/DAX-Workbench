/**
 * APPLICATION — The comparison layer (pure)
 *
 * Takes two result sets, a user-supplied key pairing and value pairing, and
 * produces a row-per-key comparison. No I/O, no engine knowledge: string and
 * number in, verdict out — which is what makes the accuracy claim testable
 * without a database.
 *
 * Aggregation is deliberate, not an edge case. A user who writes a row-level
 * SQL query and pairs only [Year] as the key NEEDS the rows summed to that
 * grain. So both sides are grouped by key and values summed, and the per-side
 * row count is reported so a non-unique key is visible rather than silent.
 */
import {
  compositeKey,
  displayKeyPart,
  normalizeKeyValue,
  toComparableNumber,
  DEFAULT_NORMALIZE,
  type NormalizeOptions,
} from './normalize'
import {
  EXACT,
  type ComparisonCell,
  type ComparisonResult,
  type ComparisonRow,
  type FieldPair,
  type ResultSet,
  type RowStatus,
  type Tolerance,
} from './types'

export interface CompareOptions {
  normalize?: NormalizeOptions
  tolerance?: Tolerance
  /** Below this many matched keys (with both sides non-empty) we refuse and
   * report a probable key-pairing mistake instead of a wall of red. */
  minKeyOverlap?: number
}

/**
 * What one value column accumulated inside one key bucket.
 *
 * Numbers are summed to the grain. Non-numeric values — dates, codes, names —
 * cannot be summed, so the first one is kept and `multi` records that the
 * bucket held more than one distinct value, which is itself a finding.
 */
interface ValueAgg {
  sum: number | null
  /** First non-numeric value, already normalized for comparison. */
  text: string | null
  /** More than one DISTINCT non-numeric value landed here. */
  multi: boolean
  /** At least one value was present and was not a number. */
  nonNumeric: boolean
}

const emptyAgg = (): ValueAgg => ({ sum: null, text: null, multi: false, nonNumeric: false })

interface Bucket {
  rowCount: number
  /** One accumulator per value pair. */
  vals: ValueAgg[]
}

const columnIndex = (rs: ResultSet, column: string): number =>
  rs.columns.findIndex((c) => c.name === column)

/** Group one side by its normalized key, summing each value column. */
function bucketize(
  rs: ResultSet,
  keyColumns: string[],
  valueColumns: string[],
  opts: NormalizeOptions,
): { buckets: Map<string, Bucket>; display: Map<string, string[]>; missingColumns: string[] } {
  const missingColumns: string[] = []
  const keyIdx = keyColumns.map((c) => {
    const i = columnIndex(rs, c)
    if (i < 0) missingColumns.push(c)
    return i
  })
  const valIdx = valueColumns.map((c) => {
    const i = columnIndex(rs, c)
    if (i < 0) missingColumns.push(c)
    return i
  })

  const buckets = new Map<string, Bucket>()
  const display = new Map<string, string[]>()
  if (missingColumns.length > 0) return { buckets, display, missingColumns }

  for (const row of rs.rows) {
    const parts = keyIdx.map((i) => normalizeKeyValue(row[i], opts))
    const key = compositeKey(parts)

    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { rowCount: 0, vals: valueColumns.map(emptyAgg) }
      buckets.set(key, bucket)
      display.set(key, parts.map(displayKeyPart))
    }
    bucket.rowCount++

    for (let v = 0; v < valIdx.length; v++) {
      const raw = row[valIdx[v]]
      const agg = bucket.vals[v]
      const n = toComparableNumber(raw)
      if (n !== null) { agg.sum = (agg.sum ?? 0) + n; continue }
      // Genuinely blank — contributes nothing either way.
      if (raw === null || raw === undefined || raw === '') continue
      // Present but not a number: keep it as text so it can still be compared.
      const text = normalizeKeyValue(raw, opts)
      if (agg.text === null) agg.text = text
      else if (agg.text !== text) agg.multi = true
      agg.nonNumeric = true
    }
  }

  return { buckets, display, missingColumns }
}

/** Is this difference inside tolerance? Relative is measured against the
 * source — the system of record is the denominator. */
function withinTolerance(source: number, target: number, tol: Tolerance): boolean {
  const delta = Math.abs(target - source)
  if (delta === 0) return true
  if (delta <= tol.absolute) return true
  if (tol.relative > 0 && source !== 0 && delta / Math.abs(source) <= tol.relative) return true
  return false
}

function cellFor(s: ValueAgg | undefined, t: ValueAgg | undefined, tol: Tolerance): ComparisonCell {
  // ── Text comparison ──────────────────────────────────────────────────────
  // If either side produced a value that is not a number, this pair cannot be
  // subtracted. Falling back to the numeric path here was a real false green:
  // both sides parse to null, null equals null, and '2023-01-01' vs
  // '2024-12-31' reported as a match.
  if (s?.nonNumeric || t?.nonNumeric) {
    const show = (a?: ValueAgg): number | string | null =>
      a?.multi ? '(multiple values)' : a?.text != null ? displayKeyPart(a.text) : a?.sum ?? null
    // A bucket holding several different text values has no single answer, so
    // it can never be declared equal.
    const comparable = !s?.multi && !t?.multi
    return {
      sourceValue: show(s),
      targetValue: show(t),
      delta: null,
      status: comparable && (s?.text ?? null) === (t?.text ?? null) ? 'match' : 'mismatch',
    }
  }

  // ── Numeric comparison ───────────────────────────────────────────────────
  const sv = s?.sum ?? null
  const tv = t?.sum ?? null
  if (sv === null && tv === null) {
    return { sourceValue: null, targetValue: null, delta: null, status: 'match' }
  }
  // A blank on one side is a real difference, so it is compared as 0 rather
  // than skipped — but both raw values are kept so the UI can show "(blank)"
  // instead of pretending the engine returned a zero.
  const a = sv ?? 0
  const b = tv ?? 0
  return {
    sourceValue: sv,
    targetValue: tv,
    delta: b - a,
    status: withinTolerance(a, b, tol) ? 'match' : 'mismatch',
  }
}

const WORST: Record<RowStatus, number> = { match: 0, mismatch: 2, onlySource: 3, onlyTarget: 3 }

export function compare(
  source: ResultSet,
  target: ResultSet,
  keys: FieldPair[],
  values: FieldPair[],
  options: CompareOptions = {},
): ComparisonResult {
  const norm = options.normalize ?? DEFAULT_NORMALIZE
  const tol = options.tolerance ?? EXACT
  const minOverlap = options.minKeyOverlap ?? 1

  const driftMs = Math.abs(Date.parse(target.executedAt) - Date.parse(source.executedAt)) || 0
  const empty = (refusal: ComparisonResult['refusal']): ComparisonResult => ({
    rows: [],
    refusal,
    summary: {
      matched: 0,
      mismatched: 0,
      onlySource: 0,
      onlyTarget: 0,
      sourceKeys: 0,
      targetKeys: 0,
      sourceDuplicateKeys: 0,
      targetDuplicateKeys: 0,
      driftMs,
    },
  })

  // ── Refuse on truncation ────────────────────────────────────────────────
  // A truncated side manufactures thousands of false "only in …" rows, and the
  // result looks authoritative while being completely wrong.
  if (source.truncated || target.truncated) {
    const side = source.truncated && target.truncated ? 'both' : source.truncated ? 'source' : 'target'
    return empty({
      kind: 'truncated',
      side,
      message:
        side === 'both'
          ? 'Both queries hit the row cap. Narrow the grain or add a filter — a truncated comparison would report differences that do not exist.'
          : `The ${side} query hit the row cap, so rows are missing from one side only. Narrow the grain or add a filter — comparing now would report differences that do not exist.`,
    })
  }

  const keyColsSource = keys.map((k) => k.source.column)
  const keyColsTarget = keys.map((k) => k.target.column)
  const valColsSource = values.map((v) => v.source.column)
  const valColsTarget = values.map((v) => v.target.column)

  const S = bucketize(source, keyColsSource, valColsSource, norm)
  const T = bucketize(target, keyColsTarget, valColsTarget, norm)

  if (S.missingColumns.length > 0 || T.missingColumns.length > 0) {
    const missing = [...S.missingColumns, ...T.missingColumns].join(', ')
    throw new Error(`Column not present in its result set: ${missing}`)
  }

  if (S.buckets.size === 0 && T.buckets.size === 0) {
    return empty({ kind: 'emptyBothSides', message: 'Both queries returned no rows — there is nothing to compare.' })
  }

  // ── Refuse on zero key overlap ──────────────────────────────────────────
  // Both sides have data but nothing joins: almost always a wrong pairing, not
  // a 100% mismatch. Saying so beats painting the whole matrix red.
  let overlap = 0
  for (const key of S.buckets.keys()) if (T.buckets.has(key)) overlap++

  if (S.buckets.size > 0 && T.buckets.size > 0 && overlap < minOverlap) {
    const sample = (m: Map<string, string[]>) =>
      [...m.values()].slice(0, 3).map((parts) => parts.join(' · '))
    return empty({
      kind: 'noKeyOverlap',
      sourceKeys: S.buckets.size,
      targetKeys: T.buckets.size,
      sampleSource: sample(S.display),
      sampleTarget: sample(T.display),
      message:
        `0 of ${S.buckets.size.toLocaleString()} source keys matched any of ${T.buckets.size.toLocaleString()} target keys. ` +
        'That is almost always a key-pairing mistake rather than a total mismatch — check that the paired columns hold the same thing.',
    })
  }

  // ── Full outer join ─────────────────────────────────────────────────────
  const rows: ComparisonRow[] = []
  let matched = 0
  let mismatched = 0
  let onlySource = 0
  let onlyTarget = 0
  let sourceDuplicateKeys = 0
  let targetDuplicateKeys = 0

  const emit = (key: string, s: Bucket | undefined, t: Bucket | undefined, display: string[]) => {
    if (s && s.rowCount > 1) sourceDuplicateKeys++
    if (t && t.rowCount > 1) targetDuplicateKeys++

    const cells = values.map((_, i) => cellFor(s?.vals[i], t?.vals[i], tol))

    let status: RowStatus
    if (!t) status = 'onlySource'
    else if (!s) status = 'onlyTarget'
    else status = cells.some((c) => c.status === 'mismatch') ? 'mismatch' : 'match'

    if (status === 'match') matched++
    else if (status === 'mismatch') mismatched++
    else if (status === 'onlySource') onlySource++
    else onlyTarget++

    rows.push({
      key: display,
      compositeKey: key,
      status,
      sourceRowCount: s?.rowCount ?? 0,
      targetRowCount: t?.rowCount ?? 0,
      cells,
    })
  }

  for (const [key, s] of S.buckets) {
    emit(key, s, T.buckets.get(key), S.display.get(key) ?? [])
  }
  for (const [key, t] of T.buckets) {
    if (!S.buckets.has(key)) emit(key, undefined, t, T.display.get(key) ?? [])
  }

  // Worst first, then by largest absolute delta: the biggest problem should
  // never be buried below an alphabetical list of agreements.
  rows.sort((a, b) => {
    const w = WORST[b.status] - WORST[a.status]
    if (w !== 0) return w
    const magnitude = (r: ComparisonRow) =>
      Math.max(...r.cells.map((c) => Math.abs(c.delta ?? 0)), 0)
    return magnitude(b) - magnitude(a)
  })

  return {
    rows,
    summary: {
      matched,
      mismatched,
      onlySource,
      onlyTarget,
      sourceKeys: S.buckets.size,
      targetKeys: T.buckets.size,
      sourceDuplicateKeys,
      targetDuplicateKeys,
      driftMs,
    },
  }
}
