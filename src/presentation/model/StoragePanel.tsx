import { useState } from 'react'
import { HardDrive, Loader2, MonitorX, TriangleAlert, RefreshCw } from 'lucide-react'
import { useApp } from '@/app/store'
import { desktopVertipaq } from '@/infrastructure/desktop/desktop-client'
import type { VpReport } from '@/infrastructure/desktop/desktop-client'
import { analyzeStorage, summarize, formatBytes, formatPct, uniqueness } from '@/application/model/vertipaq'
import './storage.css'

type Tab = 'findings' | 'columns' | 'tables'

/** VertiPaq Analyzer — what is actually consuming memory in the live model.
 * Engine-only by design: these are real storage statistics read from Analysis
 * Services, so there is no in-browser approximation to fall back on. */
export function StoragePanel() {
  const desktop = useApp((s) => s.desktop)
  const [report, setReport] = useState<VpReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('findings')

  const run = async () => {
    setBusy(true)
    setErr(null)
    try {
      setReport(await desktopVertipaq(desktop.port))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read storage metrics.')
    } finally {
      setBusy(false)
    }
  }

  if (!desktop.connected) {
    return (
      <div className="vpa vpa--empty">
        <MonitorX size={22} />
        <p>
          Storage analysis reads real VertiPaq statistics from the engine — connect Power BI
          Desktop to measure this model.
        </p>
      </div>
    )
  }

  if (!report) {
    return (
      <div className="vpa vpa--empty">
        <HardDrive size={22} />
        <p>
          See what is consuming memory: column sizes, cardinality and encoding, straight from the
          engine. On a large model this takes a few seconds.
        </p>
        {err && <div className="vpa__err">{err}</div>}
        <button className="vpa__run" onClick={() => void run()} disabled={busy}>
          {busy ? <><Loader2 size={15} className="pbs-spin" /> Measuring…</> : <>Analyze storage</>}
        </button>
      </div>
    )
  }

  const s = summarize(report)
  const findings = analyzeStorage(report)
  const rowsByTable = new Map(report.tables.map((t) => [t.name, t.rows]))

  return (
    <div className="vpa pbs-scroll">
      {/* headline numbers */}
      <div className="vpa__summary">
        <div className="vpa__stat">
          <span className="vpa__statv">{formatBytes(s.modelSize)}</span>
          <span className="vpa__statl">Model size</span>
        </div>
        <div className="vpa__stat">
          <span className="vpa__statv">{s.tableCount}</span>
          <span className="vpa__statl">Tables</span>
        </div>
        <div className="vpa__stat">
          <span className="vpa__statv">{s.columnCount}</span>
          <span className="vpa__statl">Columns</span>
        </div>
        <div className="vpa__stat">
          <span className="vpa__statv">{formatPct(s.top10Share)}</span>
          <span className="vpa__statl">In the top 10 columns</span>
        </div>
        <button className="vpa__refresh" onClick={() => void run()} disabled={busy} title="Re-measure">
          {busy ? <Loader2 size={14} className="pbs-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {s.largestColumn && (
        <p className="vpa__lede">
          The largest single column is <strong>{s.largestColumn.table}[{s.largestColumn.column}]</strong> at{' '}
          {formatBytes(s.largestColumn.totalSize)} — {formatPct(s.largestColumn.totalSize / Math.max(s.modelSize, 1))} of
          the model, over {s.largestColumn.cardinality.toLocaleString()} distinct values.
        </p>
      )}

      <div className="vpa__tabs">
        <button className="vpa__tab" data-on={tab === 'findings'} onClick={() => setTab('findings')}>
          What to fix {findings.length > 0 && <em>{findings.length}</em>}
        </button>
        <button className="vpa__tab" data-on={tab === 'columns'} onClick={() => setTab('columns')}>
          Columns
        </button>
        <button className="vpa__tab" data-on={tab === 'tables'} onClick={() => setTab('tables')}>
          Tables
        </button>
      </div>

      {tab === 'findings' && (
        findings.length === 0 ? (
          <div className="vpa__clean">
            No storage problems found — no column dominates the model, and nothing near-unique is
            large enough to be worth removing.
          </div>
        ) : (
          <div className="vpa__findings">
            {findings.map((f) => (
              <div key={f.id} className="vpa__finding" data-sev={f.severity}>
                <div className="vpa__ftop">
                  <TriangleAlert size={14} />
                  <span className="vpa__ftitle">{f.title}</span>
                  <code className="vpa__ftarget">{f.target}</code>
                  <span className="vpa__fbytes">{formatBytes(f.bytes)}</span>
                </div>
                <p className="vpa__fdetail">{f.detail}</p>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'columns' && (
        <div className="vpa__tablewrap">
          <table className="vpa__table">
            <thead>
              <tr>
                <th>Column</th>
                <th className="vpa__num">Cardinality</th>
                <th className="vpa__num">Unique</th>
                <th>Encoding</th>
                <th className="vpa__num">Dictionary</th>
                <th className="vpa__num">Data</th>
                <th className="vpa__num">Total</th>
                <th className="vpa__num">% model</th>
              </tr>
            </thead>
            <tbody>
              {report.columnsList.slice(0, 200).map((c) => {
                const u = uniqueness(c, rowsByTable.get(c.table) ?? 0)
                return (
                  <tr key={`${c.table}.${c.column}`}>
                    <td>
                      <span className="vpa__ct">{c.table}</span>
                      <span className="vpa__cc">[{c.column}]</span>
                    </td>
                    <td className="vpa__num">{c.cardinality.toLocaleString()}</td>
                    <td className="vpa__num" data-hot={u >= 0.9 ? 'true' : undefined}>{formatPct(u)}</td>
                    <td><span className="vpa__enc" data-enc={c.encoding}>{c.encoding}</span></td>
                    <td className="vpa__num">{formatBytes(c.dictionarySize)}</td>
                    <td className="vpa__num">{formatBytes(c.dataSize)}</td>
                    <td className="vpa__num vpa__strong">{formatBytes(c.totalSize)}</td>
                    <td className="vpa__num">
                      <span className="vpa__bar"><i style={{ width: `${Math.min(100, (c.totalSize / Math.max(s.modelSize, 1)) * 100)}%` }} /></span>
                      {formatPct(c.totalSize / Math.max(s.modelSize, 1))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {report.columnsList.length > 200 && (
            <div className="vpa__cap">Showing the 200 largest of {report.columnsList.length} columns.</div>
          )}
        </div>
      )}

      {tab === 'tables' && (
        <div className="vpa__tablewrap">
          <table className="vpa__table">
            <thead>
              <tr>
                <th>Table</th>
                <th className="vpa__num">Rows</th>
                <th className="vpa__num">Columns</th>
                <th className="vpa__num">Size</th>
                <th className="vpa__num">% model</th>
              </tr>
            </thead>
            <tbody>
              {report.tables.map((t) => (
                <tr key={t.name}>
                  <td className="vpa__strong">{t.name}</td>
                  <td className="vpa__num">{t.rows.toLocaleString()}</td>
                  <td className="vpa__num">{t.columns}</td>
                  <td className="vpa__num vpa__strong">{formatBytes(t.totalSize)}</td>
                  <td className="vpa__num">
                    <span className="vpa__bar"><i style={{ width: `${Math.min(100, t.percentDb * 100)}%` }} /></span>
                    {formatPct(t.percentDb)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.relationships.length > 0 && (
            <div className="vpa__cap">
              {report.relationships.length} relationships hold {formatBytes(s.relationshipSize)}
              {report.relationships.some((r) => r.missingKeys) && ' — some have missing keys'}.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
