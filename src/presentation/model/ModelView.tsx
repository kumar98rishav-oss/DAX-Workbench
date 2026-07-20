import { Share2, Wand2, Upload } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, EmptyState } from '@/design-system/components'
import { ModelGraph } from './ModelGraph'
import './model.css'

export function ModelView() {
  const tables = useApp((s) => s.model.tables)
  const relationships = useApp((s) => s.model.relationships)
  const runAutoModel = useApp((s) => s.runAutoModel)
  const requestImport = useApp((s) => s.requestImport)

  if (tables.length === 0) {
    return (
      <div className="modelview">
        <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
          <EmptyState
            icon={<Share2 size={26} />}
            title="No model yet"
            description="Import data and the Workbench will detect keys, relationships, and the fact/dimension structure automatically."
            action={
              <Button variant="primary" icon={<Upload size={16} />} onClick={requestImport}>
                Import data
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  const active = relationships.filter((r) => r.isActive).length
  const facts = tables.filter((t) => t.role === 'fact').length
  const dims = tables.filter((t) => t.role === 'dimension').length

  return (
    <div className="modelview">
      <div className="modelview__toolbar">
        <div className="modelview__stats">
          <span className="modelview__stat">
            <strong>{tables.length}</strong> tables
          </span>
          <span className="modelview__stat">
            <strong>{active}</strong> relationships
          </span>
          <span className="modelview__stat">
            <strong>{facts}</strong> facts · <strong>{dims}</strong> dimensions
          </span>
        </div>
        <div className="modelview__spacer" />
        <Button size="sm" icon={<Wand2 size={15} />} onClick={runAutoModel}>
          Re-run auto-model
        </Button>
      </div>
      <ModelGraph tables={tables} relationships={relationships} />
    </div>
  )
}
