import { useMemo, useRef, useState } from 'react'
import { X, Database, FileSpreadsheet, Braces, Globe, HelpCircle, Check, Paperclip, RotateCcw, ClipboardPaste } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, IconButton } from '@/design-system/components'
import type { SourceKind } from '@/application/import/pbi/tmdl'
import './import-preview.css'

const KIND_ICON: Record<string, typeof Database> = {
  sql: Database,
  file: FileSpreadsheet,
  inline: Braces,
  web: Globe,
  other: HelpCircle,
}
const KIND_LABEL: Record<string, string> = {
  sql: 'SQL / database',
  file: 'File',
  inline: 'Inline',
  web: 'Web / API',
  other: 'Other',
}

/**
 * PBIP source review — shows the source the Studio detected for each table
 * (from its Power Query M) and lets the user attach / paste the real data for
 * tables whose source a browser can't reach (SQL, etc.) before importing.
 */
export function PbipSourceDialog() {
  const pending = useApp((s) => s.pendingPbip)
  const bindFile = useApp((s) => s.bindPbipTable)
  const bindCsv = useApp((s) => s.bindPbipTableCsv)
  const unbind = useApp((s) => s.unbindPbipTable)
  const commit = useApp((s) => s.commitPbip)
  const cancel = useApp((s) => s.cancelPbip)

  const [pasteFor, setPasteFor] = useState<string | null>(null)
  const [pasteText, setPasteText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [pickFor, setPickFor] = useState<string | null>(null)

  const rows = useMemo(() => {
    if (!pending) return []
    return pending.model.tables.map((t) => {
      const key = t.name.toLowerCase()
      const bound = pending.real[key]
      return {
        name: t.name,
        kind: (t.source?.kind ?? 'other') as SourceKind,
        detail: t.source?.detail ?? 'Unknown source',
        real: !!bound,
        rows: bound?.rowCount ?? 0,
        from: pending.boundFrom[key],
        external: (t.source?.kind ?? 'other') !== 'file' && (t.source?.kind ?? 'other') !== 'inline',
      }
    })
  }, [pending])

  if (!pending) return null

  const realCount = rows.filter((r) => r.real).length
  const total = rows.length

  const onPick = (tableName: string) => { setPickFor(tableName); fileRef.current?.click() }

  return (
    <div className="impdlg__scrim" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="impdlg impdlg--wide" role="dialog" aria-modal="true" aria-label="Confirm data sources">
        <div className="impdlg__head">
          <div>
            <div className="impdlg__title">Data sources — “{pending.model.name}”</div>
            <div className="impdlg__sub">Detected from the project’s Power Query. Attach a file for any source a browser can’t reach (SQL, etc.).</div>
          </div>
          <IconButton label="Cancel" onClick={cancel}><X size={18} /></IconButton>
        </div>

        <div className="impdlg__body pbs-scroll">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.parquet,.pqt"
            className="pbs-visually-hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f && pickFor) void bindFile(pickFor, f)
              setPickFor(null)
            }}
          />

          {rows.map((r) => {
            const Icon = KIND_ICON[r.kind] ?? HelpCircle
            return (
              <div key={r.name} className="srcrow" data-real={r.real}>
                <div className="srcrow__main">
                  <span className="srcrow__status" data-real={r.real} title={r.real ? 'Real data bound' : 'Sample data'}>
                    {r.real ? <Check size={13} /> : null}
                  </span>
                  <div className="srcrow__body">
                    <div className="srcrow__name">{r.name}</div>
                    <div className="srcrow__src">
                      <Icon size={12} /> <span className="srcrow__kind">{KIND_LABEL[r.kind]}</span>
                      <span className="srcrow__detail">· {r.detail}</span>
                    </div>
                  </div>
                </div>
                <div className="srcrow__state">
                  {r.real ? (
                    <span className="srcrow__badge srcrow__badge--real">
                      {r.rows.toLocaleString()} real rows{r.from ? ` · ${r.from}` : ''}
                    </span>
                  ) : (
                    <span className="srcrow__badge srcrow__badge--sample">{r.external ? 'Sample — needs data' : 'Sample'}</span>
                  )}
                </div>
                <div className="srcrow__actions">
                  {r.real ? (
                    <button className="srcrow__btn" onClick={() => unbind(r.name)} title="Remove — use sample instead"><RotateCcw size={13} /> Reset</button>
                  ) : (
                    <>
                      <button className="srcrow__btn" onClick={() => onPick(r.name)}><Paperclip size={13} /> Attach file</button>
                      <button className="srcrow__btn" onClick={() => { setPasteFor(pasteFor === r.name ? null : r.name); setPasteText('') }}><ClipboardPaste size={13} /> Paste CSV</button>
                    </>
                  )}
                </div>
                {pasteFor === r.name && (
                  <div className="srcrow__paste">
                    <textarea
                      className="srcrow__textarea"
                      placeholder={`Paste CSV for “${r.name}” (first row = headers)…`}
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                    />
                    <Button size="sm" variant="primary" onClick={() => { void bindCsv(r.name, pasteText); setPasteFor(null); setPasteText('') }}>Bind</Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="impdlg__foot">
          <span style={{ marginRight: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-subtle)' }}>
            <strong style={{ color: 'var(--text)' }}>{realCount}</strong> of {total} tables with real data · rest use sample
          </span>
          <Button variant="ghost" onClick={cancel}>Cancel</Button>
          <Button variant="primary" onClick={commit}>Import project</Button>
        </div>
      </div>
    </div>
  )
}
