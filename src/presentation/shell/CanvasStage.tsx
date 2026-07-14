import { useMemo, useState } from 'react'
import {
  Sparkles,
  LayoutDashboard,
  LayoutTemplate,
  Upload,
  RefreshCw,
  Undo2,
  Redo2,
  Plus,
  Copy,
  Trash2,
  BarChart3,
  BarChartHorizontal,
  LineChart,
  AreaChart,
  PieChart,
  CircleDot,
  Filter,
  Gauge,
  TrendingUp,
  Grid3x3,
  ScatterChart,
  Table as TableIcon,
  Rows3,
  SlidersHorizontal,
  Hash,
} from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, IconButton } from '@/design-system/components'
import { makeCtx } from '@/application/query/query-engine'
import { buildVisual } from '@/application/insights/dashboard-generator'
import type { InsertKind } from '@/application/insights/dashboard-generator'
import { PageCanvas } from '@/presentation/design/PageCanvas'

const INSERTS: { kind: InsertKind; label: string; icon: typeof Hash }[] = [
  { kind: 'card', label: 'KPI Card', icon: Hash },
  { kind: 'multiRowCard', label: 'Multi-row card', icon: Rows3 },
  { kind: 'column', label: 'Column chart', icon: BarChart3 },
  { kind: 'bar', label: 'Bar chart', icon: BarChartHorizontal },
  { kind: 'line', label: 'Line chart', icon: LineChart },
  { kind: 'area', label: 'Area chart', icon: AreaChart },
  { kind: 'donut', label: 'Donut', icon: PieChart },
  { kind: 'pie', label: 'Pie', icon: CircleDot },
  { kind: 'funnel', label: 'Funnel', icon: Filter },
  { kind: 'gauge', label: 'Gauge', icon: Gauge },
  { kind: 'waterfall', label: 'Waterfall', icon: TrendingUp },
  { kind: 'treemap', label: 'Treemap', icon: Grid3x3 },
  { kind: 'scatter', label: 'Scatter', icon: ScatterChart },
  { kind: 'table', label: 'Table', icon: TableIcon },
  { kind: 'matrix', label: 'Matrix', icon: Grid3x3 },
  { kind: 'slicer', label: 'Slicer', icon: SlidersHorizontal },
]

export function CanvasStage() {
  const model = useApp((s) => s.model)
  const report = useApp((s) => s.report)
  const datasets = useApp((s) => s.datasets)
  const generate = useApp((s) => s.generateDashboard)
  const requestImport = useApp((s) => s.requestImport)
  const openLayouts = useApp((s) => s.toggleLayoutChooser)
  const selectedId = useApp((s) => s.selectedVisualId)
  const past = useApp((s) => s.past.length)
  const future = useApp((s) => s.future.length)
  const undo = useApp((s) => s.undo)
  const redo = useApp((s) => s.redo)
  const addVisual = useApp((s) => s.addVisual)
  const duplicateVisual = useApp((s) => s.duplicateVisual)
  const deleteVisual = useApp((s) => s.deleteVisual)
  const [addOpen, setAddOpen] = useState(false)

  const ctx = useMemo(() => makeCtx(model, datasets), [model, datasets])
  const page = report.pages.find((p) => p.id === report.activePageId) ?? report.pages[0]
  const hasDashboard = !!page && page.visuals.length > 0

  if (!hasDashboard) {
    return (
      <div className="pbs-canvas">
        {datasets.length === 0 ? (
          <EmptyStateBlock
            icon={<LayoutDashboard size={26} />}
            title="Design first"
            description="Import data and Studio auto-generates a dashboard — KPIs, charts, and layout — in one step."
            button={
              <Button variant="primary" icon={<Upload size={16} />} onClick={requestImport}>
                Import data
              </Button>
            }
          />
        ) : (
          <EmptyStateBlock
            icon={<Sparkles size={26} />}
            title="Generate your dashboard"
            description="Studio detects KPIs and recommends visuals from your model, then lays them out automatically."
            button={
              <Button variant="primary" icon={<Sparkles size={16} />} onClick={generate}>
                Generate dashboard
              </Button>
            }
          />
        )}
      </div>
    )
  }

  const insert = (kind: InsertKind) => {
    setAddOpen(false)
    const v = buildVisual(model, kind)
    if (v) addVisual(v)
  }

  return (
    <div className="design-mode">
      <div className="design-toolbar">
        <span className="design-toolbar__page">
          <LayoutDashboard size={16} />
          {page.name}
        </span>
        <span className="design-toolbar__meta">{page.visuals.length} visuals</span>

        <span className="design-toolbar__spacer" />

        <IconButton label="Undo" onClick={undo} disabled={past === 0}>
          <Undo2 size={17} />
        </IconButton>
        <IconButton label="Redo" onClick={redo} disabled={future === 0}>
          <Redo2 size={17} />
        </IconButton>

        <div className="design-add">
          <Button size="sm" icon={<Plus size={15} />} onClick={() => setAddOpen((o) => !o)}>
            Add visual
          </Button>
          {addOpen && (
            <>
              <div className="design-add__backdrop" onClick={() => setAddOpen(false)} />
              <div className="design-add__menu">
                {INSERTS.map((it) => {
                  const Icon = it.icon
                  return (
                    <button key={it.kind} className="design-add__item" onClick={() => insert(it.kind)}>
                      <Icon size={15} />
                      {it.label}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>

        <IconButton label="Duplicate" onClick={() => selectedId && duplicateVisual(selectedId)} disabled={!selectedId}>
          <Copy size={16} />
        </IconButton>
        <IconButton label="Delete" onClick={() => selectedId && deleteVisual(selectedId)} disabled={!selectedId}>
          <Trash2 size={16} />
        </IconButton>

        <span className="pbs-topbar__divider" />
        <Button size="sm" variant="secondary" icon={<LayoutTemplate size={14} />} onClick={() => openLayouts(true)}>
          Layouts
        </Button>
        <Button size="sm" icon={<RefreshCw size={14} />} onClick={generate}>
          Regenerate
        </Button>
      </div>
      <PageCanvas page={page} ctx={ctx} />
    </div>
  )
}

function EmptyStateBlock({
  icon,
  title,
  description,
  button,
}: {
  icon: React.ReactNode
  title: string
  description: string
  button: React.ReactNode
}) {
  return (
    <div className="pbs-empty">
      <div className="pbs-empty__icon">{icon}</div>
      <div className="pbs-empty__title">{title}</div>
      <p className="pbs-empty__desc">{description}</p>
      {button}
    </div>
  )
}
