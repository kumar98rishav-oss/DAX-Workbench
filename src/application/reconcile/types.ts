/**
 * APPLICATION — Reconciliation types
 *
 * Two engines, two result sets, one comparison layer. The tool never translates
 * DAX into SQL: the user writes both and asserts they should agree. We only ever
 * execute faithfully and compare accurately.
 *
 * SOURCE = SQL Server (the system of record).
 * TARGET = the Power BI model (what we are validating).
 *
 * The central rule: a field is NEVER referenced by a bare column name. Every
 * reference carries the id of the result set it came from, so a source column
 * and a target column cannot be confused — that is a type error, not a matter
 * of UI discipline.
 */

export type Origin = 'source' | 'target'

export interface ResultColumn {
  name: string
  /** Engine-reported type, for display only — never used for comparison. */
  dataType?: string
}

/** One execution of one query against one engine. Immutable: re-running a query
 * produces a NEW result set, so a comparison can always state exactly which two
 * executions it compared and when. */
export interface ResultSet {
  id: string
  origin: Origin
  /** User-editable, e.g. "Sales by month (warehouse)". */
  label: string
  /** The exact query text that produced these rows. */
  query: string
  /** ISO timestamp — half of the honesty story; see `drift` in the summary. */
  executedAt: string
  durationMs: number
  columns: ResultColumn[]
  rows: unknown[][]
  /** True when the engine hit the row cap. A truncated side makes any
   * comparison invalid — see `Refusal`. */
  truncated: boolean
}

/** A column, always qualified by the result set it belongs to. */
export interface FieldRef {
  resultSetId: string
  column: string
}

/** An explicit pairing. The user always pairs both sides by hand: name matching
 * across a warehouse and a model is exactly where silent mis-joins come from. */
export interface FieldPair {
  source: FieldRef
  target: FieldRef
  /** Display name for the pair; defaults to the target column. */
  label?: string
}

export interface Tolerance {
  /** Absolute difference treated as equal. */
  absolute: number
  /** Fractional difference treated as equal (0.01 = 1%), measured against the
   * source value — the system of record is the denominator. */
  relative: number
}

/** Counts are integers and should agree exactly. */
export const EXACT: Tolerance = { absolute: 0, relative: 0 }

export type RowStatus = 'match' | 'mismatch' | 'onlySource' | 'onlyTarget'

export interface ComparisonCell {
  /**
   * null means the side produced no value (SQL NULL / DAX BLANK).
   *
   * A string means the pair was compared as TEXT — dates, codes, names. Those
   * are legitimate things to reconcile (is MIN(OrderDate) the same on both
   * sides?) and they must not be waved through: comparing them numerically
   * yields null on both sides, which reads as agreement no matter how far apart
   * the real values are.
   */
  sourceValue: number | string | null
  targetValue: number | string | null
  /** target − source, with null treated as 0. null when both sides are null, and
   * null for a text comparison — there is nothing to subtract. */
  delta: number | null
  status: RowStatus
}

export interface ComparisonRow {
  /** Normalized key parts, in the order the key pairs were given. */
  key: string[]
  /** Collision-proof composite of `key`; the join identity. */
  compositeKey: string
  /** Worst status across the row's cells. */
  status: RowStatus
  /** How many underlying rows aggregated into this key, per side. A count above
   * 1 means the key is not unique at this grain — itself a finding. */
  sourceRowCount: number
  targetRowCount: number
  cells: ComparisonCell[]
}

/**
 * Why we are refusing to render a comparison.
 *
 * A wrong answer that looks authoritative is worse than no answer: a truncated
 * side or a mis-paired key both paint a confident red matrix that sends the user
 * hunting a data problem that does not exist. Both block rather than warn.
 */
export type Refusal =
  | {
      kind: 'truncated'
      side: Origin | 'both'
      message: string
    }
  | {
      kind: 'noKeyOverlap'
      sourceKeys: number
      targetKeys: number
      sampleSource: string[]
      sampleTarget: string[]
      message: string
    }
  | {
      kind: 'emptyBothSides'
      message: string
    }

export interface ComparisonSummary {
  matched: number
  mismatched: number
  onlySource: number
  onlyTarget: number
  /** Distinct keys seen per side. */
  sourceKeys: number
  targetKeys: number
  /** Keys whose grain was not unique — the comparator summed them. */
  sourceDuplicateKeys: number
  targetDuplicateKeys: number
  /** Gap between the two executions, in ms. Large gaps invite drift. */
  driftMs: number
}

export interface ComparisonResult {
  rows: ComparisonRow[]
  summary: ComparisonSummary
  /** Set when the comparison must not be trusted; `rows` is empty. */
  refusal?: Refusal
}
