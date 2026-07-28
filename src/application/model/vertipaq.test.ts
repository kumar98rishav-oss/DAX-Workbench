import { describe, it, expect } from 'vitest'
import { analyzeStorage, summarize, formatBytes, uniqueness, isLegitimateKey, KB, MB } from './vertipaq'
import type { VpReport, VpColumn, VpTable } from '@/infrastructure/desktop/desktop-client'

const col = (p: Partial<VpColumn> & { table: string; column: string }): VpColumn => ({
  dataType: 'String',
  encoding: 'HASH',
  cardinality: 10,
  totalSize: 1024,
  dataSize: 512,
  dictionarySize: 512,
  hierarchiesSize: 0,
  percentDb: 0,
  ...p,
})

const table = (name: string, rows: number, totalSize: number): VpTable => ({
  name, rows, totalSize, columnsSize: totalSize, percentDb: 0, columns: 1,
})

const report = (cols: VpColumn[], tables: VpTable[], modelSize?: number): VpReport => ({
  database: 'db',
  modelSize: modelSize ?? cols.reduce((n, c) => n + c.totalSize, 0),
  tableCount: tables.length,
  columnCount: cols.length,
  tables,
  columnsList: cols,
  relationships: [],
})

describe('formatBytes', () => {
  it('scales and stays coarse', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2 * KB)).toBe('2 KB')
    expect(formatBytes(1.5 * MB)).toBe('1.5 MB')
    expect(formatBytes(40 * MB)).toBe('40 MB')
  })
})

describe('uniqueness', () => {
  it('is 1 for a key column and clamps above it', () => {
    expect(uniqueness(col({ table: 'T', column: 'K', cardinality: 100 }), 100)).toBe(1)
    expect(uniqueness(col({ table: 'T', column: 'K', cardinality: 120 }), 100)).toBe(1)
  })
  it('is 0 when the table has no rows (no divide-by-zero)', () => {
    expect(uniqueness(col({ table: 'T', column: 'K', cardinality: 5 }), 0)).toBe(0)
  })
})

describe('analyzeStorage', () => {
  it('flags a near-unique expensive key column', () => {
    const c = col({ table: 'Fact', column: 'InvoiceNo', cardinality: 100_000, totalSize: 900 * KB, dataSize: 700 * KB, dictionarySize: 200 * KB })
    const f = analyzeStorage(report([c], [table('Fact', 100_000, 900 * KB)]))
    expect(f).toHaveLength(1)
    expect(f[0].target).toBe('Fact[InvoiceNo]')
    expect(f[0].detail).toContain('distinct value')
  })

  it('does NOT flag a low-cardinality column in a big table', () => {
    const c = col({ table: 'Fact', column: 'Status', cardinality: 4, totalSize: 8 * KB })
    const f = analyzeStorage(report([c], [table('Fact', 100_000, 8 * KB)]))
    expect(f).toHaveLength(0)
  })

  it('does not flag a near-unique column that is tiny (nothing to win)', () => {
    // A 200-row dimension key: unique, but only 2 KB — not worth a finding.
    const c = col({ table: 'Dim', column: 'Id', cardinality: 200, totalSize: 2 * KB })
    const f = analyzeStorage(report([c], [table('Dim', 200, 2 * KB)]))
    expect(f).toHaveLength(0)
  })

  it('flags a dictionary that dwarfs the data', () => {
    const c = col({ table: 'Dim', column: 'Description', cardinality: 500, totalSize: 300 * KB, dataSize: 40 * KB, dictionarySize: 260 * KB })
    const f = analyzeStorage(report([c], [table('Dim', 5000, 300 * KB)]))
    expect(f).toHaveLength(1)
    expect(f[0].detail).toContain('dictionary')
  })

  it('flags a column that dominates the model', () => {
    const big = col({ table: 'F', column: 'Big', cardinality: 50, totalSize: 900 * KB })
    const small = col({ table: 'F', column: 'S', cardinality: 5, totalSize: 100 * KB })
    const f = analyzeStorage(report([big, small], [table('F', 1000, MB)]))
    const hog = f.find((x) => x.target === 'F[Big]')
    expect(hog?.severity).toBe('high')
    expect(hog?.title).toBe('Column dominates the model')
  })

  it('stays silent about unreferenced columns when no evidence is supplied', () => {
    // Same rule as the Cleanup tab: never claim "unused" without a scan.
    const c = col({ table: 'F', column: 'Ghost', cardinality: 50, totalSize: 200 * KB })
    const f = analyzeStorage(report([c], [table('F', 1000, 200 * KB)]))
    expect(f.some((x) => /no references/.test(x.title))).toBe(false)
  })

  it('flags an unreferenced expensive column when evidence IS supplied', () => {
    const used = col({ table: 'F', column: 'Used', cardinality: 50, totalSize: 200 * KB })
    const ghost = col({ table: 'F', column: 'Ghost', cardinality: 50, totalSize: 200 * KB })
    const f = analyzeStorage(report([used, ghost], [table('F', 1000, 400 * KB)]), {
      referenced: new Set(['f[used]']),
    })
    const unref = f.filter((x) => /no references/.test(x.title))
    expect(unref).toHaveLength(1)
    expect(unref[0].target).toBe('F[Ghost]')
  })

  // Both of these were REAL false positives seen against a live model.
  it('emits ONE finding per column even when several rules trip', () => {
    // Dominates the model AND near-unique AND dictionary-heavy — one entry.
    const c = col({ table: 'Fact_Claims', column: 'ClaimNumber', cardinality: 2407, totalSize: 500 * KB, dataSize: 100 * KB, dictionarySize: 380 * KB })
    const f = analyzeStorage(report([c], [table('Fact_Claims', 2407, 500 * KB)], MB))
    expect(f).toHaveLength(1)
    // ...but the merged detail still carries every reason.
    expect(f[0].detail).toContain('distinct value')
    expect(f[0].detail).toContain('dictionary')
  })

  it('does not tell you to remove the Date column of a date table', () => {
    const c = col({ table: 'Dim_Date', column: 'Date', dataType: 'DateTime', cardinality: 1096, totalSize: 200 * KB, dataSize: 150 * KB, dictionarySize: 40 * KB })
    const f = analyzeStorage(report([c], [table('Dim_Date', 1096, 200 * KB)], MB))
    expect(f.some((x) => /Near-unique/.test(x.title))).toBe(false)
  })

  it('still flags a near-unique column on a FACT table (a degenerate dimension)', () => {
    const c = col({ table: 'Fact_Sales', column: 'TransactionRef', cardinality: 90_000, totalSize: 800 * KB, dataSize: 600 * KB, dictionarySize: 150 * KB })
    const f = analyzeStorage(report([c], [table('Fact_Sales', 100_000, 800 * KB)], 4 * MB))
    expect(f).toHaveLength(1)
    // The near-unique reason must survive, whichever headline wins the title.
    expect(f[0].detail).toContain('distinct value')
    expect(f[0].detail).not.toContain('key the model needs')
  })

  it('ranks high severity first, then by bytes', () => {
    const huge = col({ table: 'F', column: 'Huge', cardinality: 100_000, totalSize: 5 * MB, dataSize: 4 * MB, dictionarySize: 1 * MB })
    const mid = col({ table: 'F', column: 'Mid', cardinality: 90_000, totalSize: 300 * KB, dataSize: 250 * KB, dictionarySize: 50 * KB })
    const f = analyzeStorage(report([mid, huge], [table('F', 100_000, 6 * MB)], 6 * MB))
    expect(f[0].bytes).toBeGreaterThanOrEqual(f[f.length - 1].bytes)
    expect(f[0].severity).toBe('high')
  })
})

describe('isLegitimateKey', () => {
  const tables = [table('Fact_Cases', 100_000, MB), table('Dim_Date', 1096, 200 * KB), table('Dim_Patient', 500, 100 * KB)]

  it('recognises a date table date column', () => {
    const c = col({ table: 'Dim_Date', column: 'Date', dataType: 'DateTime', cardinality: 1096 })
    expect(isLegitimateKey(c, 1096, tables)).toBe(true)
  })

  it("recognises a dimension's own key", () => {
    const c = col({ table: 'Dim_Patient', column: 'PatientID', cardinality: 500 })
    expect(isLegitimateKey(c, 500, tables)).toBe(true)
  })

  it('does NOT excuse a high-cardinality column on a fact table', () => {
    const c = col({ table: 'Fact_Cases', column: 'CaseNumber', cardinality: 100_000 })
    expect(isLegitimateKey(c, 100_000, tables)).toBe(false)
  })
})

describe('summarize', () => {
  it('reports the largest column and table, and top-10 concentration', () => {
    const cols = [
      col({ table: 'A', column: 'x', totalSize: 600 * KB }),
      col({ table: 'B', column: 'y', totalSize: 300 * KB }),
      col({ table: 'B', column: 'z', totalSize: 100 * KB }),
    ]
    // Columns total 1000 KB; the model is 1000 KB, so the top 10 hold all of it.
    const modelSize = 1000 * KB
    const s = summarize(report(cols, [table('A', 10, 600 * KB), table('B', 10, 400 * KB)], modelSize))
    expect(s.largestColumn?.column).toBe('x')
    expect(s.largestTable?.name).toBe('A')
    expect(s.top10Share).toBeCloseTo(1, 5)
  })

  it('handles an empty model without dividing by zero', () => {
    const s = summarize(report([], [], 0))
    expect(s.largestColumn).toBeNull()
    expect(Number.isFinite(s.top10Share)).toBe(true)
  })
})
