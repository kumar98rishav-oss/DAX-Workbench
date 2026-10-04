/**
 * Translator tests.
 *
 * Weighted toward what it REFUSES. A translator that quietly emits something
 * plausible for a construct it does not understand is worse than one that emits
 * nothing: the user would run the draft believing the tool had understood it.
 */
import { describe, it, expect } from 'vitest'
import { daxToSql, sqlToDax, type TranslateContext } from './translate'

const ctx: TranslateContext = {
  modelTables: ['Fact_Sales', 'Dim_Product', 'Dim_Date'],
  relationships: [
    { fromTable: 'Fact_Sales', fromColumn: 'ProductKey', toTable: 'Dim_Product', toColumn: 'ProductKey' },
  ],
  schema: 'dbo',
}

const ok = (t: ReturnType<typeof sqlToDax>) => {
  if (!t.ok) throw new Error(`expected a translation, got refusal: ${t.reason}`)
  return t
}

describe('sqlToDax — the shape reconciliation actually uses', () => {
  it('translates a grouped join exactly as a person would write it', () => {
    // Verified against the live model: this DAX returns the same 144 rows and
    // the same 11,687,137.85 total as the SQL it came from.
    const t = ok(sqlToDax(`
      SELECT YEAR(FS.OrderDate) AS [Yr], MONTH(FS.OrderDate) AS [Mo],
             DP.Category AS [Product], SUM(FS.SalesAmount) AS TotalSales
      FROM dbo.Fact_sales AS FS
      INNER JOIN dbo.Dim_product AS DP ON FS.ProductKey = DP.ProductKey
      GROUP BY YEAR(FS.OrderDate), MONTH(FS.OrderDate), DP.Category
      ORDER BY [Yr], [Mo], [Product];`, ctx))
    expect(t.query).toContain(`"Yr", YEAR ( 'Fact_Sales'[OrderDate] )`)
    expect(t.query).toContain(`"Product", RELATED ( 'Dim_Product'[Category] )`)
    expect(t.query).toContain(`[Yr], [Mo], [Product]`)
    expect(t.query).toContain(`"TotalSales", SUM ( 'Fact_Sales'[SalesAmount] )`)
  })

  it('uses the model\'s own capitalisation, not the SQL author\'s', () => {
    // dbo.Fact_sales in the SQL; the model calls it Fact_Sales.
    const t = ok(sqlToDax('SELECT COUNT(*) AS [n] FROM dbo.Fact_sales', ctx))
    expect(t.query).toContain(`'Fact_Sales'`)
    expect(t.query).not.toContain(`'Fact_sales'`)
  })

  it('does not mistake an alias for part of the table name', () => {
    // `FROM t AS F` once parsed as a table literally called "t AS F".
    const t = ok(sqlToDax('SELECT F.ProductKey AS [k] FROM dbo.Fact_Sales AS F', ctx))
    expect(t.query).toContain(`'Fact_Sales'[ProductKey]`)
  })

  it('keeps COUNT(DISTINCT x) in a space where a NULL means the same thing', () => {
    const t = ok(sqlToDax('SELECT COUNT(DISTINCT ProductKey) AS [n] FROM dbo.Fact_Sales', ctx))
    expect(t.query).toContain('DISTINCTCOUNTNOBLANK')
    expect(t.notes.join(' ')).toMatch(/would count BLANK/i)
  })

  it('does not split an aggregate with a space inside it', () => {
    // COUNT(DISTINCT ProductKey) must not parse as expr "COUNT(DISTINCT"
    // plus an output name "ProductKey)".
    const t = ok(sqlToDax('SELECT COUNT(DISTINCT ProductKey) FROM dbo.Fact_Sales', ctx))
    expect(t.query).toContain('DISTINCTCOUNTNOBLANK')
  })

  it('emits ROW for pure scalars and SUMMARIZECOLUMNS for a plain group', () => {
    expect(ok(sqlToDax('SELECT COUNT(*) AS [n], SUM(SalesAmount) AS [t] FROM dbo.Fact_Sales', ctx)).query).toMatch(/^EVALUATE\nROW/)
    expect(ok(sqlToDax('SELECT ProductKey AS [p], SUM(SalesAmount) AS [t] FROM dbo.Fact_Sales GROUP BY ProductKey', ctx)).query).toContain('SUMMARIZECOLUMNS')
  })

  it('emits SELECTCOLUMNS when nothing is aggregated', () => {
    expect(ok(sqlToDax('SELECT OrderID, SalesAmount FROM dbo.Fact_Sales', ctx)).query).toContain('SELECTCOLUMNS')
  })

  it('turns a simple WHERE into FILTER and says what that changes', () => {
    const t = ok(sqlToDax("SELECT COUNT(*) AS [n] FROM dbo.Fact_Sales WHERE OrderQty > 0 AND ProductKey = 7", ctx))
    expect(t.query).toContain('FILTER')
    expect(t.query).toContain(`'Fact_Sales'[OrderQty] > 0`)
    expect(t.notes.join(' ')).toMatch(/BLANK/)
  })

  it('warns that an INNER JOIN and RELATED disagree about unmatched rows', () => {
    const t = ok(sqlToDax('SELECT DP.Category AS [c] FROM dbo.Fact_Sales AS FS INNER JOIN dbo.Dim_Product AS DP ON FS.ProductKey = DP.ProductKey', ctx))
    expect(t.notes.join(' ')).toMatch(/drops unmatched rows/i)
  })

  it('says when it could not verify the relationship it used', () => {
    const t = ok(sqlToDax('SELECT D.X AS [x] FROM dbo.Fact_Sales AS F INNER JOIN dbo.Unknown_Dim AS D ON F.K = D.K', ctx))
    expect(t.notes.join(' ')).toMatch(/No active relationship/i)
  })

  it('notes that ORDER BY was dropped rather than silently losing it', () => {
    const t = ok(sqlToDax('SELECT ProductKey AS [p], SUM(SalesAmount) AS [t] FROM dbo.Fact_Sales GROUP BY ProductKey ORDER BY [p]', ctx))
    expect(t.notes.join(' ')).toMatch(/ORDER BY was dropped/i)
  })

  it('ignores comments', () => {
    expect(ok(sqlToDax('-- a count\nSELECT COUNT(*) AS [n] FROM dbo.Fact_Sales /* trailing */;', ctx)).query).toContain('COUNTROWS')
  })
})

describe('sqlToDax — refuses by name rather than guessing', () => {
  const cases: [string, string, RegExp][] = [
    ['an outer join', 'SELECT a FROM t LEFT JOIN u ON t.k = u.k', /outer or cross join/i],
    ['a cross join', 'SELECT a FROM t CROSS JOIN u', /outer or cross join/i],
    ['a CTE', 'WITH x AS (SELECT 1 AS a) SELECT a FROM x', /SELECT statement/i],
    ['a window function', 'SELECT SUM(x) OVER (PARTITION BY y) AS a FROM t', /window function/i],
    ['HAVING', 'SELECT a, SUM(b) AS s FROM t GROUP BY a HAVING SUM(b) > 1', /HAVING/i],
    ['a subquery', 'SELECT a FROM (SELECT 1 AS a) z', /subquery/i],
    ['CASE', 'SELECT CASE WHEN a = 1 THEN 2 ELSE 3 END AS x FROM t', /CASE/i],
    ['UNION', 'SELECT a FROM t UNION SELECT a FROM u', /set operation/i],
    ['TOP', 'SELECT TOP 10 a FROM t', /TOP/i],
    ['an unknown function', 'SELECT DATEDIFF(day, a, b) AS d FROM t', /not recognised/i],
    ['a complex WHERE', "SELECT COUNT(*) AS n FROM t WHERE a IN (1,2)", /not recognised/i],
    ['a mismatched GROUP BY', 'SELECT a, b, SUM(c) AS s FROM t GROUP BY a', /does not line up/i],
  ]
  for (const [what, sql, reason] of cases) {
    it(`refuses ${what}`, () => {
      const t = sqlToDax(sql, ctx)
      expect(t.ok).toBe(false)
      if (!t.ok) expect(t.reason).toMatch(reason)
    })
  }

  it('refuses anything that is not a SELECT', () => {
    expect(sqlToDax('UPDATE t SET a = 1', ctx).ok).toBe(false)
    expect(sqlToDax('', ctx).ok).toBe(false)
  })
})

describe('daxToSql', () => {
  it('round-trips a grouped join back to equivalent SQL', () => {
    const dax = `EVALUATE
SUMMARIZE (
    ADDCOLUMNS (
        'Fact_Sales',
        "Yr", YEAR ( 'Fact_Sales'[OrderDate] ),
        "Product", RELATED ( 'Dim_Product'[Category] )
    ),
    [Yr], [Product],
    "TotalSales", SUM ( 'Fact_Sales'[SalesAmount] )
)`
    const t = ok(daxToSql(dax, ctx))
    expect(t.query).toContain('YEAR([Fact_Sales].[OrderDate]) AS [Yr]')
    expect(t.query).toContain('INNER JOIN [dbo].[Dim_Product]')
    expect(t.query).toContain('ON [Fact_Sales].[ProductKey] = [Dim_Product].[ProductKey]')
    expect(t.query).toContain('GROUP BY')
  })

  it('translates ROW and SUMMARIZECOLUMNS', () => {
    expect(ok(daxToSql(`EVALUATE ROW ( "n", COUNTROWS ( 'Fact_Sales' ) )`, ctx)).query).toContain('COUNT(*) AS [n]')
    expect(ok(daxToSql(`EVALUATE SUMMARIZECOLUMNS ( 'Fact_Sales'[ProductKey], "t", SUM ( 'Fact_Sales'[SalesAmount] ) )`, ctx)).query).toContain('GROUP BY')
  })

  it('maps DISTINCTCOUNTNOBLANK back to COUNT(DISTINCT …)', () => {
    expect(ok(daxToSql(`EVALUATE ROW ( "n", DISTINCTCOUNTNOBLANK ( 'Fact_Sales'[ProductKey] ) )`, ctx)).query)
      .toContain('COUNT(DISTINCT [Fact_Sales].[ProductKey])')
  })

  it('leaves the ON clause for the user when it cannot find the relationship', () => {
    const t = ok(daxToSql(`EVALUATE ROW ( "c", RELATED ( 'Unknown_Dim'[X] ), "n", COUNTROWS ( 'Fact_Sales' ) )`, ctx))
    expect(t.query).toMatch(/no active relationship found/i)
    expect(t.notes.join(' ')).toMatch(/left for you to complete/i)
  })

  const refuse: [string, string, RegExp][] = [
    ['VAR / RETURN', `EVALUATE VAR x = 1 RETURN ROW("a", x)`, /VAR \/ RETURN/i],
    ['CALCULATE', `EVALUATE ROW("a", CALCULATE(SUM('T'[x]), ALL('T')))`, /CALCULATE/i],
    ['time intelligence', `EVALUATE ROW("a", TOTALYTD(SUM('T'[x]), 'D'[Date]))`, /time-intelligence/i],
    ['USERELATIONSHIP', `EVALUATE ROW("a", USERELATIONSHIP('A'[x],'B'[y]))`, /USERELATIONSHIP/i],
    ['TOPN', `EVALUATE TOPN(10, 'T')`, /TOPN/i],
    ['an unsupported shape', `EVALUATE FILTER('T', 'T'[x] > 1)`, /Only ROW, SELECTCOLUMNS/i],
  ]
  for (const [what, dax, reason] of refuse) {
    it(`refuses ${what}`, () => {
      const t = daxToSql(dax, ctx)
      expect(t.ok).toBe(false)
      if (!t.ok) expect(t.reason).toMatch(reason)
    })
  }

  it('refuses anything not starting with EVALUATE', () => {
    expect(daxToSql(`ROW("a", 1)`, ctx).ok).toBe(false)
  })
})

describe('both directions always warn about what they cannot see', () => {
  it('a join translation always carries at least one caveat', () => {
    const t = ok(sqlToDax('SELECT DP.Category AS [c] FROM dbo.Fact_Sales AS FS INNER JOIN dbo.Dim_Product AS DP ON FS.ProductKey = DP.ProductKey', ctx))
    expect(t.notes.length).toBeGreaterThan(0)
  })
  it('a DAX translation involving a join warns about dropped rows', () => {
    const t = ok(daxToSql(`EVALUATE ROW ( "c", RELATED ( 'Dim_Product'[Category] ), "n", COUNTROWS ( 'Fact_Sales' ) )`, ctx))
    expect(t.notes.join(' ')).toMatch(/drops rows/i)
  })
})
