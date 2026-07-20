import { useMemo, useState } from 'react'
import { X, CalendarDays, Check, Copy, Upload, PlusSquare } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, IconButton } from '@/design-system/components'
import {
  DATE_COLUMNS,
  dateColumnCandidates,
  buildDateTableDax,
  sampleDateRows,
  buildDateTableCsv,
} from '@/application/dax/date-table'
import type { DateTableOptions } from '@/application/dax/date-table'
import { desktopCreateTable } from '@/infrastructure/desktop/desktop-client'
import '@/presentation/data/import-preview.css'
import './dax.css'

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Build a full date table: pick the range reference and the columns, preview
 * it, then deploy to Desktop (as a calculated table) and/or add to the Studio. */
export function DateTableDialog() {
  const open = useApp((s) => s.dateTableOpen)
  const toggle = useApp((s) => s.toggleDateTable)
  const model = useApp((s) => s.model)
  const datasets = useApp((s) => s.datasets)
  const desktop = useApp((s) => s.desktop)
  const importFiles = useApp((s) => s.importFiles)

  const candidates = useMemo(() => dateColumnCandidates(model), [model])

  const [name, setName] = useState('Date')
  const [sourceKey, setSourceKey] = useState<string>('') // 'Table|Column' or '__auto__'
  const [fiscalStart, setFiscalStart] = useState(1)
  const [columnIds, setColumnIds] = useState<string[]>(() => DATE_COLUMNS.map((c) => c.id).filter((id) => id !== 'fiscalYear'))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  if (!open) return null

  const activeKey = sourceKey || (candidates[0] ? `${candidates[0].table}|${candidates[0].column}` : '__auto__')
  const [srcTable, srcColumn] = activeKey === '__auto__' ? [undefined, undefined] : activeKey.split('|')
  const opts: DateTableOptions = {
    name: name.trim() || 'Date',
    source: activeKey === '__auto__' ? { kind: 'auto' } : { kind: 'column', table: srcTable, column: srcColumn },
    columnIds,
    fiscalStart,
  }
  const dax = buildDateTableDax(opts)
  const nameClash = model.tables.some((t) => t.name.toLowerCase() === opts.name.toLowerCase())

  // The reference column's real range, read from the synced rows — drives the
  // preview dates and the Studio-side CSV. Falls back to the current year.
  const range = ((): { min: Date; max: Date } => {
    const fallback = { min: new Date(new Date().getFullYear(), 0, 1), max: new Date(new Date().getFullYear(), 11, 31) }
    const scan = (tableName?: string, columnName?: string): { min: Date; max: Date } | null => {
      const table = model.tables.find((t) => (tableName ? t.name === tableName : t.columns.some((c) => c.dataType === 'date' || c.dataType === 'dateTime')))
      if (!table) return null
      const ds = datasets.find((d) => d.id === table.id)
      if (!ds) return null
      const colName = columnName ?? table.columns.find((c) => c.dataType === 'date' || c.dataType === 'dateTime')?.name
      const idx = ds.columns.findIndex((c) => c.name === colName)
      if (idx < 0) return null
      let lo = Infinity
      let hi = -Infinity
      for (const row of ds.rows) {
        const t = Date.parse(String(row[idx] ?? ''))
        if (!Number.isNaN(t)) { if (t < lo) lo = t; if (t > hi) hi = t }
      }
      return lo <= hi ? { min: new Date(lo), max: new Date(hi) } : null
    }
    return scan(srcTable, srcColumn) ?? fallback
  })()

  const preview = sampleDateRows(opts, [range.min, new Date(+range.min + Math.floor((+range.max - +range.min) / 2)), range.max])

  const toggleCol = (id: string) =>
    setColumnIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const copyDax = async () => {
    await navigator.clipboard.writeText(`${opts.name} =\n${dax}`)
    setMsg({ ok: true, text: 'DAX copied — paste it in Desktop via Modeling → New table.' })
  }

  const addToStudio = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const { csv, rowCount, capped } = buildDateTableCsv(opts, range.min, range.max)
      await importFiles([new File([csv], `${opts.name}.csv`, { type: 'text/csv' })])
      setMsg({ ok: true, text: `Added “${opts.name}” to the Workbench — ${rowCount.toLocaleString()} days${capped ? ' (capped at 40 years)' : ''}. Time intelligence is now available here too.` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Add failed' })
    } finally {
      setBusy(false)
    }
  }

  const deploy = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await desktopCreateTable(opts.name, dax, srcTable, srcColumn, desktop.port)
      setMsg({ ok: true, text: `${r.status === 'created' ? 'Created' : 'Updated'} calculated table “${r.table}” in Power BI Desktop.${r.note ? ` ${r.note}` : ''}` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Deploy failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="impdlg__scrim" onMouseDown={(e) => e.target === e.currentTarget && toggle(false)}>
      <div className="impdlg impdlg--wide" role="dialog" aria-modal="true" aria-label="Date table builder">
        <div className="impdlg__head">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <CalendarDays size={20} style={{ color: 'var(--accent)' }} />
            <div>
              <div className="impdlg__title">Date table</div>
              <div className="impdlg__sub">Pick the range reference and the columns — deploy as a calculated table.</div>
            </div>
          </div>
          <IconButton label="Close" onClick={() => toggle(false)}><X size={18} /></IconButton>
        </div>

        <div className="impdlg__body pbs-scroll">
          <div className="fct__row">
            <label className="dax-field" style={{ maxWidth: 180 }}>
              <span className="dax-field__label">Table name</span>
              <input className="dax-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="dax-field">
              <span className="dax-field__label">Date range from</span>
              <select className="dax-select" value={activeKey} onChange={(e) => setSourceKey(e.target.value)}>
                {candidates.map((c) => (
                  <option key={`${c.table}|${c.column}`} value={`${c.table}|${c.column}`}>
                    {c.table}[{c.column}]{c.isFact ? '  · fact' : ''}
                  </option>
                ))}
                <option value="__auto__">Automatic — every date in the model (CALENDARAUTO)</option>
              </select>
            </label>
            <label className="dax-field" style={{ maxWidth: 170 }}>
              <span className="dax-field__label">Fiscal year starts</span>
              <select className="dax-select" value={fiscalStart} onChange={(e) => setFiscalStart(Number(e.target.value))}>
                {MONTH_NAMES.map((m, i) => (
                  <option key={m} value={i + 1}>{m}{i === 0 ? ' (calendar)' : ''}</option>
                ))}
              </select>
            </label>
          </div>
          {nameClash && (
            <p className="dtt__warn">A table named “{opts.name}” already exists — deploying will update it if it's a calculated table, and refuse if it holds real data.</p>
          )}

          <div className="dax-field__label" style={{ marginBottom: 8 }}>Columns</div>
          <div className="fct__kinds">
            {DATE_COLUMNS.map((c) => (
              <button
                key={c.id}
                className="fct__kind"
                data-on={columnIds.includes(c.id)}
                onClick={() => toggleCol(c.id)}
                title={c.hint}
              >
                {columnIds.includes(c.id) && <Check size={12} />} {c.label}
              </button>
            ))}
          </div>

          <div className="dax-field__label" style={{ margin: '14px 0 6px' }}>
            Preview · {range.min.toLocaleDateString()} → {range.max.toLocaleDateString()}
          </div>
          <div className="dtt__preview pbs-scroll">
            <table>
              <thead><tr>{preview.headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i}>{r.map((v, j) => <td key={j}>{String(v)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="dax-field__label" style={{ margin: '14px 0 6px' }}>Generated DAX</div>
          <pre className="dtt__dax pbs-scroll">{opts.name} ={'\n'}{dax}</pre>
        </div>

        <div className="impdlg__foot">
          {msg && <span style={{ marginRight: 'auto', fontSize: 'var(--text-sm)', color: msg.ok ? 'var(--success)' : 'var(--danger)' }}>{msg.text}</span>}
          <Button variant="ghost" icon={<Copy size={15} />} onClick={() => void copyDax()}>Copy DAX</Button>
          <Button variant="ghost" icon={<PlusSquare size={15} />} onClick={() => void addToStudio()} disabled={busy}>Add to Workbench</Button>
          <Button variant="primary" icon={<Upload size={15} />} onClick={() => void deploy()} disabled={busy || !desktop.connected}>
            {desktop.connected ? 'Deploy to Desktop' : 'Desktop not connected'}
          </Button>
        </div>
      </div>
    </div>
  )
}
