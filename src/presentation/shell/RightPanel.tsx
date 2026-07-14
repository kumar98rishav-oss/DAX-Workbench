import { Sparkles, Wand2, Trash2 } from 'lucide-react'
import { useApp } from '@/app/store'
import { Badge, Button, Card } from '@/design-system/components'
import type { Rect, Visual } from '@/domain/report'
import type { VisualSpec } from '@/application/insights/dashboard-generator'

export function RightPanel() {
  const collapsed = !useApp((s) => s.panels.right)
  const mode = useApp((s) => s.mode)
  const selectedId = useApp((s) => s.selectedVisualId)
  const report = useApp((s) => s.report)
  const generateDashboard = useApp((s) => s.generateDashboard)

  const page = report.pages.find((p) => p.id === report.activePageId) ?? report.pages[0]
  const selected = mode === 'design' && selectedId ? page?.visuals.find((v) => v.id === selectedId) : undefined

  return (
    <aside className="pbs-side pbs-side--right" data-collapsed={collapsed}>
      <div className="pbs-side__header">
        <span className="pbs-side__title">{selected ? 'Visual' : 'Properties'}</span>
      </div>

      <div className="pbs-side__body pbs-scroll">
        {selected ? <VisualProps visual={selected} /> : <PageProps generate={generateDashboard} />}
      </div>
    </aside>
  )
}

function VisualProps({ visual }: { visual: Visual }) {
  const beginChange = useApp((s) => s.beginChange)
  const updateVisual = useApp((s) => s.updateVisual)
  const setVisualRect = useApp((s) => s.setVisualRect)
  const deleteVisual = useApp((s) => s.deleteVisual)

  const spec = (visual.style as { spec?: VisualSpec } | undefined)?.spec
  const setRect = (patch: Partial<Rect>) => setVisualRect(visual.id, { ...visual.rect, ...patch })

  return (
    <>
      <div className="pbs-prop-section">
        <div className="pbs-prop-section__title">Visual</div>
        <div className="pbs-prop-row">
          <span className="pbs-prop-row__label">Type</span>
          <Badge variant="accent">{visual.kind}</Badge>
        </div>
        <label className="pbs-field">
          <span className="pbs-field__label">Title</span>
          <input
            className="pbs-input"
            value={visual.title ?? ''}
            onFocus={beginChange}
            onChange={(e) => updateVisual(visual.id, { title: e.target.value })}
          />
        </label>
      </div>

      <div className="pbs-prop-section">
        <div className="pbs-prop-section__title">Layout</div>
        <div className="pbs-field-grid">
          <NumField label="X" value={visual.rect.x} onBegin={beginChange} onChange={(x) => setRect({ x })} />
          <NumField label="Y" value={visual.rect.y} onBegin={beginChange} onChange={(y) => setRect({ y })} />
          <NumField label="W" value={visual.rect.w} onBegin={beginChange} onChange={(w) => setRect({ w })} />
          <NumField label="H" value={visual.rect.h} onBegin={beginChange} onChange={(h) => setRect({ h })} />
        </div>
      </div>

      {spec && (
        <div className="pbs-prop-section">
          <div className="pbs-prop-section__title">Data</div>
          {'measure' in spec && (
            <div className="pbs-prop-row">
              <span className="pbs-prop-row__label">Measure</span>
              <span className="pbs-prop-row__value">{spec.measure.name}</span>
            </div>
          )}
          {'category' in spec && (
            <div className="pbs-prop-row">
              <span className="pbs-prop-row__label">Group by</span>
              <span className="pbs-prop-row__value">{spec.category.name}</span>
            </div>
          )}
        </div>
      )}

      <div className="pbs-prop-section" style={{ borderBottom: 'none' }}>
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={15} />}
          onClick={() => deleteVisual(visual.id)}
          style={{ color: 'var(--danger)', width: '100%' }}
        >
          Delete visual
        </Button>
      </div>
    </>
  )
}

function NumField({
  label,
  value,
  onBegin,
  onChange,
}: {
  label: string
  value: number
  onBegin: () => void
  onChange: (v: number) => void
}) {
  return (
    <label className="pbs-field">
      <span className="pbs-field__label">{label}</span>
      <input
        className="pbs-input"
        type="number"
        value={Math.round(value)}
        onFocus={onBegin}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </label>
  )
}

function PageProps({ generate }: { generate: () => void }) {
  return (
    <>
      <div className="pbs-prop-section">
        <div className="pbs-prop-section__title">Page</div>
        <div className="pbs-prop-row">
          <span className="pbs-prop-row__label">Name</span>
          <span className="pbs-prop-row__value">Executive Overview</span>
        </div>
        <div className="pbs-prop-row">
          <span className="pbs-prop-row__label">Canvas</span>
          <span className="pbs-prop-row__value">16 : 9</span>
        </div>
      </div>

      <div className="pbs-prop-section" style={{ borderBottom: 'none' }}>
        <div className="pbs-prop-section__title">Assistant</div>
        <Card style={{ margin: '0 8px', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={16} style={{ color: 'var(--accent)' }} />
            <Badge variant="accent">Suggestion</Badge>
          </div>
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--text)', lineHeight: 'var(--leading-normal)' }}>
            Select a visual to edit it, or regenerate the whole dashboard from your model.
          </p>
          <Button variant="subtle" size="sm" icon={<Wand2 size={15} />} onClick={generate}>
            Generate dashboard
          </Button>
        </Card>
      </div>
    </>
  )
}
