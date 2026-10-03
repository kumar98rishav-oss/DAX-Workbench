/**
 * L2 — Comparator tests, and L5 — the self-reconciliation property.
 *
 * L5 is the strongest guarantee in the suite: feed the SAME data to both sides,
 * shaped the way each engine really shapes it, and every comparison must come
 * back with zero differences. Any mismatch there is by definition a tool bug,
 * not a data finding.
 */
import { describe, it, expect } from 'vitest'
import { compare } from './compare'
import type { FieldPair, ResultSet } from './types'

// ── Builders ────────────────────────────────────────────────────────────────

let seq = 0
function rs(
  origin: 'source' | 'target',
  columns: string[],
  rows: unknown[][],
  over: Partial<ResultSet> = {},
): ResultSet {
  return {
    id: `rs_${++seq}`,
    origin,
    label: origin,
    query: '-- test',
    executedAt: '2026-10-03T10:00:00.000Z',
    durationMs: 1,
    columns: columns.map((name) => ({ name })),
    rows,
    truncated: false,
    ...over,
  }
}

const pair = (s: ResultSet, sc: string, t: ResultSet, tc: string): FieldPair => ({
  source: { resultSetId: s.id, column: sc },
  target: { resultSetId: t.id, column: tc },
})

// ── Core join behaviour ─────────────────────────────────────────────────────

describe('compare — classification', () => {
  const source = rs('source', ['Yr', 'Amt'], [[2023, 100], [2024, 200], [2025, 50]])
  const target = rs('target', ['Year', 'Total'], [[2023, 100], [2024, 190], [2026, 70]])
  const result = compare(
    source,
    target,
    [pair(source, 'Yr', target, 'Year')],
    [pair(source, 'Amt', target, 'Total')],
  )

  it('equal values match', () => {
    expect(result.rows.find((r) => r.key[0] === '2023')?.status).toBe('match')
  })
  it('differing values mismatch and carry a signed delta', () => {
    const row = result.rows.find((r) => r.key[0] === '2024')
    expect(row?.status).toBe('mismatch')
    expect(row?.cells[0].delta).toBe(-10) // target − source
  })
  it('a key only in the source is flagged onlySource', () => {
    expect(result.rows.find((r) => r.key[0] === '2025')?.status).toBe('onlySource')
  })
  it('a key only in the target is flagged onlyTarget', () => {
    expect(result.rows.find((r) => r.key[0] === '2026')?.status).toBe('onlyTarget')
  })
  it('summarizes the four outcomes', () => {
    expect(result.summary).toMatchObject({ matched: 1, mismatched: 1, onlySource: 1, onlyTarget: 1 })
  })
  it('sorts problems above agreements', () => {
    expect(result.rows[result.rows.length - 1].status).toBe('match')
  })
})

describe('compare — aggregation to the chosen grain', () => {
  it('sums row-level data up to the key', () => {
    // A row-level SQL query paired only on Year NEEDS the rows summed; this is
    // the normal case, not an edge case.
    const source = rs('source', ['Yr', 'Amt'], [[2024, 60], [2024, 40], [2023, 10]])
    const target = rs('target', ['Year', 'Total'], [[2024, 100], [2023, 10]])
    const r = compare(source, target, [pair(source, 'Yr', target, 'Year')], [pair(source, 'Amt', target, 'Total')])
    expect(r.summary.mismatched).toBe(0)
    expect(r.rows.find((x) => x.key[0] === '2024')?.sourceRowCount).toBe(2)
  })
  it('reports a non-unique key rather than hiding it', () => {
    const source = rs('source', ['K', 'V'], [['a', 1], ['a', 1]])
    const target = rs('target', ['K', 'V'], [['a', 2]])
    const r = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')])
    expect(r.summary.sourceDuplicateKeys).toBe(1)
    expect(r.summary.targetDuplicateKeys).toBe(0)
  })
})

describe('compare — multi-column business keys', () => {
  it('(1,23) and (12,3) stay distinct rows', () => {
    const source = rs('source', ['Ord', 'Line', 'Amt'], [[1, 23, 10], [12, 3, 99]])
    const target = rs('target', ['Ord', 'Line', 'Amt'], [[1, 23, 10], [12, 3, 99]])
    const r = compare(
      source,
      target,
      [pair(source, 'Ord', target, 'Ord'), pair(source, 'Line', target, 'Line')],
      [pair(source, 'Amt', target, 'Amt')],
    )
    expect(r.rows).toHaveLength(2)
    expect(r.summary.matched).toBe(2)
  })
})

describe('compare — blanks are differences, not zeros', () => {
  it('a blank on one side mismatches against a value on the other', () => {
    const source = rs('source', ['K', 'V'], [['a', 5]])
    const target = rs('target', ['K', 'V'], [['a', null]])
    const r = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')])
    expect(r.rows[0].status).toBe('mismatch')
    expect(r.rows[0].cells[0].targetValue).toBeNull() // not silently 0
    expect(r.rows[0].cells[0].delta).toBe(-5)
  })
  it('blank on both sides is a match with a null delta', () => {
    const source = rs('source', ['K', 'V'], [['a', null]])
    const target = rs('target', ['K', 'V'], [['a', null]])
    const r = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')])
    expect(r.rows[0].status).toBe('match')
    expect(r.rows[0].cells[0].delta).toBeNull()
  })
})

describe('compare — tolerance', () => {
  const build = (sv: number, tv: number) => {
    const source = rs('source', ['K', 'V'], [['a', sv]])
    const target = rs('target', ['K', 'V'], [['a', tv]])
    return { source, target }
  }
  it('counts are exact by default', () => {
    const { source, target } = build(100, 101)
    const r = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')])
    expect(r.rows[0].status).toBe('mismatch')
  })
  it('absolute tolerance absorbs rounding', () => {
    const { source, target } = build(100, 100.004)
    const r = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')], {
      tolerance: { absolute: 0.01, relative: 0 },
    })
    expect(r.rows[0].status).toBe('match')
  })
  it('relative tolerance is measured against the source', () => {
    const { source, target } = build(1000, 1005) // 0.5%
    const within = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')], {
      tolerance: { absolute: 0, relative: 0.01 },
    })
    expect(within.rows[0].status).toBe('match')
    const outside = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')], {
      tolerance: { absolute: 0, relative: 0.001 },
    })
    expect(outside.rows[0].status).toBe('mismatch')
  })
})

// ── Refusals: a confident wrong answer is worse than none ───────────────────

describe('compare — refuses rather than misleads', () => {
  it('refuses when either side was truncated', () => {
    const source = rs('source', ['K', 'V'], [['a', 1]], { truncated: true })
    const target = rs('target', ['K', 'V'], [['a', 1]])
    const r = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')])
    expect(r.refusal?.kind).toBe('truncated')
    expect(r.rows).toHaveLength(0)
  })

  it('names which side was truncated', () => {
    const source = rs('source', ['K', 'V'], [['a', 1]])
    const target = rs('target', ['K', 'V'], [['a', 1]], { truncated: true })
    const r = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')])
    expect(r.refusal).toMatchObject({ kind: 'truncated', side: 'target' })
  })

  it('refuses when no keys overlap — a pairing mistake, not total mismatch', () => {
    const source = rs('source', ['CustId', 'V'], [['C-1', 1], ['C-2', 2]])
    const target = rs('target', ['CustName', 'V'], [['Acme', 1], ['Globex', 2]])
    const r = compare(source, target, [pair(source, 'CustId', target, 'CustName')], [pair(source, 'V', target, 'V')])
    expect(r.refusal?.kind).toBe('noKeyOverlap')
    expect(r.rows).toHaveLength(0)
    if (r.refusal?.kind === 'noKeyOverlap') {
      expect(r.refusal.sampleSource.length).toBeGreaterThan(0)
      expect(r.refusal.sampleTarget.length).toBeGreaterThan(0)
    }
  })

  it('does NOT refuse when a single key legitimately overlaps', () => {
    const source = rs('source', ['K', 'V'], [['a', 1], ['b', 2]])
    const target = rs('target', ['K', 'V'], [['a', 1], ['c', 3]])
    const r = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')])
    expect(r.refusal).toBeUndefined()
  })

  it('refuses when both sides are empty', () => {
    const source = rs('source', ['K', 'V'], [])
    const target = rs('target', ['K', 'V'], [])
    const r = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')])
    expect(r.refusal?.kind).toBe('emptyBothSides')
  })

  it('an empty side is a real finding, not a refusal', () => {
    const source = rs('source', ['K', 'V'], [['a', 1]])
    const target = rs('target', ['K', 'V'], [])
    const r = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')])
    expect(r.refusal).toBeUndefined()
    expect(r.summary.onlySource).toBe(1)
  })

  it('throws when a paired column is not in its result set', () => {
    const source = rs('source', ['K', 'V'], [['a', 1]])
    const target = rs('target', ['K', 'V'], [['a', 1]])
    expect(() =>
      compare(source, target, [pair(source, 'Nope', target, 'K')], [pair(source, 'V', target, 'V')]),
    ).toThrow(/not present/i)
  })
})

describe('compare — drift reporting', () => {
  it('reports the gap between the two executions', () => {
    const source = rs('source', ['K', 'V'], [['a', 1]], { executedAt: '2026-10-03T10:00:00.000Z' })
    const target = rs('target', ['K', 'V'], [['a', 1]], { executedAt: '2026-10-03T10:05:00.000Z' })
    const r = compare(source, target, [pair(source, 'K', target, 'K')], [pair(source, 'V', target, 'V')])
    expect(r.summary.driftMs).toBe(5 * 60 * 1000)
  })
})

// ── L5: self-reconciliation ────────────────────────────────────────────────

describe('L5 property — identical data always reconciles to zero', () => {
  /** The same facts, shaped the way each engine really shapes them. */
  const facts = [
    { region: 'East', day: '2024-01-01', code: '007', flag: true, amount: 100 },
    { region: 'West', day: '2024-01-02', code: '008', flag: false, amount: 250.5 },
    { region: 'East', day: '2024-01-02', code: '009', flag: true, amount: 75 },
    { region: 'North', day: '2024-03-15', code: '010', flag: false, amount: 0 },
  ]

  // SQL Server: CHAR padding, DATETIME, bit as 1/0, decimals as strings.
  const source = rs(
    'source',
    ['Region', 'Day', 'Code', 'Flag', 'Amount'],
    facts.map((f) => [`${f.region}   `, `${f.day}T00:00:00`, f.code, f.flag ? 1 : 0, String(f.amount)]),
  )
  // Power BI: trimmed text, different casing, dates as UTC Date objects.
  const target = rs(
    'target',
    ['Region', 'Day', 'Code', 'Flag', 'Amount'],
    facts.map((f) => [f.region.toUpperCase(), new Date(`${f.day}T00:00:00Z`), f.code, f.flag, f.amount]),
  )

  const keyCols = ['Region', 'Day', 'Code', 'Flag']

  it('reconciles to zero across every key column, despite engine shape differences', () => {
    const r = compare(
      source,
      target,
      keyCols.map((c) => pair(source, c, target, c)),
      [pair(source, 'Amount', target, 'Amount')],
    )
    expect(r.refusal).toBeUndefined()
    expect(r.summary.mismatched).toBe(0)
    expect(r.summary.onlySource).toBe(0)
    expect(r.summary.onlyTarget).toBe(0)
    expect(r.summary.matched).toBe(facts.length)
  })

  it('reconciles to zero at every coarser grain too', () => {
    for (const grain of [['Region'], ['Day'], ['Region', 'Day'], ['Region', 'Day', 'Code']]) {
      const r = compare(
        source,
        target,
        grain.map((c) => pair(source, c, target, c)),
        [pair(source, 'Amount', target, 'Amount')],
      )
      expect(r.refusal, `grain ${grain.join('+')}`).toBeUndefined()
      expect(r.summary.mismatched, `grain ${grain.join('+')}`).toBe(0)
      expect(r.summary.onlySource + r.summary.onlyTarget, `grain ${grain.join('+')}`).toBe(0)
    }
  })

  it('a single injected defect is found, and only that one', () => {
    // Change one amount; everything else must stay green.
    const broken = rs(
      'target',
      ['Region', 'Day', 'Code', 'Flag', 'Amount'],
      target.rows.map((r, i) => (i === 1 ? [...r.slice(0, 4), 999] : r)),
    )
    const r = compare(
      source,
      broken,
      keyCols.map((c) => pair(source, c, broken, c)),
      [pair(source, 'Amount', broken, 'Amount')],
    )
    expect(r.summary.mismatched).toBe(1)
    expect(r.summary.matched).toBe(facts.length - 1)
    expect(r.rows[0].status).toBe('mismatch') // worst-first ordering
    expect(r.rows[0].cells[0].delta).toBeCloseTo(999 - 250.5)
  })
})
