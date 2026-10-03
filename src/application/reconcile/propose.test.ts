/**
 * Proposer tests.
 *
 * The rules that matter are the ones about what NOT to propose. A suite full of
 * checks that always fail, or that silently compare the wrong grain, is worse
 * than a small suite — people stop reading it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { proposeChecks, resetProposalIds, sqlObjectFromM, unmatched, type ProposeObject, type ProposeSource } from './propose'

beforeEach(resetProposalIds)

const col = (name: string, dataType = 'int') => ({ name, dataType })

const factSales: ProposeObject = {
  schema: 'dbo', name: 'Fact_Sales', kind: 'table',
  primaryKey: ['OrderID', 'OrderLineNo'],
  columns: [col('OrderID'), col('OrderLineNo'), col('OrderDate', 'date'), col('SalesAmount', 'decimal')],
}
const dimProduct: ProposeObject = {
  schema: 'dbo', name: 'Dim_Product', kind: 'table',
  primaryKey: ['ProductKey'],
  columns: [col('ProductKey'), col('ProductName', 'nvarchar')],
}

const src = (name: string, over: Partial<ProposeSource> = {}): ProposeSource =>
  ({ name, kind: 'query', ...over })

describe('proposeChecks — what it generates', () => {
  it('proposes a row count for every matched table', () => {
    const p = proposeChecks([src('Fact_Sales'), src('Dim_Product')], [factSales, dimProduct])
    expect(p.filter((x) => x.kind === 'rowCount').map((x) => x.table)).toEqual(['Fact_Sales', 'Dim_Product'])
  })

  it('proposes date coverage for date columns only', () => {
    const p = proposeChecks([src('Fact_Sales')], [factSales])
    const dates = p.filter((x) => x.kind === 'dateRange')
    expect(dates).toHaveLength(1)
    expect(dates[0].name).toContain('OrderDate')
  })

  it('caps date checks so a wide date dimension cannot flood the suite', () => {
    const wide: ProposeObject = {
      ...factSales, name: 'Dim_Date',
      columns: ['D1', 'D2', 'D3', 'D4', 'D5'].map((n) => col(n, 'date')),
    }
    const p = proposeChecks([src('Dim_Date')], [wide])
    expect(p.filter((x) => x.kind === 'dateRange')).toHaveLength(2)
  })

  it('proposes a duplicate check on the DECLARED primary key', () => {
    const p = proposeChecks([src('Fact_Sales')], [factSales])
    const dup = p.find((x) => x.kind === 'duplicates')
    expect(dup?.name).toContain('OrderID + OrderLineNo')
    expect(dup?.queries.sql).toContain('GROUP BY [OrderID], [OrderLineNo]')
  })

  it('proposes NO duplicate check when the grain is undeclared', () => {
    // Inferring a business key from column names would produce confident checks
    // against the wrong grain — worse than proposing none at all.
    const noPk: ProposeObject = { ...factSales, primaryKey: [] }
    expect(proposeChecks([src('Fact_Sales')], [noPk]).some((x) => x.kind === 'duplicates')).toBe(false)
  })

  it('everything starts ticked, but nothing is applied by itself', () => {
    const p = proposeChecks([src('Fact_Sales')], [factSales])
    expect(p.every((x) => x.selected)).toBe(true)
  })
})

describe('proposeChecks — what it refuses to propose', () => {
  it('skips calculated tables — there is no source to compare against', () => {
    const p = proposeChecks([src('Measures', { kind: 'calculated' })], [factSales])
    expect(p).toHaveLength(0)
  })

  it('skips a model table with no matching SQL object', () => {
    expect(proposeChecks([src('Nowhere')], [factSales])).toHaveLength(0)
  })
})

describe('proposeChecks — cautions', () => {
  it('flags a mapping that was only a name match', () => {
    // A model loaded from CSV extracts names no SQL object at all.
    const p = proposeChecks([src('Fact_Sales', { expression: 'let Source = Csv.Document(x) in Source' })], [factSales])
    expect(p[0].matchedBy).toBe('name')
    expect(p[0].caution).toMatch(/matched by name/i)
  })

  it('does not flag a mapping taken from the source query', () => {
    const m = 'let Source = Sql.Database("srv","db"), t = Source{[Schema="dbo",Item="Fact_Sales"]}[Data] in t'
    const p = proposeChecks([src('Fact_Sales', { expression: m })], [factSales])
    expect(p[0].matchedBy).toBe('query')
    expect(p[0].caution).toBeUndefined()
  })

  it('warns when the model filters rows out, because a difference is then correct', () => {
    const m = 'let Source = Sql.Database("srv","db"), t = Source{[Schema="dbo",Item="Fact_Sales"]}[Data],' +
      ' f = Table.SelectRows(t, each [Status] <> "Cancelled") in f'
    const p = proposeChecks([src('Fact_Sales', { expression: m })], [factSales])
    expect(p[0].caution).toMatch(/filters rows out/i)
  })
})

describe('unmatched', () => {
  it('explains a calculated table rather than dropping it silently', () => {
    const u = unmatched([src('Measures', { kind: 'calculated' })], [factSales])
    expect(u[0]).toMatchObject({ name: 'Measures' })
    expect(u[0].why).toMatch(/calculated/i)
  })
  it('explains a table with no SQL counterpart', () => {
    expect(unmatched([src('Nowhere')], [factSales])[0].why).toMatch(/no SQL table or view/i)
  })
  it('says nothing about tables that matched', () => {
    expect(unmatched([src('Fact_Sales')], [factSales])).toHaveLength(0)
  })
})

describe('sqlObjectFromM', () => {
  it('reads schema and item out of a SQL Server source', () => {
    const m = 'let Source = Sql.Database("srv","db"), t = Source{[Schema="dbo",Item="Fact_Sales"]}[Data] in t'
    expect(sqlObjectFromM(m)).toEqual({ schema: 'dbo', object: 'Fact_Sales' })
  })
  it('returns null for a non-SQL source rather than guessing', () => {
    expect(sqlObjectFromM('let Source = Csv.Document(File.Contents("x.csv")) in Source')).toBeNull()
    expect(sqlObjectFromM(undefined)).toBeNull()
  })
})
