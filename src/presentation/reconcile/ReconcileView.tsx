/**
 * PRESENTATION — Reconcile
 *
 * Source (SQL Server) on the left, Target (the Power BI model) on the right,
 * never merged. Every number on this screen carries the side it came from, and
 * the header always states WHAT two things are being compared and WHEN each was
 * read — a reconciliation screen without that is misleading by omission.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Database, Play, Plug, Check, X, Trash2, TriangleAlert, Link2, RefreshCw, Table2,
} from 'lucide-react'
import { useApp } from '@/app/store'
import { useReconcile, ROW_CAP } from '@/app/reconcile-store'
import {
  getModelSources, suggestSqlObject, sqlSchema,
  type ModelSource, type SqlSchemaObject,
} from '@/infrastructure/desktop/sql-client'
import {
  byGrain, distinctValues, duplicateKeys, nullCount, rowCount,
} from '@/application/reconcile/generators'
import type { ComparisonRow, ResultSet, RowStatus } from '@/application/reconcile/types'
import './reconcile.css'

const fmt = (n: number | null) =>
  n === null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 4 })

/**
 * Deltas need more precision than values do.
 *
 * Rounding a difference to 4 places prints "-0" for a floating-point residue,
 * which reads as "zero but somehow wrong" — the least useful thing a
 * reconciliation screen can say. Show enough digits for the number to explain
 * itself, and collapse a true residue to a clean 0.
 */
const fmtDelta = (n: number | null) => {
  if (n === null) return '—'
  // Collapse at the same threshold the default tolerance uses. Printing
  // "-2.2e-9" beside a green "Match" makes the screen argue with itself; if we
  // are treating a residue as zero, it should read as zero.
  if (Math.abs(n) < 1e-6) return '0'
  if (Math.abs(n) < 0.0001) return n.toExponential(1)
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

const STATUS_LABEL: Record<RowStatus, string> = {
  match: 'Match',
  mismatch: 'Mismatch',
  onlySource: 'Only in source',
  onlyTarget: 'Only in target',
}

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (!Number.isFinite(mins)) return ''
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

// ── Connection ──────────────────────────────────────────────────────────────

function ConnectionBar() {
  const { connection, connected, connecting, connectionError, setConnection, connect, disconnect } =
    useReconcile()

  if (connected) {
    return (
      <div className="rec-conn rec-conn--on">
        <span className="rec-chip rec-chip--source"><Database size={13} /> Source</span>
        <strong>{connected.server}</strong>
        <span className="rec-conn__db">{connected.database}</span>
        <span className="rec-conn__meta">{connected.login}</span>
        {connected.collation && (
          <span className="rec-conn__meta" title="Decides whether text keys compare case-blind">
            {connected.collation}
          </span>
        )}
        <span className="rec-conn__spacer" />
        <button className="rec-btn rec-btn--quiet" onClick={disconnect}>Disconnect</button>
      </div>
    )
  }

  return (
    <div className="rec-conn">
      <span className="rec-chip rec-chip--source"><Database size={13} /> Source</span>
      <input
        className="rec-input"
        placeholder="Server  e.g. localhost\SQLEXPRESS"
        value={connection.server}
        onChange={(e) => setConnection({ server: e.target.value })}
      />
      <input
        className="rec-input"
        placeholder="Database"
        value={connection.database ?? ''}
        onChange={(e) => setConnection({ database: e.target.value })}
      />
      <select
        className="rec-input rec-input--sm"
        value={connection.auth ?? 'integrated'}
        onChange={(e) => setConnection({ auth: e.target.value as 'integrated' | 'sql' })}
      >
        <option value="integrated">Windows</option>
        <option value="sql">SQL login</option>
      </select>
      {connection.auth === 'sql' && (
        <>
          <input
            className="rec-input rec-input--sm"
            placeholder="User"
            value={connection.user ?? ''}
            onChange={(e) => setConnection({ user: e.target.value })}
          />
          <input
            className="rec-input rec-input--sm"
            type="password"
            placeholder="Password"
            value={connection.password ?? ''}
            onChange={(e) => setConnection({ password: e.target.value })}
          />
        </>
      )}
      <button
        className="rec-btn rec-btn--primary"
        disabled={!connection.server || connecting}
        onClick={() => void connect()}
      >
        <Plug size={13} /> {connecting ? 'Connecting…' : 'Connect'}
      </button>
      {connection.auth !== 'sql' && (
        <span className="rec-conn__meta">Windows auth — nothing is stored</span>
      )}
      {connectionError && <span className="rec-err">{connectionError}</span>}
    </div>
  )
}

// ── Check generators ────────────────────────────────────────────────────────

function CheckBar({ sources }: { sources: ModelSource[] }) {
  const { connected, loadPair } = useReconcile()
  const [schema, setSchema] = useState<SqlSchemaObject[]>([])
  const [modelTable, setModelTable] = useState('')
  const [sqlKey, setSqlKey] = useState('')
  const [column, setColumn] = useState('')
  const [matchedBy, setMatchedBy] = useState<'query' | 'name' | null>(null)
  const connection = useReconcile((s) => s.connection)

  useEffect(() => {
    if (!connected) { setSchema([]); return }
    void sqlSchema(connection).then(setSchema).catch(() => setSchema([]))
  }, [connected, connection])

  // A calculated table is derived inside the model and has no SQL object behind
  // it, so offering it here could only produce a meaningless comparison.
  const reconcilable = sources.filter((s) => s.kind === 'query')

  // Pre-select the matching SQL object. The Power Query text is the reliable
  // signal, but a model built from CSV extracts (or any non-SQL source) has no
  // SQL object named in its M at all — and reconciling exactly that case is the
  // point, so fall back to matching on the table name. Either way this only
  // PRE-SELECTS: the user sees the choice and can change it.
  useEffect(() => {
    const m = reconcilable.find((t) => t.name === modelTable)
    if (!m) return
    const guess = suggestSqlObject(m.expression)
    const hit = guess
      ? schema.find(
          (o) => o.name.toLowerCase() === guess.object.toLowerCase() &&
            (!guess.schema || o.schema.toLowerCase() === guess.schema.toLowerCase()),
        )
      : schema.find((o) => o.name.toLowerCase() === m.name.toLowerCase())
    setMatchedBy(hit ? (guess ? 'query' : 'name') : null)
    if (hit) setSqlKey(`${hit.schema}.${hit.name}`)
  }, [modelTable, schema, reconcilable])

  const obj = schema.find((o) => `${o.schema}.${o.name}` === sqlKey)
  const target = obj && modelTable
    ? { table: modelTable, sqlObject: obj.name, sqlSchema: obj.schema }
    : null
  const sqlCol = obj?.columns.find((c) => c.name === column)
  const colTarget = target && sqlCol
    ? { ...target, column: sqlCol.name, sqlColumn: sqlCol.name }
    : null

  const run = (g: { dax: string; sql: string }) => loadPair(g.dax, g.sql)

  return (
    <div className="rec-checks">
      <span className="rec-checks__label">Check</span>
      <select className="rec-input rec-input--sm" value={modelTable} onChange={(e) => setModelTable(e.target.value)}>
        <option value="">Model table…</option>
        {reconcilable.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
      </select>
      <select className="rec-input rec-input--sm" value={sqlKey} onChange={(e) => { setSqlKey(e.target.value); setColumn('') }}>
        <option value="">SQL object…</option>
        {schema.map((o) => (
          <option key={`${o.schema}.${o.name}`} value={`${o.schema}.${o.name}`}>
            {o.schema}.{o.name}{o.kind === 'view' ? ' (view)' : ''}
          </option>
        ))}
      </select>
      <select className="rec-input rec-input--sm" value={column} onChange={(e) => setColumn(e.target.value)} disabled={!obj}>
        <option value="">Column…</option>
        {obj?.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
      </select>

      <button className="rec-btn" disabled={!target} onClick={() => target && run(rowCount(target))}>Row count</button>
      <button className="rec-btn" disabled={!colTarget} onClick={() => colTarget && run(distinctValues(colTarget))}>Distinct</button>
      <button className="rec-btn" disabled={!colTarget} onClick={() => colTarget && run(nullCount(colTarget))}>Nulls</button>
      <button
        className="rec-btn"
        disabled={!colTarget}
        onClick={() => colTarget && run(duplicateKeys({ ...colTarget, columns: [{ model: colTarget.column, sql: colTarget.sqlColumn }] }))}
      >
        Duplicates
      </button>
      <button
        className="rec-btn"
        disabled={!colTarget}
        onClick={() => colTarget && run(byGrain({ ...colTarget, dimensions: [{ model: colTarget.column, sql: colTarget.sqlColumn }] }))}
      >
        By grain
      </button>
      <span className="rec-checks__hint">
        {matchedBy === 'name'
          ? 'Matched by name — this table does not load from SQL, so check the object is the right one.'
          : matchedBy === 'query'
            ? 'Matched from the table’s Power Query source.'
            : 'Both queries are written into the panes — read and edit them before running.'}
      </span>
    </div>
  )
}

// ── Query panes ─────────────────────────────────────────────────────────────

function QueryPane({
  side, title, value, onChange, onRun, running, error, result,
}: {
  side: 'source' | 'target'
  title: string
  value: string
  onChange: (v: string) => void
  onRun: () => void
  running: boolean
  error: string | null
  result: ResultSet | null
}) {
  return (
    <section className={`rec-pane rec-pane--${side}`}>
      <header className="rec-pane__head">
        <span className={`rec-chip rec-chip--${side}`}>
          {side === 'source' ? <Database size={13} /> : <Table2 size={13} />} {title}
        </span>
        {result && (
          <span className="rec-pane__meta">
            {result.rows.length.toLocaleString()} rows · {result.durationMs} ms · {ago(result.executedAt)}
          </span>
        )}
        <span className="rec-conn__spacer" />
        <button className="rec-btn rec-btn--primary" onClick={onRun} disabled={running}>
          <Play size={12} /> {running ? 'Running…' : 'Run'}
        </button>
      </header>
      <textarea
        className="rec-code"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <div className="rec-err rec-err--block">{error}</div>}
      {result?.truncated && (
        <div className="rec-warn">
          <TriangleAlert size={13} /> Hit the {ROW_CAP.toLocaleString()}-row cap — comparison is blocked
          until this returns fewer rows.
        </div>
      )}
    </section>
  )
}

/**
 * Column list for a result set.
 *
 * Pairing is always EXPLICIT — the user names both sides — because name-matching
 * across a warehouse and a model is exactly where silent mis-joins come from.
 *
 * Click-to-pair is the primary interaction rather than drag: it works from the
 * keyboard, it survives a mis-aimed pointer, and it is testable. Dragging still
 * works for anyone who reaches for it first.
 */
function ColumnList({
  rs, armed, onArm, onPair,
}: {
  rs: ResultSet | null
  /** The source column waiting for its partner, if any. */
  armed?: string | null
  onArm?: (column: string) => void
  onPair?: (from: string, to: string) => void
}) {
  if (!rs) return <div className="rec-cols rec-cols--empty">Run the query to see its columns.</div>
  const isTarget = !!onPair
  return (
    <div className="rec-cols">
      {rs.columns.map((c) => (
        <button
          key={c.name}
          type="button"
          className={`rec-col rec-col--${rs.origin}`}
          data-armed={!isTarget && armed === c.name}
          data-ready={isTarget && !!armed}
          draggable={!isTarget}
          onClick={() => (isTarget ? armed && onPair(armed, c.name) : onArm?.(c.name))}
          onDragStart={(e) => e.dataTransfer.setData('text/plain', c.name)}
          onDragOver={isTarget ? (e) => e.preventDefault() : undefined}
          onDrop={isTarget ? (e) => {
            e.preventDefault()
            const from = e.dataTransfer.getData('text/plain')
            if (from) onPair(from, c.name)
          } : undefined}
        >
          {c.name}
        </button>
      ))}
    </div>
  )
}

// ── Pairing ─────────────────────────────────────────────────────────────────

function PairingBar() {
  const {
    source, target, keys, values, addKeyPair, addValuePair,
    removeKeyPair, removeValuePair, clearPairs, recompute, tolerance, setTolerance,
  } = useReconcile()
  const [mode, setMode] = useState<'key' | 'value'>('key')
  const [armed, setArmed] = useState<string | null>(null)

  const pair = (from: string, to: string) => {
    if (mode === 'key') addKeyPair(from, to)
    else addValuePair(from, to)
    setArmed(null)
  }

  return (
    <section className="rec-pairing">
      <div className="rec-pairing__head">
        <span className="rec-checks__label"><Link2 size={13} /> Pair columns</span>
        <div className="rec-seg">
          <button data-on={mode === 'key'} onClick={() => setMode('key')}>Keys (grain)</button>
          <button data-on={mode === 'value'} onClick={() => setMode('value')}>Values</button>
        </div>
        <span className="rec-checks__hint">
          {armed
            ? <>Now pick the <b>Target</b> column that matches <b>{armed}</b>.</>
            : <>Click a <b>Source</b> column, then its <b>Target</b> column. Dragging works too.</>}
        </span>
        <span className="rec-conn__spacer" />
        <label className="rec-tol">
          ± <input
            className="rec-input rec-input--xs"
            type="number"
            value={tolerance.absolute}
            onChange={(e) => setTolerance({ absolute: Number(e.target.value) || 0 })}
          />
        </label>
        <button className="rec-btn rec-btn--quiet" onClick={clearPairs}><Trash2 size={12} /> Clear</button>
        <button
          className="rec-btn rec-btn--primary"
          disabled={values.length === 0}
          onClick={recompute}
        >
          <RefreshCw size={12} /> Compare
        </button>
      </div>

      <div className="rec-pairing__grid">
        <div>
          <div className="rec-pairing__sub">Source columns — pick one</div>
          <ColumnList rs={source} armed={armed} onArm={setArmed} />
        </div>
        <div>
          <div className="rec-pairing__sub">Target columns — then its match</div>
          <ColumnList rs={target} armed={armed} onPair={pair} />
        </div>
      </div>

      {(keys.length > 0 || values.length > 0) && (
        <div className="rec-pairs">
          {keys.map((k, i) => (
            <span key={`k${i}`} className="rec-pair rec-pair--key">
              <b>key</b> {k.source.column} ↔ {k.target.column}
              <button onClick={() => removeKeyPair(i)}><X size={11} /></button>
            </span>
          ))}
          {values.map((v, i) => (
            <span key={`v${i}`} className="rec-pair">
              <b>value</b> {v.source.column} ↔ {v.target.column}
              <button onClick={() => removeValuePair(i)}><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Matrix ──────────────────────────────────────────────────────────────────

/** Rows nest by key, so [Year, Month, Product] reads as a drill path. Children
 * are rolled up in the browser from the one result each side already returned —
 * expanding costs nothing and never re-queries. */
interface Node {
  label: string
  path: string
  depth: number
  rows: ComparisonRow[]
  children: Node[]
  status: RowStatus
  /** Per value pair, rolled up from this node's rows. A parent that shows only
   * a delta is half a story — the user needs both sides to judge whether a
   * difference matters. */
  sourceTotals: (number | null)[]
  targetTotals: (number | null)[]
  totals: (number | null)[]
}

/** Sum one side of one value pair across rows, keeping null when no row on that
 * side produced a value — so "no data" never renders as a confident zero. */
function rollup(rows: ComparisonRow[], i: number, pick: (c: ComparisonRow['cells'][number]) => number | null) {
  let sum: number | null = null
  for (const r of rows) {
    const v = pick(r.cells[i])
    if (v !== null && v !== undefined) sum = (sum ?? 0) + v
  }
  return sum
}

function buildTree(rows: ComparisonRow[], depth: number, keyCount: number, valueCount: number, prefix = ''): Node[] {
  if (rows.length === 0) return []
  // A scalar comparison (row count, grand total) has no key to group by — both
  // sides collapsed to one bucket, so show it as a single "Total" row.
  if (keyCount === 0) {
    const r = rows[0]
    return [{
      label: 'Total', path: '/total', depth: 0, rows, children: [], status: r.status,
      sourceTotals: r.cells.map((c) => c.sourceValue),
      targetTotals: r.cells.map((c) => c.targetValue),
      totals: r.cells.map((c) => c.delta),
    }]
  }
  if (depth >= keyCount) return []
  const groups = new Map<string, ComparisonRow[]>()
  for (const r of rows) {
    const label = r.key[depth] ?? '—'
    const arr = groups.get(label)
    if (arr) arr.push(r)
    else groups.set(label, [r])
  }
  const nodes: Node[] = []
  for (const [label, group] of groups) {
    const idx = Array.from({ length: valueCount }, (_, i) => i)
    const sourceTotals = idx.map((i) => rollup(group, i, (c) => c?.sourceValue ?? null))
    const targetTotals = idx.map((i) => rollup(group, i, (c) => c?.targetValue ?? null))
    const totals = idx.map((i) => rollup(group, i, (c) => c?.delta ?? null))
    const status: RowStatus =
      group.some((r) => r.status === 'onlySource') ? 'onlySource'
        : group.some((r) => r.status === 'onlyTarget') ? 'onlyTarget'
          : group.some((r) => r.status === 'mismatch') ? 'mismatch'
            : 'match'
    nodes.push({
      label,
      path: `${prefix}/${label}`,
      depth,
      rows: group,
      status,
      sourceTotals,
      targetTotals,
      totals,
      children: buildTree(group, depth + 1, keyCount, valueCount, `${prefix}/${label}`),
    })
  }
  // Problems first, then biggest absolute difference.
  const rank: Record<RowStatus, number> = { match: 0, mismatch: 2, onlySource: 3, onlyTarget: 3 }
  nodes.sort((a, b) => {
    const r = rank[b.status] - rank[a.status]
    if (r !== 0) return r
    const mag = (n: Node) => Math.max(...n.totals.map((t) => Math.abs(t ?? 0)), 0)
    return mag(b) - mag(a)
  })
  return nodes
}

function MatrixRows({ nodes, open, toggle }: { nodes: Node[]; open: Set<string>; toggle: (p: string) => void }) {
  const { values } = useReconcile()
  return (
    <>
      {nodes.map((n) => {
        const leaf = n.children.length === 0
        const isOpen = open.has(n.path)
        return (
          // The Fragment needs the key: without it React cannot tell these
          // sibling groups apart, and expanding a row re-renders the wrong one
          // (or nothing at all).
          <Fragment key={n.path}>
            <tr className={`rec-row rec-row--${n.status}`}>
              <td style={{ paddingLeft: 8 + n.depth * 18 }}>
                {!leaf && (
                  <button className="rec-tw" onClick={() => toggle(n.path)} aria-expanded={isOpen}>
                    {isOpen ? '▾' : '▸'}
                  </button>
                )}
                {n.label}
              </td>
              {values.map((_, i) => (
                <Fragment key={i}>
                  <td className="rec-num">{fmt(n.sourceTotals[i])}</td>
                  <td className="rec-num">{fmt(n.targetTotals[i])}</td>
                  <td className="rec-num rec-num--delta">{fmtDelta(n.totals[i])}</td>
                </Fragment>
              ))}
              <td><span className={`rec-status rec-status--${n.status}`}>{STATUS_LABEL[n.status]}</span></td>
            </tr>
            {!leaf && isOpen && <MatrixRows nodes={n.children} open={open} toggle={toggle} />}
          </Fragment>
        )
      })}
    </>
  )
}

function Matrix() {
  const { result, keys, values, source, target } = useReconcile()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (p: string) =>
    setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })

  const tree = useMemo(
    () => (result ? buildTree(result.rows, 0, keys.length, values.length) : []),
    [result, keys.length, values.length],
  )

  if (!result) {
    return (
      <div className="rec-empty">
        Run both queries, pair a key and a value, then Compare.
      </div>
    )
  }

  if (result.refusal) {
    return (
      <div className="rec-refusal">
        <TriangleAlert size={16} />
        <div>
          <strong>Not comparing — the answer would be wrong.</strong>
          <p>{result.refusal.message}</p>
          {result.refusal.kind === 'noKeyOverlap' && (
            <div className="rec-refusal__samples">
              <div><span className="rec-chip rec-chip--source">Source</span> {result.refusal.sampleSource.join(' · ')}</div>
              <div><span className="rec-chip rec-chip--target">Target</span> {result.refusal.sampleTarget.join(' · ')}</div>
            </div>
          )}
        </div>
      </div>
    )
  }

  const s = result.summary
  return (
    <div className="rec-matrix">
      <div className="rec-summary">
        <span className="rec-stat rec-stat--ok"><Check size={13} /> {s.matched.toLocaleString()} match</span>
        <span className="rec-stat rec-stat--bad"><X size={13} /> {s.mismatched.toLocaleString()} mismatch</span>
        <span className="rec-stat rec-stat--warn">{s.onlySource.toLocaleString()} only in source</span>
        <span className="rec-stat rec-stat--warn">{s.onlyTarget.toLocaleString()} only in target</span>
        {(s.sourceDuplicateKeys > 0 || s.targetDuplicateKeys > 0) && (
          <span className="rec-stat" title="The key is not unique at this grain; rows were summed.">
            key not unique: {s.sourceDuplicateKeys} source / {s.targetDuplicateKeys} target
          </span>
        )}
        {s.driftMs > 60_000 && (
          <span className="rec-stat rec-stat--warn">
            {Math.round(s.driftMs / 60000)}m between the two reads — use Run both
          </span>
        )}
      </div>

      <table className="rec-table">
        <thead>
          <tr>
            <th>{keys.length === 0 ? 'Total' : keys.map((k) => k.target.column).join(' ▸ ')}</th>
            {values.map((v, i) => (
              <>
                <th key={`hs${i}`} className="rec-th--source">Source · {v.source.column}</th>
                <th key={`ht${i}`} className="rec-th--target">Target · {v.target.column}</th>
                <th key={`hd${i}`} className="rec-num">Δ</th>
              </>
            ))}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <MatrixRows nodes={tree} open={open} toggle={toggle} />
        </tbody>
      </table>

      <footer className="rec-foot">
        {source && <span><span className="rec-chip rec-chip--source">Source</span> read {ago(source.executedAt)}</span>}
        {target && <span><span className="rec-chip rec-chip--target">Target</span> read {ago(target.executedAt)}</span>}
      </footer>
    </div>
  )
}

// ── View ────────────────────────────────────────────────────────────────────

export function ReconcileView() {
  const desktop = useApp((s) => s.desktop)
  const [sources, setSources] = useState<ModelSource[]>([])
  const {
    connected, sourceQuery, targetQuery, setSourceQuery, setTargetQuery,
    runSource, runTarget, runBoth, runningSource, runningTarget,
    sourceError, targetError, source, target,
  } = useReconcile()

  useEffect(() => {
    if (!desktop.connected) return
    void getModelSources(desktop.port).then(setSources).catch(() => setSources([]))
  }, [desktop.connected, desktop.port])

  // Import models hold a snapshot: a difference may mean the refresh is stale
  // rather than that the data is wrong, and the user must be able to see which.
  const refreshed = sources.map((s) => s.refreshedAt).filter(Boolean).sort().pop()

  return (
    <div className="recview pbs-scroll">
      <header className="rec-head">
        <div>
          <h2>Reconcile</h2>
          <p>
            Compare the Power BI model against its SQL Server source. Nothing is translated —
            you write both queries, and the tool reports the difference.
          </p>
        </div>
        <div className="rec-head__target">
          <span className="rec-chip rec-chip--target"><Table2 size={13} /> Target</span>
          {desktop.connected
            ? <><strong>Power BI Desktop</strong>{refreshed && <span className="rec-conn__meta">refreshed {ago(refreshed)}</span>}</>
            : <span className="rec-conn__meta">No model open</span>}
        </div>
      </header>

      <ConnectionBar />
      {connected && desktop.connected && <CheckBar sources={sources} />}

      <div className="rec-panes">
        <QueryPane
          side="source" title="SQL Server" value={sourceQuery} onChange={setSourceQuery}
          onRun={() => void runSource()} running={runningSource} error={sourceError} result={source}
        />
        <QueryPane
          side="target" title="Power BI model" value={targetQuery} onChange={setTargetQuery}
          onRun={() => void runTarget()} running={runningTarget} error={targetError} result={target}
        />
      </div>

      <div className="rec-runboth">
        <button
          className="rec-btn rec-btn--primary"
          onClick={() => void runBoth()}
          disabled={runningSource || runningTarget || !connected}
        >
          <Play size={13} /> Run both
        </button>
        <span className="rec-checks__hint">
          Back to back, so the gap between the two reads cannot show up as a difference.
        </span>
      </div>

      <PairingBar />
      <Matrix />
    </div>
  )
}
