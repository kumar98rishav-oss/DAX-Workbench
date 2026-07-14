/**
 * APPLICATION — Natural-language → DAX generation (heuristic, offline)
 * Maps a plain-language request to a best-practice DAX measure using the
 * model's tables/columns. Returns the measure + an explanation of the logic.
 */
import type { SemanticModel, Table } from '@/domain/model'

export interface GeneratedDax {
  name: string
  expression: string
  explanation: string
  formatString: string
}

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

/** Pick the numeric column whose name best matches the prompt. */
function pickColumn(prompt: string, table: Table): { col: string; type: 'currency' | 'plain' } | null {
  const p = prompt.toLowerCase()
  const numeric = table.columns.filter((c) => c.dataType === 'integer' || c.dataType === 'decimal')
  const named = numeric.find((c) => p.includes(c.name.toLowerCase().replace(/_/g, ' ')))
  const chosen = named ?? numeric.find((c) => c.role === 'measureCandidate') ?? numeric[0]
  if (!chosen) return null
  const currency = /amount|revenue|sales|price|cost|profit|value|total/i.test(chosen.name)
  return { col: chosen.name, type: currency ? 'currency' : 'plain' }
}

const ref = (t: string, c: string) => `'${t}'[${c}]`
const CUR = '\\$#,##0'

export function generateDaxFromNL(prompt: string, model: SemanticModel): GeneratedDax | null {
  const fact = factTable(model)
  if (!fact) return null
  const p = prompt.toLowerCase().trim()
  if (!p) return null

  const picked = pickColumn(prompt, fact)
  const colName = picked?.col ?? 'Amount'
  const base = ref(fact.name, colName)
  const isCurrency = picked?.type === 'currency'
  const fmt = isCurrency ? CUR : '#,##0'
  const date = dateColumn(model)
  const pretty = colName.replace(/_/g, ' ')

  // ---- pattern matching (most specific first) ----

  if (/(year.?to.?date|ytd)/.test(p) && date) {
    return {
      name: `YTD ${pretty}`,
      expression: `TOTALYTD(SUM(${base}), ${ref(date.table, date.col)})`,
      explanation: `Year-to-date total of ${pretty}. TOTALYTD accumulates SUM(${colName}) from the start of the year through the dates in context, using the ${date.table} date column.`,
      formatString: fmt,
    }
  }

  if (/(running|cumulative)/.test(p) && date) {
    return {
      name: `Cumulative ${pretty}`,
      expression: `CALCULATE(\n    SUM(${base}),\n    FILTER(\n        ALL(${ref(date.table, date.col)}),\n        ${ref(date.table, date.col)} <= MAX(${ref(date.table, date.col)})\n    )\n)`,
      explanation: `Running total of ${pretty}. CALCULATE re-evaluates SUM over ALL dates up to the latest date in the current context, producing a cumulative curve.`,
      formatString: fmt,
    }
  }

  if (/(year.?over.?year|yoy|growth|vs last year|previous year)/.test(p) && date) {
    return {
      name: `${pretty} YoY %`,
      expression: `VAR Current = SUM(${base})\nVAR Prior = CALCULATE(SUM(${base}), SAMEPERIODLASTYEAR(${ref(date.table, date.col)}))\nRETURN DIVIDE(Current - Prior, Prior)`,
      explanation: `Year-over-year growth of ${pretty}. Compares the current-period SUM with the same period last year (SAMEPERIODLASTYEAR) and returns the percentage change via DIVIDE (safe against divide-by-zero).`,
      formatString: '0.0%',
    }
  }

  if (/(rolling|moving)\s*(average|avg)/.test(p) && date) {
    return {
      name: `Rolling Avg ${pretty}`,
      expression: `AVERAGEX(\n    DATESINPERIOD(${ref(date.table, date.col)}, MAX(${ref(date.table, date.col)}), -3, MONTH),\n    CALCULATE(SUM(${base}))\n)`,
      explanation: `3-month rolling average of ${pretty}. DATESINPERIOD builds a trailing 3-month window ending at the latest date; AVERAGEX averages the monthly totals over that window.`,
      formatString: fmt,
    }
  }

  if (/(% of total|percent of total|share|contribution)/.test(p)) {
    return {
      name: `${pretty} % of Total`,
      expression: `DIVIDE(\n    SUM(${base}),\n    CALCULATE(SUM(${base}), ALL(${fact.name}))\n)`,
      explanation: `Share of total ${pretty}. Divides the current SUM by the grand total (CALCULATE … ALL removes filters), giving each row's contribution.`,
      formatString: '0.0%',
    }
  }

  if (/(average|avg|mean)/.test(p)) {
    return {
      name: `Average ${pretty}`,
      expression: `AVERAGE(${base})`,
      explanation: `Arithmetic mean of ${pretty} across the rows in context.`,
      formatString: isCurrency ? CUR : '#,##0.00',
    }
  }

  if (/(distinct|unique)\s*(count|number)?/.test(p)) {
    const dim = fact.columns.find((c) => c.role === 'key') ?? fact.columns[0]
    return {
      name: `Distinct ${dim?.name ?? 'Count'}`,
      expression: `DISTINCTCOUNT(${ref(fact.name, dim?.name ?? colName)})`,
      explanation: `Number of distinct ${dim?.name ?? colName} values in context.`,
      formatString: '#,##0',
    }
  }

  if (/(count|number of|how many)/.test(p)) {
    return {
      name: `${fact.name} Count`,
      expression: `COUNTROWS(${fact.name})`,
      explanation: `Row count of ${fact.name} in the current filter context.`,
      formatString: '#,##0',
    }
  }

  if (/(margin|profit %|profitability)/.test(p)) {
    const profit = fact.columns.find((c) => /profit|margin/i.test(c.name))
    const revenue = fact.columns.find((c) => /revenue|sales|amount/i.test(c.name))
    if (profit && revenue) {
      return {
        name: 'Margin %',
        expression: `DIVIDE(SUM(${ref(fact.name, profit.name)}), SUM(${ref(fact.name, revenue.name)}))`,
        explanation: `Profit margin: profit divided by revenue, safe against zero revenue.`,
        formatString: '0.0%',
      }
    }
  }

  // default: total
  return {
    name: `Total ${pretty}`,
    expression: `SUM(${base})`,
    explanation: `Total ${pretty} — sums ${colName} across the rows in the current filter context. This is the additive baseline other time-intelligence measures build on.`,
    formatString: fmt,
  }
}
