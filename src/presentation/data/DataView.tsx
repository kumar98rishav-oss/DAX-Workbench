import { Upload, Table2 } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button } from '@/design-system/components'
import { DataGrid } from './DataGrid'
import { DropZone } from './DropZone'
import './data.css'

export function DataView() {
  const datasets = useApp((s) => s.datasets)
  const activeId = useApp((s) => s.activeDatasetId)
  const setActive = useApp((s) => s.setActiveDataset)
  const requestImport = useApp((s) => s.requestImport)

  if (datasets.length === 0) {
    return (
      <div className="dataview">
        <DropZone />
      </div>
    )
  }

  const active = datasets.find((d) => d.id === activeId) ?? datasets[0]

  return (
    <div className="dataview">
      <div className="dataview__toolbar">
        <div className="dataview__tabs" role="tablist" aria-label="Datasets">
          {datasets.map((d) => (
            <button
              key={d.id}
              role="tab"
              aria-selected={d.id === active.id}
              className="dataview__tab"
              data-active={d.id === active.id ? 'true' : undefined}
              onClick={() => setActive(d.id)}
            >
              <Table2 size={14} />
              {d.name}
            </button>
          ))}
        </div>
        <span className="dataview__meta">
          {active.rowCount.toLocaleString()} rows · {active.columns.length} columns
        </span>
        <Button size="sm" icon={<Upload size={15} />} onClick={requestImport}>
          Import
        </Button>
      </div>
      <DataGrid columns={active.columns} rows={active.rows} />
    </div>
  )
}
