/**
 * APPLICATION — Propose a baseline suite (pure)
 *
 * Reads what the model and the database already say about themselves, and
 * drafts the checks a reviewer would otherwise build by hand.
 *
 * Why this matters more than it looks: coverage in reconciliation is purely a
 * function of how cheap a check is to create. Built one at a time, a suite
 * covers the tables someone already suspected — and the table nobody suspected
 * is the one that drifts. Composing the generators mechanically is what makes
 * checking ALL of them realistic.
 *
 * Everything here PROPOSES. Nothing is added without the reviewer ticking it,
 * because a mapping can be wrong and a deliberate Power Query filter will
 * produce a difference that is correct.
 */
import { dateCoverage, duplicateKeys, rowCount, type GeneratedPair } from './generators'

export interface ProposeSource {
  name: string
  kind: 'query' | 'calculated' | 'none' | 'other'
  /** Partition M, used to find the SQL object and to spot transformations. */
  expression?: string
}

export interface ProposeColumn {
  name: string
  dataType: string
}

export interface ProposeObject {
  schema: string
  name: string
  kind: 'table' | 'view'
  columns: ProposeColumn[]
  /** Declared primary key, in key order. Empty for a view. */
  primaryKey?: string[]
}

export type ProposalKind = 'rowCount' | 'dateRange' | 'duplicates'

export interface Proposal {
  id: string
  name: string
  kind: ProposalKind
  /** Model table. */
  table: string
  /** The SQL object it was matched to, qualified. */
  object: string
  queries: GeneratedPair
  /** How the model table found its SQL object. Name matching is a guess. */
  matchedBy: 'query' | 'name'
  /** Why this one may be noisy. Shown so a reviewer can untick it knowingly. */
  caution?: string
  selected: boolean
}

/** SQL types that carry a calendar date worth checking coverage on. */
const DATE_TYPES = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'])

/** More than a couple of date columns per table is noise — Dim_Date alone can
 * carry half a dozen. The reviewer can always build more by hand. */
const MAX_DATE_CHECKS_PER_TABLE = 2

/** Power Query steps that REMOVE rows. A table shaped by one of these will
 * legitimately disagree with its source, and a check that always fails trains
 * people to ignore the suite. */
const FILTER_STEPS = /Table\.SelectRows|Table\.RemoveRows|Table\.FirstN|Table\.Range|Table\.Distinct/

/** Pull the SQL object named in a table's Power Query, when there is one. */
export function sqlObjectFromM(m?: string): { schema?: string; object: string } | null {
  if (!m || !/Sql\.Databases?\s*\(/.test(m)) return null
  const item = m.match(/Item\s*=\s*"([^"]+)"/)?.[1]
  if (!item) return null
  return { schema: m.match(/Schema\s*=\s*"([^"]+)"/)?.[1], object: item }
}

function matchObject(
  source: ProposeSource,
  schema: ProposeObject[],
): { object: ProposeObject; matchedBy: 'query' | 'name' } | null {
  const fromM = sqlObjectFromM(source.expression)
  if (fromM) {
    const hit = schema.find(
      (o) => o.name.toLowerCase() === fromM.object.toLowerCase() &&
        (!fromM.schema || o.schema.toLowerCase() === fromM.schema.toLowerCase()),
    )
    if (hit) return { object: hit, matchedBy: 'query' }
  }
  // A model built from extracts names no SQL object at all, and reconciling
  // exactly that case is the point — so fall back to the table name.
  const byName = schema.find((o) => o.name.toLowerCase() === source.name.toLowerCase())
  return byName ? { object: byName, matchedBy: 'name' } : null
}

let seq = 0
const id = () => `prop_${++seq}`

/** Reset between runs so ids stay short and predictable in tests. */
export function resetProposalIds(): void { seq = 0 }

export function proposeChecks(sources: ProposeSource[], schema: ProposeObject[]): Proposal[] {
  const out: Proposal[] = []

  for (const source of sources) {
    // A calculated table is derived inside the model; there is no source to
    // reconcile it against, so proposing one could only mislead.
    if (source.kind !== 'query') continue

    const match = matchObject(source, schema)
    if (!match) continue // nothing to compare it to — silently skipped, not a failure

    const { object, matchedBy } = match
    const target = { table: source.name, sqlObject: object.name, sqlSchema: object.schema }
    const qualified = `${object.schema}.${object.name}`

    const cautions: string[] = []
    if (matchedBy === 'name') cautions.push('matched by name, not by the table’s source query')
    if (FILTER_STEPS.test(source.expression ?? '')) {
      cautions.push('the model filters rows out of this table, so a difference may be correct')
    }
    const caution = cautions.length > 0 ? cautions.join('; ') : undefined

    const add = (kind: ProposalKind, name: string, queries: GeneratedPair) =>
      out.push({ id: id(), name, kind, table: source.name, object: qualified, queries, matchedBy, caution, selected: true })

    add('rowCount', `${source.name} — row count`, rowCount(target))

    for (const col of object.columns.filter((c) => DATE_TYPES.has(c.dataType.toLowerCase())).slice(0, MAX_DATE_CHECKS_PER_TABLE)) {
      add('dateRange', `${source.name} — ${col.name} range`, dateCoverage({ ...target, column: col.name, sqlColumn: col.name }))
    }

    // Only on a DECLARED primary key. Guessing a business key from column names
    // would produce confident checks against the wrong grain, which is worse
    // than proposing none.
    if (object.primaryKey && object.primaryKey.length > 0) {
      add(
        'duplicates',
        `${source.name} — duplicate ${object.primaryKey.join(' + ')}`,
        duplicateKeys({ ...target, columns: object.primaryKey.map((c) => ({ model: c, sql: c })) }),
      )
    }
  }

  return out
}

/** Tables the model holds that could not be matched, so the reviewer learns
 * what was left out instead of wondering. */
export function unmatched(sources: ProposeSource[], schema: ProposeObject[]): { name: string; why: string }[] {
  const out: { name: string; why: string }[] = []
  for (const s of sources) {
    if (s.kind === 'calculated') { out.push({ name: s.name, why: 'calculated in the model — no source to compare against' }); continue }
    if (s.kind !== 'query') continue
    if (!matchObject(s, schema)) out.push({ name: s.name, why: 'no SQL table or view of that name' })
  }
  return out
}
