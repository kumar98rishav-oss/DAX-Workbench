/**
 * APPLICATION — Natural-language → DAX generation (heuristic, offline)
 *
 * Supported structure (any order, brackets optional):
 *   [sum|total|count|average|min|max|distinct] <field>
 *   [where|for <field> = <value> [and <field> <op> <value> …]]
 *   [ytd|qtd|mtd|running|yoy|rolling avg|% of total|per]
 *
 * Filter values are resolved against the real column values in the data, so
 * "count shipments where order delivered" →
 *   CALCULATE ( COUNTROWS ( 'Shipments' ), 'Shipments'[Order_Status] = "Delivered" )
 */
import type { Column, SemanticModel, Table } from '@/domain/model'
import type { DatasetData } from '@/application/import/types'

export interface GeneratedDax {
  name: string
  expression: string
  explanation: string
  formatString: string
}

const CUR = '\\$#,##0'
const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function factTable(model: SemanticModel): Table | undefined {
  return (
    model.tables.find((t) => t.role === 'fact') ??
    model.tables.find((t) => t.columns.some((c) => c.role === 'measureCandidate')) ??
    model.tables[0]
  )
}
function dateColumn(model: SemanticModel): { table: string; col: string } | null {
  const dt = model.tables.find((t) => t.role === 'date')
  const from = (t?: Table) => t?.columns.find((x) => x.dataType === 'date' || x.dataType === 'dateTime')
  const c = from(dt) ?? model.tables.map((t) => ({ t, c: from(t) })).find((x) => x.c)
  if (dt && from(dt)) return { table: dt.name, col: from(dt)!.name }
  for (const t of model.tables) { const col = from(t); if (col) return { table: t.name, col: col.name } }
  return c ? null : null
}
const numericCols = (t: Table): Column[] => t.columns.filter((c) => c.dataType === 'integer' || c.dataType === 'decimal')
const ref = (t: string, c: string) => `'${t}'[${c}]`

// ---- value index for filter resolution ----
interface ValueEntry { value: string; low: string; table: string; column: string }
function buildValueIndex(model: SemanticModel, datasets: DatasetData[]): ValueEntry[] {
  const byId: Record<string, DatasetData> = {}
  for (const d of datasets) byId[d.id] = d
  const out: ValueEntry[] = []
  for (const t of model.tables) {
    const data = byId[t.id]
    if (!data) continue
    t.columns.forEach((col, idx) => {
      if (col.dataType !== 'string' || col.role === 'key') return
      if ((col.distinctCount ?? 999) > 40) return
      const seen = new Set<string>()
      for (const row of data.rows) {
        const v = row[idx]
        if (v == null) continue
        const s = String(v)
        if (seen.has(s)) continue
        seen.add(s)
        out.push({ value: s, low: s.toLowerCase(), table: t.name, column: col.name })
        if (seen.size > 40) break
      }
    })
  }
  return out
}

interface StrFilter { table: string; column: string; value: string }
interface NumFilter { table: string; column: string; op: string; value: number }

function matchStringFilters(text: string, index: ValueEntry[], excludeCol?: string): StrFilter[] {
  const t = ` ${text.toLowerCase()} `
  const sorted = [...index].sort((a, b) => b.low.length - a.low.length)
  const used = new Set<string>()
  const out: StrFilter[] = []
  for (const e of sorted) {
    if (e.low.length < 2 || e.column === excludeCol) continue
    if (new RegExp(`[^a-z0-9]${escapeReg(e.low)}[^a-z0-9]`).test(t)) {
      const key = `${e.table}|${e.column}`
      if (used.has(key)) continue
      used.add(key)
      out.push({ table: e.table, column: e.column, value: e.value })
      if (out.length >= 3) break
    }
  }
  return out
}

function matchNumericFilters(text: string, fact: Table): NumFilter[] {
  const out: NumFilter[] = []
  const re = /([a-z][a-z0-9 _]*?)\s*(>=|<=|<>|=|>|<)\s*([\d][\d.,]*)/g
  let m: RegExpExecArray | null
  const p = text.toLowerCase()
  while ((m = re.exec(p))) {
    const nameFrag = m[1].trim()
    const col = fact.columns.find((c) => c.name.toLowerCase().replace(/_/g, ' ') === nameFrag || c.name.toLowerCase().includes(nameFrag.split(' ').pop() ?? ''))
    if (col && (col.dataType === 'integer' || col.dataType === 'decimal')) {
      out.push({ table: fact.name, column: col.name, op: m[2], value: Number(m[3].replace(/,/g, '')) })
    }
  }
  return out
}

function pickColumn(text: string, table: Table): { col: string; currency: boolean } | null {
  const nums = numericCols(table)
  if (nums.length === 0) return null
  const p = text.toLowerCase()
  const ptoks = p.split(/[^a-z0-9]+/).filter(Boolean)
  let best: Column | null = null
  let bestScore = -1
  for (const c of nums) {
    const cname = c.name.toLowerCase().replace(/_/g, ' ')
    let score = 0
    if (p.includes(cname)) score += 6
    for (const tk of cname.split(/[^a-z0-9]+/).filter(Boolean)) if (tk.length > 2 && ptoks.includes(tk)) score += 2
    if (c.role === 'measureCandidate') score += 0.5
    if (score > bestScore) { bestScore = score; best = c }
  }
  const chosen = bestScore > 0 ? best! : nums.find((c) => c.role === 'measureCandidate') ?? nums[0]
  return { col: chosen.name, currency: /amount|revenue|sales|price|cost|profit|value|total|spend|margin|income|gmv/i.test(chosen.name) }
}

export function generateDaxFromNL(prompt: string, model: SemanticModel, datasets: DatasetData[] = []): GeneratedDax | null {
  const fact = factTable(model)
  if (!fact) return null
  const raw = prompt.trim()
  const p = raw.toLowerCase()
  if (!p) return null

  // split measure text vs filter text on where/for
  const wm = p.match(/\b(where|for which|filtered by|only where|only for|\bfor\b)\b/)
  const measureText = wm ? raw.slice(0, wm.index) : raw
  const filterText = wm ? raw.slice((wm.index ?? 0) + wm[0].length) : raw

  const picked = pickColumn(measureText, fact)
  const colName = picked?.col ?? numericCols(fact)[0]?.name
  const isCurrency = picked?.currency ?? false
  const fmtNum = isCurrency ? CUR : '#,##0'
  const date = dateColumn(model)
  const pretty = (colName ?? 'Value').replace(/_/g, ' ')

  // filters
  const index = buildValueIndex(model, datasets)
  const strF = matchStringFilters(filterText, index, colName)
  const numF = matchNumericFilters(filterText, fact)
  const hasFilters = strF.length + numF.length > 0
  const predStrings = [
    ...strF.map((f) => `${ref(f.table, f.column)} = "${f.value}"`),
    ...numF.map((f) => `${ref(f.table, f.column)} ${f.op} ${f.value}`),
  ]
  const filterLabel = [...strF.map((f) => f.value), ...numF.map((f) => `${f.column} ${f.op} ${f.value}`)].join(', ')

  // ---- time intelligence (takes an inner SUM) ----
  let inner: string
  let baseName: string
  let fmt = fmtNum

  if (/(year.?to.?date|\bytd\b)/.test(p) && date && colName) {
    inner = `TOTALYTD ( SUM ( ${ref(fact.name, colName)} ), ${ref(date.table, date.col)} )`; baseName = `YTD ${pretty}`
  } else if (/(quarter.?to.?date|\bqtd\b)/.test(p) && date && colName) {
    inner = `TOTALQTD ( SUM ( ${ref(fact.name, colName)} ), ${ref(date.table, date.col)} )`; baseName = `QTD ${pretty}`
  } else if (/(month.?to.?date|\bmtd\b)/.test(p) && date && colName) {
    inner = `TOTALMTD ( SUM ( ${ref(fact.name, colName)} ), ${ref(date.table, date.col)} )`; baseName = `MTD ${pretty}`
  } else if (/(running|cumulative)/.test(p) && date && colName) {
    const d = ref(date.table, date.col)
    inner = `CALCULATE ( SUM ( ${ref(fact.name, colName)} ), FILTER ( ALL ( ${d} ), ${d} <= MAX ( ${d} ) ) )`; baseName = `Cumulative ${pretty}`
  } else if (/(year.?over.?year|\byoy\b|growth|vs last year)/.test(p) && date && colName) {
    const b = ref(fact.name, colName)
    inner = `VAR Curr = SUM ( ${b} )\nVAR Prior = CALCULATE ( SUM ( ${b} ), SAMEPERIODLASTYEAR ( ${ref(date.table, date.col)} ) )\nRETURN DIVIDE ( Curr - Prior, Prior )`
    baseName = `${pretty} YoY %`; fmt = '0.0%'
  } else if (/(rolling|moving)\s*(average|avg)/.test(p) && date && colName) {
    const d = ref(date.table, date.col)
    inner = `AVERAGEX ( DATESINPERIOD ( ${d}, MAX ( ${d} ), -3, MONTH ), CALCULATE ( SUM ( ${ref(fact.name, colName)} ) ) )`; baseName = `Rolling Avg ${pretty}`
  } else if (/(% of total|percent of total|share)/.test(p) && colName) {
    const b = ref(fact.name, colName)
    inner = `DIVIDE ( SUM ( ${b} ), CALCULATE ( SUM ( ${b} ), ALL ( '${fact.name}' ) ) )`; baseName = `${pretty} % of Total`; fmt = '0.0%'
  } else if (/\bper\b/.test(measureText) && colName) {
    inner = `DIVIDE ( SUM ( ${ref(fact.name, colName)} ), COUNTROWS ( '${fact.name}' ) )`; baseName = `${pretty} per Record`
  } else {
    // plain aggregation
    let agg: 'count' | 'distinct' | 'sum' | 'avg' | 'min' | 'max' = 'sum'
    if (/\b(distinct|unique)\b/.test(p)) agg = 'distinct'
    else if (/\b(count|number of|how many)\b/.test(measureText)) agg = 'count'
    else if (/\b(average|avg|mean)\b/.test(measureText)) agg = 'avg'
    else if (/\b(max|maximum|highest|largest|peak)\b/.test(measureText)) agg = 'max'
    else if (/\b(min|minimum|lowest|smallest)\b/.test(measureText)) agg = 'min'
    else if (!colName) agg = 'count'

    if (agg === 'count') { inner = `COUNTROWS ( '${fact.name}' )`; baseName = `${fact.name} Count`; fmt = '#,##0' }
    else if (agg === 'distinct') {
      const dim = fact.columns.find((c) => c.role === 'key') ?? fact.columns.find((c) => c.dataType === 'string') ?? fact.columns[0]
      inner = `DISTINCTCOUNT ( ${ref(fact.name, dim?.name ?? colName ?? 'Id')} )`; baseName = `Distinct ${dim?.name ?? pretty}`; fmt = '#,##0'
    } else if (colName) {
      const fn = { sum: 'SUM', avg: 'AVERAGE', min: 'MIN', max: 'MAX' }[agg]
      inner = `${fn} ( ${ref(fact.name, colName)} )`
      baseName = `${agg === 'sum' ? 'Total' : agg === 'avg' ? 'Average' : agg === 'min' ? 'Min' : 'Max'} ${pretty}`
      if (agg === 'avg' && !isCurrency) fmt = '#,##0.00'
    } else {
      inner = `COUNTROWS ( '${fact.name}' )`; baseName = `${fact.name} Count`; fmt = '#,##0'
    }
  }

  // ---- wrap with filters ----
  let expression = inner
  let explanation = `${baseName}.`
  if (hasFilters) {
    expression = `CALCULATE (\n    ${inner},\n    ${predStrings.join(',\n    ')}\n)`
    explanation = `${baseName}, filtered where ${predStrings.join(' and ')}.`
  } else {
    explanation = `${baseName} across the rows in the current filter context.`
  }
  const name = hasFilters ? `${baseName} (${filterLabel})` : baseName

  return { name, expression, explanation, formatString: fmt }
}
