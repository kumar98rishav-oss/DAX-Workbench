/**
 * APPLICATION — KPI / Measure engine (pure)
 * Scans fact tables for additive numerics and emits best-practice measures
 * (name, aggregation, DAX, format, semantic kind) above a confidence bar.
 */
import type { SemanticModel } from '@/domain/model'
import type { Agg } from '@/application/query/query-engine'

export type MeasureKind = 'currency' | 'quantity' | 'count' | 'ratio' | 'generic'

export interface GeneratedMeasure {
  id: string
  name: string
  tableId: string
  tableName: string
  columnId: string
  agg: Agg
  dax: string
  formatString: string
  kind: MeasureKind
  displayFolder: string
  confidence: number
}

const CURRENCY = /(revenue|sales|amount|price|cost|profit|margin|income|spend|value|total|gmv|arpu)/i
const QUANTITY = /(qty|quantity|boxes|units?|count|orders?|volume|weight|clicks|visits|sessions)/i
const RATE = /(rate|ratio|percent|pct|%|share|conversion|churn|retention|discount)/i
const AVERAGEABLE = /(price|rate|ratio|percent|pct|score|age|avg|average|per\b)/i

function daxColRef(tableName: string, colName: string): string {
  return `'${tableName}'[${colName}]`
}

function measureFor(
  tableId: string,
  tableName: string,
  columnId: string,
  columnName: string,
): GeneratedMeasure {
  const averageable = AVERAGEABLE.test(columnName) && !/total|amount|revenue|sales/i.test(columnName)
  const agg: Agg = averageable ? 'avg' : 'sum'

  let kind: MeasureKind = 'generic'
  if (RATE.test(columnName)) kind = 'ratio'
  else if (CURRENCY.test(columnName)) kind = 'currency'
  else if (QUANTITY.test(columnName)) kind = 'quantity'

  const name = `${agg === 'avg' ? 'Average' : 'Total'} ${columnName.replace(/_/g, ' ')}`
  const fn = agg === 'avg' ? 'AVERAGE' : 'SUM'
  const dax = `${name} = ${fn}(${daxColRef(tableName, columnName)})`

  const formatString =
    kind === 'currency'
      ? '\\$#,##0'
      : kind === 'ratio'
        ? '0.0%'
        : agg === 'avg'
          ? '#,##0.00'
          : '#,##0'

  return {
    id: `m__${tableId}__${columnId}__${agg}`,
    name,
    tableId,
    tableName,
    columnId,
    agg,
    dax,
    formatString,
    kind,
    displayFolder: kind === 'currency' ? 'Financials' : kind === 'quantity' ? 'Volumes' : 'Metrics',
    confidence: CURRENCY.test(columnName) || QUANTITY.test(columnName) ? 0.9 : 0.6,
  }
}

/** Generate measures for every fact table's additive numeric columns. */
export function generateMeasures(model: SemanticModel): GeneratedMeasure[] {
  const fkColumns = new Set(model.relationships.map((r) => r.fromColumn))
  const measures: GeneratedMeasure[] = []

  const factTables = model.tables.filter((t) => t.role === 'fact')
  const tables = factTables.length > 0 ? factTables : model.tables

  for (const table of tables) {
    let added = 0
    for (const col of table.columns) {
      if (col.dataType !== 'integer' && col.dataType !== 'decimal') continue
      if (col.role === 'key') continue
      if (fkColumns.has(col.id)) continue
      // Skip obvious identifiers even if numeric.
      if (/(^id$|_id$|id$|code|zip|postal|year|latitude|longitude|lat$|lon$|lng$)/i.test(col.name))
        continue
      measures.push(measureFor(table.id, table.name, col.id, col.name))
      added++
    }

    // A row-count measure per fact is always useful.
    measures.push({
      id: `m__${table.id}__rows__count`,
      name: `${table.name} Count`,
      tableId: table.id,
      tableName: table.name,
      columnId: '',
      agg: 'count',
      dax: `${table.name} Count = COUNTROWS('${table.name}')`,
      formatString: '#,##0',
      kind: 'count',
      displayFolder: 'Metrics',
      confidence: added > 0 ? 0.7 : 0.5,
    })
  }

  return measures
}
