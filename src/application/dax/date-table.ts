/**
 * APPLICATION — Date-table generator
 * Builds a DAX calculated-table expression (CALENDAR over a fact column's range,
 * or CALENDARAUTO) with a user-chosen column set, plus matching sample rows so
 * the dialog can show exactly what each column will contain. The same option
 * set drives three outputs: the DAX (for Desktop), a CSV (for the in-browser
 * model), and the preview.
 */
import type { SemanticModel } from '@/domain/model'

export interface DateColumnDef {
  id: string
  label: string
  /** The actual column name written into the table. */
  col: string
  hint: string
  /** DAX expression over [Date]; `m` = fiscal-year start month (1 = calendar). */
  dax: (m: number) => string
  /** The same value computed in JS, for previews and the Studio-side CSV. */
  sample: (d: Date, m: number) => string | number | boolean
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
/** Monday=1 … Sunday=7 — matches WEEKDAY([Date], 2). */
const isoWeekday = (d: Date): number => ((d.getDay() + 6) % 7) + 1
const pad2 = (n: number): string => String(n).padStart(2, '0')

export const DATE_COLUMNS: DateColumnDef[] = [
  { id: 'year', col: 'Year', label: 'Year', hint: '2026', dax: () => 'YEAR([Date])', sample: (d) => d.getFullYear() },
  { id: 'quarter', col: 'Quarter', label: 'Quarter', hint: 'Q3', dax: () => '"Q" & QUARTER([Date])', sample: (d) => `Q${Math.floor(d.getMonth() / 3) + 1}` },
  { id: 'monthNo', col: 'MonthNo', label: 'Month number', hint: '7 — sorts month names', dax: () => 'MONTH([Date])', sample: (d) => d.getMonth() + 1 },
  { id: 'monthName', col: 'MonthName', label: 'Month name', hint: 'July', dax: () => 'FORMAT([Date], "MMMM")', sample: (d) => MONTHS[d.getMonth()] },
  { id: 'monthShort', col: 'MonthShort', label: 'Month short', hint: 'Jul', dax: () => 'FORMAT([Date], "MMM")', sample: (d) => MONTHS[d.getMonth()].slice(0, 3) },
  { id: 'yearMonth', col: 'YearMonth', label: 'Year-month', hint: '2026-07 — sortable axis', dax: () => 'FORMAT([Date], "YYYY-MM")', sample: (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` },
  { id: 'week', col: 'WeekOfYear', label: 'Week of year', hint: '29 (weeks start Monday)', dax: () => 'WEEKNUM([Date], 2)', sample: (d) => { const start = new Date(d.getFullYear(), 0, 1); const day = (start.getDay() + 6) % 7; return Math.floor(((+d - +start) / 86400000 + day) / 7) + 1 } },
  { id: 'day', col: 'Day', label: 'Day', hint: '18', dax: () => 'DAY([Date])', sample: (d) => d.getDate() },
  { id: 'weekdayNo', col: 'WeekdayNo', label: 'Weekday number', hint: '6 — sorts weekday names', dax: () => 'WEEKDAY([Date], 2)', sample: (d) => isoWeekday(d) },
  { id: 'weekdayName', col: 'WeekdayName', label: 'Weekday name', hint: 'Saturday', dax: () => 'FORMAT([Date], "dddd")', sample: (d) => DAYS[isoWeekday(d) - 1] },
  { id: 'isWeekend', col: 'IsWeekend', label: 'Is weekend', hint: 'TRUE / FALSE', dax: () => 'WEEKDAY([Date], 2) > 5', sample: (d) => isoWeekday(d) > 5 },
  {
    id: 'fiscalYear',
    col: 'FiscalYear',
    label: 'Fiscal year',
    hint: 'labelled by the year it ends in',
    dax: (m) => (m === 1 ? 'YEAR([Date])' : `YEAR([Date]) + IF(MONTH([Date]) >= ${m}, 1, 0)`),
    sample: (d, m) => d.getFullYear() + (m !== 1 && d.getMonth() + 1 >= m ? 1 : 0),
  },
]

export interface DateSource {
  kind: 'column' | 'auto'
  /** When kind = column: the fact table + date column whose MIN/MAX set the range. */
  table?: string
  column?: string
}

export interface DateTableOptions {
  name: string
  source: DateSource
  columnIds: string[]
  fiscalStart: number // 1 = plain calendar year
}

/** Every date/dateTime column in the model — the candidates for the range
 * reference, fact tables first since that's almost always the right answer. */
export function dateColumnCandidates(model: SemanticModel): { table: string; column: string; isFact: boolean }[] {
  const out: { table: string; column: string; isFact: boolean }[] = []
  for (const t of model.tables) {
    for (const c of t.columns) {
      if (c.dataType === 'date' || c.dataType === 'dateTime') out.push({ table: t.name, column: c.name, isFact: t.role === 'fact' })
    }
  }
  return out.sort((a, b) => Number(b.isFact) - Number(a.isFact))
}

/** The deployable calculated-table expression. */
export function buildDateTableDax(opts: DateTableOptions): string {
  const cols = DATE_COLUMNS.filter((c) => opts.columnIds.includes(c.id))
  const colLines = cols.map((c) => `    "${c.col}", ${c.dax(opts.fiscalStart)}`)

  const base =
    opts.source.kind === 'column' && opts.source.table && opts.source.column
      ? `CALENDAR(_min, _max)`
      : opts.fiscalStart !== 1
        ? `CALENDARAUTO(${opts.fiscalStart - 1})`
        : `CALENDARAUTO()`

  const body =
    colLines.length === 0
      ? base
      : `ADDCOLUMNS(\n    ${base},\n${colLines.join(',\n')}\n)`

  if (opts.source.kind === 'column' && opts.source.table && opts.source.column) {
    return [
      `VAR _min = MIN('${opts.source.table}'[${opts.source.column}])`,
      `VAR _max = MAX('${opts.source.table}'[${opts.source.column}])`,
      `RETURN`,
      body,
    ].join('\n')
  }
  return body
}

/** A few rows computed with the same semantics as the DAX, for the preview. */
export function sampleDateRows(opts: DateTableOptions, dates: Date[]): { headers: string[]; rows: (string | number | boolean)[][] } {
  const cols = DATE_COLUMNS.filter((c) => opts.columnIds.includes(c.id))
  return {
    headers: ['Date', ...cols.map((c) => c.col)],
    rows: dates.map((d) => [
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      ...cols.map((c) => c.sample(d, opts.fiscalStart)),
    ]),
  }
}

/** The full table as CSV — the "Add to Studio" path reuses the normal import
 * pipeline, so the in-browser model gets a real date table too. Capped so an
 * open-ended range can't flood the browser. */
export function buildDateTableCsv(opts: DateTableOptions, min: Date, max: Date): { csv: string; rowCount: number; capped: boolean } {
  const CAP = 40 * 366
  const start = new Date(min.getFullYear(), min.getMonth(), min.getDate())
  const end = new Date(max.getFullYear(), max.getMonth(), max.getDate())
  const cols = DATE_COLUMNS.filter((c) => opts.columnIds.includes(c.id))
  const headers = ['Date', ...cols.map((c) => c.col)]
  const lines = [headers.join(',')]
  let capped = false
  let n = 0
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (n >= CAP) { capped = true; break }
    const cells = [
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      ...cols.map((c) => String(c.sample(d, opts.fiscalStart))),
    ]
    lines.push(cells.join(','))
    n++
  }
  return { csv: lines.join('\n'), rowCount: n, capped }
}
