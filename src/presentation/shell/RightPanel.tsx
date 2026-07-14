import { useMemo } from 'react'
import { Sparkles, Wand2, Trash2 } from 'lucide-react'
import { useApp } from '@/app/store'
import { Badge, Button, Card } from '@/design-system/components'
import type { Rect, Visual } from '@/domain/report'
import {
  measureCatalog,
  categoryCatalog,
} from '@/application/insights/dashboard-generator'
import type {
  VisualSpec,
  MeasureOption,
  CategoryOption,
  CategorySpec,
} from '@/application/insights/dashboard-generator'

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
          <DataBindings visual={visual} spec={spec} />
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

// --- data bindings: pick which measure / category each visual field shows ---

const catKey = (c: CategorySpec) => (c.bucket ? `${c.tableId}:${c.columnId}:${c.bucket}` : `${c.tableId}:${c.columnId}`)

/** Headline binding name — used to keep the title in sync when it mirrors it. */
function primaryName(spec: VisualSpec): string {
  switch (spec.type) {
    case 'card':
    case 'series':
    case 'rank':
      return spec.measure.name
    case 'multi':
    case 'matrix':
      return spec.measures[0]?.name ?? ''
    case 'scatter':
      return spec.x.name
    case 'combo':
      return spec.bar.name
    case 'slicer':
      return spec.category.name
    case 'text':
      return spec.title
  }
}

function DataBindings({ visual, spec }: { visual: Visual; spec: VisualSpec }) {
  const model = useApp((s) => s.model)
  const setVisualSpec = useApp((s) => s.setVisualSpec)

  const allMeasures = useMemo(() => measureCatalog(model), [model])
  const groupable = useMemo(() => allMeasures.filter((m) => m.groupable), [allMeasures])
  const categories = useMemo(() => categoryCatalog(model), [model])

  const apply = (next: VisualSpec) => {
    const title = visual.title === primaryName(spec) ? primaryName(next) : undefined
    setVisualSpec(visual.id, next, title)
  }

  switch (spec.type) {
    case 'card':
      return (
        <MeasurePicker label="Measure" value={spec.measure.name} options={allMeasures} onPick={(o) => apply({ ...spec, measure: o.spec })} />
      )

    case 'multi':
      return (
        <>
          {spec.measures.map((m, i) => (
            <MeasurePicker
              key={i}
              label={`Measure ${i + 1}`}
              value={m.name}
              options={allMeasures}
              onPick={(o) => apply({ ...spec, measures: spec.measures.map((x, j) => (j === i ? o.spec : x)) })}
            />
          ))}
        </>
      )

    case 'series':
    case 'rank':
      return (
        <>
          <MeasurePicker label="Measure" value={spec.measure.name} options={groupable} onPick={(o) => apply({ ...spec, measure: o.spec })} />
          <CategoryPicker label="Group by" value={catKey(spec.category)} options={categories} onPick={(o) => apply({ ...spec, category: o.spec })} />
        </>
      )

    case 'matrix':
      return (
        <>
          <CategoryPicker label="Rows" value={catKey(spec.category)} options={categories} onPick={(o) => apply({ ...spec, category: o.spec })} />
          {spec.measures.map((m, i) => (
            <MeasurePicker
              key={i}
              label={`Value ${i + 1}`}
              value={m.name}
              options={groupable}
              onPick={(o) => apply({ ...spec, measures: spec.measures.map((x, j) => (j === i ? o.spec : x)) })}
            />
          ))}
        </>
      )

    case 'scatter':
      return (
        <>
          <MeasurePicker label="X axis" value={spec.x.name} options={groupable} onPick={(o) => apply({ ...spec, x: o.spec })} />
          <MeasurePicker label="Y axis" value={spec.y.name} options={groupable} onPick={(o) => apply({ ...spec, y: o.spec })} />
          <CategoryPicker label="Points" value={catKey(spec.category)} options={categories} onPick={(o) => apply({ ...spec, category: o.spec })} />
        </>
      )

    case 'combo':
      return (
        <>
          <MeasurePicker label="Bars" value={spec.bar.name} options={groupable} onPick={(o) => apply({ ...spec, bar: o.spec })} />
          <MeasurePicker label="Line" value={spec.line.name} options={groupable} onPick={(o) => apply({ ...spec, line: o.spec })} />
          <CategoryPicker label="Group by" value={catKey(spec.category)} options={categories} onPick={(o) => apply({ ...spec, category: o.spec })} />
        </>
      )

    case 'slicer':
      return (
        <CategoryPicker label="Field" value={catKey(spec.category)} options={categories} onPick={(o) => apply({ ...spec, category: o.spec })} />
      )

    case 'text':
      return <div className="pbs-prop-row"><span className="pbs-prop-row__value">Text visual</span></div>
  }
}

function MeasurePicker({
  label,
  value,
  options,
  onPick,
}: {
  label: string
  value: string
  options: MeasureOption[]
  onPick: (o: MeasureOption) => void
}) {
  const known = options.some((o) => o.name === value)
  const aggs = options.filter((o) => o.groupable)
  const dax = options.filter((o) => !o.groupable)
  return (
    <label className="pbs-field">
      <span className="pbs-field__label">{label}</span>
      <select
        className="pbs-select"
        value={value}
        onChange={(e) => {
          const o = options.find((x) => x.name === e.target.value)
          if (o) onPick(o)
        }}
      >
        {!known && <option value={value}>{value}</option>}
        {aggs.length > 0 && (
          <optgroup label="Aggregations">
            {aggs.map((o) => (
              <option key={o.name} value={o.name}>{o.name}</option>
            ))}
          </optgroup>
        )}
        {dax.length > 0 && (
          <optgroup label="DAX measures">
            {dax.map((o) => (
              <option key={o.name} value={o.name}>{o.name}</option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  )
}

function CategoryPicker({
  label,
  value,
  options,
  onPick,
}: {
  label: string
  value: string
  options: CategoryOption[]
  onPick: (o: CategoryOption) => void
}) {
  const known = options.some((o) => o.key === value)
  return (
    <label className="pbs-field">
      <span className="pbs-field__label">{label}</span>
      <select
        className="pbs-select"
        value={value}
        onChange={(e) => {
          const o = options.find((x) => x.key === e.target.value)
          if (o) onPick(o)
        }}
      >
        {!known && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
    </label>
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
