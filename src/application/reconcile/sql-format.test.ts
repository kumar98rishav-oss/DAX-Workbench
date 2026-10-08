/**
 * L3 — SQL formatter.
 *
 * The readability tests are the easy half. The half that matters is
 * "preserves meaning": a formatter that rewrites a WHERE clause would quietly
 * invalidate the comparison this whole tool exists to establish, and it would
 * do it while looking tidier than before.
 */
import { describe, it, expect } from 'vitest'
import { formatSql } from './sql-format'

/** Every token that carries meaning, with all whitespace removed.
 * Formatting may change the spacing and the case of KEYWORDS; it may not
 * change anything else, so this is what must stay identical. */
const meaning = (sql: string) =>
  (sql
    // literals, bracketed/quoted identifiers and comments, kept verbatim
    .match(/'(?:[^']|'')*'|\[[^\]]*\]|"[^"]*"|--[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*|<>|<=|>=|!=|[(),;.*+\-/%=<>&|~^]/g) ?? [])
    .map((t) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t.toUpperCase() : t))

describe('preserves meaning', () => {
  const cases: [string, string][] = [
    ['the real reconciliation query', `
      SELECT YEAR([Fact_Sales].[OrderDate]) AS [Yr], MONTH([Fact_Sales].[OrderDate]) AS [Mo],
      [Dim_product].[Category] AS [Product],
      SUM([Fact_Sales].[SalesAmount]) + Case when YEAR([Fact_Sales].[OrderDate]) = 2024 and
      MONTH([Fact_Sales].[OrderDate]) = 8 and [Dim_product].[Category]= 'home & kitchen' then 50000
      when [Dim_product].[Category]= 'apparel' then -50000 else 0 end AS [Total_Sales]
      FROM [dbo].[Fact_Sales] INNER JOIN [dbo].[Dim_product]
      ON [Fact_Sales].[ProductKey] = [Dim_product].[ProductKey]
      GROUP BY YEAR([Fact_Sales].[OrderDate]), MONTH([Fact_Sales].[OrderDate]), [Dim_product].[Category];`],
    ['a string containing SQL keywords', `SELECT 'FROM WHERE GROUP BY' AS x FROM t`],
    ['a string containing a quote', `SELECT 'it''s fine' AS x FROM t`],
    ['a line comment holding a verb', `SELECT 1 -- DROP TABLE t\nFROM t`],
    ['a block comment', `SELECT /* GROUP BY */ 1 FROM t`],
    ['an identifier named like a clause', `SELECT [Group By], [Order] FROM [Where]`],
    ['nested parentheses', `SELECT SUM(CASE WHEN (a > 1 AND b < 2) THEN c ELSE 0 END) FROM t`],
    ['a subquery', `SELECT a FROM (SELECT b AS a FROM t WHERE x = 1) s WHERE a > 0`],
    ['negative numbers', `SELECT -50000 + 1, a - b FROM t`],
    ['a left join with multiple conditions', `SELECT a FROM x LEFT JOIN y ON x.k = y.k AND x.d = y.d WHERE z IS NOT NULL`],
  ]

  for (const [name, sql] of cases) {
    it(name, () => {
      expect(meaning(formatSql(sql))).toEqual(meaning(sql))
    })
  }
})

describe('is idempotent', () => {
  it('formatting twice changes nothing the second time', () => {
    const sql = `SELECT a, b FROM t INNER JOIN u ON t.k = u.k WHERE a > 1 AND b < 2 GROUP BY a, b`
    const once = formatSql(sql)
    expect(formatSql(once)).toBe(once)
  })
})

describe('readability', () => {
  it('puts each clause on its own line', () => {
    const out = formatSql(`SELECT a FROM t WHERE a > 1 GROUP BY a ORDER BY a`)
    expect(out.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual([
      'SELECT', 'a', 'FROM t', 'WHERE a > 1', 'GROUP BY', 'a', 'ORDER BY', 'a',
    ])
  })

  it('indents the select list', () => {
    expect(formatSql(`SELECT a, b FROM t`)).toBe('SELECT\n    a,\n    b\nFROM t')
  })

  it('breaks a CASE onto readable lines', () => {
    const out = formatSql(`SELECT CASE WHEN a = 1 THEN 10 ELSE 0 END AS x FROM t`)
    expect(out).toContain('CASE')
    expect(out).toContain('WHEN a = 1 THEN 10')
    expect(out).toContain('ELSE 0')
    expect(out).toContain('END AS x')
  })

  it('starts AND / OR on their own lines in a WHERE', () => {
    const out = formatSql(`SELECT a FROM t WHERE a > 1 AND b < 2 OR c = 3`)
    const lines = out.split('\n').map((l) => l.trim())
    expect(lines).toContain('AND b < 2')
    expect(lines).toContain('OR c = 3')
  })

  it('does NOT split a comma inside a function call', () => {
    // Breaking here would scatter DATEDIFF's arguments across three lines.
    const out = formatSql(`SELECT DATEDIFF(day, a, b) AS d FROM t`)
    expect(out).toContain('DATEDIFF(DAY, a, b) AS d')
  })

  it('uppercases keywords but leaves identifiers alone', () => {
    const out = formatSql(`select a from [my table] where b = 1`)
    expect(out).toContain('SELECT')
    expect(out).toContain('WHERE')
    expect(out).toContain('[my table]')  // not upper-cased
  })

  it('indents ON under its JOIN', () => {
    const out = formatSql(`SELECT a FROM x INNER JOIN y ON x.k = y.k`)
    expect(out).toContain('INNER JOIN')
    expect(out).toMatch(/\n {4}ON x\.k = y\.k/)
  })
})

describe('degrades safely', () => {
  it('an empty query is returned unchanged', () => {
    expect(formatSql('')).toBe('')
    expect(formatSql('   ')).toBe('   ')
  })
  it('an unterminated string does not throw or lose text', () => {
    const out = formatSql(`SELECT 'unterminated FROM t`)
    expect(out).toContain(`'unterminated FROM t`)
  })
  it('unbalanced parentheses do not throw', () => {
    expect(() => formatSql(`SELECT SUM(a FROM t`)).not.toThrow()
  })
})
