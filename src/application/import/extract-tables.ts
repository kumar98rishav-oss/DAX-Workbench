/**
 * APPLICATION — Table extraction from a spreadsheet grid (pure)
 * A single worksheet can hold several tables laid out side-by-side and
 * separated by blank columns (a very common Excel pattern). This splits a
 * raw grid into one or more tables, trimming blank rows/columns.
 */

type Cell = unknown

export interface RawTable {
  name: string
  headers: string[]
  rows: Cell[][]
}

const isBlank = (v: Cell): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

/** Pad ragged rows so every row has the same width. */
function rectangular(rows: Cell[][]): Cell[][] {
  let width = 0
  for (const r of rows) if (r.length > width) width = r.length
  return rows.map((r) => {
    const c = r.slice()
    while (c.length < width) c.push(null)
    return c
  })
}

/**
 * Split one sheet's grid into tables separated by fully-blank columns.
 * Returns a table per contiguous block of populated columns.
 */
export function extractTables(sheetName: string, grid: Cell[][]): RawTable[] {
  // Drop fully-blank rows, then square off the grid.
  const rows = rectangular(grid.filter((r) => r.some((c) => !isBlank(c))))
  if (rows.length === 0) return []
  const width = rows[0].length

  // Contiguous runs of non-blank columns become table candidates.
  const groups: number[][] = []
  let current: number[] | null = null
  for (let c = 0; c < width; c++) {
    const columnBlank = rows.every((r) => isBlank(r[c]))
    if (columnBlank) {
      current = null
    } else {
      if (!current) {
        current = []
        groups.push(current)
      }
      current.push(c)
    }
  }

  const tables: RawTable[] = []
  for (const cols of groups) {
    let sub = rows.map((r) => cols.map((c) => r[c]))
    // Trim trailing all-blank rows (shorter tables padded by taller neighbours).
    while (sub.length > 0 && sub[sub.length - 1].every(isBlank)) sub.pop()

    const headerRow = sub[0] ?? []
    const body = sub.slice(1)
    if (headerRow.every(isBlank) || body.length === 0) continue

    const headers = headerRow.map((h, i) => (isBlank(h) ? `Column ${i + 1}` : String(h).trim()))
    tables.push({ name: '', headers, rows: body })
  }

  // Name: a single-table sheet keeps the sheet name; multiple tables take
  // their leading column header (falling back to "<Sheet> N").
  if (tables.length === 1) {
    tables[0].name = sheetName
  } else {
    tables.forEach((t, i) => {
      const lead = t.headers[0]
      t.name = lead && !/^Column \d+$/.test(lead) ? lead : `${sheetName} ${i + 1}`
    })
  }

  return tables
}
