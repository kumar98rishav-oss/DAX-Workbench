import { describe, it, expect } from 'vitest'
import {
  modelSignature,
  resolveActiveModel,
  modelLabelParts,
  type DesktopModelInfo,
} from './model-select'

const model = (port: number, tables: string[], measureCount = 0): DesktopModelInfo => ({
  port,
  database: `db-${port}`,
  tableCount: tables.length,
  measureCount,
  tables,
})

const SALES = ['Sales', 'Product', 'Date']
const HR = ['Employee', 'Department']

describe('modelSignature', () => {
  it('is stable across a port + database change (the restart case)', () => {
    const before = { ...model(61271, SALES, 12) }
    const after = { ...model(52999, SALES, 12), database: 'a-totally-different-guid' }
    expect(modelSignature(after)).toBe(modelSignature(before))
  })

  it('is order-independent and case-insensitive on table names', () => {
    const a = model(1, ['Sales', 'Product', 'Date'], 3)
    const b = model(1, ['date', 'sales', 'PRODUCT'], 3)
    expect(modelSignature(a)).toBe(modelSignature(b))
  })

  it('distinguishes different reports', () => {
    expect(modelSignature(model(1, SALES))).not.toBe(modelSignature(model(1, HR)))
  })

  it('distinguishes same tables but different measure counts', () => {
    expect(modelSignature(model(1, SALES, 12))).not.toBe(modelSignature(model(1, SALES, 13)))
  })

  it('falls back to table-name length when tableCount is absent', () => {
    expect(modelSignature({ port: 1, database: 'd', tables: SALES })).toContain('t3:')
  })
})

describe('resolveActiveModel', () => {
  it('returns nothing when no model is open', () => {
    expect(resolveActiveModel([])).toEqual({ model: null, needsChoice: false, rebound: false })
  })

  it('auto-selects the only open model', () => {
    const r = resolveActiveModel([model(61271, SALES)])
    expect(r.model?.port).toBe(61271)
    expect(r.needsChoice).toBe(false)
  })

  it('needs a choice when several are open and nothing is pinned', () => {
    const r = resolveActiveModel([model(1, SALES), model(2, HR)])
    expect(r.model).toBeNull()
    expect(r.needsChoice).toBe(true)
  })

  it('honours the exact pinned port when it is still alive', () => {
    const r = resolveActiveModel([model(1, SALES), model(2, HR)], 2)
    expect(r.model?.port).toBe(2)
    expect(r.needsChoice).toBe(false)
    expect(r.rebound).toBe(false)
  })

  it('re-binds to a new port by signature when the pinned port is gone (restart)', () => {
    // We were on port 1 (Sales). Desktop restarted → Sales is now on port 9.
    const sig = modelSignature(model(1, SALES, 5))
    const r = resolveActiveModel([model(9, SALES, 5), model(2, HR)], 1, sig)
    expect(r.model?.port).toBe(9)
    expect(r.needsChoice).toBe(false)
    expect(r.rebound).toBe(true)
  })

  it('does NOT hijack the pin when a second, different report is opened', () => {
    // Pinned to Sales on port 1; user opens HR on port 2. Stay on Sales.
    const sig = modelSignature(model(1, SALES, 5))
    const r = resolveActiveModel([model(1, SALES, 5), model(2, HR, 8)], 1, sig)
    expect(r.model?.port).toBe(1)
    expect(r.needsChoice).toBe(false)
  })

  it('asks the user when the pinned signature matches several (same report twice)', () => {
    const sig = modelSignature(model(1, SALES, 5))
    const r = resolveActiveModel([model(3, SALES, 5), model(4, SALES, 5)], 1, sig)
    expect(r.model).toBeNull()
    expect(r.needsChoice).toBe(true)
  })

  it('prefers an exact live port over a signature that matches several', () => {
    const sig = modelSignature(model(1, SALES, 5))
    const r = resolveActiveModel([model(3, SALES, 5), model(4, SALES, 5)], 4, sig)
    expect(r.model?.port).toBe(4)
    expect(r.needsChoice).toBe(false)
  })
})

describe('modelLabelParts', () => {
  it('pluralises correctly', () => {
    expect(modelLabelParts(model(1, ['One'], 1))).toBe('1 table · 1 measure')
    expect(modelLabelParts(model(1, ['A', 'B'], 3))).toBe('2 tables · 3 measures')
  })
})
