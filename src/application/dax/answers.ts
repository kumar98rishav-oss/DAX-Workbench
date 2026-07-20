/**
 * APPLICATION — Answers (KPI board / Matrix / Table)
 * Query builders for the KPI surface. Everything here produces DAX the bridge's
 * /dax endpoint runs as-is on the live engine, with DEFINE blocks carrying any
 * measures that exist only in the Studio. Matrix and Table use
 * SUMMARIZECOLUMNS — the same query shape Power BI Desktop generates for its
 * own visuals — so the numbers agree with Desktop by construction.
 */
import { dependencyClosure } from './live-preview'
import type { NamedDax } from './live-preview'

export interface DimRef {
  table: string
  column: string
}

const eN = (n: string): string => n.replace(/]/g, ']]')
const eT = (t: string): string => t.replace(/'/g, "''")

/** DEFINE block covering the union of every picked measure's dependency chain. */
function defineBlock(pool: NamedDax[], picked: string[], homeTable: string): string {
  const seen = new Set<string>()
  const defs: string[] = []
  for (const name of picked) {
    for (const m of dependencyClosure(pool, name)) {
      const key = m.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      defs.push(`MEASURE '${eT(homeTable)}'[${eN(m.name)}] = ${m.dax}`)
    }
  }
  return defs.length === 0 ? '' : `DEFINE\n${defs.join('\n')}\n`
}

/** One query, every KPI value: EVALUATE ROW("k0",[A],"k1",[B],…).
 * Values come back positionally — k-aliases dodge every naming edge case. */
export function buildKpiBoardQuery(pool: NamedDax[], picked: string[], homeTable: string): string {
  const cols = picked.map((name, i) => `"k${i}", [${eN(name)}]`).join(', ')
  return `${defineBlock(pool, picked, homeTable)}EVALUATE ROW(${cols})`
}

/** Flat answer set: dims × measures via SUMMARIZECOLUMNS, capped and ordered.
 * Serves the Table page directly and the Matrix page before its pivot. */
export function buildAnswerQuery(
  dims: DimRef[],
  measureNames: string[],
  pool: NamedDax[],
  homeTable: string,
  cap: number,
): string {
  const dimRefs = dims.map((d) => `'${eT(d.table)}'[${eN(d.column)}]`)
  const measureCols = measureNames.map((name, i) => `"k${i}", [${eN(name)}]`)
  const body = `SUMMARIZECOLUMNS(${[...dimRefs, ...measureCols].join(', ')})`
  const order = dimRefs.length > 0 ? ` ORDER BY ${dimRefs.map((r) => `${r} ASC`).join(', ')}` : ''
  return `${defineBlock(pool, measureNames, homeTable)}EVALUATE TOPN(${cap}, ${body})${order}`
}

/** Rows from /dax mapped positionally: first `dimCount` columns are the dims,
 * the rest are the k-aliased measures in the order they were asked for. */
export function mapAnswerRows(
  columns: string[],
  rows: Record<string, unknown>[],
  dimCount: number,
): { dims: unknown[]; values: unknown[] }[] {
  return rows.map((r) => {
    const cells = columns.map((c) => r[c])
    return { dims: cells.slice(0, dimCount), values: cells.slice(dimCount) }
  })
}

/** Pivot a flat (rowDim, colDim, value) answer set into a matrix. Column order
 * is first-appearance, which the ORDER BY has already made deterministic. */
export function pivotMatrix(
  flat: { dims: unknown[]; values: unknown[] }[],
): { colKeys: string[]; rows: { key: string; cells: (unknown | undefined)[] }[] } {
  const colKeys: string[] = []
  const colIndex = new Map<string, number>()
  const rowIndex = new Map<string, { key: string; cells: (unknown | undefined)[] }>()
  for (const f of flat) {
    const rowKey = String(f.dims[0] ?? '(blank)')
    const colKey = String(f.dims[1] ?? '(blank)')
    if (!colIndex.has(colKey)) {
      colIndex.set(colKey, colKeys.length)
      colKeys.push(colKey)
    }
    let row = rowIndex.get(rowKey)
    if (!row) {
      row = { key: rowKey, cells: [] }
      rowIndex.set(rowKey, row)
    }
    row.cells[colIndex.get(colKey)!] = f.values[0]
  }
  return { colKeys, rows: [...rowIndex.values()] }
}

/** Render a value the way its measure's format string says to. */
export function formatValue(v: unknown, fmt?: string): string {
  if (v === null || v === undefined) return '—'
  if (typeof v !== 'number') return String(v)
  const f = fmt ?? ''
  if (f.includes('%')) return `${(v * 100).toFixed(f.includes('.00') ? 2 : 1)}%`
  const digits = f.includes('.00') ? 2 : f.includes('.0') ? 1 : Math.abs(v) < 100 && !Number.isInteger(v) ? 2 : 0
  const num = v.toLocaleString(undefined, { maximumFractionDigits: digits })
  return f.includes('$') ? `$${num}` : num
}
