import { useMemo, useState } from 'react'
import { X, Factory, Check, Upload, Sparkles } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, IconButton } from '@/design-system/components'
import {
  SUITE_KINDS,
  MEASURE_SUITE_KINDS,
  buildSuite,
  buildSuiteForMeasure,
  suiteColumnsByTable,
  suiteMeasures,
  measureHomeTable,
  suitePlan,
  modelHasDate,
} from '@/application/dax/factory'
import type { SuiteMeasure } from '@/application/dax/factory'
import { desktopCreateMeasure, desktopEvaluateScalar } from '@/infrastructure/desktop/desktop-client'
import { buildDefineQuery, dependencyClosure, modelMeasures, defineHomeTable } from '@/application/dax/live-preview'
import '@/presentation/data/import-preview.css'
import './dax.css'

const fmt = (v?: number) => (v == null ? '—' : Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))

/** Build a whole analytical suite for one field, verify it, deploy it. */
export function MeasureFactoryDialog() {
  const open = useApp((s) => s.factoryOpen)
  const toggle = useApp((s) => s.toggleFactory)
  const model = useApp((s) => s.model)
  const datasets = useApp((s) => s.datasets)
  const commitMeasures = useApp((s) => s.commitMeasures)
  const desktop = useApp((s) => s.desktop)

  const columnsByTable = useMemo(() => suiteColumnsByTable(model), [model])
  const measures = useMemo(() => suiteMeasures(model), [model])
  const hasDate = useMemo(() => modelHasDate(model), [model])

  // Base is chosen by three linked pickers: a Table scopes the Column list; a
  // Measure (model-global) is the alternative base. Empty string = "not chosen",
  // resolved to a default at render — the dialog mounts before a model loads, so
  // a useState initializer would latch onto the empty startup model.
  const [table, setTable] = useState('')
  const [column, setColumn] = useState('')
  const [measure, setMeasure] = useState('')
  // null = "every kind this base supports".
  const [picked, setPicked] = useState<string[] | null>(null)
  const [suite, setSuite] = useState<SuiteMeasure[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  if (!open) return null

  const tableNames = columnsByTable.map((g) => g.table)
  const activeTable = table && tableNames.includes(table) ? table : tableNames[0] ?? ''
  const activeCols = columnsByTable.find((g) => g.table === activeTable)?.columns ?? []
  const activeColumn = column && activeCols.includes(column) ? column : activeCols[0] ?? ''
  const baseIsMeasure = measure !== '' && measures.some((m) => m.name === measure)
  const homeForMeasure = baseIsMeasure ? measureHomeTable(model, measure) : undefined

  const kinds = (baseIsMeasure ? MEASURE_SUITE_KINDS : SUITE_KINDS).filter((k) => !k.needsDate || hasDate)
  const sel = picked ?? kinds.map((k) => k.id)
  const canBuild = baseIsMeasure ? kinds.length > 0 : activeColumn !== ''

  // Changing the source resets the kind selection to "all" and clears the result.
  const resetSource = () => { setPicked(null); setSuite([]); setMsg(null) }
  const onTable = (v: string) => { setTable(v); setColumn(''); setMeasure(''); resetSource() }
  const onColumn = (v: string) => { setColumn(v); setMeasure(''); resetSource() }
  const onMeasure = (v: string) => { setMeasure(v); resetSource() }

  const build = () => {
    setMsg(null)
    const built = baseIsMeasure
      ? buildSuiteForMeasure(measure, model, sel)
      : buildSuite(activeColumn, model, datasets, sel, activeTable)
    setSuite(built)
    // Swap each row's sample number for the real engine's, sequentially so a
    // 12-measure suite doesn't hammer Desktop with parallel queries.
    if (desktop.connected) {
      const home = defineHomeTable(model)
      if (!home) return
      void (async () => {
        for (const m of built) {
          try {
            const pool = [...m.plan.map((st) => ({ name: st.name, dax: st.dax })), ...modelMeasures(model)]
            const chain = dependencyClosure(pool, m.name)
            const v = await desktopEvaluateScalar(buildDefineQuery(chain, m.name, home), desktop.port)
            if (typeof v === 'number') {
              setSuite((rows) => rows.map((r) => (r.name === m.name ? { ...r, preview: { ok: true, value: v }, live: true } : r)))
            }
          } catch { /* row keeps its sample value */ }
        }
      })()
    }
  }
  const toggleKind = (id: string) => setPicked(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id])
  const toggleRow = (name: string) => setSuite((s) => s.map((m) => (m.name === name ? { ...m, selected: !m.selected } : m)))

  const deploy = async () => {
    const steps = suitePlan(suite)
    if (steps.length === 0) return
    setBusy(true)
    setMsg(null)
    try {
      const last = steps[steps.length - 1]
      commitMeasures(steps, last.name)
      let pushed = 0
      if (desktop.connected) {
        // Land the suite on the table that owns the base — the field's table for a
        // column base, the measure's own home table for a measure base.
        const homeName = baseIsMeasure ? homeForMeasure : activeTable
        const home =
          (homeName ? model.tables.find((t) => t.name === homeName) : undefined) ??
          model.tables.find((t) => t.role === 'fact') ??
          model.tables[0]
        for (const st of steps) {
          const f = suite.find((m) => m.name === st.name)?.formatString
          await desktopCreateMeasure(home?.name ?? '', st.name, st.dax, f, 'Studio', desktop.port)
          pushed++
        }
      }
      setMsg({ ok: true, text: desktop.connected ? `Added ${steps.length} measures to the Workbench and deployed ${pushed} to Power BI Desktop.` : `Added ${steps.length} measures to the Workbench. Connect Desktop to deploy them.` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Deploy failed' })
    } finally {
      setBusy(false)
    }
  }

  const selectedCount = suite.filter((s) => s.selected).length
  const planCount = suitePlan(suite).length

  return (
    <div className="impdlg__scrim" onMouseDown={(e) => e.target === e.currentTarget && toggle(false)}>
      <div className="impdlg impdlg--wide" role="dialog" aria-modal="true" aria-label="Measure factory">
        <div className="impdlg__head">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Factory size={20} style={{ color: 'var(--accent)' }} />
            <div>
              <div className="impdlg__title">Measure factory</div>
              <div className="impdlg__sub">Build a whole suite for a field or an existing measure — verified, then deployed together.</div>
            </div>
          </div>
          <IconButton label="Close" onClick={() => toggle(false)}><X size={18} /></IconButton>
        </div>

        <div className="impdlg__body pbs-scroll">
          <div className="fct__row">
            <label className="dax-field">
              <span className="dax-field__label">Table</span>
              <select className="dax-select" value={activeTable} onChange={(e) => onTable(e.target.value)} disabled={tableNames.length === 0}>
                {tableNames.length === 0 && <option value="">no tables</option>}
                {tableNames.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="dax-field">
              <span className="dax-field__label">Column</span>
              <select className="dax-select" value={baseIsMeasure ? '' : activeColumn} onChange={(e) => onColumn(e.target.value)} disabled={activeCols.length === 0}>
                {baseIsMeasure && <option value="">— using a measure —</option>}
                {activeCols.length === 0 && !baseIsMeasure && <option value="">no numeric columns</option>}
                {activeCols.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="dax-field">
              <span className="dax-field__label">Measure</span>
              <select className="dax-select" value={measure} onChange={(e) => onMeasure(e.target.value)} disabled={measures.length === 0}>
                <option value="">— build from column —</option>
                {measures.map((m) => <option key={`${m.table}|${m.name}`} value={m.name}>{m.name}</option>)}
              </select>
            </label>
            <Button variant="primary" icon={<Sparkles size={15} />} onClick={build} disabled={!canBuild}>Build suite</Button>
          </div>

          <p className="fct__base">
            {baseIsMeasure ? (
              <>Building the time-intelligence family for measure <code>[{measure}]</code>{homeForMeasure && <> · lives on <code>{homeForMeasure}</code></>}</>
            ) : activeColumn ? (
              <>Building from <code>{activeTable}[{activeColumn}]</code> — <strong>{activeCols.length}</strong> numeric {activeCols.length === 1 ? 'column' : 'columns'} on this table.</>
            ) : (
              <>This table has no numeric column to build on — pick another table, or choose an existing measure.</>
            )}
          </p>

          <div className="fct__kinds">
            {kinds.map((k) => (
              <button key={k.id} className="fct__kind" data-on={sel.includes(k.id)} onClick={() => toggleKind(k.id)}>
                {sel.includes(k.id) && <Check size={12} />} {k.label}
              </button>
            ))}
          </div>

          {suite.length === 0 ? (
            <p className="fct__empty">Pick a base and press <strong>Build suite</strong> — each measure is generated with the same deterministic engine and previewed against the live model before you deploy.</p>
          ) : (
            suite.map((m) => (
              <div key={m.name} className="fct__item" data-on={m.selected} onClick={() => toggleRow(m.name)}>
                <span className="fct__check">{m.selected && <Check size={13} />}</span>
                <div className="fct__body">
                  <div className="fct__name">{m.name} <span className="fct__label">{m.label}</span></div>
                  <code className="fct__dax">{m.dax.replace(/\s+/g, ' ')}</code>
                </div>
                <span className={`fct__val${m.preview.ok ? '' : ' is-na'}`}>
                  {m.preview.ok ? fmt(m.preview.value) : 'preview n/a'}
                  {m.live && <em className="dax-badge dax-badge--live">live</em>}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="impdlg__foot">
          <span style={{ marginRight: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-subtle)' }}>
            {suite.length > 0 && <><strong style={{ color: 'var(--text)' }}>{selectedCount}</strong> selected · {planCount} measures incl. base steps</>}
          </span>
          {msg && <span style={{ fontSize: 'var(--text-sm)', color: msg.ok ? 'var(--success)' : 'var(--danger)', marginRight: 8 }}>{msg.text}</span>}
          <Button variant="ghost" onClick={() => toggle(false)}>Close</Button>
          <Button variant="primary" icon={<Upload size={15} />} onClick={() => void deploy()} disabled={busy || selectedCount === 0}>
            {desktop.connected ? 'Add + deploy to Desktop' : 'Add to Workbench'}
          </Button>
        </div>
      </div>
    </div>
  )
}
