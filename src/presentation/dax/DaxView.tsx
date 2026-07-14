import { useEffect, useMemo, useRef, useState } from 'react'
import { Sigma, Plus, Sparkles, Trash2, Check, FunctionSquare } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, EmptyState } from '@/design-system/components'
import { makeCtx } from '@/application/query/query-engine'
import { evaluateDax } from '@/application/dax/evaluator'
import { searchDax, DAX_CATALOG } from '@/application/dax/functions'
import type { DaxFunction } from '@/application/dax/functions'
import { DependencyGraph } from './DependencyGraph'
import './dax.css'

function formatByString(v: number, fmt: string): string {
  if (fmt.includes('%')) return `${(v * 100).toFixed(1)}%`
  const digits = fmt.includes('.') ? 2 : 0
  const num = v.toLocaleString(undefined, { maximumFractionDigits: digits })
  return fmt.includes('$') ? `$${num}` : num
}

const EXAMPLES = [
  'Total Amount',
  'Count Shipments where Order_Status = Delivered',
  'Average Boxes',
  'YTD Amount',
  'Distinct Product',
  'Amount % of total',
]

const FORMATS: { label: string; value: string }[] = [
  { label: 'Whole number', value: '#,##0' },
  { label: 'Decimal (2 dp)', value: '#,##0.00' },
  { label: 'Currency', value: '\\$#,##0' },
  { label: 'Currency (2 dp)', value: '\\$#,##0.00' },
  { label: 'Percentage', value: '0.0%' },
  { label: 'Percentage (2 dp)', value: '0.00%' },
  { label: 'Thousands (K)', value: '#,##0,"K"' },
  { label: 'Millions (M)', value: '#,##0,,"M"' },
  { label: 'Date', value: 'yyyy-mm-dd' },
]

function FormatField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = FORMATS.some((f) => f.value === value)
  const [custom, setCustom] = useState(!isPreset && value !== '' && value !== '#,##0')
  if (custom) {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="dax-input" style={{ flex: 1 }} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Custom format string" />
        <button type="button" className="dax-format-preset" onClick={() => setCustom(false)} title="Use a preset">⟲</button>
      </div>
    )
  }
  return (
    <select
      className="dax-select"
      value={isPreset ? value : '__custom__'}
      onChange={(e) => {
        if (e.target.value === '__custom__') setCustom(true)
        else onChange(e.target.value)
      }}
    >
      {FORMATS.map((f) => (
        <option key={f.value} value={f.value}>{f.label}</option>
      ))}
      <option value="__custom__">Custom…</option>
    </select>
  )
}

export function DaxView() {
  const model = useApp((s) => s.model)
  const datasets = useApp((s) => s.datasets)
  const selectedId = useApp((s) => s.selectedMeasureId)
  const selectMeasure = useApp((s) => s.selectMeasure)
  const addMeasure = useApp((s) => s.addMeasure)
  const updateMeasure = useApp((s) => s.updateMeasure)
  const deleteMeasure = useApp((s) => s.deleteMeasure)
  const generateMeasure = useApp((s) => s.generateMeasure)

  const [prompt, setPrompt] = useState('')
  const [explanation, setExplanation] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const codeRef = useRef<HTMLTextAreaElement>(null)

  const ctx = useMemo(() => makeCtx(model, datasets), [model, datasets])

  const measures = useMemo(
    () => model.tables.flatMap((t) => t.measures.map((m) => ({ ...m, tableName: t.name }))),
    [model],
  )

  // auto-select first measure
  useEffect(() => {
    if (!selectedId && measures.length > 0) selectMeasure(measures[0].id)
  }, [selectedId, measures, selectMeasure])

  const selected = measures.find((m) => m.id === selectedId)
  const results = useMemo(() => searchDax(query), [query])

  const preview = useMemo(
    () => (selected ? evaluateDax(selected.expression, ctx) : null),
    [selected, ctx],
  )

  const runGenerate = (text: string = prompt) => {
    if (!text.trim()) return
    const r = generateMeasure(text)
    if (r) setExplanation(r.explanation)
  }

  const insertFn = (fn: DaxFunction) => {
    if (!selected) return
    const ta = codeRef.current
    const insert = `${fn.name}(`
    if (ta) {
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const next = selected.expression.slice(0, start) + insert + selected.expression.slice(end)
      updateMeasure(selected.id, { expression: next })
      requestAnimationFrame(() => {
        ta.focus()
        const caret = start + insert.length
        ta.setSelectionRange(caret, caret)
      })
    } else {
      updateMeasure(selected.id, { expression: selected.expression + insert })
    }
  }

  return (
    <div className="daxview">
      {/* measures */}
      <aside className="dax-list">
        <div className="dax-list__head">
          <span className="dax-list__title">Measures</span>
          <Button size="sm" variant="ghost" icon={<Plus size={15} />} onClick={addMeasure}>
            New
          </Button>
        </div>
        <div className="dax-list__body pbs-scroll">
          {model.tables
            .filter((t) => t.measures.length > 0)
            .map((t) => (
              <div key={t.id}>
                <div className="dax-group__label">{t.name}</div>
                {t.measures.map((m) => (
                  <button
                    key={m.id}
                    className="dax-measure"
                    data-active={m.id === selectedId ? 'true' : undefined}
                    onClick={() => {
                      selectMeasure(m.id)
                      setExplanation(m.description || null)
                    }}
                  >
                    <Sigma size={15} className="dax-measure__icon" />
                    {m.name}
                  </button>
                ))}
              </div>
            ))}
          {measures.length === 0 && (
            <p style={{ padding: 'var(--space-4)', color: 'var(--text-subtle)', fontSize: 'var(--text-sm)' }}>
              No measures yet. Import data to auto-generate them, or add one.
            </p>
          )}
        </div>
      </aside>

      {/* editor */}
      <main className="dax-editor pbs-scroll">
        {!selected ? (
          <div className="dax-editor__empty">
            <EmptyState
              icon={<FunctionSquare size={26} />}
              title="DAX Architect"
              description="Select or create a measure, describe it in plain language, and Studio writes best-practice DAX with a live preview."
              action={<Button variant="primary" icon={<Plus size={16} />} onClick={addMeasure}>New measure</Button>}
            />
          </div>
        ) : (
          <>
            <div className="dax-nl">
              <input
                className="dax-nl__input"
                placeholder="Describe a measure — e.g. “count Shipments where Order_Status = Delivered”"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runGenerate()}
              />
              <Button variant="primary" icon={<Sparkles size={15} />} onClick={() => runGenerate()}>
                Generate
              </Button>
            </div>

            <div className="dax-hint">
              <span className="dax-hint__syntax">
                <strong>Structure:</strong> [sum · count · average · distinct · min · max] <em>field</em> [where <em>field</em> = <em>value</em>] [ytd · running · yoy · % of total · per]
              </span>
              <div className="dax-examples">
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="dax-example" onClick={() => { setPrompt(ex); runGenerate(ex) }}>
                    {ex}
                  </button>
                ))}
              </div>
            </div>

            <div className="dax-row">
              <label className="dax-field">
                <span className="dax-field__label">Measure name</span>
                <input
                  className="dax-input"
                  value={selected.name}
                  onChange={(e) => updateMeasure(selected.id, { name: e.target.value })}
                />
              </label>
              <label className="dax-field" style={{ maxWidth: 200 }}>
                <span className="dax-field__label">Format</span>
                <FormatField value={selected.formatString ?? ''} onChange={(v) => updateMeasure(selected.id, { formatString: v })} />
              </label>
            </div>

            <label className="dax-field">
              <span className="dax-field__label">DAX expression</span>
              <textarea
                ref={codeRef}
                className="dax-code"
                spellCheck={false}
                value={selected.expression}
                onChange={(e) => updateMeasure(selected.id, { expression: e.target.value })}
              />
            </label>

            <div className="dax-preview">
              <span className="dax-preview__label">Preview</span>
              {preview?.ok ? (
                <>
                  <span className="dax-preview__value">
                    {formatByString(preview.value, selected.formatString ?? '#,##0')}
                  </span>
                  <Check size={18} className="dax-preview__ok" />
                </>
              ) : (
                <span className="dax-preview__value" data-error="true">
                  {preview?.note ?? '—'}
                </span>
              )}
            </div>

            {explanation && (
              <div className="dax-explain">
                <strong>Why this DAX:</strong> {explanation}
              </div>
            )}

            <div className="dax-field">
              <span className="dax-field__label">Dependency Graph</span>
              <DependencyGraph expression={selected.expression} name={selected.name} model={model} />
            </div>

            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={15} />}
              onClick={() => deleteMeasure(selected.id)}
              style={{ color: 'var(--danger)', alignSelf: 'flex-start' }}
            >
              Delete measure
            </Button>
          </>
        )}
      </main>

      {/* reference */}
      <aside className="dax-ref">
        <div className="dax-ref__head">
          <input
            className="dax-ref__search"
            placeholder="Search DAX functions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="dax-ref__count">{DAX_CATALOG.length} functions · click to insert</div>
        </div>
        <div className="dax-ref__list pbs-scroll">
          {results.map((fn) => (
            <button key={fn.name} className="dax-fn" onClick={() => insertFn(fn)} title={fn.description}>
              <span className="dax-fn__name">{fn.name}</span>
              <span className="dax-fn__cat">{fn.category}</span>
              <div className="dax-fn__syntax">{fn.syntax}</div>
              <div className="dax-fn__desc">{fn.description}</div>
            </button>
          ))}
        </div>
      </aside>
    </div>
  )
}
