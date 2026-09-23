/**
 * APPLICATION — DAX reference validation (pure)
 *
 * "Does this DAX reference only things that exist in the model?" — the static
 * half of trust-but-verify. It is a DIFFERENT job from parseDependencies:
 * that finds the KNOWN dependencies for the graph and deliberately drops
 * anything it can't resolve; this finds the UNKNOWN references so an
 * AI-invented table, column, or measure is caught before a measure is saved.
 *
 * The hard parts, all covered by validate.test.ts:
 *  - a bare `[X]` is a measure ref OR a row-context column ref
 *  - `'Table'[Measure]` is a legal way to write a measure ref, not a column
 *  - table-only refs (ALL(T), COUNTROWS(T)) to a missing table must be caught
 *  - DAX `VAR` names and function names must NOT be mistaken for missing tables
 */
import type { SemanticModel } from '@/domain/model'
import { maskLiterals } from './dependencies'

export interface RefValidation {
  ok: boolean
  /** `Table[Column]` where the table exists but the column does not. */
  unknownColumns: string[]
  /** Table-only references to a table that isn't in the model. */
  unknownTables: string[]
  /** Bare `[Name]` that matches no measure and no column. */
  unknownMeasures: string[]
}

/** Table-valued functions whose FIRST argument is a table reference. Used to
 * find `ALL(MissingTable)`-style refs that carry no column to give them away.
 * (CALENDAR/CALENDARAUTO take dates, not a table, so they're excluded.) */
const TABLE_ARG_FN =
  'COUNTROWS|ALL|ALLEXCEPT|ALLSELECTED|ALLCROSSFILTERED|ALLNOBLANKROW|FILTER|VALUES|DISTINCT|' +
  'RELATEDTABLE|SUMMARIZE|SUMMARIZECOLUMNS|CALCULATETABLE|ADDCOLUMNS|SELECTCOLUMNS|TOPN|GROUPBY|' +
  'NATURALINNERJOIN|NATURALLEFTOUTERJOIN|TREATAS|INTERSECT|UNION|EXCEPT|CROSSJOIN'

/**
 * Validate every table/column/measure reference in a DAX expression against the
 * model. `extraMeasures` lets a caller treat measures that are being created in
 * the same batch (not yet in the model) as known, so a suite doesn't flag its
 * own siblings.
 */
export function validateReferences(
  expression: string,
  model: SemanticModel,
  extraMeasures: string[] = [],
): RefValidation {
  const expr = maskLiterals(expression ?? '')

  const tableNames = new Set(model.tables.map((t) => t.name.toLowerCase()))
  const measureNames = new Set([
    ...model.tables.flatMap((t) => t.measures.map((m) => m.name.toLowerCase())),
    ...extraMeasures.map((n) => n.toLowerCase()),
  ])
  const columnKeys = new Set(
    model.tables.flatMap((t) => t.columns.map((c) => `${t.name.toLowerCase()}[${c.name.toLowerCase()}]`)),
  )
  const columnNames = new Set(model.tables.flatMap((t) => t.columns.map((c) => c.name.toLowerCase())))

  // DAX variables are local names, not model objects — collect them so a
  // `RETURN COUNTROWS(myVar)` never reads as a missing table.
  const varNames = new Set<string>()
  const varRe = /\bVAR\s+([A-Za-z_][\w]*)/gi
  let m: RegExpExecArray | null
  while ((m = varRe.exec(expr))) varNames.add(m[1].toLowerCase())

  const unknownColumns = new Set<string>()
  const unknownTables = new Set<string>()
  const unknownMeasures = new Set<string>()

  // 1) Qualified refs: 'Table'[Name] or Table[Name]
  const colRe = /(?:'([^']+)'|([A-Za-z_][\w]*))\s*\[([^\]]+)\]/g
  const consumed: Array<[number, number]> = []
  while ((m = colRe.exec(expr))) {
    const table = (m[1] ?? m[2]).trim()
    const name = m[3].trim()
    consumed.push([m.index, colRe.lastIndex])
    const tl = table.toLowerCase()
    if (columnKeys.has(`${tl}[${name.toLowerCase()}]`)) continue // real column
    if (measureNames.has(name.toLowerCase())) continue // 'Table'[Measure] — legal measure ref
    if (varNames.has(tl)) continue // variable, not a model table
    if (tableNames.has(tl)) unknownColumns.add(`${table}[${name}]`) // real table, missing column
    else unknownTables.add(table) // table itself doesn't exist
  }

  // 2) Bare [Name] → measure ref or row-context column ref
  const brRe = /\[([^\]]+)\]/g
  while ((m = brRe.exec(expr))) {
    const idx = m.index
    const end = brRe.lastIndex
    if (consumed.some(([s, e]) => idx >= s && end <= e)) continue
    const name = m[1].trim()
    const key = name.toLowerCase()
    if (measureNames.has(key) || columnNames.has(key)) continue
    unknownMeasures.add(`[${name}]`)
  }

  // 3) Table-only refs inside table functions, e.g. ALL(Sales), COUNTROWS(Dates)
  const tblFn = new RegExp(`(?:${TABLE_ARG_FN})\\s*\\(\\s*(?:'([^']+)'|([A-Za-z_][\\w]*))\\s*(?=[,)])`, 'gi')
  while ((m = tblFn.exec(expr))) {
    const tbl = (m[1] ?? m[2]).trim()
    const tl = tbl.toLowerCase()
    if (tableNames.has(tl) || varNames.has(tl)) continue
    unknownTables.add(tbl)
  }

  return {
    ok: unknownColumns.size === 0 && unknownTables.size === 0 && unknownMeasures.size === 0,
    unknownColumns: [...unknownColumns],
    unknownTables: [...unknownTables],
    unknownMeasures: [...unknownMeasures],
  }
}

/** Flat list of every unresolved reference, formatted for display. */
export function unknownReferences(expression: string, model: SemanticModel, extraMeasures: string[] = []): string[] {
  const v = validateReferences(expression, model, extraMeasures)
  return [...v.unknownTables, ...v.unknownColumns, ...v.unknownMeasures]
}
