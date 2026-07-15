import { X, FolderOpen, Upload, FileWarning } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, IconButton } from '@/design-system/components'
import './import-preview.css'

/**
 * Shown when a .pbix carries only a binary (XPress9) data model we can't read.
 * Turns the dead-end into the two paths that actually work.
 */
export function PbixFallbackDialog() {
  const fallback = useApp((s) => s.pbixFallback)
  const dismiss = useApp((s) => s.dismissPbixFallback)
  const requestOpenPbip = useApp((s) => s.requestOpenPbip)
  const requestImport = useApp((s) => s.requestImport)

  if (!fallback) return null

  const openPbip = () => {
    dismiss()
    requestOpenPbip()
  }
  const importData = () => {
    dismiss()
    requestImport()
  }

  return (
    <div className="impdlg__scrim" onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
      <div className="impdlg impdlg--sm" role="dialog" aria-modal="true" aria-label="PBIX import">
        <div className="impdlg__head">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <FileWarning size={20} style={{ color: 'var(--warning, #d97706)' }} />
            <div>
              <div className="impdlg__title">Couldn’t read this .pbix</div>
              <div className="impdlg__sub">{fallback.pages > 0 ? `${fallback.pages} report page${fallback.pages === 1 ? '' : 's'} found` : 'Best-effort import'}</div>
            </div>
          </div>
          <IconButton label="Close" onClick={dismiss}>
            <X size={18} />
          </IconButton>
        </div>

        <div className="impdlg__body pbs-scroll">
          <p className="pbixfb__msg">{fallback.message}</p>

          <div className="pbixfb__choices">
            <button className="pbixfb__choice" onClick={openPbip}>
              <FolderOpen size={20} />
              <span className="pbixfb__choice-title">Open the .pbip project folder</span>
              <span className="pbixfb__choice-desc">Full import — tables, relationships &amp; measures. Recommended.</span>
            </button>
            <button className="pbixfb__choice" onClick={importData}>
              <Upload size={20} />
              <span className="pbixfb__choice-title">Import the data instead</span>
              <span className="pbixfb__choice-desc">Load the underlying Excel / CSV / Parquet to build fresh.</span>
            </button>
          </div>
        </div>

        <div className="impdlg__foot">
          <Button variant="ghost" onClick={dismiss} style={{ marginLeft: 'auto' }}>Cancel</Button>
          <Button variant="primary" icon={<FolderOpen size={15} />} onClick={openPbip}>Open PBIP</Button>
        </div>
      </div>
    </div>
  )
}
