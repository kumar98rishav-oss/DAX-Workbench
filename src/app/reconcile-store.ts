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
  bindCheck, classify, evidenceFrom, newId, suggestName, summarize,
  type CheckRun, type CheckSuite, type SavedCheck,
} from '@/application/reconcile/suite'
import { getSuites, putSuites } from '@/infrastructure/desktop/sql-client'
import { daxToSql, sqlToDax, type TranslateContext } from '@/application/reconcile/translate'
import type { AdhocRecord } from '@/application/reconcile/report'
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

  // ── Drafting one query from the other ─────────────────────────────────────
  /** The outcome of the last translate. Cleared as soon as either query is
   * edited, so advice never outlives the text it was about. */
  translation:
    | { ok: true; direction: 'sqlToDax' | 'daxToSql'; notes: string[] }
    | { ok: false; reason: string; hint?: string }
    | null
  translate: (direction: 'sqlToDax' | 'daxToSql', ctx: TranslateContext) => void
  dismissTranslation: () => void

  // ── Ad-hoc comparisons ────────────────────────────────────────────────────
  /** Every comparison run in the builder this session, so a report documents
   * the investigation and not only the saved suite. Keyed by the query pair:
   * re-comparing the same pair updates its entry instead of adding another. */
  adhoc: AdhocRecord[]
  removeAdhoc: (id: string) => void
  clearAdhoc: () => void

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
  /** Bumped each time a check is loaded into the panes, so the view knows to
   * reveal the builder. A counter rather than a flag: opening the same check
   * twice must still open the builder the second time. */
  builderNonce: number
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

  // Editing a query drops any translation advice with it: a note about what a
  // draft did or did not handle is worthless once the text has moved on.
  setSourceQuery: (sql) => set({ sourceQuery: sql, translation: null, ...invalidate }),
  setTargetQuery: (dax) => set({ targetQuery: dax, translation: null, ...invalidate }),
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
  builderNonce: 0,

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
        table: p.table,
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
      builderNonce: get().builderNonce + 1,
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

    const mk = (origin: 'source' | 'target', cols: string[], rows: Record<string, unknown>[], truncated: boolean): ResultSet => ({
      id: nextId(), origin, label: origin, query: '', executedAt: new Date().toISOString(),
      durationMs: 0, columns: cols.map((name) => ({ name })),
      rows: rows.map((r) => cols.map((c) => r[c] ?? null)), truncated,
    })

    /** One attempt: both sides together, then compare. Throws on anything that
     * stopped the check from being evaluated. */
    const attempt = async (check: SavedCheck) => {
      const [sq, tq] = await Promise.all([
        sqlQuery(connection, check.sourceQuery, ROW_CAP),
        desktopRunDax(check.targetQuery, port, ROW_CAP),
      ])
      const s = mk('source', sq.columns, sq.rows, sq.truncated)
      const t = mk('target', tq.columns, tq.rows, tq.truncated)
      const bound = bindCheck(check, s, t)
      const result = compare(s, t, bound.keys, bound.values, { tolerance: check.tolerance, normalize })
      return {
        result,
        // Keep the numbers, not just the verdict: a result that cannot show its
        // working is asking to be taken on faith.
        evidence: evidenceFrom(
          result,
          bound.values.map((v) => v.target.column),
          s.rows.length,
          t.rows.length,
        ),
      }
    }

    /**
     * A timeout during a long suite is contention, not a verdict.
     *
     * Both engines live on this machine and a run fires them together for every
     * check; under that burst a query that takes 150ms alone can wait past its
     * command timeout. Observed twice on a 45-check suite, hitting a DIFFERENT
     * check each time — the signature of load, not of a bad query. Anything
     * else (a renamed column, broken SQL) is deterministic and retrying it just
     * wastes another timeout.
     */
    const isContention = (e: unknown) => /timeout/i.test((e as Error)?.message ?? '')

    for (const check of enabled) {
      set({ runningCheckId: check.id })
      const t0 = performance.now()
      const base = { checkId: check.id, name: check.name, ranAt: new Date().toISOString() }
      let lastError: unknown

      for (let tries = 0; tries < 2; tries++) {
        try {
          const { result, evidence } = await attempt(check)
          out.push({
            ...base,
            status: classify(result),
            summary: result.summary,
            evidence,
            refusal: result.refusal,
            durationMs: Math.round(performance.now() - t0),
          })
          lastError = undefined
          break
        } catch (e) {
          lastError = e
          // Let the engines breathe before the second go.
          if (tries === 0 && isContention(e)) {
            await new Promise((r) => setTimeout(r, 750))
            continue
          }
          break
        }
      }

      if (lastError) {
        // The check did not run. That is inconclusive, never a pass — see classify().
        out.push({
          ...base,
          status: 'inconclusive',
          error: isContention(lastError)
            ? `Timed out twice — the server was busy. ${(lastError as Error).message}`
            : (lastError as Error).message,
          durationMs: Math.round(performance.now() - t0),
        })
      }
      set({ runs: [...out] })
    }

    set({ running: false, runningCheckId: null, lastRunAt: new Date().toISOString() })
  },

  translation: null,
  dismissTranslation: () => set({ translation: null }),

  translate: (direction, ctx) => {
    const { sourceQuery, targetQuery } = get()
    const t = direction === 'sqlToDax' ? sqlToDax(sourceQuery, ctx) : daxToSql(targetQuery, ctx)
    if (!t.ok) {
      // Leave the other pane untouched: a refusal must not half-write something.
      set({ translation: { ok: false, reason: t.reason, hint: t.hint } })
      return
    }
    set({
      ...(direction === 'sqlToDax' ? { targetQuery: t.query } : { sourceQuery: t.query }),
      translation: { ok: true, direction, notes: t.notes },
      // The drafted query has not run, so any standing result is now about
      // something else.
      keys: [], values: [], source: null, target: null, ...invalidate,
    })
  },

  adhoc: [],
  removeAdhoc: (id) => set((s) => ({ adhoc: s.adhoc.filter((a) => a.id !== id) })),
  clearAdhoc: () => set({ adhoc: [] }),

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
      const result = compare(source, target, keys, values, opts)
      const { sourceQuery, targetQuery, adhoc } = get()

      // Record it so the report covers the investigation too. Keyed by the
      // query pair, so tightening a tolerance and comparing again revises the
      // entry rather than filling the report with near-duplicates.
      const record: AdhocRecord = {
        id: newId('adh'),
        name: suggestName(sourceQuery, targetQuery),
        sourceQuery,
        targetQuery,
        ranAt: new Date().toISOString(),
        durationMs: (source.durationMs ?? 0) + (target.durationMs ?? 0),
        status: classify(result),
        summary: result.summary,
        refusal: result.refusal,
        evidence: evidenceFrom(result, values.map((v) => v.target.column), source.rows.length, target.rows.length),
        keys: keys.map((k) => ({ source: k.source.column, target: k.target.column })),
        values: values.map((v) => ({ source: v.source.column, target: v.target.column })),
      }
      const sameQueries = (a: AdhocRecord) =>
        a.sourceQuery === sourceQuery && a.targetQuery === targetQuery
      const existing = adhoc.findIndex(sameQueries)

      set({
        result,
        adhoc: existing >= 0
          ? adhoc.map((a, i) => (i === existing ? { ...record, id: a.id } : a))
          : [...adhoc, record],
      })
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
