/**
 * APPLICATION — DAX dependency extraction (pure)
 * Parses a measure expression into the columns, tables, measures, and
 * functions it references — powering the dependency graph.
 */
import type { SemanticModel } from '@/domain/model'
import { DAX_BY_NAME } from './functions'

export interface DaxDependencies {
  columns: { table: string; column: string }[]
  tables: string[]
  measures: string[]
  functions: string[]
}

export function parseDependencies(expression: string, model: SemanticModel, selfName?: string): DaxDependencies {
  const expr = expression ?? ''
  const measureNames = new Map(model.tables.flatMap((t) => t.measures.map((m) => [m.name.toLowerCase(), m.name] as const)))
  const tableNames = new Set(model.tables.map((t) => t.name.toLowerCase()))
  const self = selfName?.toLowerCase()

  const columns: { table: string; column: string }[] = []
  const tables = new Set<string>()
  const measures = new Set<string>()
  const functions = new Set<string>()

  // Column refs: 'Table'[Col] or Table[Col]
  const colRe = /(?:'([^']+)'|([A-Za-z_][\w]*))\s*\[([^\]]+)\]/g
  const consumed: Array<[number, number]> = []
  let m: RegExpExecArray | null
  while ((m = colRe.exec(expr))) {
    const table = (m[1] ?? m[2]).trim()
    columns.push({ table, column: m[3].trim() })
    tables.add(table)
    consumed.push([m.index, colRe.lastIndex])
  }

  // Lone [X] → measure reference (if it matches a known measure)
  const brRe = /\[([^\]]+)\]/g
  while ((m = brRe.exec(expr))) {
    if (consumed.some(([s, e]) => (m as RegExpExecArray).index >= s && brRe.lastIndex <= e)) continue
    const key = m[1].trim().toLowerCase()
    if (measureNames.has(key) && key !== self) measures.add(measureNames.get(key)!)
  }

  // Functions
  const fnRe = /\b([A-Z][A-Z0-9.]{1,})\s*\(/g
  while ((m = fnRe.exec(expr))) {
    if (DAX_BY_NAME[m[1]]) functions.add(m[1])
  }

  // Table-only refs inside table functions, e.g. COUNTROWS(Sales), ALL(Sales)
  const tblFn = /(?:COUNTROWS|ALL|ALLEXCEPT|ALLSELECTED|FILTER|VALUES|DISTINCT|RELATEDTABLE|SUMMARIZE|SUMMARIZECOLUMNS|CALCULATETABLE|ADDCOLUMNS|SELECTCOLUMNS|TOPN|GROUPBY|CALENDAR)\s*\(\s*(?:'([^']+)'|([A-Za-z_][\w]*))\s*(?=[,)])/g
  while ((m = tblFn.exec(expr))) {
    const tbl = (m[1] ?? m[2]).trim()
    if (tableNames.has(tbl.toLowerCase())) tables.add(tbl)
  }

  // dedupe columns
  const seen = new Set<string>()
  const cols = columns.filter((c) => {
    const k = `${c.table}[${c.column}]`
    return seen.has(k) ? false : (seen.add(k), true)
  })

  return { columns: cols, tables: [...tables], measures: [...measures], functions: [...functions] }
}
