import { useEffect, useState, type DragEvent } from 'react'
import {
  Play, Pause, FastForward, StepForward, RotateCcw, Plus, GripVertical, X, Check,
  ChevronDown, ChevronRight, ShieldCheck, CircleDot, Save, GitBranch,
  CheckCircle2, XCircle, Flag, Circle, Loader2, Pencil, FileCog,
} from 'lucide-react'
import { IconButton, Segmented } from '@/design-system/components'
import { usePipeline } from '@/app/pipeline-store'
import type { PipelineStage } from '@/infrastructure/desktop/pipeline-client'
import './pipeline.css'

const GATE = {
  green: { Icon: CheckCircle2, cls: 'ok' },
  red: { Icon: XCircle, cls: 'bad' },
  hold: { Icon: Flag, cls: 'hold' },
  pending: { Icon: Circle, cls: 'pending' },
} as const
const gateOf = (r: string) => GATE[r as keyof typeof GATE] ?? GATE.pending
const fmtNum = (n: number | null) => (n == null ? '—' : Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(Math.round(n * 100) / 100))
const MODE_OPTS = [{ value: 'default', label: 'Default' }, { value: 'custom', label: 'Custom' }]

type DragSkill = { kind: 'skill'; ref: string; from: number | 'tray' }
const setDrag = (e: DragEvent, p: DragSkill) => { e.dataTransfer.setData('application/x-pl', JSON.stringify(p)); e.dataTransfer.effectAllowed = 'move' }
const getDrag = (e: DragEvent): DragSkill | null => { try { return JSON.parse(e.dataTransfer.getData('application/x-pl')) as DragSkill } catch { return null } }
type Store = ReturnType<typeof usePipeline.getState>

export function PipelinePanel() {
  const store = usePipeline()
  const { state, catalog, error, connect, skillMeta } = store
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<number | null>(null)
  const [stageDrag, setStageDrag] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [trayTab, setTrayTab] = useState<'default' | 'custom' | 'templates'>('default')
  useEffect(() => { connect() }, [connect])

  if (!state) {
    return (
      <div className="pl"><div className="pl__empty">
        <Loader2 className="pl__spin" size={22} />
        <p>{error ?? 'Connecting to the Pipeline Host…'}</p>
        <code>node tools/pipeline-host/server.mjs</code>
      </div></div>
    )
  }

  const mode = state.mode ?? 'default'
  const custom = mode === 'custom'
  const src = state.source ?? { kind: 'data' as const, path: '' }
  const toggleExp = (id: number) => setExpanded((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const dropStage = (targetId: number) => {
    if (stageDrag == null || stageDrag === targetId) { setStageDrag(null); setOver(null); return }
    const order = state.stages.map((x) => x.id)
    order.splice(order.indexOf(targetId), 0, order.splice(order.indexOf(stageDrag), 1)[0])
    store.reorderStages(order); setStageDrag(null); setOver(null)
  }

  return (
    <div className="pl">
      <header className="pl__bar">
        <div className="pl__title">
          Delivery Pipeline
          <span className={`pl__status pl__status--${state.status}`}>{state.status}</span>
          {Object.keys(state.reconciliation.sums).length > 0 && <span className="pl__recon">reconciled: {Object.keys(state.reconciliation.sums).join(', ')}</span>}
        </div>
        <div className="pl__actions">
          <select className="pl__sel" value="" onChange={(e) => { if (e.target.value) store.loadTemplate(e.target.value) }}>
            <option value="">Templates…</option>
            {state.templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
          <IconButton label="Save current as template" onClick={() => { const n = window.prompt('Template name'); if (n) store.saveTemplate(n) }}><Save size={16} /></IconButton>
          <select className="pl__sel" value="" onChange={(e) => { if (e.target.value) store.loadHistory(e.target.value) }}>
            <option value="">History…</option>
            {state.history.map((h) => <option key={h.id} value={h.id}>{new Date(h.at).toLocaleTimeString()} · {h.status}</option>)}
          </select>
          <span className="pl__gap" />
          <Segmented options={MODE_OPTS} value={mode} onChange={(v) => store.setMode(v as 'default' | 'custom')} ariaLabel="Pipeline mode" />
          <span className="pl__gap" />
          <IconButton label="Run" active={state.status === 'running'} onClick={store.run}><Play size={16} /></IconButton>
          <IconButton label="Pause" active={state.status === 'paused'} onClick={store.pause}><Pause size={16} /></IconButton>
          <IconButton label="Continue past breakpoint" onClick={store.resume}><FastForward size={16} /></IconButton>
          <IconButton label="Step to next stage" onClick={() => store.runTo(Math.min(state.currentStage + 1, state.stages.length - 1))}><StepForward size={16} /></IconButton>
          <IconButton label="Reset to best order" onClick={store.reset}><RotateCcw size={16} /></IconButton>
          {custom && <IconButton label="Add a stage" onClick={() => store.addStage('New stage')}><Plus size={16} /></IconButton>}
        </div>
      </header>

      <div className={`pl__body ${custom ? 'is-custom' : ''}`}>
        {custom && (
          <aside className="pl__tray">
            <div className="pl__tray-tabs">
              {(['default', 'custom', 'templates'] as const).map((t) => (
                <button key={t} className={`pl__tray-tab ${trayTab === t ? 'on' : ''}`} onClick={() => setTrayTab(t)}>
                  {t === 'default' ? 'Default' : t === 'custom' ? 'Custom' : 'Templates'}
                </button>
              ))}
            </div>

            {trayTab === 'default' && catalog.filter((g) => g.group !== 'Custom').map((grp) => (
              <div key={grp.group} className="pl__tray-grp">
                <div className="pl__tray-grplabel">{grp.group}</div>
                {grp.skills.map((ref) => <span key={ref} className="pl-chip pl-chip--drag" draggable onDragStart={(e) => setDrag(e, { kind: 'skill', ref, from: 'tray' })}>{ref}</span>)}
              </div>
            ))}

            {trayTab === 'custom' && (
              <div className="pl__tray-grp">
                <div className="pl__tray-head">Custom skills
                  <button className="pl__tray-add" title="Add a custom skill" onClick={() => { const ref = window.prompt('Custom skill name'); if (ref) store.addCustomSkill(ref, 'Custom') }}>＋</button>
                </div>
                {catalog.filter((g) => g.group === 'Custom').flatMap((g) => g.skills).map((ref) => <span key={ref} className="pl-chip pl-chip--drag" draggable onDragStart={(e) => setDrag(e, { kind: 'skill', ref, from: 'tray' })}>{ref}</span>)}
                {catalog.filter((g) => g.group === 'Custom').flatMap((g) => g.skills).length === 0 && <div className="pl__tray-empty">No custom skills yet — click ＋ above, or drop a JSON file in the custom folder.</div>}
              </div>
            )}

            {trayTab === 'templates' && (
              <div className="pl__tray-tmpls">
                {state.templates.map((t) => (
                  <div key={t.name} className="pl__tray-tmpl">
                    <button className="pl__tray-tmpl-name" title="Load this template into the pipeline" onClick={() => store.loadTemplate(t.name)}>{t.name}</button>
                    <button className="pl__tray-tmpl-run" title="Load and run" onClick={() => { store.loadTemplate(t.name); window.setTimeout(() => store.run(), 200) }}><Play size={12} /></button>
                  </div>
                ))}
                {state.templates.length === 0 && <div className="pl__tray-empty">No templates yet — build a pipeline and save it with the 💾 button in the toolbar.</div>}
              </div>
            )}
          </aside>
        )}

        <ol className="pl__mid">
          {state.stages.map((st) => (
            <StageCard key={st.id} st={st} custom={custom} store={store} allStages={state.stages}
              statePath={state.statePath} skillMeta={skillMeta}
              active={st.id === state.currentStage && state.status === 'running'}
              expanded={expanded.has(st.id)} onToggle={() => toggleExp(st.id)}
              editing={editing === st.id} setEditing={(v) => setEditing(v ? st.id : null)} />
          ))}
        </ol>

        <div className={`pl__canvas ${custom ? 'is-custom' : ''}`}>
          <div className="pl__source">
            <div className="pl__source-head">Source <span>— Claude reads this at Bootstrap, so you don't repeat the path in your prompt</span>
              <button className="pl__source-newbtn" title="Scaffold a new project: creates the folder + data\ + a project-spec.md to fill in, and points Source at it"
                onClick={() => { const p = window.prompt('New project folder (will be created):', 'E:\\Data Analyst\\POWER BI\\MyNewProject'); if (p) store.newProject(p) }}>＋ New project</button>
            </div>
            <div className="pl__source-toggle">
              <button className={src.kind === 'data' ? 'on' : ''} onClick={() => store.setSource('data', src.path)}>📁 Data folder</button>
              <button className={src.kind === 'pbip' ? 'on' : ''} onClick={() => store.setSource('pbip', src.path)}>📄 PBIP file</button>
            </div>
            <input className="pl__source-path" key={src.kind} defaultValue={src.path}
              placeholder={src.kind === 'data' ? 'Paste the folder path that holds your CSVs' : 'Paste the .pbip file path, or leave blank to use the model open in Desktop'}
              onBlur={(e) => store.setSource(src.kind, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
          </div>
          <div className="pl__canvas-head">{custom ? 'Drag to reorder' : 'Best-practice flow'}</div>
          <div className="pl__flow">
            {state.stages.map((st, i) => {
              const g = gateOf(st.gate.result)
              const active = st.id === state.currentStage && state.status === 'running'
              return (
                <div key={st.id} className="pl__flowrow">
                  <div className={`fl-node fl-node--${g.cls} ${active ? 'is-active' : ''} ${over === st.id && stageDrag != null ? 'is-over' : ''} ${stageDrag === st.id ? 'is-drag' : ''}`}
                    draggable={custom} onClick={() => toggleExp(st.id)}
                    onDragStart={() => setStageDrag(st.id)} onDragEnd={() => { setStageDrag(null); setOver(null) }}
                    onDragOver={(e) => { if (custom && stageDrag != null) { e.preventDefault(); setOver(st.id) } }}
                    onDrop={() => { if (custom && stageDrag != null) dropStage(st.id) }}>
                    {custom && <GripVertical size={13} className="fl-node__grip" />}
                    {st.breakpoint && <span className="fl-node__bp" />}
                    <span className="fl-node__dot" />
                    <span className="fl-node__n">{i}</span>
                    <span className="fl-node__name">{st.name}</span>
                    {st.branch?.onFail != null && <GitBranch size={11} className="fl-node__br" />}
                    {st.requiresSignoff && <ShieldCheck size={12} className="fl-node__lock" />}
                    <g.Icon size={13} className={`fl-node__gate fl-node__gate--${g.cls}`} />
                  </div>
                  {i < state.stages.length - 1 && <div className="fl-conn" />}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <section className="pl__log">
        {state.assumptions.length > 0 && <div className="pl__assume">assumptions: {state.assumptions.slice(-3).join(' · ')}</div>}
        {state.stages.flatMap((x) => x.logs).slice(-6).map((l, i) => <div key={i} className="pl__logline">{l}</div>)}
      </section>
    </div>
  )
}

function StageCard({ st, custom, store, allStages, statePath, skillMeta, active, expanded, onToggle, editing, setEditing }: {
  st: PipelineStage; custom: boolean; store: Store; allStages: PipelineStage[];
  statePath?: string; skillMeta: Record<string, { kind: string; path: string; about: string }>; active: boolean;
  expanded: boolean; onToggle: () => void; editing: boolean; setEditing: (v: boolean) => void
}) {
  const [over, setOver] = useState(false)
  const [descEdit, setDescEdit] = useState(false)
  const g = gateOf(st.gate.result)
  const onDrop = (e: DragEvent) => {
    setOver(false)
    const p = getDrag(e); if (!p || p.kind !== 'skill') return
    if (p.from === 'tray') store.addSkill(st.id, p.ref)
    else if (p.from !== st.id) store.moveSkill(p.from, st.id, p.ref)
  }

  return (
    <li className={`pl-node pl-node--${st.state} ${active ? 'is-active' : ''} ${over ? 'is-drop' : ''}`}
      onDragOver={(e) => { if (custom) { e.preventDefault(); setOver(true) } }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="pl-node__row" onClick={onToggle}>
        {expanded ? <ChevronDown size={14} className="pl-node__caret" /> : <ChevronRight size={14} className="pl-node__caret" />}
        <span className="pl-node__n">{st.id}</span>
        {editing ? (
          <input className="pl-node__edit" autoFocus defaultValue={st.name} onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { store.renameStage(st.id, e.target.value); setEditing(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        ) : (
          <span className="pl-node__name" onDoubleClick={(e) => { if (custom) { e.stopPropagation(); setEditing(true) } }}>{st.name}</span>
        )}
        <button className={`pl-node__bp ${st.breakpoint ? 'on' : ''}`} title={st.breakpoint ? 'Clear breakpoint' : 'Set breakpoint'} onClick={(e) => { e.stopPropagation(); store.toggleBreakpoint(st.id) }}><CircleDot size={13} /></button>
        {st.requiresSignoff && <ShieldCheck size={13} className="pl-node__lock" />}
        <g.Icon size={15} className={`pl-node__gate pl-node__gate--${g.cls}`} />
        {custom && <button className="pl-node__x" title="Remove stage" onClick={(e) => { e.stopPropagation(); store.removeStage(st.id) }}><X size={13} /></button>}
      </div>

      {st.skills.length > 0 && (
        <div className="pl-node__skills">
          {st.skills.map((sk) => (
            <span key={sk.ref} className={`pl-chip ${sk.enabled ? '' : 'pl-chip--off'}`} draggable={custom} onDragStart={(e) => { if (custom) setDrag(e, { kind: 'skill', ref: sk.ref, from: st.id }) }}>
              <button className={`pl-chip__dot ${sk.enabled ? 'on' : ''}`} title={sk.enabled ? 'Disable' : 'Enable'} onClick={() => store.toggleSkill(st.id, sk.ref)} />
              {sk.ref}
              {custom && <button className="pl-chip__x" title="Remove skill" onClick={() => store.removeSkill(st.id, sk.ref)}><X size={11} /></button>}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="pl-node__insp">
          <div className="pl-node__about">
            <div className="pl-node__abouthd">
              <span>What this stage does &amp; handles</span>
              <button className="pl-node__editbtn" title="Edit this note" onClick={() => setDescEdit(true)}><Pencil size={11} /></button>
            </div>
            {descEdit ? (
              <textarea className="pl-node__desc" autoFocus defaultValue={st.description ?? ''}
                onBlur={(e) => { store.setDescription(st.id, e.target.value); setDescEdit(false) }} />
            ) : (
              <p className="pl-node__desctext">{st.description || '(no note yet — click the pencil to add one)'}</p>
            )}
          </div>

          {st.skills.length > 0 && (
            <div className="pl-node__skilldetail">
              <div className="pl-node__skilldetailhd">Skills used — where each lives (edit there to change behaviour)</div>
              {st.skills.map((sk) => {
                const m = skillMeta[sk.ref] ?? { kind: 'custom skill', path: `.claude/skills/${sk.ref}/`, about: 'Custom skill — no metadata registered.' }
                return (
                  <div key={sk.ref} className="pl-skillrow">
                    <div className="pl-skillrow__top"><b>{sk.ref}</b><span className="pl-skillrow__kind">{m.kind}</span></div>
                    <div className="pl-skillrow__about">{m.about}</div>
                    <code className="pl-skillrow__path" title={m.path}>{m.path}</code>
                  </div>
                )
              })}
            </div>
          )}

          {custom && st.skills.length === 0 && <div className="pl-node__hint">Drag a skill here from the tray →</div>}
          <div className="pl-node__meta">
            <span className="pl-node__gatetype">gate: <b>{st.gate.type}</b></span>
            <label className="pl-node__sign"><input type="checkbox" checked={st.requiresSignoff} onChange={(e) => store.setSignoff(st.id, e.target.checked)} /> sign-off</label>
            <label className="pl-node__branch">on fail →
              <select value={st.branch?.onFail ?? ''} onChange={(e) => store.setBranch(st.id, e.target.value === '' ? null : Number(e.target.value))} onClick={(e) => e.stopPropagation()}>
                <option value="">(stop)</option>
                {allStages.filter((x) => x.id !== st.id).map((x) => <option key={x.id} value={x.id}>{x.id} · {x.name}</option>)}
              </select>
            </label>
            {st.requiresSignoff && st.state !== 'passed' && (st.approved
              ? <span className="pl-node__approved"><Check size={12} /> approved</span>
              : <button className="pl-node__approve" title="Approve this gate, release its breakpoint, and resume the run — one click" onClick={() => store.approveAndContinue(st.id)}><Check size={12} /> approve &amp; continue</button>)}
            <button className="pl-node__verify" title="The HOST runs the baseline measures on the live engine and sets this gate from the real numbers — verified, not asserted" onClick={() => store.verify(st.id)}><ShieldCheck size={12} /> verify on engine</button>
            <button className="pl-node__run" onClick={() => store.runStage(st.id)}>run to here</button>
          </div>
          {(st.gate.checks?.length ?? 0) > 0 && (
            <div className="pl-node__checks">
              {st.gate.checks!.map((c, i) => (
                <div key={i} className={`pl-check ${c.ok ? 'ok' : 'bad'}`}>
                  <span className="pl-check__dot" />
                  <span className="pl-check__name">{c.name}</span>
                  <span className="pl-check__nums">expected {fmtNum(c.expected)} · engine {fmtNum(c.actual)}</span>
                </div>
              ))}
            </div>
          )}
          {st.logs.length > 0 && <div className="pl-node__logs">{st.logs.slice(-4).map((l, i) => <div key={i}>{l}</div>)}</div>}
          {st.artifacts.length > 0 && <div className="pl-node__arts">artifacts: {st.artifacts.join(', ')}</div>}
          <div className="pl-node__stored"><FileCog size={12} /> stage config stored in <code>{statePath ?? '.daxwb/pipeline.json'}</code> — editable</div>
        </div>
      )}
    </li>
  )
}
