import { useMemo, useState } from 'react'
import { X, Factory, Check, Upload, Sparkles } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, IconButton } from '@/design-system/components'
import { SUITE_KINDS, buildSuite, suiteFields, suitePlan, modelHasDate } from '@/application/dax/factory'
import type { SuiteMeasure } from '@/application/dax/factory'
import { desktopCreateMeasure } from '@/infrastructure/desktop/desktop-client'
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

  const fields = useMemo(() => suiteFields(model), [model])
  const hasDate = useMemo(() => modelHasDate(model), [model])
  const kinds = useMemo(() => SUITE_KINDS.filter((k) => !k.needsDate || hasDate), [hasDate])

  const [field, setField] = useState('')
  // null = "every kind this model supports". The dialog is mounted before a model
  // is loaded, so a useState initializer would latch onto the empty startup model
  // and permanently drop the time-intelligence kinds.
  const [picked, setPicked] = useState<string[] | null>(null)
  const [suite, setSuite] = useState<SuiteMeasure[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  if (!open) return null
  const activeField = field || fields[0] || ''
  const sel = picked ?? kinds.map((k) => k.id)

  const build = () => {
    setMsg(null)
    setSuite(buildSuite(activeField, model, datasets, sel))
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
        // Land the suite on the table that owns the field, not just the first fact.
        const home =
          model.tables.find((t) => t.columns.some((c) => c.name === activeField)) ??
          model.tables.find((t) => t.role === 'fact') ??
          model.tables[0]
        for (const st of steps) {
          const f = suite.find((m) => m.name === st.name)?.formatString
          await desktopCreateMeasure(home?.name ?? '', st.name, st.dax, f, 'Studio', desktop.port)
          pushed++
        }
      }
      setMsg({ ok: true, text: desktop.connected ? `Added ${steps.length} measures to the Studio and deployed ${pushed} to Power BI Desktop.` : `Added ${steps.length} measures to the Studio. Connect Desktop to deploy them.` })
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
              <div className="impdlg__sub">Build a whole suite for one field — verified, then deployed together.</div>
            </div>
          </div>
          <IconButton label="Close" onClick={() => toggle(false)}><X size={18} /></IconButton>
        </div>

        <div className="impdlg__body pbs-scroll">
          <div className="fct__row">
            <label className="dax-field" style={{ maxWidth: 260 }}>
              <span className="dax-field__label">Field</span>
              <select className="dax-select" value={activeField} onChange={(e) => { setField(e.target.value); setSuite([]) }}>
                {fields.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <Button variant="primary" icon={<Sparkles size={15} />} onClick={build} disabled={!activeField}>Build suite</Button>
          </div>

          <div className="fct__kinds">
            {kinds.map((k) => (
              <button key={k.id} className="fct__kind" data-on={sel.includes(k.id)} onClick={() => toggleKind(k.id)}>
                {sel.includes(k.id) && <Check size={12} />} {k.label}
              </button>
            ))}
          </div>

          {suite.length === 0 ? (
            <p className="fct__empty">Pick a field and press <strong>Build suite</strong> — each measure is generated with the same deterministic engine and previewed before you deploy.</p>
          ) : (
            suite.map((m) => (
              <div key={m.name} className="fct__item" data-on={m.selected} onClick={() => toggleRow(m.name)}>
                <span className="fct__check">{m.selected && <Check size={13} />}</span>
                <div className="fct__body">
                  <div className="fct__name">{m.name} <span className="fct__label">{m.label}</span></div>
                  <code className="fct__dax">{m.dax.replace(/\s+/g, ' ')}</code>
                </div>
                <span className={`fct__val${m.preview.ok ? '' : ' is-na'}`}>{m.preview.ok ? fmt(m.preview.value) : 'preview n/a'}</span>
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
            {desktop.connected ? 'Add + deploy to Desktop' : 'Add to Studio'}
          </Button>
        </div>
      </div>
    </div>
  )
}
