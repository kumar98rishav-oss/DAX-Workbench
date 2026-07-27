/**
 * Formatter contract tests.
 * The two properties every case must satisfy:
 *  1. Idempotence — formatting formatted output changes nothing.
 *  2. Code preservation — stripping whitespace and case, the output is the
 *     same code as the input. The formatter may only move whitespace and
 *     uppercase keywords; it must NEVER corrupt an expression.
 */
import { describe, it, expect } from 'vitest'
import { formatDax } from './formatter'

/** Whitespace- and case-insensitive fingerprint of a DAX expression. */
const fingerprint = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/** Every expression here is run through both property checks below. */
const CASES: { name: string; input: string }[] = [
  { name: 'simple aggregation', input: `SUM(Sales[Amount])` },
  { name: 'multi-arg CALCULATE', input: `CALCULATE([Sales], Sales[Year] = 2024)` },
  { name: 'quoted table name', input: `CALCULATE([Sales], 'Dim Date'[Year] = 2024)` },
  { name: 'quoted table in iterator', input: `SUMX('Fact Sales', 'Fact Sales'[Qty] * 'Fact Sales'[Price])` },
  { name: 'bare quoted table', input: `COUNTROWS('Dim Customer')` },
  { name: 'escaped quotes in string', input: `IF([x]>0, "a ""quoted"" str", BLANK())` },
  { name: 'nested FILTER with logic ops', input: `SUMX(FILTER(Sales, Sales[Qty] > 1 && NOT ISBLANK(Sales[Amt])), Sales[Amt])` },
  { name: 'VAR/RETURN with iterator', input: `VAR t = ADDCOLUMNS(VALUES(Dim[K]), "@v", [M]) RETURN SUMX(t, [@v])` },
  { name: 'IN with brace list', input: `CALCULATE([M], Sales[Region] IN {"East", "West"})` },
  { name: 'bare brace list', input: `{1, 2, 3}` },
  { name: 'dash-dash comment', input: `-- leading comment\nSUM(Sales[Amt])` },
  { name: 'slash-slash comment', input: `// note\nSUM(Sales[Amt])` },
  { name: 'comment between args', input: `CALCULATE(SUM(Sales[Amt]), -- inline note\nALL(Sales))` },
  { name: 'SWITCH TRUE ladder', input: `SWITCH(TRUE(), [x]<0, "neg", [x]=0, "zero", "pos")` },
  { name: 'DIVIDE with alternate', input: `DIVIDE([A]-[B], [B], 0)` },
  { name: 'chained subtraction', input: `[A] - [B] - 5` },
  { name: 'comparison operators', input: `IF(Sales[Amt] >= 10 && Sales[Amt] <> 20, 1, 0)` },
  { name: 'time intelligence', input: `CALCULATE([Total], DATESYTD('Date'[Date]))` },
  { name: 'measure-only expression', input: `[Total Sales]` },
]

describe('formatDax golden output', () => {
  it('breaks multi-arg calls one argument per line', () => {
    expect(formatDax(`CALCULATE([Sales], Sales[Year] = 2024)`)).toBe(
      `CALCULATE (\n    [Sales],\n    Sales[Year] = 2024\n)`,
    )
  })

  it('keeps simple single-arg calls compact', () => {
    expect(formatDax(`SUM(Sales[Amount])`)).toBe(`SUM ( Sales[Amount] )`)
  })

  it('uppercases known function names, leaves identifiers alone', () => {
    expect(formatDax(`sum(Sales[Amount])`)).toBe(`SUM ( Sales[Amount] )`)
    expect(formatDax(`countrows(MyTable)`)).toBe(`COUNTROWS ( MyTable )`)
  })

  it('gives VAR and RETURN their own lines and indents the body', () => {
    expect(formatDax(`VAR x = 1 RETURN x + 1`)).toBe(`VAR x = 1\nRETURN\n    x + 1`)
  })

  it('preserves quoted table names exactly', () => {
    expect(formatDax(`COUNTROWS('Dim Customer')`)).toBe(`COUNTROWS ( 'Dim Customer' )`)
    // Words inside a quoted name must never be uppercased ('Dim Date' ≠ 'Dim DATE')
    expect(formatDax(`SUM('Dim Date'[Year])`)).toBe(`SUM ( 'Dim Date'[Year] )`)
  })

  it('treats -- as a line comment, same as //', () => {
    expect(formatDax(`-- note\nSUM(Sales[Amt])`)).toContain(`-- note`)
    expect(formatDax(`-- note\nSUM(Sales[Amt])`)).not.toContain(`-  -`)
  })

  it('keeps brace lists on one line', () => {
    expect(formatDax(`CALCULATE([M], Sales[Region] IN {"East", "West"})`)).toContain(
      `{ "East", "West" }`,
    )
  })

  it('renders empty parens without a double space', () => {
    expect(formatDax(`BLANK()`)).toBe(`BLANK ( )`)
  })
})

describe('formatDax properties', () => {
  for (const c of CASES) {
    it(`idempotent — ${c.name}`, () => {
      const once = formatDax(c.input)
      expect(formatDax(once)).toBe(once)
    })

    it(`preserves the code — ${c.name}`, () => {
      expect(fingerprint(formatDax(c.input))).toBe(fingerprint(c.input))
    })
  }
})

describe('formatDax fail-safety', () => {
  it('returns empty/whitespace input unchanged', () => {
    expect(formatDax('')).toBe('')
    expect(formatDax('   ')).toBe('   ')
  })

  it('never throws on malformed input', () => {
    const garbage = [`'Unterminated`, `"open string`, `SUM(((`, `)))`, `[unclosed`, `{{{`]
    for (const g of garbage) {
      expect(() => formatDax(g)).not.toThrow()
    }
  })
})
