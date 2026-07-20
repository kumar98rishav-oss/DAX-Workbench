import {
  Download, X, FileCode2, FolderArchive, FileText, Palette, Braces, Terminal, Globe,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useApp } from '@/app/store'
import { IconButton } from '@/design-system/components'
import { pluginRegistry } from '@/app/plugins'
import { downloadBlob } from '@/infrastructure/export/download'
import './export.css'

const ICONS: Record<string, LucideIcon> = {
  FileCode2, FolderArchive, FileText, Palette, Braces, Terminal, Globe,
}

export function ExportDialog() {
  const open = useApp((s) => s.exportOpen)
  const toggle = useApp((s) => s.toggleExport)
  const model = useApp((s) => s.model)
  const report = useApp((s) => s.report)
  const datasets = useApp((s) => s.datasets)
  const projectName = useApp((s) => s.projectName)

  if (!open) return null

  const name = (projectName ?? model.name ?? 'DAXWorkbench').replace(/[^A-Za-z0-9_-]+/g, '_')
  const hasModel = model.tables.length > 0

  return (
    <div className="export__scrim" onMouseDown={(e) => e.target === e.currentTarget && toggle(false)}>
      <div className="export" role="dialog" aria-modal="true" aria-label="Export">
        <div className="export__head">
          <div>
            <div className="export__title">Export</div>
            <div className="export__sub">Open formats — no proprietary lock-in</div>
          </div>
          <IconButton label="Close" onClick={() => toggle(false)}>
            <X size={18} />
          </IconButton>
        </div>

        {!hasModel ? (
          <div className="export__empty">Import data first — then export to any format.</div>
        ) : (
          <div className="export__grid">
            {pluginRegistry.exporters.map((e) => {
              const Icon = ICONS[e.icon] ?? FileText
              return (
                <button
                  key={e.id}
                  className="export__item"
                  onClick={() => {
                    const { filename, blob } = e.run({ model, report, datasets, name })
                    downloadBlob(filename, blob)
                  }}
                >
                  <span className="export__icon"><Icon size={18} /></span>
                  <span className="export__item-body">
                    <span className="export__item-title">{e.name}</span>
                    <span className="export__item-desc">{e.description}</span>
                  </span>
                  <Download size={16} className="export__dl" />
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
