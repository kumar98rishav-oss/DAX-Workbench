/**
 * DEFINE-query builder tests — the path every live preview on the real engine
 * goes through. Escaping bugs here mean broken queries (or worse) against the
 * user's actual model, so names with quotes and brackets get explicit coverage.
 */
import { describe, it, expect } from 'vitest'
import { dependencyClosure, buildDefineQuery, type NamedDax } from './live-preview'

const pool: NamedDax[] = [
  { name: 'Total Sales', dax: `SUM(Sales[Amount])` },
  { name: 'Total Cost', dax: `SUM(Sales[Cost])` },
  { name: 'Margin', dax: `[Total Sales] - [Total Cost]` },
  { name: 'Margin %', dax: `DIVIDE([Margin], [Total Sales])` },
  { name: 'Unrelated', dax: `COUNTROWS(Dim)` },
]

describe('dependencyClosure', () => {
  it('walks the full chain', () => {
    const names = dependencyClosure(pool, 'Margin %').map((m) => m.name)
    expect(names).toContain('Margin %')
    expect(names).toContain('Margin')
    expect(names).toContain('Total Sales')
    expect(names).toContain('Total Cost')
  })

  it('excludes measures the target does not depend on', () => {
    const names = dependencyClosure(pool, 'Margin %').map((m) => m.name)
    expect(names).not.toContain('Unrelated')
  })

  it('a leaf measure depends only on itself', () => {
    expect(dependencyClosure(pool, 'Total Sales').map((m) => m.name)).toEqual(['Total Sales'])
  })

  it('a name not in the pool resolves to nothing (engine-side measure)', () => {
    expect(dependencyClosure(pool, 'Deployed Only')).toEqual([])
  })

  it('is case-insensitive like the engine', () => {
    const names = dependencyClosure(pool, 'margin %').map((m) => m.name)
    expect(names).toContain('Margin')
  })
})

describe('buildDefineQuery', () => {
  it('defines the chain then evaluates a single scalar row', () => {
    const q = buildDefineQuery(dependencyClosure(pool, 'Margin'), 'Margin', 'Sales')
    expect(q).toMatch(/^DEFINE\n/)
    expect(q).toContain(`MEASURE 'Sales'[Margin] =`)
    expect(q.trim().endsWith(`EVALUATE ROW("v", [Margin])`)).toBe(true)
  })

  it('emits a bare EVALUATE when there is nothing to define', () => {
    expect(buildDefineQuery([], 'Deployed Only', 'Sales')).toBe(
      `EVALUATE ROW("v", [Deployed Only])`,
    )
  })

  it('escapes ] in measure names as ]]', () => {
    const q = buildDefineQuery([{ name: 'Weird]Name', dax: `1` }], 'Weird]Name', 'Sales')
    expect(q).toContain(`[Weird]]Name]`)
    expect(q).toContain(`EVALUATE ROW("v", [Weird]]Name])`)
  })

  it(`escapes ' in the home table name as ''`, () => {
    const q = buildDefineQuery([{ name: 'M', dax: `1` }], 'M', `O'Brien Sales`)
    expect(q).toContain(`MEASURE 'O''Brien Sales'[M] =`)
  })

  it('defines each measure once even if the pool has duplicates', () => {
    const dup: NamedDax[] = [
      { name: 'M', dax: `1` },
      { name: 'm', dax: `2` },
    ]
    const q = buildDefineQuery(dup, 'M', 'Sales')
    expect(q.match(/MEASURE /g)?.length).toBe(1)
  })
})
