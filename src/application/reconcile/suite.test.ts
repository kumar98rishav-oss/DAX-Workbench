/**
 * Suite tests.
 *
 * The classification rules carry the most weight here: a suite that calls an
 * unevaluated check "passed" is the false green this whole feature exists to
 * prevent, and it would be invisible — the summary would just look good.
 */
import { describe, it, expect } from 'vitest'
import {
  bindCheck, classify, evidenceFrom, groupChecks, newId, OTHER_GROUP, suggestName, summarize, verdict,
  type CheckRun, type SavedCheck,
} from './suite'
import type { ComparisonResult, ComparisonSummary, ResultSet } from './types'

const emptySummary: ComparisonSummary = {
  matched: 0, mismatched: 0, onlySource: 0, onlyTarget: 0,
  sourceKeys: 0, targetKeys: 0, sourceDuplicateKeys: 0, targetDuplicateKeys: 0, driftMs: 0,
}

const result = (over: Partial<ComparisonSummary>, refusal?: ComparisonResult['refusal']): ComparisonResult => ({
  rows: [],
  summary: { ...emptySummary, ...over },
  refusal,
})

describe('classify', () => {
  it('passes when everything matched', () => {
    expect(classify(result({ matched: 24 }))).toBe('pass')
  })
  it('fails on a value mismatch', () => {
    expect(classify(result({ matched: 23, mismatched: 1 }))).toBe('fail')
  })
  it('fails on a key present only on one side', () => {
    expect(classify(result({ matched: 23, onlySource: 1 }))).toBe('fail')
    expect(classify(result({ matched: 23, onlyTarget: 1 }))).toBe('fail')
  })

  it('a refusal is INCONCLUSIVE — never a pass', () => {
    // The failure mode this guards: a truncated side means the check did not
    // run, and counting it as a pass makes a broken suite look healthy.
    const truncated = result({}, { kind: 'truncated', side: 'target', message: 'capped' })
    expect(classify(truncated)).toBe('inconclusive')
  })
  it('a refusal is not a fail either', () => {
    // Calling it a fail sends someone hunting a data problem when the real fix
    // is the check's own configuration.
    const noOverlap = result({}, {
      kind: 'noKeyOverlap', sourceKeys: 10, targetKeys: 10,
      sampleSource: [], sampleTarget: [], message: 'no overlap',
    })
    expect(classify(noOverlap)).not.toBe('fail')
    expect(classify(noOverlap)).toBe('inconclusive')
  })
  it('two empty sides prove nothing, so they are inconclusive', () => {
    expect(classify(result({}, { kind: 'emptyBothSides', message: 'nothing' }))).toBe('inconclusive')
  })
  it('a refusal outranks a clean-looking summary', () => {
    // A refused comparison leaves the summary zeroed, which reads as "clean".
    const r = result({ matched: 0 }, { kind: 'truncated', side: 'both', message: 'capped' })
    expect(classify(r)).toBe('inconclusive')
  })
})

describe('summarize', () => {
  const runs = (...statuses: CheckRun['status'][]): CheckRun[] =>
    statuses.map((status, i) => ({ checkId: `c${i}`, name: `c${i}`, status, durationMs: 1, ranAt: '' }))

  it('counts each outcome separately', () => {
    expect(summarize(runs('pass', 'pass', 'fail', 'inconclusive'))).toEqual({
      passed: 2, failed: 1, inconclusive: 1,
    })
  })
  it('never folds inconclusive into passed', () => {
    const s = summarize(runs('pass', 'inconclusive'))
    expect(s.passed).toBe(1)
    expect(s.inconclusive).toBe(1)
  })
})

describe('verdict', () => {
  const run = (passed: number, failed: number, inconclusive: number) => ({
    startedAt: '', finishedAt: '', passed, failed, inconclusive,
    runs: Array.from({ length: passed + failed + inconclusive }, () => ({}) as CheckRun),
  })

  it('says all clear only when everything ran and agreed', () => {
    expect(verdict(run(12, 0, 0))).toMatch(/all clear/i)
  })
  it('does NOT say all clear when a check could not run', () => {
    const v = verdict(run(11, 0, 1))
    expect(v).not.toMatch(/all clear/i)
    expect(v).toMatch(/could not run/i)
  })
  it('reports failures and non-runs separately', () => {
    const v = verdict(run(10, 2, 1))
    expect(v).toContain('10 passed')
    expect(v).toContain('2 failed')
    expect(v).toContain('1 could not run')
  })
  it('handles an empty suite', () => {
    expect(verdict(run(0, 0, 0))).toMatch(/no checks/i)
  })
})

describe('bindCheck', () => {
  const rs = (id: string, origin: 'source' | 'target', cols: string[]): ResultSet => ({
    id, origin, label: id, query: '', executedAt: '', durationMs: 0,
    columns: cols.map((name) => ({ name })), rows: [], truncated: false,
  })

  const check: SavedCheck = {
    id: 'c1', name: 'Sales by month',
    sourceQuery: '', targetQuery: '',
    keys: [{ source: 'Yr', target: '[Yr]' }],
    values: [{ source: 'Amount', target: '[Amount]' }],
    tolerance: { absolute: 0, relative: 0 }, enabled: true,
  }

  it('resolves stored names into result-set-qualified refs', () => {
    const s = rs('rs_1', 'source', ['Yr', 'Amount'])
    const t = rs('rs_2', 'target', ['[Yr]', '[Amount]'])
    const { keys, values } = bindCheck(check, s, t)
    expect(keys[0].source).toEqual({ resultSetId: 'rs_1', column: 'Yr' })
    expect(keys[0].target).toEqual({ resultSetId: 'rs_2', column: '[Yr]' })
    expect(values[0].target.resultSetId).toBe('rs_2')
  })

  it('names the check and the column when the source query changed', () => {
    const s = rs('rs_1', 'source', ['Year', 'Amount']) // renamed Yr → Year
    const t = rs('rs_2', 'target', ['[Yr]', '[Amount]'])
    expect(() => bindCheck(check, s, t)).toThrow(/Sales by month.*"Yr"/s)
  })

  it('names the check when the target query changed', () => {
    const s = rs('rs_1', 'source', ['Yr', 'Amount'])
    const t = rs('rs_2', 'target', ['[Yr]'])
    expect(() => bindCheck(check, s, t)).toThrow(/Sales by month.*"\[Amount\]"/s)
  })

  it('binds a keyless scalar check', () => {
    const scalar: SavedCheck = { ...check, keys: [], values: [{ source: 'n', target: '[n]' }] }
    const { keys, values } = bindCheck(scalar, rs('a', 'source', ['n']), rs('b', 'target', ['[n]']))
    expect(keys).toEqual([])
    expect(values).toHaveLength(1)
  })
})

describe('evidenceFrom', () => {
  const row = (cells: { s: number | string | null; t: number | string | null; d: number | null; st: 'match' | 'mismatch' }[]) => ({
    key: [], compositeKey: '', status: 'match' as const, sourceRowCount: 1, targetRowCount: 1,
    cells: cells.map((c) => ({ sourceValue: c.s, targetValue: c.t, delta: c.d, status: c.st })),
  })

  it('keeps the actual numbers for a scalar check', () => {
    // The whole point: a verdict that cannot show its working is asking to be
    // taken on faith.
    const r: ComparisonResult = { rows: [row([{ s: 19658, t: 19658, d: 0, st: 'match' }])], summary: emptySummary }
    const e = evidenceFrom(r, ['[RowCount]'], 1, 1)
    expect(e.values).toEqual([{ label: '[RowCount]', source: 19658, target: 19658, delta: 0, status: 'match' }])
    expect(e.comparedRows).toBe(1)
  })

  it('keeps text values, not just numbers', () => {
    const r: ComparisonResult = { rows: [row([{ s: '2023-01-01', t: '2024-12-31', d: null, st: 'mismatch' }])], summary: emptySummary }
    expect(evidenceFrom(r, ['[First]'], 1, 1).values?.[0]).toMatchObject({ source: '2023-01-01', target: '2024-12-31' })
  })

  it('quotes NO row for a multi-row comparison', () => {
    // Picking a representative row out of 24 would be worse than saying how
    // many were compared — it reads like the whole answer.
    const r: ComparisonResult = {
      rows: [row([{ s: 1, t: 1, d: 0, st: 'match' }]), row([{ s: 2, t: 2, d: 0, st: 'match' }])],
      summary: emptySummary,
    }
    const e = evidenceFrom(r, ['[v]'], 24, 24)
    expect(e.values).toBeUndefined()
    expect(e.comparedRows).toBe(2)
  })

  it('records what each engine returned, so a surprise can be traced', () => {
    const r: ComparisonResult = { rows: [], summary: emptySummary }
    expect(evidenceFrom(r, [], 19658, 10000)).toMatchObject({ sourceRows: 19658, targetRows: 10000 })
  })

  it('falls back to a positional label when none is supplied', () => {
    const r: ComparisonResult = { rows: [row([{ s: 1, t: 1, d: 0, st: 'match' }])], summary: emptySummary }
    expect(evidenceFrom(r, [], 1, 1).values?.[0].label).toBe('value 1')
  })
})

describe('groupChecks', () => {
  const c = (id: string, table?: string): SavedCheck => ({
    id, name: id, sourceQuery: '', targetQuery: '', keys: [], values: [],
    tolerance: { absolute: 0, relative: 0 }, enabled: true, table,
  })

  it('groups by table, keeping first-seen order', () => {
    const g = groupChecks([c('a', 'Fact_Sales'), c('b', 'Dim_Product'), c('c', 'Fact_Sales')])
    expect(g.map((x) => x.table)).toEqual(['Fact_Sales', 'Dim_Product'])
    expect(g[0].checks.map((x) => x.id)).toEqual(['a', 'c'])
  })

  it('collects table-less checks rather than guessing where they belong', () => {
    // A hand-typed name must not be parsed into somebody else's group.
    const g = groupChecks([c('a', 'Fact_Sales'), c('my check')])
    expect(g.find((x) => x.table === OTHER_GROUP)?.checks.map((x) => x.id)).toEqual(['my check'])
  })

  it('handles an empty suite', () => {
    expect(groupChecks([])).toEqual([])
  })
})

describe('suggestName', () => {
  it('names a row count after its table', () => {
    expect(suggestName('SELECT COUNT(*) FROM [dbo].[Fact_Sales];', `EVALUATE ROW("n", COUNTROWS('Fact_Sales'))`))
      .toBe('Fact_Sales — row count')
  })
  it('recognises the other generators', () => {
    expect(suggestName('SELECT 1 FROM [dbo].[Dim_Product]', 'EVALUATE ROW("n", DISTINCTCOUNTNOBLANK(x))'))
      .toContain('distinct values')
    expect(suggestName('SELECT 1 FROM [dbo].[Fact_Sales]', 'EVALUATE SUMMARIZE(x)'))
      .toContain('by grain')
  })
  it('falls back without throwing on unparseable input', () => {
    expect(suggestName('', '')).toBe('check')
  })
})

describe('newId', () => {
  it('is unique across rapid calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('chk')))
    expect(ids.size).toBe(500)
  })
  it('carries its prefix', () => {
    expect(newId('chk').startsWith('chk_')).toBe(true)
  })
})
