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
  Database, Play, PlayCircle, Plug, Check, X, Trash2, TriangleAlert, Link2, RefreshCw, Table2, Save, Wand2,
  Copy, FileSearch, ChevronUp, FileDown, ArrowRight, ArrowLeft,
} from 'lucide-react'
import { useApp } from '@/app/store'
import { useReconcile, ROW_CAP } from '@/app/reconcile-store'
import {
  getModelSources, suggestSqlObject, sqlSchema,
  type ModelSource, type SqlSchemaObject,
} from '@/infrastructure/desktop/sql-client'
import { getDesktopModel, modelLabel, type DesktopRelationship } from '@/infrastructure/desktop/desktop-client'
import { adhocAsSuite, buildCsv, buildReportHtml, reportFilename, type ReportInput } from '@/application/reconcile/report'
import {
  byGrain, dateCoverage, distinctValues, duplicateKeys, nullCount, orphanKeys, rowCount, valueSet,
} from '@/application/reconcile/generators'
import {
  groupChecks, summarize, type CheckRun, type CheckStatus, type SavedCheck,
} from '@/application/reconcile/suite'
import type { ProposalKind } from '@/application/reconcile/propose'
import type { ComparisonRow, ResultSet, RowStatus } from '@/application/reconcile/types'
import './reconcile.css'

const fmt = (n: number | string | null) =>
  n === null ? '—'
    : typeof n === 'string' ? n
      : n.toLocaleString(undefined, { maximumFractionDigits: 4 })

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

function CheckBar({ sources, rels }: { sources: ModelSource[]; rels: DesktopRelationship[] }) {
  const [relKey, setRelKey] = useState('')
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

  const activeRels = rels.filter((r) => r.isActive)
  const rel = activeRels.find((r) => `${r.fromTable}|${r.fromColumn}|${r.toTable}|${r.toColumn}` === relKey)
  // Both ends need a SQL object before there is an anti-join to write.
  const factObj = rel && schema.find((o) => o.name.toLowerCase() === rel.fromTable.toLowerCase())
  const dimObj = rel && schema.find((o) => o.name.toLowerCase() === rel.toTable.toLowerCase())
  const orphanTarget = rel && factObj && dimObj
    ? {
        factTable: rel.fromTable, factColumn: rel.fromColumn,
        factSqlObject: factObj.name, factSqlSchema: factObj.schema, factSqlColumn: rel.fromColumn,
        dimTable: rel.toTable, dimColumn: rel.toColumn,
        dimSqlObject: dimObj.name, dimSqlSchema: dimObj.schema, dimSqlColumn: rel.toColumn,
      }
    : null

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
      <button className="rec-btn" disabled={!colTarget} onClick={() => colTarget && run(dateCoverage(colTarget))} title="First date, last date and how many distinct days carry data">Date range</button>
      <button className="rec-btn" disabled={!colTarget} onClick={() => colTarget && run(valueSet(colTarget))} title="Every distinct value and its frequency — a matching count is not a matching set">Value set</button>
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

      {/* Orphans is driven by a relationship, not by a table and column, so it
          gets its own picker. ACTIVE relationships only: RELATED follows the
          active path, and offering an inactive one would generate DAX that
          quietly measures something else. */}
      {activeRels.length > 0 && (
        <>
          <select className="rec-input rec-input--sm" value={relKey} onChange={(e) => setRelKey(e.target.value)}>
            <option value="">Relationship…</option>
            {activeRels.map((r) => {
              const k = `${r.fromTable}|${r.fromColumn}|${r.toTable}|${r.toColumn}`
              return <option key={k} value={k}>{`${r.fromTable}[${r.fromColumn}] → ${r.toTable}`}</option>
            })}
          </select>
          <button
            className="rec-btn"
            disabled={!orphanTarget}
            title="Fact rows whose key resolves to nothing — the failure every other check here passes straight through"
            onClick={() => orphanTarget && run(orphanKeys(orphanTarget))}
          >
            Orphans
          </button>
        </>
      )}

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

// ── Suite ───────────────────────────────────────────────────────────────────

/**
 * One line showing WHAT was compared, not merely that it was.
 *
 * "1 matched" is a claim the reader has to take on trust; "19,658 = 19,658" is
 * the evidence itself. Scalar checks — most of them — quote their numbers
 * directly. A grain check has no single row to quote, so it reports how many
 * keys were compared and leaves the detail to the matrix.
 */
function runDetail(run?: CheckRun): string {
  if (!run) return 'not run yet'
  if (run.error) return run.error
  if (run.refusal) return run.refusal.message

  const ev = run.evidence
  if (ev?.values?.length) {
    return ev.values
      .map((v) => {
        const a = fmt(v.source)
        const b = fmt(v.target)
        return a === b ? `${v.label.replace(/^\[|\]$/g, '')} ${a}` : `${v.label.replace(/^\[|\]$/g, '')} ${a} vs ${b}`
      })
      .join(' · ')
  }

  const s = run.summary
  if (!s) return ''
  if (run.status === 'pass') return `${s.matched.toLocaleString()} keys compared, all agree`
  const bits: string[] = []
  if (s.mismatched) bits.push(`${s.mismatched.toLocaleString()} mismatched`)
  if (s.onlySource) bits.push(`${s.onlySource.toLocaleString()} only in source`)
  if (s.onlyTarget) bits.push(`${s.onlyTarget.toLocaleString()} only in target`)
  return bits.join(' · ')
}

/** Everything needed to reproduce a verdict by hand, in a form that pastes
 * straight into SSMS and DAX Studio. */
function evidenceText(check: SavedCheck, run?: CheckRun): string {
  const lines = [
    `CHECK   ${check.name}`,
    run ? `RESULT  ${run.status.toUpperCase()} — ${runDetail(run)}` : 'RESULT  not run',
    run ? `RAN     ${run.ranAt} (${run.durationMs} ms)` : '',
    '',
    '-- SOURCE (SQL Server) ------------------------------------------',
    check.sourceQuery,
    '',
    '-- TARGET (Power BI model) --------------------------------------',
    check.targetQuery,
  ]
  if (run?.evidence) {
    lines.push('', `-- RETURNED ------------------------------------------------------`)
    lines.push(`source rows: ${run.evidence.sourceRows}   target rows: ${run.evidence.targetRows}`)
    for (const v of run.evidence.values ?? []) {
      lines.push(`${v.label}: source=${fmt(v.source)} target=${fmt(v.target)} ${v.status}`)
    }
  }
  return lines.filter((l) => l !== '').join('\n')
}

/** The proof, on demand: both queries and what each returned, so the number can
 * be re-derived by hand in SSMS and DAX Studio rather than believed. */
function Evidence({ check, run }: { check: SavedCheck; run?: CheckRun }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(evidenceText(check, run))
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* clipboard blocked — the text is on screen either way */ }
  }

  return (
    <div className="rec-ev">
      <div className="rec-ev__bar">
        <span className="rec-checks__hint">Run these yourself to confirm the numbers.</span>
        <span className="rec-conn__spacer" />
        {run?.evidence && (
          <span className="rec-conn__meta">
            returned {run.evidence.sourceRows} / {run.evidence.targetRows} row
            {run.evidence.sourceRows === 1 && run.evidence.targetRows === 1 ? '' : 's'}
          </span>
        )}
        <button className="rec-btn rec-btn--quiet" onClick={() => void copy()}>
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy evidence'}
        </button>
      </div>

      {run?.evidence?.values?.length ? (
        <table className="rec-ev__values">
          <thead>
            <tr>
              <th />
              <th className="rec-th--source">Source · SQL Server</th>
              <th className="rec-th--target">Target · Power BI</th>
              <th className="rec-num">Δ</th>
            </tr>
          </thead>
          <tbody>
            {run.evidence.values.map((v) => (
              <tr key={v.label} className={`rec-row rec-row--${v.status}`}>
                <td>{v.label.replace(/^\[|\]$/g, '')}</td>
                <td className="rec-num">{fmt(v.source)}</td>
                <td className="rec-num">{fmt(v.target)}</td>
                <td className="rec-num rec-num--delta">{fmtDelta(v.delta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div className="rec-ev__queries">
        <div>
          <span className="rec-chip rec-chip--source"><Database size={12} /> SQL Server</span>
          <pre>{check.sourceQuery}</pre>
        </div>
        <div>
          <span className="rec-chip rec-chip--target"><Table2 size={12} /> Power BI model</span>
          <pre>{check.targetQuery}</pre>
        </div>
      </div>
    </div>
  )
}

const STATUS_MARK: Record<CheckStatus, string> = { pass: '✓', fail: '✗', inconclusive: '!' }

/** Exhaustive by type, so adding a proposal kind cannot silently fall through
 * to the wrong label — which is exactly what happened when orphans shipped. */
const KIND_LABEL: Record<ProposalKind, string> = {
  rowCount: 'rows',
  dateRange: 'dates',
  duplicates: 'dupes',
  orphans: 'orphans',
}

/** Review the drafted checks before any of them join the suite. A mapping can
 * be wrong and a deliberate filter produces a correct difference, so this step
 * is not a formality. */
function ProposalReview() {
  const {
    proposals, unmatchedTables, toggleProposal, setAllProposals,
    addSelectedProposals, dismissProposals,
  } = useReconcile()
  if (proposals.length === 0) return null

  const picked = proposals.filter((p) => p.selected).length
  const flagged = proposals.filter((p) => p.caution).length

  return (
    <div className="rec-prop">
      <header className="rec-prop__head">
        <strong>{proposals.length} checks drafted</strong>
        <span className="rec-checks__hint">
          Read them before adding — a mapping can be wrong, and a table the model
          deliberately filters will differ on purpose.
        </span>
        <span className="rec-conn__spacer" />
        <button className="rec-btn rec-btn--quiet" onClick={() => setAllProposals(true)}>All</button>
        <button className="rec-btn rec-btn--quiet" onClick={() => setAllProposals(false)}>None</button>
        <button className="rec-btn rec-btn--quiet" onClick={dismissProposals}>Cancel</button>
        <button className="rec-btn rec-btn--primary" disabled={picked === 0} onClick={() => void addSelectedProposals()}>
          Add {picked}
        </button>
      </header>

      {flagged > 0 && (
        <div className="rec-prop__warn">
          <TriangleAlert size={12} /> {flagged} need a look before you trust them.
        </div>
      )}

      <ul className="rec-prop__list">
        {proposals.map((p) => (
          <li key={p.id} className="rec-prop__row" data-caution={!!p.caution}>
            <input type="checkbox" checked={p.selected} onChange={() => toggleProposal(p.id)} />
            <span className="rec-prop__kind">{KIND_LABEL[p.kind]}</span>
            <span className="rec-prop__name">{p.name}</span>
            <span className="rec-prop__obj">{p.object}</span>
            {p.caution && <span className="rec-prop__caution">{p.caution}</span>}
          </li>
        ))}
      </ul>

      {unmatchedTables.length > 0 && (
        <footer className="rec-prop__foot">
          Left out: {unmatchedTables.map((u) => `${u.name} (${u.why})`).join(' · ')}
        </footer>
      )}
    </div>
  )
}

/**
 * The headline answer, and the Run button beside it.
 *
 * Previously the verdict was a small chip in a toolbar, which is the wrong
 * weight for the only thing a reader came here to find out. Three outcomes are
 * always shown apart — a suite that could not evaluate some of its checks is
 * never described as clear.
 */
/** Hand a string to the browser as a file. A BOM goes on CSV so Excel reads it as
 * UTF-8 rather than guessing a legacy code page and mangling the dashes. */
function downloadText(filename: string, mime: string, text: string): void {
  const body = mime.startsWith('text/csv') ? `﻿${text}` : text
  const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next tick: revoking inside the click can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function VerdictBanner({ modelLabel, modelRefreshedAt }: { modelLabel?: string; modelRefreshedAt?: string }) {
  const { suite, runs, running, lastRunAt, connected, runAll, adhoc } = useReconcile()
  const sqlInfo = useReconcile((s) => s.connected)
  const enabled = suite.checks.filter((c) => c.enabled).length

  /** Build the report from what is on screen right now. Pure builders do the
   * work; this only gathers inputs and hands the file to the browser. */
  const download = (kind: 'html' | 'csv') => {
    // Ad-hoc comparisons join the suite under their own heading: the report
    // should document the investigation, not only the checks that were saved.
    const extra = adhocAsSuite(adhoc)
    const input: ReportInput = {
      generatedAt: new Date().toISOString(),
      source: sqlInfo
        ? { server: sqlInfo.server, database: sqlInfo.database, login: sqlInfo.login, collation: sqlInfo.collation, version: sqlInfo.version }
        : null,
      model: { label: modelLabel, refreshedAt: modelRefreshedAt },
      suite: { ...suite, checks: [...suite.checks, ...extra.checks] },
      runs: [...runs, ...extra.runs],
    }
    downloadText(
      reportFilename(kind, input),
      kind === 'html' ? 'text/html' : 'text/csv',
      kind === 'html' ? buildReportHtml(input) : buildCsv(input),
    )
  }
  const counts = summarize(runs)
  const clear = runs.length > 0 && counts.failed === 0 && counts.inconclusive === 0
  const tone = running ? 'busy' : runs.length === 0 ? 'idle' : clear ? 'ok' : counts.failed > 0 ? 'bad' : 'warn'

  const headline = () => {
    if (running) return `Running… ${runs.length} of ${enabled}`
    if (!connected) return 'Connect to your SQL Server to run checks'
    if (suite.checks.length === 0) return 'No checks yet'
    if (runs.length === 0) return `${enabled} check${enabled === 1 ? '' : 's'} ready`
    if (clear) return `All clear — ${counts.passed} check${counts.passed === 1 ? '' : 's'} passed`
    const bits: string[] = []
    if (counts.failed > 0) bits.push(`${counts.failed} failed`)
    if (counts.inconclusive > 0) bits.push(`${counts.inconclusive} could not run`)
    return bits.join(' · ')
  }

  const sub = () => {
    if (running) return 'Both sides of each check run together, so drift cannot look like a difference.'
    if (!connected) return null
    if (suite.checks.length === 0) return 'Propose checks drafts a baseline across every table at once.'
    if (runs.length === 0) return 'Nothing has been run yet.'
    if (clear) return lastRunAt ? `Model and source agree. Last run ${ago(lastRunAt)}.` : null
    return `${counts.passed} of ${runs.length} passed. Open the groups below to see what moved.`
  }

  const totalMs = runs.reduce((a, r) => a + r.durationMs, 0)

  return (
    <div className="rec-verdict" data-tone={tone}>
      <span className="rec-verdict__mark">
        {running ? '…' : tone === 'ok' ? '✓' : tone === 'bad' ? '✗' : tone === 'warn' ? '!' : '·'}
      </span>
      <div className="rec-verdict__text">
        <strong>{headline()}</strong>
        {sub() && <p>{sub()}</p>}
      </div>
      {!running && runs.length > 0 && <span className="rec-verdict__ms">{(totalMs / 1000).toFixed(1)}s</span>}
      {/* Documentation: what was tested, and what came back. Only offered once a
          run exists — a report with no results would document nothing. */}
      {!running && runs.length > 0 && (
        <span className="rec-verdict__dl">
          <button className="rec-btn" onClick={() => download('html')} title="A readable report: results, the numbers compared, and every query. Opens anywhere and prints to PDF.">
            <FileDown size={13} /> Report
          </button>
          <button className="rec-btn rec-btn--quiet" onClick={() => download('csv')} title="One row per metric, for Excel">
            CSV
          </button>
        </span>
      )}
      <button
        className="rec-btn rec-btn--primary rec-btn--lg"
        disabled={running || !connected || enabled === 0}
        onClick={() => void runAll()}
      >
        <PlayCircle size={15} /> {running ? 'Running…' : 'Run all'}
      </button>
      {running && (
        <div className="rec-verdict__bar">
          <div style={{ width: `${enabled ? (runs.length / enabled) * 100 : 0}%` }} />
        </div>
      )}
    </div>
  )
}

/** Drop the group's own name off a check so the list reads as a list, not as
 * the same prefix forty-five times. */
function shortName(name: string, table: string): string {
  const stripped = name.replace(new RegExp(`^${table.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*(—\\s*)?`), '')
  return stripped || name
}

function SuitePanel({ sources, rels }: { sources: ModelSource[]; rels: DesktopRelationship[] }) {
  const {
    suite, suiteError, runs, running, runningCheckId, lastRunAt, connected,
    loadSuite, saveCurrentAsCheck, removeCheck, toggleCheck, openCheck, runAll, values,
    propose, proposing, proposals,
  } = useReconcile()
  const [name, setName] = useState('')
  /** Per-group open state. Undefined means "follow the status" — see below. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** Which checks are showing their working. */
  const [shown, setShown] = useState<Record<string, boolean>>({})

  useEffect(() => { void loadSuite() }, [loadSuite])

  const groups = groupChecks(suite.checks)

  return (
    <section className="rec-suite">
      <header className="rec-suite__head">
        <span className="rec-checks__label">Checks ({suite.checks.length})</span>
        <input
          className="rec-input rec-input--sm"
          placeholder="Name this check…"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="rec-btn"
          disabled={values.length === 0}
          title={values.length === 0 ? 'Pair at least one value first' : 'Save the current queries and pairing'}
          onClick={() => { void saveCurrentAsCheck(name); setName('') }}
        >
          <Save size={12} /> Save current
        </button>
        <button
          className="rec-btn"
          disabled={!connected || proposing || sources.length === 0}
          title="Draft a baseline suite from the model and the database"
          onClick={() => void propose(
            sources.map((s) => ({ name: s.name, kind: s.kind, expression: s.expression })),
            rels.map((r) => ({
              fromTable: r.fromTable, fromColumn: r.fromColumn,
              toTable: r.toTable, toColumn: r.toColumn, isActive: r.isActive,
            })),
          )}
        >
          <Wand2 size={12} /> {proposing ? 'Reading…' : 'Propose checks'}
        </button>
        <span className="rec-conn__spacer" />
      </header>

      {suiteError && <div className="rec-err rec-err--block">{suiteError}</div>}

      <ProposalReview />

      {suite.checks.length === 0 && proposals.length === 0 ? (
        <div className="rec-suite__empty">
          <b>Propose checks</b> drafts a baseline across every table at once, or build one below and
          <b> Save current</b>. Saved checks re-run together after each refresh, so you find out what
          moved instead of hoping.
        </div>
      ) : suite.checks.length === 0 ? null : (
        <div className="rec-suite__groups">
          {groups.map((g) => {
            const groupRuns = g.checks.map((c) => runs.find((r) => r.checkId === c.id))
            const bad = groupRuns.filter((r) => r?.status === 'fail').length
            const unknown = groupRuns.filter((r) => r?.status === 'inconclusive').length
            const ok = groupRuns.filter((r) => r?.status === 'pass').length
            const worst = bad > 0 ? 'fail' : unknown > 0 ? 'inconclusive' : ok > 0 ? 'pass' : 'none'
            // A group that is fine stays shut: the reader only needs to open
            // what is unhappy. Anything not passing opens itself.
            const open = expanded[g.table] ?? (worst === 'fail' || worst === 'inconclusive')

            return (
              <div key={g.table} className="rec-grp" data-status={worst}>
                <button className="rec-grp__head" onClick={() => setExpanded((e) => ({ ...e, [g.table]: !open }))}>
                  <span className="rec-grp__tw">{open ? '▾' : '▸'}</span>
                  <span className={`rec-suite__mark rec-suite__mark--${worst}`}>
                    {worst === 'none' ? '·' : STATUS_MARK[worst as CheckStatus]}
                  </span>
                  <span className="rec-grp__name">{g.table}</span>
                  <span className="rec-grp__count">{g.checks.length} check{g.checks.length === 1 ? '' : 's'}</span>
                  <span className="rec-grp__state">
                    {bad > 0 && <span className="rec-stat rec-stat--bad">{bad} failed</span>}
                    {unknown > 0 && <span className="rec-stat rec-stat--warn">{unknown} could not run</span>}
                    {bad === 0 && unknown === 0 && ok > 0 && <span className="rec-stat rec-stat--ok">all passed</span>}
                  </span>
                </button>

                {open && (
                  <ul className="rec-suite__list">
                    {g.checks.map((c) => {
                      const run = runs.find((r) => r.checkId === c.id)
                      const active = runningCheckId === c.id
                      const showing = shown[c.id] ?? false
                      return (
                        <Fragment key={c.id}>
                          <li className="rec-suite__row" data-status={run?.status ?? 'none'} data-off={!c.enabled}>
                            <input
                              type="checkbox"
                              checked={c.enabled}
                              onChange={() => void toggleCheck(c.id)}
                              title={c.enabled ? 'Included in Run all' : 'Skipped'}
                            />
                            <span className={`rec-suite__mark rec-suite__mark--${run?.status ?? 'none'}`}>
                              {active ? '…' : run ? STATUS_MARK[run.status] : '·'}
                            </span>
                            <button
                              className="rec-suite__name"
                              onClick={() => setShown((s) => ({ ...s, [c.id]: !showing }))}
                              title="Show the queries and the numbers behind this result"
                            >
                              {shortName(c.name, g.table)}
                            </button>
                            <span className="rec-suite__detail">{active ? 'running…' : runDetail(run)}</span>
                            {run && <span className="rec-suite__ms">{run.durationMs} ms</span>}
                            <button
                              className="rec-suite__del"
                              onClick={() => setShown((s) => ({ ...s, [c.id]: !showing }))}
                              title={showing ? 'Hide the working' : 'Show the working'}
                            >
                              {showing ? <ChevronUp size={12} /> : <FileSearch size={12} />}
                            </button>
                            <button className="rec-suite__del" onClick={() => void removeCheck(c.id)} title="Remove">
                              <Trash2 size={12} />
                            </button>
                          </li>
                          {showing && (
                            <li className="rec-suite__evrow">
                              <Evidence check={c} run={run} />
                              <button className="rec-btn rec-btn--quiet" onClick={() => openCheck(c.id)}>
                                Open in builder
                              </button>
                            </li>
                          )}
                        </Fragment>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}

      {lastRunAt && <footer className="rec-suite__foot">Last run {ago(lastRunAt)}</footer>}
    </section>
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
  sourceTotals: (number | string | null)[]
  targetTotals: (number | string | null)[]
  totals: (number | null)[]
}

/**
 * Roll one side of one value pair up to this node.
 *
 * A single row shows its own value verbatim, so a text comparison (a date, a
 * code) survives to the screen instead of being flattened to a dash. Several
 * rows can only be summed, which is meaningful for numbers and not for text —
 * so text parents show nothing rather than something invented.
 */
function rollup(
  rows: ComparisonRow[],
  i: number,
  pick: (c: ComparisonRow['cells'][number]) => number | string | null,
): number | string | null {
  if (rows.length === 1) return pick(rows[0].cells[i])
  let sum: number | null = null
  for (const r of rows) {
    const v = pick(r.cells[i])
    if (typeof v === 'number') sum = (sum ?? 0) + v
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
    const totals = idx.map((i) => {
      const d = rollup(group, i, (c) => c?.delta ?? null)
      return typeof d === 'number' ? d : null
    })
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
  const [rels, setRels] = useState<DesktopRelationship[]>([])
  const {
    connected, sourceQuery, targetQuery, setSourceQuery, setTargetQuery,
    runSource, runTarget, runBoth, runningSource, runningTarget,
    sourceError, targetError, source, target, suite, builderNonce, suiteLoaded,
    translate, translation, dismissTranslation,
  } = useReconcile()

  // What the translator needs to spell table names the model's way and to
  // justify a RELATED() with a real relationship.
  const translateCtx = useMemo(() => ({
    modelTables: sources.map((s) => s.name),
    relationships: rels.filter((r) => r.isActive).map((r) => ({
      fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn,
    })),
    schema: 'dbo',
  }), [sources, rels])
  const [builderOpen, setBuilderOpen] = useState(false)

  // Open on an empty suite — with nothing to run, building IS the task. Gated
  // on suiteLoaded: the suite arrives asynchronously, so before it lands every
  // suite looks empty and the builder would spring open on every page load.
  const checkCount = suite.checks.length
  useEffect(() => {
    if (suiteLoaded && checkCount === 0) setBuilderOpen(true)
  }, [suiteLoaded, checkCount])
  // Open when a saved check is loaded, or clicking it would look like nothing
  // happened. Keyed off the nonce rather than the query text, which is never
  // empty and so would hold the builder permanently open.
  useEffect(() => { if (builderNonce > 0) setBuilderOpen(true) }, [builderNonce])

  useEffect(() => {
    if (!desktop.connected) return
    void getModelSources(desktop.port).then(setSources).catch(() => setSources([]))
    // Relationships drive the orphan checks — the one failure no other check
    // here can see.
    void getDesktopModel(desktop.port).then((m) => setRels(m.relationships)).catch(() => setRels([]))
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
            Compare the Power BI model against its SQL Server source. Nothing is translated behind
            your back — you own both queries, and the tool reports the difference.
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
      <VerdictBanner modelLabel={modelLabel(desktop.database) ?? undefined} modelRefreshedAt={refreshed} />
      <SuitePanel sources={sources} rels={rels} />

      {/* The builder is the editor, not the dashboard. Once a suite exists the
          day-to-day job is running it and reading the result, so the two query
          panes stop occupying the screen until they are asked for — opening a
          check from the list expands this automatically. */}
      <section className="rec-builder" data-open={builderOpen}>
        <button className="rec-builder__head" onClick={() => setBuilderOpen((v) => !v)}>
          <span className="rec-grp__tw">{builderOpen ? '▾' : '▸'}</span>
          <span className="rec-grp__name">Build a check</span>
          <span className="rec-checks__hint">
            Write both queries, pair the columns, compare — then save it into the suite.
          </span>
        </button>

        {builderOpen && (
          <div className="rec-builder__body">
            {connected && desktop.connected && <CheckBar sources={sources} rels={rels} />}

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
              <span className="rec-conn__spacer" />
              {/* A draft, not an authority. It saves typing; what runs is still
                  what you read and approve in the pane. */}
              <span className="rec-checks__hint">Draft from the other side</span>
              <button className="rec-btn" title="Draft DAX from this SQL" onClick={() => translate('sqlToDax', translateCtx)}>
                <ArrowRight size={12} /> SQL to DAX
              </button>
              <button className="rec-btn" title="Draft SQL from this DAX" onClick={() => translate('daxToSql', translateCtx)}>
                <ArrowLeft size={12} /> DAX to SQL
              </button>
            </div>

            {translation && (
              <div className="rec-trans" data-ok={translation.ok}>
                <TriangleAlert size={14} />
                <div className="rec-trans__body">
                  {translation.ok ? (
                    <>
                      <strong>
                        Drafted into the {translation.direction === 'sqlToDax' ? 'Power BI' : 'SQL Server'} pane —
                        read it before running.
                      </strong>
                      <p>
                        The two engines do not mean the same thing by a join or a blank, and no translator can see
                        filter context. This is a starting point you own, not a guarantee that the two agree.
                      </p>
                      {translation.notes.length > 0 && (
                        <ul>{translation.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                      )}
                    </>
                  ) : (
                    <>
                      <strong>Not translated — {translation.reason}</strong>
                      {translation.hint && <p>{translation.hint}</p>}
                    </>
                  )}
                </div>
                <button className="rec-suite__del" onClick={dismissTranslation} title="Dismiss">
                  <X size={12} />
                </button>
              </div>
            )}

            <PairingBar />
            <Matrix />
          </div>
        )}
      </section>
    </div>
  )
}
