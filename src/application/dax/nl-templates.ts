/**
 * APPLICATION — Natural-language → DAX generation (heuristic, offline)
 * Maps a plain-language request to a best-practice DAX measure using the
 * model's real tables/columns. Returns the measure + an explanation.
 */
import type { Column, SemanticModel, Table } from '@/domain/model'

export interface GeneratedDax {
  name: string
  expression: string
  explanation: string
  formatString: string
}

const CUR = '\\$#,##0'

function factTable(model: SemanticModel): Table | undefined {
  return (
    model.tables.find((t) => t.role === 'fact') ??
    model.tables.find((t) => t.columns.some((c) => c.role === 'measureCandidate')) ??
    model.tables[0]
  )
}

function dateColumn(model: SemanticModel): { table: string; col: string } | null {
  const dateTbl = model.tables.find((t) => t.role === 'date')
  if (dateTbl) {
    const c = dateTbl.columns.find((x) => x.dataType === 'date' || x.dataType === 'dateTime')
    if (c) return { table: dateTbl.name, col: c.name }
  }
  for (const t of model.tables) {
    const c = t.columns.find((x) => x.dataType === 'date' || x.dataType === 'dateTime')
    if (c) return { table: t.name, col: c.name }
  }
  return null
}

const numericCols = (t: Table): Column[] => t.columns.filter((c) => c.dataType === 'integer' || c.dataType === 'decimal')

/** Score numeric columns against the prompt and pick the best match. */
function pickColumn(prompt: string, table: Table): { col: string; currency: boolean } | null {
  const nums = numericCols(table)
  if (nums.length === 0) return null
  const p = prompt.toLowerCase()
  const ptoks = p.split(/[^a-z0-9]+/).filter(Boolean)

  let best: Column | null = null
  let bestScore = -1
  for (const c of nums) {
    const cname = c.name.toLowerCase().replace(/_/g, ' ')
    const ctoks = cname.split(/[^a-z0-9]+/).filter(Boolean)
    let score = 0
    if (p.includes(cname)) score += 6
    for (const tk of ctoks) if (tk.length > 2 && ptoks.includes(tk)) score += 2
    if (c.role === 'measureCandidate') score += 0.5
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  const chosen = bestScore > 0 ? best! : nums.find((c) => c.role === 'measureCandidate') ?? nums[0]
  const currency = /amount|revenue|sales|price|cost|profit|value|total|spend|margin|income|gmv/i.test(chosen.name)
  return { col: chosen.name, currency }
}

const ref = (t: string, c: string) => `'${t}'[${c}]`

export function generateDaxFromNL(prompt: string, model: SemanticModel): GeneratedDax | null {
  const fact = factTable(model)
  if (!fact) return null
  const p = prompt.toLowerCase().trim()
  if (!p) return null

  const picked = pickColumn(prompt, fact)
  const colName = picked?.col ?? numericCols(fact)[0]?.name
  if (!colName) return null
  const base = ref(fact.name, colName)
  const isCurrency = picked?.currency ?? false
  const fmt = isCurrency ? CUR : '#,##0'
  const date = dateColumn(model)
  const pretty = colName.replace(/_/g, ' ')

  // ---- pattern matching, most-specific first ----

  if (/(year.?to.?date|\bytd\b)/.test(p) && date) {
    return { name: `YTD ${pretty}`, expression: `TOTALYTD ( SUM ( ${base} ), ${ref(date.table, date.col)} )`, explanation: `Year-to-date total of ${pretty}: TOTALYTD accumulates SUM(${colName}) from the start of the year through the dates in context, over ${date.table}.`, formatString: fmt }
  }
  if (/(quarter.?to.?date|\bqtd\b)/.test(p) && date) {
    return { name: `QTD ${pretty}`, expression: `TOTALQTD ( SUM ( ${base} ), ${ref(date.table, date.col)} )`, explanation: `Quarter-to-date total of ${pretty}.`, formatString: fmt }
  }
  if (/(month.?to.?date|\bmtd\b)/.test(p) && date) {
    return { name: `MTD ${pretty}`, expression: `TOTALMTD ( SUM ( ${base} ), ${ref(date.table, date.col)} )`, explanation: `Month-to-date total of ${pretty}.`, formatString: fmt }
  }
  if (/(running|cumulative|to.?date total)/.test(p) && date) {
    const d = ref(date.table, date.col)
    return { name: `Cumulative ${pretty}`, expression: `CALCULATE (\n    SUM ( ${base} ),\n    FILTER ( ALL ( ${d} ), ${d} <= MAX ( ${d} ) )\n)`, explanation: `Running total of ${pretty}: re-evaluates SUM over ALL dates up to the latest date in context.`, formatString: fmt }
  }
  if (/(year.?over.?year|\byoy\b|growth|vs last year|previous year|change)/.test(p) && date) {
    return { name: `${pretty} YoY %`, expression: `VAR Curr = SUM ( ${base} )\nVAR Prior = CALCULATE ( SUM ( ${base} ), SAMEPERIODLASTYEAR ( ${ref(date.table, date.col)} ) )\nRETURN DIVIDE ( Curr - Prior, Prior )`, explanation: `Year-over-year growth of ${pretty}: compares the current SUM with the same period last year and returns the % change via DIVIDE.`, formatString: '0.0%' }
  }
  if (/(rolling|moving)\s*(average|avg)/.test(p) && date) {
    const d = ref(date.table, date.col)
    return { name: `Rolling Avg ${pretty}`, expression: `AVERAGEX (\n    DATESINPERIOD ( ${d}, MAX ( ${d} ), -3, MONTH ),\n    CALCULATE ( SUM ( ${base} ) )\n)`, explanation: `3-month rolling average of ${pretty} using a trailing DATESINPERIOD window.`, formatString: fmt }
  }
  if (/(% of total|percent of total|share|contribution)/.test(p)) {
    return { name: `${pretty} % of Total`, expression: `DIVIDE (\n    SUM ( ${base} ),\n    CALCULATE ( SUM ( ${base} ), ALL ( '${fact.name}' ) )\n)`, explanation: `Share of grand total ${pretty}: divides the current SUM by the all-rows total.`, formatString: '0.0%' }
  }
  if (/(margin|profit %|profitability)/.test(p)) {
    const profit = fact.columns.find((c) => /profit|margin/i.test(c.name))
    const revenue = fact.columns.find((c) => /revenue|sales|amount|value/i.test(c.name))
    if (profit && revenue) {
      return { name: 'Margin %', expression: `DIVIDE ( SUM ( ${ref(fact.name, profit.name)} ), SUM ( ${ref(fact.name, revenue.name)} ) )`, explanation: `Profit margin: profit ÷ revenue, safe against zero revenue.`, formatString: '0.0%' }
    }
  }
  if (/\bper\b/.test(p)) {
    return { name: `${pretty} per Record`, expression: `DIVIDE ( SUM ( ${base} ), COUNTROWS ( '${fact.name}' ) )`, explanation: `Average ${pretty} per row of ${fact.name}.`, formatString: fmt }
  }
  if (/\b(max|maximum|highest|peak|largest)\b/.test(p)) {
    return { name: `Max ${pretty}`, expression: `MAX ( ${base} )`, explanation: `Largest value of ${pretty} in context.`, formatString: fmt }
  }
  if (/\b(min|minimum|lowest|smallest)\b/.test(p)) {
    return { name: `Min ${pretty}`, expression: `MIN ( ${base} )`, explanation: `Smallest value of ${pretty} in context.`, formatString: fmt }
  }
  if (/(distinct|unique)/.test(p)) {
    const dim = fact.columns.find((c) => c.role === 'key') ?? fact.columns.find((c) => c.dataType === 'string') ?? fact.columns[0]
    return { name: `Distinct ${dim?.name ?? 'Count'}`, expression: `DISTINCTCOUNT ( ${ref(fact.name, dim?.name ?? colName)} )`, explanation: `Number of distinct ${dim?.name ?? colName} values in context.`, formatString: '#,##0' }
  }
  if (/(average|avg|mean)/.test(p)) {
    return { name: `Average ${pretty}`, expression: `AVERAGE ( ${base} )`, explanation: `Arithmetic mean of ${pretty} across the rows in context.`, formatString: isCurrency ? CUR : '#,##0.00' }
  }
  if (/(count|number of|how many|rows?)/.test(p) && !/(amount|revenue|sales|value)/.test(p)) {
    return { name: `${fact.name} Count`, expression: `COUNTROWS ( '${fact.name}' )`, explanation: `Row count of ${fact.name} in the current filter context.`, formatString: '#,##0' }
  }

  // default: total (SUM)
  return { name: `Total ${pretty}`, expression: `SUM ( ${base} )`, explanation: `Total ${pretty}: sums ${colName} across the rows in the current filter context — the additive baseline for time-intelligence measures.`, formatString: fmt }
}
