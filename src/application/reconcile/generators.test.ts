/**
 * L1 — Generator golden tests, and L4 — identifier quoting.
 *
 * The generated queries are the contract: a regression shows up here as a
 * string diff rather than as a wrong number against a real warehouse. L4
 * matters because user-controlled names reach a query string — quoting is a
 * safety boundary, not tidiness.
 */
import { describe, it, expect } from 'vitest'
import {
  byGrain,
  dateCoverage,
  daxColumn,
  daxTable,
  distinctValues,
  duplicateKeys,
  nullCount,
  orphanKeys,
  rowCount,
  sqlIdent,
  sqlObject,
  valueSet,
} from './generators'

describe('L4 — identifier quoting', () => {
  it('quotes a DAX table and doubles embedded single quotes', () => {
    expect(daxTable('Fact Sales')).toBe("'Fact Sales'")
    expect(daxTable("O'Brien Sales")).toBe("'O''Brien Sales'")
  })
  it('quotes a DAX column and doubles embedded closing brackets', () => {
    expect(daxColumn('Sales', 'Amount')).toBe("'Sales'[Amount]")
    expect(daxColumn('Sales', 'a]b')).toBe("'Sales'[a]]b]")
  })
  it('quotes a T-SQL identifier and doubles embedded closing brackets', () => {
    expect(sqlIdent('Order Lines')).toBe('[Order Lines]')
    expect(sqlIdent('My] Table')).toBe('[My]] Table]')
  })
  it('qualifies with a schema when given', () => {
    expect(sqlObject('Fact_Sales', 'dbo')).toBe('[dbo].[Fact_Sales]')
    expect(sqlObject('Fact_Sales')).toBe('[Fact_Sales]')
  })
  it('a crafted name cannot break out of its quoting', () => {
    // Without doubling, "x] FROM sys.tables --" would escape the brackets.
    const hostile = 'x] FROM sys.tables --'
    const quoted = sqlIdent(hostile)
    expect(quoted).toBe('[x]] FROM sys.tables --]')
    // Every ] inside the body is doubled, so the only single ] is the terminator.
    expect(quoted.slice(1, -1).split(']').length - 1).toBe(2)
  })
})

const T = { table: 'Fact Sales', sqlObject: 'Fact_Sales', sqlSchema: 'dbo' }
const C = { ...T, column: 'Customer Id', sqlColumn: 'CustomerID' }

describe('L1 — row count', () => {
  const g = rowCount(T)
  it('emits COUNTROWS against the quoted model table', () => {
    expect(g.dax).toBe(`EVALUATE\nROW ( "RowCount", COUNTROWS ( 'Fact Sales' ) )`)
  })
  it('emits COUNT(*) against the qualified SQL object', () => {
    expect(g.sql).toBe('SELECT COUNT(*) AS [RowCount]\nFROM [dbo].[Fact_Sales];')
  })
})

describe('L1 — distinct values', () => {
  const g = distinctValues(C)

  it('uses DISTINCTCOUNTNOBLANK, never DISTINCTCOUNT', () => {
    // THE trap. DAX DISTINCTCOUNT counts BLANK as a value; SQL COUNT(DISTINCT)
    // ignores NULL, so the two differ by exactly 1 on any nullable column.
    expect(g.dax).toContain('DISTINCTCOUNTNOBLANK')
    expect(g.dax).not.toMatch(/\bDISTINCTCOUNT\s*\(/)
  })
  it('emits the matching SQL', () => {
    expect(g.sql).toBe('SELECT COUNT(DISTINCT [CustomerID]) AS [DistinctValues]\nFROM [dbo].[Fact_Sales];')
  })
  it('explains the asymmetry in its note', () => {
    expect(g.note).toMatch(/ignores NULL/i)
  })
})

describe('L1 — null count', () => {
  const g = nullCount(C)
  it('emits COUNTBLANK on the model side', () => {
    expect(g.dax).toBe(`EVALUATE\nROW ( "Blanks", COUNTBLANK ( 'Fact Sales'[Customer Id] ) )`)
  })
  it('emits a SUM(CASE …) on the source side', () => {
    expect(g.sql).toContain('SUM(CASE WHEN [CustomerID] IS NULL THEN 1 ELSE 0 END) AS [Blanks]')
  })
})

describe('L1 — duplicate business keys', () => {
  const g = duplicateKeys({
    ...T,
    columns: [
      { model: 'Order Id', sql: 'OrderID' },
      { model: 'Order Line', sql: 'OrderLine' },
    ],
  })

  it('groups natively by each key column — never concatenates', () => {
    // Concatenation would make (1,23) and (12,3) both "123".
    expect(g.sql).toContain('GROUP BY [OrderID], [OrderLine]')
    expect(g.sql).not.toMatch(/\+|CONCAT/)
    expect(g.dax).toContain(`'Fact Sales'[Order Id], 'Fact Sales'[Order Line]`)
    expect(g.dax).not.toContain('&')
  })
  it('keeps only keys appearing more than once', () => {
    expect(g.sql).toContain('HAVING COUNT(*) > 1')
    expect(g.dax).toContain('[Rows] > 1')
  })

  it('returns COUNTS, so a clean table is a pass rather than "could not run"', () => {
    // Listing the offending rows composes wrongly: a clean table returns no
    // rows on EITHER side, both-sides-empty is a refusal, and a passing check
    // would have been reported as inconclusive.
    expect(g.sql).toContain('AS [DuplicateKeys]')
    expect(g.sql).toContain('AS [ExtraRows]')
    expect(g.dax).toContain('"DuplicateKeys"')
    expect(g.dax).toContain('"ExtraRows"')
  })
  it('coalesces the empty case to 0 on both sides', () => {
    // COUNTROWS of an empty table is BLANK, which compares as "no value"
    // rather than as a zero.
    expect(g.dax).toContain('COALESCE ( COUNTROWS ( _Dups ), 0 )')
    expect(g.sql).toContain('ISNULL(SUM([Rows]) - COUNT(*), 0)')
  })
})

describe('L1 — orphaned foreign keys', () => {
  const R = {
    factTable: 'Fact Sales', factColumn: 'Product Key',
    factSqlObject: 'Fact_Sales', factSqlSchema: 'dbo', factSqlColumn: 'ProductKey',
    dimTable: 'Dim Product', dimColumn: 'Product Key',
    dimSqlObject: 'Dim_Product', dimSqlSchema: 'dbo', dimSqlColumn: 'ProductKey',
  }
  const g = orphanKeys(R)

  it('anti-joins on the source side', () => {
    expect(g.sql).toContain('LEFT JOIN [dbo].[Dim_Product] AS d')
    expect(g.sql).toContain('ON f.[ProductKey] = d.[ProductKey]')
    expect(g.sql).toContain('d.[ProductKey] IS NULL')
  })

  it('walks the relationship with RELATED on the model side', () => {
    expect(g.dax).toContain(`RELATED ( 'Dim Product'[Product Key] )`)
    expect(g.dax).toContain(`FILTER (\n        'Fact Sales'`)
  })

  it('EXCLUDES blank keys on both sides', () => {
    // "No product recorded" and "a product id that does not exist" are different
    // problems with different fixes; the nulls check already owns the first.
    expect(g.sql).toContain('f.[ProductKey] IS NOT NULL')
    expect(g.dax).toContain(`NOT ISBLANK ( 'Fact Sales'[Product Key] )`)
  })

  it('reports rows AND distinct bad keys', () => {
    // 4,000 rows across 3 bad keys is a mapping gap; across 4,000 keys it is a
    // broken load. The counts tell those apart.
    expect(g.sql).toContain('AS [Orphans]')
    expect(g.sql).toContain('COUNT(DISTINCT f.[ProductKey]) AS [OrphanKeys]')
    expect(g.dax).toContain('"Orphans"')
    expect(g.dax).toContain('"OrphanKeys"')
  })

  it('coalesces the clean case to 0 so a healthy model is a pass', () => {
    expect(g.dax).toContain('COALESCE ( COUNTROWS ( _Orphans ), 0 )')
  })

  it('explains that blanks are somebody else’s check', () => {
    expect(g.note).toMatch(/blank keys are excluded/i)
  })
})

describe('L1 — by grain', () => {
  const dims = [
    { model: 'Year', sql: 'OrderYear' },
    { model: 'Month', sql: 'OrderMonth' },
  ]

  it('counts rows when no measure is given', () => {
    const g = byGrain({ ...T, dimensions: dims })
    expect(g.dax).toContain(`COUNTROWS ( 'Fact Sales' )`)
    expect(g.sql).toContain('COUNT(*) AS [Value]')
  })
  it('sums the paired measure when one is given', () => {
    const g = byGrain({ ...T, dimensions: dims, measure: { model: 'Amount', sqlExpression: 'LineAmount' } })
    expect(g.dax).toContain(`SUM ( 'Fact Sales'[Amount] )`)
    expect(g.sql).toContain('SUM(LineAmount) AS [Value]')
  })
  it('groups both sides by every dimension, in the drill order', () => {
    const g = byGrain({ ...T, dimensions: dims })
    expect(g.dax).toContain(`'Fact Sales'[Year], 'Fact Sales'[Month]`)
    expect(g.sql).toContain('GROUP BY [OrderYear], [OrderMonth]')
  })
  it('names the drill path in its note', () => {
    expect(byGrain({ ...T, dimensions: dims }).note).toContain('Year ▸ Month')
  })
})

describe('L1 — date coverage', () => {
  const D = { ...T, column: 'Order Date', sqlColumn: 'OrderDate' }
  const g = dateCoverage(D)

  it('returns range AND density, because they fail differently', () => {
    // First/Last move when a boundary shifts; Days alone moves when a date in
    // the middle is missing. Either on its own misses a real failure.
    for (const k of ['First', 'Last', 'Days']) {
      expect(g.sql).toContain(`AS [${k}]`)
      expect(g.dax).toContain(`"${k}"`)
    }
  })
  it('counts days with DISTINCTCOUNTNOBLANK to match COUNT(DISTINCT)', () => {
    expect(g.dax).toContain('DISTINCTCOUNTNOBLANK')
    expect(g.sql).toContain('COUNT(DISTINCT [OrderDate])')
  })
  it('quotes both identifiers', () => {
    expect(g.dax).toContain(`'Fact Sales'[Order Date]`)
    expect(g.sql).toContain('FROM [dbo].[Fact_Sales]')
  })
})

describe('L1 — value set', () => {
  const g = valueSet(C)

  it('returns each distinct value with its frequency, not just a count', () => {
    expect(g.sql).toContain('GROUP BY [CustomerID]')
    expect(g.sql).toContain('COUNT(*) AS [Value]')
    expect(g.dax).toContain(`'Fact Sales'[Customer Id]`)
  })
  it('explains why a matching count is not a matching set', () => {
    expect(g.note).toMatch(/does not mean a matching set/i)
  })
})

describe('generated queries are read-only', () => {
  const all = [
    rowCount(T),
    distinctValues(C),
    nullCount(C),
    dateCoverage({ ...T, column: 'Order Date', sqlColumn: 'OrderDate' }),
    valueSet(C),
    duplicateKeys({ ...T, columns: [{ model: 'Order Id', sql: 'OrderID' }] }),
    byGrain({ ...T, dimensions: [{ model: 'Year', sql: 'OrderYear' }] }),
  ]
  it('every generated SQL statement begins with SELECT', () => {
    for (const g of all) expect(g.sql.trimStart().toUpperCase().startsWith('SELECT')).toBe(true)
  })
  it('no generated SQL contains a mutating keyword', () => {
    for (const g of all) {
      expect(g.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|GRANT)\b/i)
    }
  })
  it('every generated DAX statement begins with EVALUATE', () => {
    for (const g of all) expect(g.dax.trimStart().startsWith('EVALUATE')).toBe(true)
  })
})
