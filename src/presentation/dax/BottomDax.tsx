import { useMemo, useState } from 'react'
import { Sparkles, Sigma, Check } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button } from '@/design-system/components'
import { makeCtx } from '@/application/query/query-engine'
import { evaluateDax } from '@/application/dax/evaluator'
import { generateDaxFromNL } from '@/application/dax/nl-templates'
import type { VisualSpec } from '@/application/insights/dashboard-generator'
import { DependencyGraph } from './DependencyGraph'
import './dax.css'
import './bottom-dax.css'
import './dependency-graph.css'

function fmtByString(v: number, fmt: string): string {
  if (fmt.includes('%')) return `${(v * 100).toFixed(1)}%`
  const num = v.toLocaleString(undefined, { maximumFractionDigits: fmt.includes('.') ? 2 : 0 })
  return fmt.includes('$') ? `$${num}` : num
}

export function BottomDax() {
  const model = useApp((s) => s.model)
  const report = useApp((s) => s.report)
  const datasets = useApp((s) => s.datasets)
  const selVisual = useApp((s) => s.selectedVisualId)
  const selMeasure = useApp((s) => s.selectedMeasureId)
  const updateMeasure = useApp((s) => s.updateMeasure)
  const addMeasure = useApp((s) => s.addMeasure)
  const selectVisual = useApp((s) => s.selectVisual)

  const [prompt, setPrompt] = useState('')
  const [explain, setExplain] = useState<string | null>(null)

  const target = useMemo(() => {
    const measures = model.tables.flatMap((t) => t.measures)
    const page = report.pages.find((p) => p.id === report.activePageId) ?? report.pages[0]
    if (selVisual && page) {
      const v = page.visuals.find((x) => x.id === selVisual)
      const spec = (v?.style as { spec?: VisualSpec } | undefined)?.spec
      let nm: string | undefined
      if (spec) {
        if ('measure' in spec) nm = spec.measure.name
        else if (spec.type === 'multi') nm = spec.measures[0]?.name
        else if (spec.type === 'matrix') nm = spec.measures[0]?.name
        else if (spec.type === 'scatter') nm = spec.x.name
      }
      if (nm) {
        const found = measures.find((m) => m.name === nm)
        if (found) return found
      }
    }
    if (selMeasure) {
      const f = measures.find((m) => m.id === selMeasure)
      if (f) return f
    }
    return measures[0] ?? null
  }, [model, report, selVisual, selMeasure])

  const ctx = useMemo(() => makeCtx(model, datasets), [model, datasets])

  if (!target) {
    return <div className="bdx__empty">Select a card or measure to view and edit its DAX.</div>
  }

  const preview = evaluateDax(target.expression, ctx)

  const generate = () => {
    const g = generateDaxFromNL(prompt, model)
    if (!g) return
    addMeasure()
    const id = useApp.getState().selectedMeasureId
    if (id) updateMeasure(id, { name: g.name, expression: g.expression, formatString: g.formatString })
    selectVisual(null) // focus the newly-generated measure
    setExplain(g.explanation)
    setPrompt('')
  }

  return (
    <div className="bdx">
      <div className="bdx__editor">
        <div className="bdx__head">
          <span className="bdx__name"><Sigma size={14} /> {target.name}</span>
          {preview.ok ? (
            <span className="bdx__preview"><Check size={13} /> {fmtByString(preview.value, target.formatString ?? '#,##0')}</span>
          ) : (
            <span className="bdx__preview bdx__preview--warn">{preview.note}</span>
          )}
        </div>

        <div className="dax-nl bdx__nl">
          <input
            className="dax-nl__input"
            placeholder="Describe a measure to generate — e.g. “YTD revenue”, “% of total”, “average deal”"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && generate()}
          />
          <Button variant="primary" size="sm" icon={<Sparkles size={14} />} onClick={generate}>Generate</Button>
        </div>

        <textarea
          className="dax-code bdx__code"
          spellCheck={false}
          value={target.expression}
          onChange={(e) => updateMeasure(target.id, { expression: e.target.value })}
        />

        {explain && <div className="dax-explain bdx__explain"><strong>Why:</strong> {explain}</div>}
      </div>

      <div className="bdx__deps">
        <div className="bdx__deps-title">Dependency Graph</div>
        <DependencyGraph expression={target.expression} name={target.name} model={model} />
      </div>
    </div>
  )
}
