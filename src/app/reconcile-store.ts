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
  sqlSchema,
  sqlTest,
  type SqlConnection,
  type SqlTestResult,
} from '@/infrastructure/desktop/sql-client'
import {
  proposeChecks, resetProposalIds, unmatched,
  type Proposal, type ProposeObject, type ProposeRelationship, type ProposeSource,
} from '@/application/reconcile/propose'
import { compare, type CompareOptions } from '@/application/reconcile/compare'
import { DEFAULT_NORMALIZE, type NormalizeOptions } from '@/application/reconcile/normalize'
import {
  bindCheck, classify, newId, suggestName, summarize,
  type CheckRun, type CheckSuite, type SavedCheck,
} from '@/application/reconcile/suite'
import { getSuites, putSuites } from '@/infrastructure/desktop/sql-client'
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

  // ── Suite ─────────────────────────────────────────────────────────────────
  suite: CheckSuite
  suiteLoaded: boolean
  suiteError: string | null
  running: boolean
  /** Which check is executing, so the list can show progress rather than freeze. */
  runningCheckId: string | null
  runs: CheckRun[]
  lastRunAt: string | null

  /** Drafted checks awaiting review. Never applied without a tick. */
  proposals: Proposal[]
  proposing: boolean
  unmatchedTables: { name: string; why: string }[]
  propose: (sources: ProposeSource[], relationships: ProposeRelationship[]) => Promise<void>
  toggleProposal: (id: string) => void
  setAllProposals: (selected: boolean) => void
  addSelectedProposals: () => Promise<void>
  dismissProposals: () => void

  loadSuite: () => Promise<void>
  saveCurrentAsCheck: (name?: string) => Promise<void>
  removeCheck: (id: string) => Promise<void>
  toggleCheck: (id: string) => Promise<void>
  /** Put a saved check back into the two panes so it can be inspected or edited. */
  openCheck: (id: string) => void
  runAll: () => Promise<void>
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

  // ── Suite ───────────────────────────────────────────────────────────────
  suite: { id: 'default', name: 'Checks', checks: [] },
  suiteLoaded: false,
  suiteError: null,
  running: false,
  runningCheckId: null,
  runs: [],
  lastRunAt: null,

  proposals: [],
  proposing: false,
  unmatchedTables: [],

  propose: async (sources, relationships) => {
    set({ proposing: true, suiteError: null })
    try {
      const schema = await sqlSchema(get().connection)
      const objects: ProposeObject[] = schema.map((o) => ({
        schema: o.schema, name: o.name, kind: o.kind,
        columns: o.columns.map((c) => ({ name: c.name, dataType: c.dataType })),
        primaryKey: o.primaryKey ?? [],
      }))
      resetProposalIds()
      set({
        proposals: proposeChecks(sources, objects, relationships),
        unmatchedTables: unmatched(sources, objects),
        proposing: false,
      })
    } catch (e) {
      set({ proposing: false, suiteError: (e as Error).message })
    }
  },

  toggleProposal: (id) =>
    set((s) => ({ proposals: s.proposals.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p)) })),

  setAllProposals: (selected) =>
    set((s) => ({ proposals: s.proposals.map((p) => ({ ...p, selected })) })),

  dismissProposals: () => set({ proposals: [], unmatchedTables: [] }),

  /**
   * Turn ticked proposals into saved checks.
   *
   * The pairing is written from the generators' own column names rather than
   * discovered by running the queries: these are OUR queries, so the names are
   * known up front and a draft suite can be added without touching either
   * engine. bindCheck still validates them at run time, so a drifted query
   * surfaces as a named error rather than a wrong comparison.
   */
  addSelectedProposals: async () => {
    const { proposals, suite, connection } = get()
    const picked = proposals.filter((p) => p.selected)
    if (picked.length === 0) return

    const PAIRS: Record<Proposal['kind'], { keys: string[]; values: string[] }> = {
      rowCount: { keys: [], values: ['RowCount'] },
      dateRange: { keys: [], values: ['First', 'Last', 'Days'] },
      duplicates: { keys: [], values: ['DuplicateKeys', 'ExtraRows'] },
      orphans: { keys: [], values: ['Orphans', 'OrphanKeys'] },
    }

    const checks: SavedCheck[] = picked.map((p) => {
      const shape = PAIRS[p.kind]
      return {
        id: newId('chk'),
        name: p.name,
        sourceQuery: p.queries.sql,
        targetQuery: p.queries.dax,
        keys: shape.keys.map((c) => ({ source: c, target: `[${c}]` })),
        // DAX brackets its ROW() column names; SQL does not.
        values: shape.values.map((c) => ({ source: c, target: `[${c}]` })),
        tolerance: { absolute: 1e-6, relative: 0 },
        enabled: true,
      }
    })

    const next: CheckSuite = {
      ...suite,
      builtAgainst: { server: connection.server, database: connection.database },
      checks: [...suite.checks, ...checks],
    }
    set({ suite: next, proposals: [], unmatchedTables: [] })
    try { await putSuites([next]) } catch (e) { set({ suiteError: (e as Error).message }) }
  },

  loadSuite: async () => {
    try {
      const all = await getSuites<CheckSuite>()
      set({ suite: all[0] ?? { id: 'default', name: 'Checks', checks: [] }, suiteLoaded: true, suiteError: null })
    } catch (e) {
      // A missing bridge must not make the screen unusable — ad-hoc comparison
      // still works, only saving is unavailable.
      set({ suiteLoaded: true, suiteError: (e as Error).message })
    }
  },

  saveCurrentAsCheck: async (name) => {
    const { sourceQuery, targetQuery, keys, values, tolerance, suite, connection } = get()
    if (values.length === 0) {
      set({ suiteError: 'Pair at least one value before saving — a check with nothing to compare would always pass.' })
      return
    }
    const check: SavedCheck = {
      id: newId('chk'),
      name: name?.trim() || suggestName(sourceQuery, targetQuery),
      sourceQuery,
      targetQuery,
      // Stored by column NAME: result-set ids change on every run.
      keys: keys.map((k) => ({ source: k.source.column, target: k.target.column })),
      values: values.map((v) => ({ source: v.source.column, target: v.target.column })),
      tolerance,
      enabled: true,
    }
    const next: CheckSuite = {
      ...suite,
      builtAgainst: { server: connection.server, database: connection.database },
      checks: [...suite.checks, check],
    }
    set({ suite: next, suiteError: null })
    try { await putSuites([next]) } catch (e) { set({ suiteError: (e as Error).message }) }
  },

  removeCheck: async (id) => {
    const next = { ...get().suite, checks: get().suite.checks.filter((c) => c.id !== id) }
    set({ suite: next, runs: get().runs.filter((r) => r.checkId !== id) })
    try { await putSuites([next]) } catch (e) { set({ suiteError: (e as Error).message }) }
  },

  toggleCheck: async (id) => {
    const next = {
      ...get().suite,
      checks: get().suite.checks.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
    }
    set({ suite: next })
    try { await putSuites([next]) } catch (e) { set({ suiteError: (e as Error).message }) }
  },

  openCheck: (id) => {
    const c = get().suite.checks.find((x) => x.id === id)
    if (!c) return
    set({
      sourceQuery: c.sourceQuery,
      targetQuery: c.targetQuery,
      tolerance: c.tolerance,
      // The pairing cannot be restored until both queries have run and produced
      // result sets to bind against, so it is cleared rather than left pointing
      // at ids from a previous run.
      keys: [], values: [], source: null, target: null,
      ...invalidate,
    })
  },

  /**
   * Run every enabled check.
   *
   * Sequential across checks (two engines, one at a time, so a big suite does
   * not stampede them) but both sides of a SINGLE check run together — the gap
   * between those two reads is drift, and drift is a difference nobody caused.
   */
  runAll: async () => {
    const { suite, connection, normalize } = get()
    const enabled = suite.checks.filter((c) => c.enabled)
    if (enabled.length === 0) return

    set({ running: true, runs: [], suiteError: null })
    const port = useApp.getState().desktop.port
    const out: CheckRun[] = []

    for (const check of enabled) {
      set({ runningCheckId: check.id })
      const t0 = performance.now()
      const base = { checkId: check.id, name: check.name, ranAt: new Date().toISOString() }
      try {
        const [sq, tq] = await Promise.all([
          sqlQuery(connection, check.sourceQuery, ROW_CAP),
          desktopRunDax(check.targetQuery, port, ROW_CAP),
        ])
        const mk = (origin: 'source' | 'target', cols: string[], rows: Record<string, unknown>[], truncated: boolean): ResultSet => ({
          id: nextId(), origin, label: origin, query: '', executedAt: new Date().toISOString(),
          durationMs: 0, columns: cols.map((name) => ({ name })),
          rows: rows.map((r) => cols.map((c) => r[c] ?? null)), truncated,
        })
        const s = mk('source', sq.columns, sq.rows, sq.truncated)
        const t = mk('target', tq.columns, tq.rows, tq.truncated)
        const bound = bindCheck(check, s, t)
        const result = compare(s, t, bound.keys, bound.values, { tolerance: check.tolerance, normalize })
        out.push({
          ...base,
          status: classify(result),
          summary: result.summary,
          refusal: result.refusal,
          durationMs: Math.round(performance.now() - t0),
        })
      } catch (e) {
        // A query error or a renamed column means the check did not run. That is
        // inconclusive, never a pass — see classify().
        out.push({
          ...base,
          status: 'inconclusive',
          error: (e as Error).message,
          durationMs: Math.round(performance.now() - t0),
        })
      }
      set({ runs: [...out] })
    }

    set({ running: false, runningCheckId: null, lastRunAt: new Date().toISOString() })
  },

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
