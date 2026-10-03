/**
 * APP — Reconciliation state
 *
 * Kept out of the main store: this is a self-contained workspace (a connection,
 * two queries, two result sets and a pairing), and nothing else in the app
 * needs to read it.
 */
import { create } from 'zustand'
import { useApp } from '@/app/store'
import { desktopRunDax } from '@/infrastructure/desktop/desktop-client'
import {
  sqlQuery,
  sqlTest,
  type SqlConnection,
  type SqlTestResult,
} from '@/infrastructure/desktop/sql-client'
import { compare, type CompareOptions } from '@/application/reconcile/compare'
import { DEFAULT_NORMALIZE, type NormalizeOptions } from '@/application/reconcile/normalize'
import type { ComparisonResult, FieldPair, ResultSet, Tolerance } from '@/application/reconcile/types'

/** How many rows either side may return before a comparison is refused.
 * Matches the bridge's default; both sides must use the same number or the
 * comparison is biased toward whichever side truncated. */
export const ROW_CAP = 100_000

let seq = 0
const nextId = () => `rs_${++seq}`

interface ReconcileState {
  connection: SqlConnection
  connected: SqlTestResult | null
  connecting: boolean
  connectionError: string | null

  sourceQuery: string
  targetQuery: string
  /** The last execution of each side. Null until run. */
  source: ResultSet | null
  target: ResultSet | null
  runningSource: boolean
  runningTarget: boolean
  sourceError: string | null
  targetError: string | null

  keys: FieldPair[]
  values: FieldPair[]
  tolerance: Tolerance
  normalize: NormalizeOptions
  result: ComparisonResult | null

  setConnection: (patch: Partial<SqlConnection>) => void
  connect: () => Promise<void>
  disconnect: () => void

  setSourceQuery: (sql: string) => void
  setTargetQuery: (dax: string) => void
  /** Load a generated check into both panes at once. */
  loadPair: (dax: string, sql: string) => void

  runSource: () => Promise<void>
  runTarget: () => Promise<void>
  runBoth: () => Promise<void>

  addKeyPair: (sourceCol: string, targetCol: string) => void
  addValuePair: (sourceCol: string, targetCol: string) => void
  removeKeyPair: (i: number) => void
  removeValuePair: (i: number) => void
  clearPairs: () => void
  setTolerance: (t: Partial<Tolerance>) => void
  setNormalize: (n: Partial<NormalizeOptions>) => void
  recompute: () => void
}

/** Drop the comparison whenever its inputs change — a stale verdict shown
 * beside edited queries is the most misleading thing this screen could do. */
const invalidate = { result: null }

export const useReconcile = create<ReconcileState>((set, get) => ({
  connection: { server: '', database: '', auth: 'integrated', timeoutSec: 30 },
  connected: null,
  connecting: false,
  connectionError: null,

  sourceQuery: 'SELECT COUNT(*) AS [RowCount]\nFROM [dbo].[YourTable];',
  targetQuery: `EVALUATE\nROW ( "RowCount", COUNTROWS ( 'YourTable' ) )`,
  source: null,
  target: null,
  runningSource: false,
  runningTarget: false,
  sourceError: null,
  targetError: null,

  keys: [],
  values: [],
  // Not exact-zero. A SQL `decimal` becomes a JS `number` on the way through
  // JSON, and summing those reintroduces binary-floating-point residue: two
  // sides that agree to the cent can still differ by ~1e-9. Comparing exactly
  // reports every money column as a wall of mismatches whose delta renders as
  // "0" — the confident-but-wrong answer this tool exists to avoid. A
  // millionth absorbs representation noise and is far below any difference
  // that could matter; integer counts still differ by at least 1.
  tolerance: { absolute: 1e-6, relative: 0 },
  normalize: DEFAULT_NORMALIZE,
  result: null,

  setConnection: (patch) =>
    set((s) => ({ connection: { ...s.connection, ...patch }, connectionError: null })),

  connect: async () => {
    set({ connecting: true, connectionError: null })
    try {
      const info = await sqlTest(get().connection)
      // The server's own collation decides whether keys compare case-blind;
      // guessing would silently split or merge keys on text columns.
      const caseInsensitive = info.collation ? /_CI_/i.test(info.collation) : true
      set((s) => ({
        connected: info,
        connecting: false,
        normalize: { ...s.normalize, caseInsensitive },
      }))
    } catch (e) {
      set({ connecting: false, connected: null, connectionError: (e as Error).message })
    }
  },

  disconnect: () => set({ connected: null, source: null, ...invalidate }),

  setSourceQuery: (sql) => set({ sourceQuery: sql, ...invalidate }),
  setTargetQuery: (dax) => set({ targetQuery: dax, ...invalidate }),
  loadPair: (dax, sql) =>
    set({ targetQuery: dax, sourceQuery: sql, keys: [], values: [], ...invalidate }),

  runSource: async () => {
    const { connection, sourceQuery } = get()
    set({ runningSource: true, sourceError: null, ...invalidate })
    const started = performance.now()
    try {
      const r = await sqlQuery(connection, sourceQuery, ROW_CAP)
      set({
        runningSource: false,
        source: {
          id: nextId(),
          origin: 'source',
          label: connection.database || connection.server,
          query: sourceQuery,
          executedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
          columns: r.columns.map((name) => ({ name })),
          rows: r.rows.map((row) => r.columns.map((c) => row[c] ?? null)),
          truncated: r.truncated,
        },
      })
    } catch (e) {
      set({ runningSource: false, source: null, sourceError: (e as Error).message })
    }
  },

  runTarget: async () => {
    const { targetQuery } = get()
    set({ runningTarget: true, targetError: null, ...invalidate })
    const started = performance.now()
    try {
      // Name the port explicitly. Without it the bridge picks the only open
      // model — and refuses outright when the user has two reports open, which
      // is exactly when they are most likely to be reconciling.
      const port = useApp.getState().desktop.port
      const r = await desktopRunDax(targetQuery, port, ROW_CAP)
      set({
        runningTarget: false,
        target: {
          id: nextId(),
          origin: 'target',
          label: 'Power BI model',
          query: targetQuery,
          executedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
          columns: r.columns.map((name) => ({ name })),
          rows: r.rows.map((row) => r.columns.map((c) => row[c] ?? null)),
          truncated: r.truncated,
        },
      })
    } catch (e) {
      set({ runningTarget: false, target: null, targetError: (e as Error).message })
    }
  },

  // Back to back on purpose: the gap between the two reads is drift, and drift
  // shows up as a difference that is nobody's fault.
  runBoth: async () => {
    await Promise.all([get().runSource(), get().runTarget()])
    get().recompute()
  },

  addKeyPair: (sourceCol, targetCol) =>
    set((s) => {
      if (!s.source || !s.target) return s
      return {
        keys: [
          ...s.keys,
          { source: { resultSetId: s.source.id, column: sourceCol }, target: { resultSetId: s.target.id, column: targetCol } },
        ],
        ...invalidate,
      }
    }),

  addValuePair: (sourceCol, targetCol) =>
    set((s) => {
      if (!s.source || !s.target) return s
      return {
        values: [
          ...s.values,
          { source: { resultSetId: s.source.id, column: sourceCol }, target: { resultSetId: s.target.id, column: targetCol } },
        ],
        ...invalidate,
      }
    }),

  removeKeyPair: (i) => set((s) => ({ keys: s.keys.filter((_, x) => x !== i), ...invalidate })),
  removeValuePair: (i) => set((s) => ({ values: s.values.filter((_, x) => x !== i), ...invalidate })),
  clearPairs: () => set({ keys: [], values: [], ...invalidate }),
  setTolerance: (t) => set((s) => ({ tolerance: { ...s.tolerance, ...t }, ...invalidate })),
  setNormalize: (n) => set((s) => ({ normalize: { ...s.normalize, ...n }, ...invalidate })),

  recompute: () => {
    const { source, target, keys, values, tolerance, normalize } = get()
    // No keys is legitimate, not an incomplete setup: a row count or a grand
    // total is a single scalar per side with nothing to group by. Both sides
    // then collapse to one bucket and compare directly.
    if (!source || !target || values.length === 0) {
      set({ result: null })
      return
    }
    const opts: CompareOptions = { tolerance, normalize }
    try {
      set({ result: compare(source, target, keys, values, opts) })
    } catch (e) {
      set({
        result: {
          rows: [],
          summary: {
            matched: 0, mismatched: 0, onlySource: 0, onlyTarget: 0,
            sourceKeys: 0, targetKeys: 0, sourceDuplicateKeys: 0, targetDuplicateKeys: 0, driftMs: 0,
          },
          refusal: { kind: 'emptyBothSides', message: (e as Error).message },
        },
      })
    }
  },
}))
