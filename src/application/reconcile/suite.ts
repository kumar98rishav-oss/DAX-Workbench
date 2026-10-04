/**
 * APPLICATION — Check suites (pure)
 *
 * A saved check is a reconciliation you can run again: the two queries, the
 * pairing, and the tolerance. A suite is a set of them you run after every
 * refresh to find out what moved.
 *
 * The one decision everything else hangs off: a check that could not be
 * evaluated is NOT a pass. See `classify`.
 */
import type {
  ComparisonResult,
  ComparisonSummary,
  FieldPair,
  Refusal,
  ResultSet,
  RowStatus,
  Tolerance,
} from './types'

/**
 * A pairing as it is STORED.
 *
 * Deliberately column names rather than the `FieldRef`s the comparator uses. A
 * FieldRef carries a result-set id, which is what makes source and target
 * impossible to confuse during a live comparison — but a saved check has no
 * result sets yet, and the ids change on every run. Names are the stable
 * identity; `bindCheck` turns them back into FieldRefs at run time.
 */
export interface StoredPair {
  source: string
  target: string
}

export interface SavedCheck {
  id: string
  name: string
  /** T-SQL, run against the source. */
  sourceQuery: string
  /** DAX, run against the model. */
  targetQuery: string
  keys: StoredPair[]
  values: StoredPair[]
  tolerance: Tolerance
  /** Skipped by Run all when false, but kept in the suite. */
  enabled: boolean
  /** Model table this check belongs to, recorded so the list can group by it.
   * Absent for hand-built checks — those group under "Other", because guessing
   * a table from a name the user typed would put checks in the wrong place. */
  table?: string
}

export interface CheckSuite {
  id: string
  name: string
  /** What this suite was built against — a label for warning when the current
   * connection differs. Never credentials: no password is ever persisted. */
  builtAgainst?: { server: string; database?: string }
  checks: SavedCheck[]
}

export type CheckStatus = 'pass' | 'fail' | 'inconclusive'

/** What one value pair actually returned, kept so the result can show its
 * working rather than asserting it. */
export interface EvidenceValue {
  label: string
  source: number | string | null
  target: number | string | null
  delta: number | null
  status: RowStatus
}

/**
 * The numbers behind a verdict.
 *
 * "1 matched" is a claim; "19,658 = 19,658" is evidence. A reconciliation tool
 * that reports agreement without showing what agreed is asking for exactly the
 * trust it exists to replace — so every run keeps the values it compared, and
 * the row counts each engine returned to produce them.
 */
export interface CheckEvidence {
  /** One entry per value pair. Present only when the comparison produced a
   * single row: a grain check has no one row to quote, and inventing a
   * representative would be worse than saying how many were compared. */
  values?: EvidenceValue[]
  /** Distinct keys compared. 1 for a scalar check. */
  comparedRows: number
  /** Rows each engine actually returned, so a surprising verdict can be traced
   * back to a query that returned more or less than expected. */
  sourceRows: number
  targetRows: number
}

export function evidenceFrom(
  result: ComparisonResult,
  valueLabels: string[],
  sourceRows: number,
  targetRows: number,
): CheckEvidence {
  const base = { comparedRows: result.rows.length, sourceRows, targetRows }
  if (result.rows.length !== 1) return base
  const row = result.rows[0]
  return {
    ...base,
    values: row.cells.map((c, i) => ({
      label: valueLabels[i] ?? `value ${i + 1}`,
      source: c.sourceValue,
      target: c.targetValue,
      delta: c.delta,
      status: c.status,
    })),
  }
}

export interface CheckRun {
  checkId: string
  name: string
  status: CheckStatus
  summary?: ComparisonSummary
  /** The numbers that produced the verdict. */
  evidence?: CheckEvidence
  refusal?: Refusal
  /** Why it could not run: a query error, a missing column, a lost connection. */
  error?: string
  durationMs: number
  ranAt: string
}

export interface SuiteRun {
  startedAt: string
  finishedAt: string
  runs: CheckRun[]
  passed: number
  failed: number
  inconclusive: number
}

/**
 * Pass, fail, or could-not-tell.
 *
 * The third outcome is the whole point. A refusal — truncated side, no key
 * overlap, nothing returned — means the check did not run, and folding that
 * into "pass" would reintroduce exactly the false green this tool exists to
 * prevent: a suite reporting all-clear because half of it silently failed to
 * evaluate. Folding it into "fail" is wrong too; it would send someone hunting
 * a data problem when the real fix is the check's own configuration.
 *
 * So inconclusive is counted and shown on its own, and a suite with any
 * inconclusive check is never described as passing.
 */
export function classify(result: ComparisonResult): CheckStatus {
  if (result.refusal) return 'inconclusive'
  const s = result.summary
  const clean = s.mismatched === 0 && s.onlySource === 0 && s.onlyTarget === 0
  return clean ? 'pass' : 'fail'
}

/** Resolve a saved check's stored column names against the result sets a run
 * just produced. Throws naming the check and the column, because "Column not
 * present" is useless when twenty checks ran. */
export function bindCheck(
  check: SavedCheck,
  source: ResultSet,
  target: ResultSet,
): { keys: FieldPair[]; values: FieldPair[] } {
  const has = (rs: ResultSet, col: string) => rs.columns.some((c) => c.name === col)

  const bind = (pairs: StoredPair[], kind: string): FieldPair[] =>
    pairs.map((p) => {
      if (!has(source, p.source)) {
        throw new Error(`"${check.name}": the source query no longer returns a ${kind} column named "${p.source}".`)
      }
      if (!has(target, p.target)) {
        throw new Error(`"${check.name}": the target query no longer returns a ${kind} column named "${p.target}".`)
      }
      return {
        source: { resultSetId: source.id, column: p.source },
        target: { resultSetId: target.id, column: p.target },
      }
    })

  return { keys: bind(check.keys, 'key'), values: bind(check.values, 'value') }
}

export function summarize(runs: CheckRun[]): Pick<SuiteRun, 'passed' | 'failed' | 'inconclusive'> {
  let passed = 0
  let failed = 0
  let inconclusive = 0
  for (const r of runs) {
    if (r.status === 'pass') passed++
    else if (r.status === 'fail') failed++
    else inconclusive++
  }
  return { passed, failed, inconclusive }
}

/**
 * One line for the top of the screen.
 *
 * A suite is only "all clear" when every check actually ran AND agreed. Any
 * check that could not be evaluated is named separately, never absorbed.
 */
export function verdict(run: SuiteRun): string {
  const total = run.runs.length
  if (total === 0) return 'No checks to run.'
  if (run.failed === 0 && run.inconclusive === 0) {
    return `All clear — ${total} check${total === 1 ? '' : 's'} passed.`
  }
  const parts: string[] = [`${run.passed} passed`]
  if (run.failed > 0) parts.push(`${run.failed} failed`)
  if (run.inconclusive > 0) parts.push(`${run.inconclusive} could not run`)
  return parts.join(' · ')
}

export interface CheckGroup {
  table: string
  checks: SavedCheck[]
}

/** Hand-built checks have no table; they collect here rather than being guessed into
 * someone else's group. */
export const OTHER_GROUP = 'Other checks'

/**
 * Group checks by the table they test, preserving first-seen order.
 *
 * Forty-five checks in a flat list is a wall. Grouped, the question a reader
 * actually has — "which table is unhappy?" — is answerable without scrolling.
 */
export function groupChecks(checks: SavedCheck[]): CheckGroup[] {
  const map = new Map<string, SavedCheck[]>()
  for (const c of checks) {
    const key = c.table ?? OTHER_GROUP
    const existing = map.get(key)
    if (existing) existing.push(c)
    else map.set(key, [c])
  }
  return [...map.entries()].map(([table, group]) => ({ table, checks: group }))
}

/** A stable id without pulling in a uuid dependency. */
export const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** Suggest a name from the queries, so saving does not demand typing. */
export function suggestName(sourceQuery: string, targetQuery: string): string {
  const from = sourceQuery.match(/FROM\s+(\[?[\w ]+\]?\.)?\[?([\w ]+)\]?/i)?.[2]
  const dax = targetQuery.match(/\b(COUNTROWS|DISTINCTCOUNTNOBLANK|COUNTBLANK|SUMMARIZE|SUM)\b/i)?.[1]
  const what =
    dax === 'COUNTROWS' ? 'row count'
      : dax === 'DISTINCTCOUNTNOBLANK' ? 'distinct values'
        : dax === 'COUNTBLANK' ? 'blanks'
          : dax === 'SUMMARIZE' ? 'by grain'
            : dax === 'SUM' ? 'total'
              : 'check'
  return from ? `${from} — ${what}` : what
}
