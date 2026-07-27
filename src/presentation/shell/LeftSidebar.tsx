import type { ReactNode } from 'react'
import {
  Database,
  Table2,
  Plus,
  Sigma,
  Upload,
} from 'lucide-react'
import { useApp } from '@/app/store'
import { IconButton } from '@/design-system/components'

export function LeftSidebar() {
  const collapsed = !useApp((s) => s.panels.left)
  const datasets = useApp((s) => s.datasets)
  const activeDatasetId = useApp((s) => s.activeDatasetId)
  const mode = useApp((s) => s.mode)
  const setActiveDataset = useApp((s) => s.setActiveDataset)
  const requestImport = useApp((s) => s.requestImport)
  const measures = datasets.flatMap((d) =>
    d.columns.filter((c) => c.role === 'measureCandidate').map((c) => ({ ds: d.name, name: c.name })),
  )

  return (
    <aside className="pbs-side pbs-side--left" data-collapsed={collapsed}>
      <div className="pbs-side__header">
        <span className="pbs-side__title">Assets</span>
        <IconButton label="Import data" size="sm" onClick={requestImport}>
          <Plus size={16} />
        </IconButton>
      </div>

      <div className="pbs-side__body pbs-scroll">
        <NavGroup label="Data" icon={<Database size={13} />}>
          {datasets.length === 0 ? (
            <button className="pbs-navitem" onClick={requestImport}>
              <span className="pbs-navitem__icon">
                <Upload size={16} />
              </span>
              <span className="pbs-navitem__label" style={{ color: 'var(--text-subtle)' }}>
                Import data…
              </span>
            </button>
          ) : (
            datasets.map((d) => (
              <button
                key={d.id}
                className="pbs-navitem"
                data-active={mode === 'data' && d.id === activeDatasetId ? 'true' : undefined}
                onClick={() => setActiveDataset(d.id)}
              >
                <span className="pbs-navitem__icon">
                  <Table2 size={16} />
                </span>
                <span className="pbs-navitem__label">{d.name}</span>
                <span className="pbs-navitem__count">{d.columns.length}</span>
              </button>
            ))
          )}
        </NavGroup>

        {measures.length > 0 && (
          <NavGroup label="Measures" icon={<Sigma size={13} />}>
            {measures.slice(0, 8).map((m) => (
              <div key={`${m.ds}-${m.name}`} className="pbs-navitem">
                <span className="pbs-navitem__icon">
                  <Sigma size={16} />
                </span>
                <span className="pbs-navitem__label">{m.name}</span>
              </div>
            ))}
          </NavGroup>
        )}

      </div>
    </aside>
  )
}

function NavGroup({
  label,
  icon,
  children,
}: {
  label: string
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <div className="pbs-navgroup">
      <div className="pbs-navgroup__label">
        {icon}
        {label}
      </div>
      {children}
    </div>
  )
}
