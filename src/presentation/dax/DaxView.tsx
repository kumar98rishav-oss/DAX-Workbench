import { useEffect, useMemo, useRef, useState } from 'react'
import { Sigma, Plus, Sparkles, Trash2, Check, FunctionSquare, MonitorCheck, MonitorX, Upload, PlayCircle, Factory, Stethoscope, GraduationCap, CalendarDays, ListTree, Zap } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, EmptyState } from '@/design-system/components'
import { makeCtx } from '@/application/query/query-engine'
import { evaluateDax } from '@/application/dax/evaluator'
import { buildArchitectLearnUrl } from '@/application/dax/architect/learn-link'
import { searchDax, DAX_CATALOG } from '@/application/dax/functions'
import type { DaxFunction } from '@/application/dax/functions'
import { suggest } from '@/application/dax/intent/suggest'
import type { Suggestion } from '@/application/dax/intent/suggest'
import { recordPick } from '@/application/dax/intent/memory'
import { desktopPreview, desktopCreateMeasure, desktopEvaluateScalar, modelLabel } from '@/infrastructure/desktop/desktop-client'
import { buildDefineQuery, dependencyClosure, modelMeasures, defineHomeTable } from '@/application/dax/live-preview'
import { DependencyGraph } from './DependencyGraph'
import { DaxAll } from './DaxAll'
import { DaxOptimizer } from './DaxOptimizer'
import './dax.css'
import './dax-panel.css'

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
  const commitMeasures = useApp((s) => s.commitMeasures)
  const desktop = useApp((s) => s.desktop)
  const refreshDesktop = useApp((s) => s.refreshDesktop)
  const syncFromDesktop = useApp((s) => s.syncFromDesktop)
  const toggleFactory = useApp((s) => s.toggleFactory)
  const toggleDoctor = useApp((s) => s.toggleDoctor)
  const toggleDateTable = useApp((s) => s.toggleDateTable)

  const [prompt, setPrompt] = useState('')
  const [explanation, setExplanation] = useState<string | null>(null)
  const [plan, setPlan] = useState<{ stepNumber: number; name: string; dax: string; reason: string }[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [query, setQuery] = useState('')
  const [desktopMsg, setDesktopMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<'functions' | 'all' | 'optimizer'>('functions')
  const codeRef = useRef<HTMLTextAreaElement>(null)

  // Detect the local Power BI Desktop bridge (polls; fails soft when absent).
  useEffect(() => {
    void refreshDesktop()
    const id = setInterval(() => void refreshDesktop(), 15000)
    return () => clearInterval(id)
  }, [refreshDesktop])

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

  // LIVE preview — when Desktop is connected, the number shown by default comes
  // from the REAL engine over the full data. A DEFINE query carries the whole
  // dependency chain, so even measures that exist only in the Studio evaluate
  // exactly. The in-browser value renders instantly and is replaced when the
  // real one lands; on any failure we quietly keep the local number.
  const [live, setLive] = useState<{ key: string; value: unknown } | null>(null)
  useEffect(() => {
    setLive(null)
    if (!selected || !desktop.connected) return
    const home = defineHomeTable(model)
    if (!home) return
    const key = `${selected.id}:${selected.expression}`
    const t = setTimeout(() => {
      const chain = dependencyClosure(modelMeasures(model), selected.name)
      const query = buildDefineQuery(chain, selected.name, home)
      desktopEvaluateScalar(query, desktop.port)
        .then((v) => setLive({ key, value: v }))
        .catch(() => { /* local preview remains */ })
    }, 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.expression, selected?.name, desktop.connected, desktop.port, model])

  const liveValue =
    live && selected && live.key === `${selected.id}:${selected.expression}` ? live.value : undefined

  // Live values for suggestion cards, keyed by measure name.
  const [liveCards, setLiveCards] = useState<Record<string, unknown>>({})

  // Evaluate the selected measure on the REAL model in Power BI Desktop.
  const verifyOnDesktop = async () => {
    if (!selected) return
    setBusy(true)
    setDesktopMsg(null)
    try {
      const v = await desktopPreview(selected.expression, desktop.port)
      setDesktopMsg({ ok: true, text: `Real value from Desktop: ${typeof v === 'number' ? v.toLocaleString() : String(v)}` })
    } catch (e) {
      setDesktopMsg({ ok: false, text: e instanceof Error ? e.message : 'Verify failed' })
    } finally {
      setBusy(false)
    }
  }

  // Write the selected measure straight into the live Desktop model.
  const pushToDesktop = async () => {
    if (!selected) return
    setBusy(true)
    setDesktopMsg(null)
    try {
      const r = await desktopCreateMeasure(selected.tableName, selected.name, selected.expression, selected.formatString, selected.displayFolder, desktop.port)
      setDesktopMsg({ ok: true, text: `${r.status === 'created' ? 'Created' : 'Updated'} “${r.name}” in ${r.table} — it’s live in Power BI Desktop.` })
      void refreshDesktop()
    } catch (e) {
      setDesktopMsg({ ok: false, text: e instanceof Error ? e.message : 'Push failed' })
    } finally {
      setBusy(false)
    }
  }

  // Generate now proposes ranked suggestions; the user picks one to commit.
  const runGenerate = (text: string = prompt) => {
    if (!text.trim()) return
    // "create a date table" is a structure request, not a measure — open the builder.
    if (/\b(date|calendar)\s*table\b/i.test(text)) {
      toggleDateTable(true)
      return
    }
    const { suggestions: sugg } = suggest(text, model, datasets)
    if (sugg.length > 0) {
      setSuggestions(sugg)
      // Replace each card's sample number with the real engine's, as they land.
      setLiveCards({})
      const home = defineHomeTable(model)
      if (desktop.connected && home) {
        for (const s of sugg) {
          // Plan steps first so the suggestion's DAX wins over same-named
          // model measures; the closure trims to what this card needs.
          const pool = [...s.plan.map((st) => ({ name: st.name, dax: st.dax })), ...modelMeasures(model)]
          const chain = dependencyClosure(pool, s.measureName)
          desktopEvaluateScalar(buildDefineQuery(chain, s.measureName, home), desktop.port)
            .then((v) => setLiveCards((prev) => ({ ...prev, [s.measureName]: v })))
            .catch(() => { /* card keeps its sample value */ })
        }
      }
      return
    }
    // No model / nothing to rank — commit directly.
    commitPrompt(text)
  }

  const commitPrompt = (canonical: string) => {
    const r = generateMeasure(canonical)
    if (r) {
      setExplanation(r.explanation)
      setPlan(r.plan ?? [])
      setWarnings(r.validationErrors ?? [])
    }
  }

  const pickSuggestion = (s: Suggestion) => {
    const id = commitMeasures(s.plan, s.measureName, s.formatString)
    if (id) {
      selectMeasure(id)
      setExplanation(s.explanation)
      setPlan(s.plan.map((st, i) => ({ stepNumber: i + 1, name: st.name, dax: st.dax, reason: st.reason })))
      setWarnings(s.validationErrors)
    }
    recordPick(s.signature, s.patternId, s.tokens) // learn from the choice
    setSuggestions([])
    setPrompt('')
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
        <div className="dax-tools">
          <button className="dax-tool" onClick={() => toggleFactory(true)} title="Build a whole measure suite for one field">
            <Factory size={13} /> Factory
          </button>
          <button className="dax-tool" onClick={() => toggleDoctor(true)} title="Audit the model: formats, DAX issues, docs">
            <Stethoscope size={13} /> Doctor
          </button>
          <button className="dax-tool" onClick={() => toggleDateTable(true)} title="Generate a date table — pick columns and the fact table it ranges over, deploy to Desktop">
            <CalendarDays size={13} /> Dates
          </button>
          <button
            className="dax-tool"
            onClick={() => {
              // Carries the model's tables, types and relationships (and the
              // current prompt) into the standalone learning tool via its own
              // share-link format — schema only, never data rows.
              const url = buildArchitectLearnUrl(model, prompt)
              if (url) window.open(url, '_blank', 'noopener,noreferrer')
            }}
            disabled={model.tables.every((t) => t.columns.length === 0)}
            title="Practice on YOUR model in DAX Architect — the standalone learning tool this engine came from. Opens with your tables and relationships already loaded."
          >
            <GraduationCap size={13} /> Learn
          </button>
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
              description="Select or create a measure, describe it in plain language, and the Workbench writes best-practice DAX with a live preview."
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

            {suggestions.length > 0 && (
              <div className="dax-suggest">
                <div className="dax-suggest__head">
                  <span className="dax-suggest__title">{suggestions.length} suggestions — pick the best match</span>
                  <button className="dax-suggest__clear" onClick={() => setSuggestions([])}>Dismiss</button>
                </div>
                <div className="dax-suggest__grid">
                  {suggestions.map((s, i) => (
                    <button key={s.patternId + i} className="dax-sugg" onClick={() => pickSuggestion(s)}>
                      <div className="dax-sugg__top">
                        <span className="dax-sugg__label">{s.label}</span>
                        <span className="dax-sugg__pct">{Math.round(s.score * 100)}%</span>
                      </div>
                      <div className="dax-sugg__bar"><span style={{ width: `${Math.round(s.score * 100)}%` }} /></div>
                      <div className="dax-sugg__name">{s.measureName}{s.plan.length > 1 && <em> · {s.plan.length} measures</em>}</div>
                      <code className="dax-sugg__dax">{s.dax}</code>
                      {s.corrections.length > 0 && (
                        <div className="dax-sugg__fix">✓ read {s.corrections.join(', ')}</div>
                      )}
                      <div className="dax-sugg__foot">
                        <span className="dax-sugg__preview">
                          {liveCards[s.measureName] !== undefined ? (
                            <>
                              {typeof liveCards[s.measureName] === 'number'
                                ? formatByString(liveCards[s.measureName] as number, s.formatString)
                                : String(liveCards[s.measureName] ?? '—')}
                              <em className="dax-badge dax-badge--live">live</em>
                            </>
                          ) : s.preview.ok ? (
                            <>
                              {formatByString(s.preview.value ?? 0, s.formatString)}
                              {desktop.connected && <em className="dax-badge dax-badge--sample">sample</em>}
                            </>
                          ) : (
                            s.preview.note
                          )}
                        </span>
                        <span className="dax-sugg__use">Use →</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

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
              {liveValue !== undefined ? (
                <>
                  <span className="dax-preview__value">
                    {typeof liveValue === 'number'
                      ? formatByString(liveValue, selected.formatString ?? '#,##0')
                      : String(liveValue ?? '—')}
                  </span>
                  <em className="dax-badge dax-badge--live">live · full data</em>
                  <Check size={18} className="dax-preview__ok" />
                </>
              ) : preview?.ok ? (
                <>
                  <span className="dax-preview__value">
                    {formatByString(preview.value, selected.formatString ?? '#,##0')}
                  </span>
                  <em className={`dax-badge ${desktop.connected ? 'dax-badge--sample' : 'dax-badge--local'}`}>
                    {desktop.connected ? 'sample · fetching live…' : 'local sample'}
                  </em>
                  <Check size={18} className="dax-preview__ok" />
                </>
              ) : (
                <span className="dax-preview__value" data-error="true">
                  {preview?.note ?? '—'}
                </span>
              )}
            </div>

            {/* Power BI Desktop bridge — real preview + push, when connected */}
            <div className="dax-desktop">
              <span className={`dax-desktop__badge${desktop.connected ? ' is-on' : desktop.bridge ? ' is-wait' : ''}`}>
                {desktop.connected ? <MonitorCheck size={14} /> : <MonitorX size={14} />}
                {desktop.connected
                  ? `Power BI Desktop · ${modelLabel(desktop.database) ?? 'connected'}`
                  : desktop.bridge
                    ? 'Bridge running — open a .pbix in Desktop'
                    : 'Desktop bridge not running'}
              </span>
              {desktop.connected ? (
                <>
                  <Button size="sm" variant="subtle" icon={<MonitorCheck size={14} />} onClick={() => void syncFromDesktop()} disabled={busy}>Sync model</Button>
                  <Button size="sm" variant="subtle" icon={<PlayCircle size={14} />} onClick={verifyOnDesktop} disabled={busy}>Verify on Desktop</Button>
                  <Button size="sm" variant="primary" icon={<Upload size={14} />} onClick={pushToDesktop} disabled={busy}>Push to Desktop</Button>
                </>
              ) : (
                <span className="dax-desktop__hint">
                  {desktop.bridge ? 'Open your report in Power BI Desktop → real previews & one-click deploy appear here.' : 'Start the local bridge (tools/pbi-desktop-bridge) to work against your real model.'}
                </span>
              )}
              {desktopMsg && (
                <span className={`dax-desktop__msg${desktopMsg.ok ? '' : ' is-err'}`}>{desktopMsg.text}</span>
              )}
            </div>

            {warnings.length > 0 && (
              <div className="dax-warnings">
                {warnings.map((w, i) => (
                  <div key={i} className="dax-warning">⚠ {w}</div>
                ))}
              </div>
            )}

            {explanation && (
              <div className="dax-explain">
                <strong>Why this DAX:</strong> {explanation}
              </div>
            )}

            {plan.length > 1 && (
              <div className="dax-field">
                <span className="dax-field__label">Build plan · {plan.length} measures (branched)</span>
                <ol className="dax-plan">
                  {plan.map((st) => {
                    const m = measures.find((x) => x.name === st.name)
                    return (
                      <li
                        key={st.stepNumber}
                        className="dax-plan__step"
                        data-active={m && m.id === selectedId ? 'true' : undefined}
                        onClick={() => m && selectMeasure(m.id)}
                      >
                        <div className="dax-plan__name">{st.name}</div>
                        <code className="dax-plan__dax">{st.dax}</code>
                        {st.reason && <div className="dax-plan__reason">{st.reason}</div>}
                      </li>
                    )
                  })}
                </ol>
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

      {/* reference · all DAX · optimizer */}
      <aside className="dax-ref">
        <div className="dax-ref__tabs">
          <button className="dax-ref__tab" data-on={panel === 'functions'} onClick={() => setPanel('functions')}>
            <FunctionSquare size={13} /> Functions
          </button>
          <button className="dax-ref__tab" data-on={panel === 'all'} onClick={() => setPanel('all')}>
            <ListTree size={13} /> All DAX
          </button>
          <button className="dax-ref__tab" data-on={panel === 'optimizer'} onClick={() => setPanel('optimizer')}>
            <Zap size={13} /> Optimizer
          </button>
        </div>

        {panel === 'functions' && (
          <>
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
          </>
        )}

        {panel === 'all' && (
          <DaxAll model={model} selectedId={selectedId} onSelect={(id) => selectMeasure(id)} />
        )}

        {panel === 'optimizer' && (
          <div className="dax-ref__pane pbs-scroll">
            {selected ? (
              <DaxOptimizer
                key={selected.id}
                name={selected.name}
                expression={selected.expression}
                onApply={(dax) => updateMeasure(selected.id, { expression: dax })}
              />
            ) : (
              <p className="dall__empty">Select a measure to analyse it.</p>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}
