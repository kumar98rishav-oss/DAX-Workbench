import { useMemo, useState } from 'react'
import { X, Stethoscope, Wrench, FileDown, AlertTriangle, Info } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, IconButton } from '@/design-system/components'
import { analyzeModel, modelDocs } from '@/application/dax/doctor'
import type { Finding } from '@/application/dax/doctor'
import { desktopCreateMeasure } from '@/infrastructure/desktop/desktop-client'
import '@/presentation/data/import-preview.css'
import './dax.css'

/** Best-practice analyzer over the real model, with one-click fixes + docs. */
export function ModelDoctorDialog() {
  const open = useApp((s) => s.doctorOpen)
  const toggle = useApp((s) => s.toggleDoctor)
  const model = useApp((s) => s.model)
  const updateMeasure = useApp((s) => s.updateMeasure)
  const desktop = useApp((s) => s.desktop)

  const [fixed, setFixed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const findings = useMemo(() => (open ? analyzeModel(model) : []), [open, model])
  if (!open) return null

  const measureOf = (name: string) => model.tables.flatMap((t) => t.measures.map((m) => ({ t, m }))).find((x) => x.m.name === name)

  const applyFix = async (f: Finding) => {
    if (!f.fix) return
    const hit = measureOf(f.measure)
    if (!hit) return
    setBusy(true)
    try {
      updateMeasure(hit.m.id, { ...(f.fix.formatString ? { formatString: f.fix.formatString } : {}), ...(f.fix.displayFolder ? { displayFolder: f.fix.displayFolder } : {}) })
      if (desktop.connected) {
        await desktopCreateMeasure(
          hit.t.name, hit.m.name, hit.m.expression,
          f.fix.formatString ?? hit.m.formatString,
          f.fix.displayFolder ?? hit.m.displayFolder,
          desktop.port,
        )
      }
      setFixed((s) => new Set(s).add(f.id))
      setMsg({ ok: true, text: `Fixed “${f.measure}”${desktop.connected ? ' (and updated Desktop)' : ''}.` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Fix failed' })
    } finally {
      setBusy(false)
    }
  }

  const fixAll = async () => {
    setBusy(true)
    let n = 0
    for (const f of findings.filter((x) => x.fix && !fixed.has(x.id))) {
      try { await applyFix(f); n++ } catch { /* keep going */ }
    }
    setBusy(false)
    setMsg({ ok: true, text: `Applied ${n} fixes${desktop.connected ? ' (Desktop updated)' : ''}.` })
  }

  const downloadDocs = () => {
    const blob = new Blob([modelDocs(model)], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${model.name || 'model'}-data-dictionary.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const fixable = findings.filter((f) => f.fix && !fixed.has(f.id)).length
  const warnings = findings.filter((f) => f.severity === 'warning').length

  return (
    <div className="impdlg__scrim" onMouseDown={(e) => e.target === e.currentTarget && toggle(false)}>
      <div className="impdlg impdlg--wide" role="dialog" aria-modal="true" aria-label="Model doctor">
        <div className="impdlg__head">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Stethoscope size={20} style={{ color: 'var(--accent)' }} />
            <div>
              <div className="impdlg__title">Model doctor</div>
              <div className="impdlg__sub">{findings.length} findings · {warnings} worth fixing · {fixable} auto-fixable</div>
            </div>
          </div>
          <IconButton label="Close" onClick={() => toggle(false)}><X size={18} /></IconButton>
        </div>

        <div className="impdlg__body pbs-scroll">
          {findings.length === 0 && <p className="fct__empty">No issues found — your measures are formatted, organised and blank-safe. 🎉</p>}
          {findings.map((f) => (
            <div key={f.id} className="doc__item" data-fixed={fixed.has(f.id)}>
              <span className={`doc__sev doc__sev--${f.severity}`}>
                {f.severity === 'info' ? <Info size={13} /> : <AlertTriangle size={13} />}
              </span>
              <div className="doc__body">
                <div className="doc__msg">{f.message}</div>
                <div className="doc__why">{f.why}</div>
                {f.suggestedDax && (
                  <details className="doc__fixdax">
                    <summary>Suggested rewrite</summary>
                    <code>{f.suggestedDax.replace(/\s+/g, ' ')}</code>
                  </details>
                )}
              </div>
              <span className="doc__rule">{f.rule}</span>
              {f.fix && (
                fixed.has(f.id)
                  ? <span className="doc__done">Fixed</span>
                  : <button className="srcrow__btn" disabled={busy} onClick={() => void applyFix(f)} title={f.fix.formatString ?? f.fix.displayFolder}>
                      <Wrench size={13} />{' '}
                      {!f.fix.formatString
                        ? 'Set folder'
                        // An inherited format can be a full 3-part pattern — too long for a button.
                        : f.fix.formatString.length > 16 ? 'Set format' : `Set ${f.fix.formatString}`}
                    </button>
              )}
            </div>
          ))}
        </div>

        <div className="impdlg__foot">
          {msg && <span style={{ marginRight: 'auto', fontSize: 'var(--text-sm)', color: msg.ok ? 'var(--success)' : 'var(--danger)' }}>{msg.text}</span>}
          <Button variant="ghost" icon={<FileDown size={15} />} onClick={downloadDocs}>Download docs</Button>
          <Button variant="primary" icon={<Wrench size={15} />} onClick={() => void fixAll()} disabled={busy || fixable === 0}>Fix all ({fixable})</Button>
        </div>
      </div>
    </div>
  )
}
