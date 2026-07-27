/**
 * In-browser evaluator tests — the sample-data preview path used whenever the
 * Desktop bridge is not connected. The contract under test: supported DAX
 * computes the right number; anything outside the subset returns a friendly
 * note (ok: false) instead of throwing or returning a wrong value.
 */
import { describe, it, expect } from 'vitest'
import { evaluateDax } from './evaluator'
import { makeCtx } from '@/application/query/query-engine'
import type { SemanticModel } from '@/domain/model'
import type { DatasetData } from '@/application/import/types'

const model: SemanticModel = {
  id: 'm1',
  name: 'Test',
  relationships: [],
  tables: [
    {
      id: 'sales',
      name: 'Sales',
      role: 'fact',
      columns: [
        { id: 'amt', name: 'Amount', dataType: 'decimal', role: 'measureCandidate' },
        { id: 'qty', name: 'Qty', dataType: 'integer', role: 'measureCandidate' },
        { id: 'reg', name: 'Region', dataType: 'string', role: 'dimension' },
      ],
      measures: [
        { id: 'total', name: 'Total Amount', expression: 'SUM(Sales[Amount])' },
      ],
    },
  ],
}

const data: DatasetData[] = [
  {
    id: 'sales',
    name: 'Sales',
    columns: [],
    rowCount: 3,
    rows: [
      [100, 1, 'East'],
      [200, 2, 'West'],
      [300, 3, 'East'],
    ],
  },
]

const ctx = makeCtx(model, data)

const value = (dax: string): number => {
  const r = evaluateDax(dax, ctx)
  if (!r.ok) throw new Error(`expected a value, got note: ${r.note}`)
  return r.value
}

describe('evaluateDax aggregations', () => {
  it('SUM', () => expect(value('SUM(Sales[Amount])')).toBe(600))
  it('AVERAGE', () => expect(value('AVERAGE(Sales[Amount])')).toBe(200))
  it('MIN / MAX', () => {
    expect(value('MIN(Sales[Amount])')).toBe(100)
    expect(value('MAX(Sales[Amount])')).toBe(300)
  })
  it('DISTINCTCOUNT', () => expect(value('DISTINCTCOUNT(Sales[Region])')).toBe(2))
  it('COUNTROWS', () => expect(value('COUNTROWS(Sales)')).toBe(3))
})

describe('evaluateDax expressions', () => {
  it('arithmetic over aggregates', () => {
    expect(value('SUM(Sales[Amount]) * 2')).toBe(1200)
    expect(value('SUM(Sales[Amount]) - SUM(Sales[Qty])')).toBe(594)
  })
  it('DIVIDE', () => {
    expect(value('DIVIDE(SUM(Sales[Amount]), COUNTROWS(Sales))')).toBe(200)
  })
  it('VAR / RETURN', () => {
    expect(value('VAR x = SUM(Sales[Amount]) RETURN x / 2')).toBe(300)
  })
  it('measure reference resolves through the model', () => {
    expect(value('[Total Amount] * 2')).toBe(1200)
  })
  it('SUMX row iterator', () => {
    expect(value('SUMX(Sales, Sales[Amount] * Sales[Qty])')).toBe(1400)
  })
  it('CALCULATE with a same-table filter', () => {
    expect(value('CALCULATE(SUM(Sales[Amount]), Sales[Region] = "East")')).toBe(400)
  })
  it('IF over an aggregate condition', () => {
    expect(value('IF(COUNTROWS(Sales) > 2, 1, 0)')).toBe(1)
  })
  it('IF condition comparing against a number literal (regression: number token ate the comma)', () => {
    expect(value('IF(SUM(Sales[Amount]) > 500, 1, 0)')).toBe(1)
    expect(value('IF(1 > 0, 5, 6)')).toBe(5)
  })
})

describe('evaluateDax fail-soft contract', () => {
  it('unsupported functions return a note, never throw', () => {
    const r = evaluateDax('PATH(Sales[Region], Sales[Region])', ctx)
    expect(r.ok).toBe(false)
  })
  it('unknown table returns a note', () => {
    const r = evaluateDax('SUM(Nope[Amount])', ctx)
    expect(r.ok).toBe(false)
  })
  it('garbage input returns a note', () => {
    const r = evaluateDax('!!! not dax at all', ctx)
    expect(r.ok).toBe(false)
  })
})
