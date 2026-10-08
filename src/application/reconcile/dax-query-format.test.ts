import { describe, it, expect } from 'vitest'
import { formatDaxQuery } from './dax-query-format'

/** Identifiers, literals and punctuation with whitespace removed — what must
 * survive formatting untouched. */
const meaning = (dax: string) =>
  (dax.match(/'[^']*'|"[^"]*"|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*|[(),.]/g) ?? [])
    .map((t) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t.toUpperCase() : t))

describe('preserves meaning', () => {
  const q = `EVALUATE SUMMARIZE( ADDCOLUMNS('Fact_Sales', "Yr", YEAR('Fact_Sales'[OrderDate]), "Product", RELATED('Dim_product'[Category])), [Yr],[Product], "Total_Sales", SUM('Fact_Sales'[SalesAmount]))`

  it('a real reconciliation query is unchanged apart from layout', () => {
    expect(meaning(formatDaxQuery(q))).toEqual(meaning(q))
  })

  it('column names inside quotes are untouched', () => {
    const out = formatDaxQuery(q)
    expect(out).toContain('"Total_Sales"')
    expect(out).toContain("'Fact_Sales'[SalesAmount]")
  })
})

describe('query keywords get their own line', () => {
  it('EVALUATE does not share a line with the expression', () => {
    const out = formatDaxQuery(`EVALUATE SUMMARIZE('T', [A])`)
    expect(out.split('\n')[0].trim()).toBe('EVALUATE')
  })

  it('a column named like a keyword is NOT split', () => {
    // Why the ORDER BY rule was dropped rather than fixed: an unanchored rule
    // did not mask string literals, and would have broken this name in half.
    const out = formatDaxQuery(`EVALUATE SUMMARIZE('T', [A], "Order By", SUM('T'[B]))`)
    expect(out).toContain('"Order By"')
  })
})

describe('degrades safely', () => {
  it('empty input is returned as given', () => {
    expect(formatDaxQuery('')).toBe('')
    expect(formatDaxQuery('  ')).toBe('  ')
  })

  it('is idempotent', () => {
    const once = formatDaxQuery(`EVALUATE SUMMARIZE('T', [A], "X", SUM('T'[B]))`)
    expect(formatDaxQuery(once)).toBe(once)
  })

  it('does not throw on nonsense', () => {
    expect(() => formatDaxQuery('EVALUATE ((((')).not.toThrow()
  })
})
