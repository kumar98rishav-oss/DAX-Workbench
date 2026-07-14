import { useEffect, useState } from 'react'
import { X, Check, Table2, Info, Database, Share2, Sigma } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, IconButton } from '@/design-system/components'
import './import-preview.css'

type Mode = 'replace' | 'merge'

export function ImportPreviewDialog() {
  const pending = useApp((s) => s.pendingImport)
  const commit = useApp((s) => s.commitImport)
  const cancel = useApp((s) => s.cancelImport)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<Mode>('replace')

  useEffect(() => {
    if (pending) {
      setSelected(new Set(pending.tables.map((t) => t.id)))
      setMode('replace')
    }
  }, [pending])

  if (!pending) return null

  const hasCurrent = pending.currentTables > 0
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  const allOn = selected.size === pending.tables.length
  const toggleAll = () =>
    setSelected(allOn ? new Set() : new Set(pending.tables.map((t) => t.id)))

  return (
    <div className="impdlg__scrim" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="impdlg" role="dialog" aria-modal="true" aria-label="Confirm import">
        <div className="impdlg__head">
          <div>
            <div className="impdlg__title">Import data</div>
            <div className="impdlg__sub">{pending.fileNames.join(', ')}</div>
          </div>
          <IconButton label="Cancel" onClick={cancel}>
            <X size={18} />
          </IconButton>
        </div>

        <div className="impdlg__body pbs-scroll">
          <div className="impdlg__summary">
            <span className="impdlg__stat">
              <b>{pending.tables.length}</b>
              <span>{pending.tables.length === 1 ? 'table' : 'tables'} detected</span>
            </span>
            <span className="impdlg__stat">
              <b>{pending.relationships}</b>
              <span>{pending.relationships === 1 ? 'relationship' : 'relationships'} captured</span>
            </span>
          </div>

          {hasCurrent && (
            <div className="impdlg__notice">
              <Info size={16} style={{ flexShrink: 0, marginTop: 1, color: 'var(--accent)' }} />
              <span>
                {pending.isSampleData ? (
                  <>You currently have <strong>sample data{pending.templateName ? ` from “${pending.templateName}”` : ''}</strong>. </>
                ) : (
                  <>Your project has <strong>{pending.currentTables} table{pending.currentTables === 1 ? '' : 's'}</strong>. </>
                )}
                {pending.currentMeasures > 0 && (
                  <>
                    It also has <strong>{pending.currentMeasures} measure{pending.currentMeasures === 1 ? '' : 's'}</strong> —
                    the model and its measures are regenerated on import.
                  </>
                )}
              </span>
            </div>
          )}

          {hasCurrent && (
            <div className="impdlg__mode">
              <button className="impdlg__modeopt" data-on={mode === 'replace'} onClick={() => setMode('replace')}>
                <span className="impdlg__modeopt-title">Replace current data</span>
                <span className="impdlg__modeopt-desc">Discard existing tables, start fresh</span>
              </button>
              <button className="impdlg__modeopt" data-on={mode === 'merge'} onClick={() => setMode('merge')}>
                <span className="impdlg__modeopt-title">Add to current</span>
                <span className="impdlg__modeopt-desc">Keep existing tables, append new</span>
              </button>
            </div>
          )}

          <div className="impdlg__listhead">
            <span className="impdlg__listtitle">Tables to import</span>
            <button className="impdlg__selectall" onClick={toggleAll}>
              {allOn ? 'Deselect all' : 'Select all'}
            </button>
          </div>

          {pending.tables.map((t) => {
            const on = selected.has(t.id)
            const measureCols = t.data.columns.filter((c) => c.role === 'measureCandidate').length
            return (
              <button key={t.id} className="impdlg__table" data-on={on} onClick={() => toggle(t.id)}>
                <span className="impdlg__check">{on && <Check size={14} />}</span>
                <Table2 size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <span className="impdlg__table-body">
                  <span className="impdlg__table-name">{t.name}</span>
                  <span className="impdlg__table-meta">
                    {t.rowCount.toLocaleString()} rows · {t.columnCount} cols
                    {measureCols > 0 && ` · ${measureCols} measure-ready`}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="impdlg__foot">
          <span style={{ marginRight: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-subtle)', display: 'inline-flex', gap: 12 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Database size={13} /> {selected.size} selected</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Share2 size={13} /> {pending.relationships}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Sigma size={13} /> auto</span>
          </span>
          <Button variant="ghost" onClick={cancel}>Cancel</Button>
          <Button variant="primary" disabled={selected.size === 0} onClick={() => commit([...selected], mode)}>
            Import {selected.size} table{selected.size === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </div>
  )
}
