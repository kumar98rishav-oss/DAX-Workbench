/**
 * The trust-but-verify core: validateReferences must catch AI-invented tables,
 * columns and measures — WITHOUT false-flagging DAX variables, function names,
 * or the legal `'Table'[Measure]` form. Every case here is one an AI could
 * plausibly emit into a real finance model.
 */
import { describe, it, expect } from 'vitest'
import { validateReferences, unknownReferences } from './validate'
import type { SemanticModel, Table, Column, Measure, DataType } from '@/domain/model'

function col(name: string, dataType: DataType = 'decimal'): Column {
  return { id: name, name, dataType, role: 'measureCandidate' }
}
function meas(name: string, expression = '0'): Measure {
  return { id: name, name, expression }
}
function tbl(name: string, columns: Column[], measures: Measure[] = []): Table {
  return { id: name, name, role: 'fact', columns, measures }
}
// A model shaped like the live finance report.
const MODEL: SemanticModel = {
  tables: [
    tbl('fct_Billing', [col('Revenue'), col('CostGBP'), col('BillableHours')]),
    tbl('dim_date', [{ ...col('Date', 'dateTime') }, col('Year', 'integer')]),
    tbl('_Measures', [], [meas('Revenue'), meas('Gross Margin %'), meas('Revenue YTD')]),
  ],
} as SemanticModel

describe('validateReferences — catches invented references', () => {
  it('flags an invented TABLE in a table-only function (the classic hole)', () => {
    // `Dates` doesn't exist — dim_date does. parseDependencies would drop this.
    const v = validateReferences("CALCULATE ( [Revenue], DATESYTD ( ALL ( Dates ) ) )", MODEL)
    expect(v.ok).toBe(false)
    expect(v.unknownTables).toContain('Dates')
  })

  it('flags an invented COLUMN on a real table', () => {
    const v = validateReferences('SUM ( fct_Billing[Profit] )', MODEL)
    expect(v.unknownColumns).toContain('fct_Billing[Profit]')
    expect(v.unknownTables).toHaveLength(0)
  })

  it('flags a qualified ref whose TABLE is invented', () => {
    const v = validateReferences("SUM ( 'Sales'[Amount] )", MODEL)
    expect(v.unknownTables).toContain('Sales')
    expect(v.unknownColumns).toHaveLength(0)
  })

  it('flags an invented MEASURE reference', () => {
    const v = validateReferences('[Revenue] - [Made Up Measure]', MODEL)
    expect(v.unknownMeasures).toContain('[Made Up Measure]')
  })

  it('reports every distinct problem at once', () => {
    const v = validateReferences('CALCULATE ( [Ghost], SUM ( fct_Billing[Nope] ), ALL ( Phantom ) )', MODEL)
    expect(v.unknownMeasures).toContain('[Ghost]')
    expect(v.unknownColumns).toContain('fct_Billing[Nope]')
    expect(v.unknownTables).toContain('Phantom')
    expect(v.ok).toBe(false)
  })
})

describe('validateReferences — does NOT false-flag valid DAX', () => {
  it('passes a fully valid measure', () => {
    const v = validateReferences("CALCULATE ( [Revenue], DATESYTD ( 'dim_date'[Date] ) )", MODEL)
    expect(v).toEqual({ ok: true, unknownColumns: [], unknownTables: [], unknownMeasures: [] })
  })

  it("accepts 'Table'[Measure] — a legal measure reference, not a column", () => {
    const v = validateReferences("CALCULATE ( '_Measures'[Revenue], ALL ( fct_Billing ) )", MODEL)
    expect(v.ok).toBe(true)
  })

  it('does NOT mistake a VAR table for a missing table', () => {
    const dax = 'VAR Filtered = FILTER ( fct_Billing, fct_Billing[Revenue] > 0 ) RETURN COUNTROWS ( Filtered )'
    const v = validateReferences(dax, MODEL)
    expect(v.ok).toBe(true)
    expect(v.unknownTables).toHaveLength(0)
  })

  it('does NOT treat a nested table function as a missing table', () => {
    // FILTER(ALL(fct_Billing), ...) — ALL is a function, not a table arg to FILTER.
    const v = validateReferences('COUNTROWS ( FILTER ( ALL ( fct_Billing ), fct_Billing[Revenue] > 0 ) )', MODEL)
    expect(v.ok).toBe(true)
  })

  it('ignores refs inside string literals and comments', () => {
    const dax = 'VAR x = "ALL ( Ghost )" -- SUM ( Phantom[Col] )\nRETURN [Revenue]'
    const v = validateReferences(dax, MODEL)
    expect(v.ok).toBe(true)
  })

  it('accepts a bare column ref in row context', () => {
    // [Revenue] is also a column on fct_Billing — a bare ref is legal.
    const v = validateReferences('SUMX ( fct_Billing, [Revenue] * 1.2 )', MODEL)
    expect(v.ok).toBe(true)
  })

  it('honours extraMeasures for siblings created in the same batch', () => {
    const dax = '[Revenue YTD] - [Revenue PY]'
    expect(validateReferences(dax, MODEL).ok).toBe(false) // Revenue PY not in model yet
    expect(validateReferences(dax, MODEL, ['Revenue PY']).ok).toBe(true)
  })
})

describe('unknownReferences — flat list for display', () => {
  it('concatenates tables, columns and measures', () => {
    const out = unknownReferences('CALCULATE ( [Ghost], fct_Billing[Nope], ALL ( Phantom ) )', MODEL)
    expect(out).toEqual(expect.arrayContaining(['Phantom', 'fct_Billing[Nope]', '[Ghost]']))
  })
  it('is empty for valid DAX', () => {
    expect(unknownReferences('[Revenue] * 2', MODEL)).toHaveLength(0)
  })
})
