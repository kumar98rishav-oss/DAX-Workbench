/**
 * L3 — Syntax highlighting.
 *
 * Two invariants carry the whole thing, and both are security- or
 * correctness-relevant rather than cosmetic:
 *   lossless — the highlight layer sits behind a transparent textarea, so a
 *              dropped character visibly tears the caret away from the text.
 *   escaped  — user-typed SQL reaches innerHTML, so this is an injection
 *              boundary, not a styling detail.
 */
import { describe, it, expect } from 'vitest'
import { tokenizeSql, tokenizeDax, highlightHtml, escapeHtml } from './highlight'

const rebuild = (tokens: { text: string }[]) => tokens.map((t) => t.text).join('')
const kindsOf = (tokens: { kind: string; text: string }[], text: string) =>
  tokens.filter((t) => t.text === text).map((t) => t.kind)

describe('lossless', () => {
  const samples = [
    `SELECT YEAR([Fact_Sales].[OrderDate]) AS [Yr] FROM [dbo].[Fact_Sales]`,
    `SELECT 'it''s' AS x -- trailing comment`,
    `SELECT /* block */ 1`,
    `EVALUATE SUMMARIZE('Fact_Sales', [Yr], "Total", SUM('Fact_Sales'[Amount]))`,
    `  leading and trailing whitespace  `,
    `weird ¬ characters ✓ and emoji 🙂`,
    `unterminated 'string`,
    `unterminated [bracket`,
    ``,
    `\n\n\n`,
  ]

  for (const s of samples) {
    it(`SQL rebuilds exactly: ${JSON.stringify(s.slice(0, 40))}`, () => {
      expect(rebuild(tokenizeSql(s))).toBe(s)
    })
    it(`DAX rebuilds exactly: ${JSON.stringify(s.slice(0, 40))}`, () => {
      expect(rebuild(tokenizeDax(s))).toBe(s)
    })
  }
})

describe('escaping — this is an injection boundary', () => {
  it('escapes angle brackets so markup cannot be injected', () => {
    const html = highlightHtml(`SELECT '<img src=x onerror=alert(1)>'`, 'sql')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('escapes a closing span that would break out of a token', () => {
    const html = highlightHtml(`SELECT '</span><script>alert(1)</script>'`, 'sql')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes ampersands so entities cannot be smuggled', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('escapes the same way in DAX', () => {
    const html = highlightHtml(`EVALUATE ROW("x", "<script>")`, 'dax')
    expect(html).not.toContain('<script>')
  })
})

describe('SQL classification', () => {
  const t = tokenizeSql(`SELECT SUM([a]) AS x FROM t WHERE d = '2024-01-01' AND n = 5`)

  it('keywords are keywords', () => {
    expect(kindsOf(t, 'SELECT')).toEqual(['keyword'])
    expect(kindsOf(t, 'FROM')).toEqual(['keyword'])
    expect(kindsOf(t, 'WHERE')).toEqual(['keyword'])
  })
  it('a name followed by ( is a function', () => {
    expect(kindsOf(t, 'SUM')).toEqual(['function'])
  })
  it('single quotes are a STRING in SQL', () => {
    expect(kindsOf(t, `'2024-01-01'`)).toEqual(['string'])
  })
  it('brackets are identifiers', () => {
    expect(kindsOf(t, '[a]')).toEqual(['identifier'])
  })
  it('numbers are numbers', () => {
    expect(kindsOf(t, '5')).toEqual(['number'])
  })
  it('an unknown name followed by ( still reads as a call', () => {
    expect(kindsOf(tokenizeSql('SELECT dbo.My_Udf(1)'), 'dbo.My_Udf')).toEqual(['function'])
  })
  it('a keyword NOT followed by ( is not a function', () => {
    // LEFT is both a keyword (LEFT JOIN) and a function (LEFT(s, n)).
    expect(kindsOf(tokenizeSql('SELECT a FROM x LEFT JOIN y ON 1=1'), 'LEFT')).toEqual(['keyword'])
    expect(kindsOf(tokenizeSql('SELECT LEFT(a, 2)'), 'LEFT')).toEqual(['function'])
  })
})

describe('DAX classification — quoting is the opposite of SQL', () => {
  const t = tokenizeDax(`EVALUATE SUMMARIZE('Fact_Sales', [Yr], "Total_Sales", SUM('Fact_Sales'[Amount]))`)

  it('EVALUATE is a keyword', () => {
    expect(kindsOf(t, 'EVALUATE')).toEqual(['keyword'])
  })
  it('single quotes are a TABLE NAME, not a string', () => {
    // Colouring 'Fact_Sales' as a string literal would be actively misleading.
    expect(kindsOf(t, `'Fact_Sales'`)).toEqual(['identifier', 'identifier'])
  })
  it('double quotes are the STRING in DAX', () => {
    expect(kindsOf(t, `"Total_Sales"`)).toEqual(['string'])
  })
  it('catalogue functions are functions', () => {
    expect(kindsOf(t, 'SUMMARIZE')).toEqual(['function'])
    expect(kindsOf(t, 'SUM')).toEqual(['function'])
  })
  it('column references are identifiers', () => {
    expect(kindsOf(t, '[Yr]')).toEqual(['identifier'])
  })
  it('VAR and RETURN are keywords', () => {
    const v = tokenizeDax('VAR x = 1 RETURN x')
    expect(kindsOf(v, 'VAR')).toEqual(['keyword'])
    expect(kindsOf(v, 'RETURN')).toEqual(['keyword'])
  })
})

describe('never throws on partial input', () => {
  for (const s of [`SELECT (((`, `EVALUATE "`, `'`, `[`, `/*`, `--`, `SUM(`]) {
    it(`survives ${JSON.stringify(s)}`, () => {
      expect(() => highlightHtml(s, 'sql')).not.toThrow()
      expect(() => highlightHtml(s, 'dax')).not.toThrow()
    })
  }
})

describe('html output', () => {
  it('wraps classified tokens and leaves plain text bare', () => {
    const html = highlightHtml('SELECT a', 'sql')
    expect(html).toContain('<span class="tok tok--keyword">SELECT</span>')
    expect(html).toContain(' a')
  })
  it('ends with a newline so the layer matches the textarea height', () => {
    expect(highlightHtml('SELECT 1', 'sql').endsWith('\n')).toBe(true)
  })
})
