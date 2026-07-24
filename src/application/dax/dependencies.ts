/**
 * APPLICATION — DAX dependency extraction (pure)
 * Parses a measure expression into the columns, tables, measures, and
 * functions it references — powering the dependency graph.
 *
 * Accuracy note: this feeds the Cleanup surface, where a MISSED dependency
 * is dangerous (an object looks orphaned and gets deleted) while an extra
 * one is merely conservative (it blocks a delete). Every ambiguous case
 * below therefore resolves toward reporting MORE dependencies, not fewer.
 */
import type { SemanticModel } from '@/domain/model'
import { DAX_BY_NAME } from './functions'

export interface DaxDependencies {
  columns: { table: string; column: string }[]
  tables: string[]
  measures: string[]
  functions: string[]
  /**
   * Bare `[Name]` refs that match a column rather than a measure. The home
   * table is only implied by row context, so we cannot resolve it here —
   * callers must treat every same-named column as possibly referenced.
   */
  unqualified: string[]
}

/**
 * Blank out string literals and comments, preserving length so match offsets
 * still line up with the original expression. A `[Ref]` inside "a string" or
 * after a -- comment is not a dependency.
 */
export function maskLiterals(expr: string): string {
  const out = expr.split('')
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < out.length; k++) out[k] = ' '
  }
  let i = 0
  while (i < expr.length) {
    const c = expr[i]
    const n = expr[i + 1]
    // "string literal", with "" as the escaped quote
    if (c === '"') {
      let j = i + 1
      while (j < expr.length) {
        if (expr[j] === '"') {
          if (expr[j + 1] === '"') {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      blank(i, j)
      i = j
      continue
    }
    // -- line comment  //  // line comment
    if ((c === '-' && n === '-') || (c === '/' && n === '/')) {
      let j = i
      while (j < expr.length && expr[j] !== '\n') j++
      blank(i, j)
      i = j
      continue
    }
    // /* block comment */
    if (c === '/' && n === '*') {
      const end = expr.indexOf('*/', i + 2)
      const j = end === -1 ? expr.length : end + 2
      blank(i, j)
      i = j
      continue
    }
    i++
  }
  return out.join('')
}

/** Collision-proof key: JSON quoting keeps 'A B'+'C' distinct from 'A'+'B C'. */
function colKey(table: string, column: string): string {
  return JSON.stringify([table.toLowerCase(), column.toLowerCase()])
}

export function parseDependencies(expression: string, model: SemanticModel, selfName?: string): DaxDependencies {
  // Mask first: refs inside strings/comments are not real dependencies.
  const expr = maskLiterals(expression ?? '')
  const measureNames = new Map(
    model.tables.flatMap((t) => t.measures.map((m) => [m.name.toLowerCase(), m.name] as const)),
  )
  const tableNames = new Set(model.tables.map((t) => t.name.toLowerCase()))
  // Real columns, so a qualified ref can be told apart from a measure ref.
  const columnKeys = new Set(
    model.tables.flatMap((t) => t.columns.map((c) => colKey(t.name, c.name))),
  )
  const columnNames = new Set(model.tables.flatMap((t) => t.columns.map((c) => c.name.toLowerCase())))
  const self = selfName?.toLowerCase()

  const columns: { table: string; column: string }[] = []
  const tables = new Set<string>()
  const measures = new Set<string>()
  const functions = new Set<string>()
  const unqualified = new Set<string>()

  // Qualified refs: 'Table'[Name] or Table[Name]
  const colRe = /(?:'([^']+)'|([A-Za-z_][\w]*))\s*\[([^\]]+)\]/g
  const consumed: Array<[number, number]> = []
  let m: RegExpExecArray | null
  while ((m = colRe.exec(expr))) {
    const table = (m[1] ?? m[2]).trim()
    const name = m[3].trim()
    consumed.push([m.index, colRe.lastIndex])

    const key = name.toLowerCase()
    const isRealColumn = columnKeys.has(colKey(table, name))
    // 'Table'[Measure] is a legal, and common, way to write a MEASURE ref.
    // Classifying it as a column would hide the dependency entirely.
    if (!isRealColumn && measureNames.has(key)) {
      if (key !== self) measures.add(measureNames.get(key)!)
      if (tableNames.has(table.toLowerCase())) tables.add(table)
      continue
    }

    columns.push({ table, column: name })
    tables.add(table)
  }

  // Bare [X] → a measure ref, or a row-context column ref
  const brRe = /\[([^\]]+)\]/g
  while ((m = brRe.exec(expr))) {
    if (consumed.some(([s, e]) => (m as RegExpExecArray).index >= s && brRe.lastIndex <= e)) continue
    const key = m[1].trim().toLowerCase()
    if (measureNames.has(key)) {
      if (key !== self) measures.add(measureNames.get(key)!)
    } else if (columnNames.has(key)) {
      // Row-context column ref; home table is unknowable from the text alone.
      unqualified.add(m[1].trim())
    }
  }

  // Functions — DAX is case-insensitive, so match any case and canonicalise.
  const fnRe = /\b([A-Za-z][A-Za-z0-9.]{1,})\s*\(/g
  while ((m = fnRe.exec(expr))) {
    const canonical = m[1].toUpperCase()
    if (DAX_BY_NAME[canonical]) functions.add(canonical)
  }

  // Table-only refs inside table functions, e.g. COUNTROWS(Sales), ALL(Sales)
  const tblFn =
    /(?:COUNTROWS|ALL|ALLEXCEPT|ALLSELECTED|FILTER|VALUES|DISTINCT|RELATEDTABLE|SUMMARIZE|SUMMARIZECOLUMNS|CALCULATETABLE|ADDCOLUMNS|SELECTCOLUMNS|TOPN|GROUPBY|CALENDAR)\s*\(\s*(?:'([^']+)'|([A-Za-z_][\w]*))\s*(?=[,)])/gi
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

  return {
    columns: cols,
    tables: [...tables],
    measures: [...measures],
    functions: [...functions],
    unqualified: [...unqualified],
  }
}
