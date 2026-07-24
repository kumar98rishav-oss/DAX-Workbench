import { useMemo, useState } from 'react'
import { Eraser, Undo2, Redo2, Trash2, TriangleAlert, ShieldCheck, CircleHelp, Search } from 'lucide-react'
import { useApp } from '@/app/store'
import { Badge, Button, EmptyState, Segmented } from '@/design-system/components'
import {
  buildUsageGraph,
  cascadeImpact,
  NO_REPORT,
  type ObjectKind,
  type UsageNode,
  type UsageState,
} from '@/application/dax/usage'
import './cleanup.css'

const STATE_LABEL: Record<UsageState, string> = {
  referenced: 'Referenced',
  'no-model-refs': 'No model refs',
  unused: 'Unused',
}
const STATE_VARIANT: Record<UsageState, 'success' | 'warning' | 'neutral' | 'accent'> = {
  referenced: 'success',
  'no-model-refs': 'warning',
  unused: 'accent',
}

export function CleanupView() {
  const model = useApp((s) => s.model)
  const staged = useApp((s) => s.cleanupStaged)
  const canUndo = useApp((s) => s.cleanupUndo.length > 0)
  const canRedo = useApp((s) => s.cleanupRedo.length > 0)
  const toggleStage = useApp((s) => s.toggleCleanupStage)
  const clearStage = useApp((s) => s.clearCleanupStage)
  const undo = useApp((s) => s.undoCleanup)
  const redo = useApp((s) => s.redoCleanup)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | UsageState>('all')
  const [kind, setKind] = useState<ObjectKind>('measure')
  const [selected, setSelected] = useState<string | null>(null)

  // Report layer is not wired yet, so nothing can be proven unused.
  const graph = useMemo(() => buildUsageGraph(model, NO_REPORT), [model])

  /** Everything of the selected kind — drives both the rows and the counts. */
  const kindNodes = useMemo(() => graph.nodes.filter((n) => n.kind === kind), [graph, kind])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return kindNodes
      .filter((n) => (filter === 'all' ? true : n.state === filter))
      .filter((n) => (q ? n.label.toLowerCase().includes(q) : true))
      .sort((a, b) => {
        const rank = (n: UsageNode) => (n.state === 'referenced' ? 2 : n.state === 'unused' ? 0 : 1)
        return rank(a) - rank(b) || a.label.localeCompare(b.label)
      })
  }, [kindNodes, filter, query])

  const impact = useMemo(() => cascadeImpact(graph, staged), [graph, staged])
  const active = selected ? graph.byKey[selected] : null

  if (model.tables.length === 0) {
    return (
      <div className="cleanup">
        <div className="cleanup__empty">
          <EmptyState
            icon={<Eraser size={26} />}
            title="Nothing to clean up yet"
            description="Connect to Power BI Desktop or open a model, and the Workbench will map every dependency between measures, columns, and tables."
          />
        </div>
      </div>
    )
  }

  const counts = {
    referenced: kindNodes.filter((n) => n.state === 'referenced').length,
    'no-model-refs': kindNodes.filter((n) => n.state === 'no-model-refs').length,
    unused: kindNodes.filter((n) => n.state === 'unused').length,
  }
  const KIND_NOUN: Record<ObjectKind, string> = { measure: 'measures', column: 'columns', table: 'tables' }

  return (
    <div className="cleanup">
      <div className="cleanup__toolbar">
        <div className="cleanup__stats">
          <span className="cleanup__stat">
            <strong>{kindNodes.length}</strong> {KIND_NOUN[kind]}
          </span>
          <span className="cleanup__stat">
            <strong>{counts.referenced}</strong> referenced
          </span>
          <span className="cleanup__stat cleanup__stat--warn">
            <strong>{counts['no-model-refs']}</strong> no model refs
          </span>
        </div>
        <div className="cleanup__spacer" />
        <div className="cleanup__search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search objects…" />
        </div>
        <Button size="sm" icon={<Undo2 size={15} />} disabled={!canUndo} onClick={undo}>
          Undo
        </Button>
        <Button size="sm" icon={<Redo2 size={15} />} disabled={!canRedo} onClick={redo}>
          Redo
        </Button>
      </div>

      {!graph.scanned && (
        <div className="cleanup__notice">
          <CircleHelp size={15} />
          <span>
            <strong>Report layer not scanned.</strong> The Analysis Services engine exposes the model only — it cannot
            see which visuals bind a measure. Objects below are marked <em>no model refs</em>, never <em>unused</em>:
            nothing in the model references them, but a report page still might.
          </span>
        </div>
      )}

      <div className="cleanup__body">
        <div className="cleanup__list">
          <div className="cleanup__filters">
            {(['all', 'referenced', 'no-model-refs', 'unused'] as const).map((f) => (
              <button
                key={f}
                className={`cleanup__filter ${filter === f ? 'is-active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : STATE_LABEL[f]}
              </button>
            ))}
            <div className="cleanup__filters-spacer" />
            <Segmented
              ariaLabel="Object kind"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'measure', label: 'Measures' },
                { value: 'column', label: 'Columns' },
                { value: 'table', label: 'Tables' },
              ]}
            />
          </div>
          <div className="cleanup__rows">
            {rows.map((n) => {
              const isStaged = staged.includes(n.key)
              const breaks = impact.includes(n.key)
              return (
                <div
                  key={n.key}
                  className={`cleanup__row ${isStaged ? 'is-staged' : ''} ${breaks ? 'is-breaking' : ''} ${
                    selected === n.key ? 'is-selected' : ''
                  }`}
                  onClick={() => setSelected(n.key)}
                >
                  <input
                    type="checkbox"
                    checked={isStaged}
                    onChange={() => toggleStage(n.key)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span className={`cleanup__kind cleanup__kind--${n.kind}`}>{n.kind[0].toUpperCase()}</span>
                  <span className="cleanup__label">{n.label}</span>
                  {breaks && (
                    <span className="cleanup__breaks" title="A staged deletion would break this">
                      <TriangleAlert size={13} /> breaks
                    </span>
                  )}
                  <Badge variant={STATE_VARIANT[n.state]}>{STATE_LABEL[n.state]}</Badge>
                </div>
              )
            })}
            {rows.length === 0 && <div className="cleanup__none">No objects match.</div>}
          </div>
        </div>

        <aside className="cleanup__aside">
          <div className="cleanup__pane">
            <h3>{active ? active.label : 'Select an object'}</h3>
            {active ? (
              <>
                <div className="cleanup__meta">
                  <Badge variant={STATE_VARIANT[active.state]}>{STATE_LABEL[active.state]}</Badge>
                  <span className="cleanup__muted">{active.kind}</span>
                </div>
                {active.reasons.length > 0 && (
                  <ul className="cleanup__reasons">
                    {active.reasons.map((r) => (
                      <li key={r}>
                        <ShieldCheck size={13} /> {r}
                      </li>
                    ))}
                  </ul>
                )}
                <h4>Depends on ({active.dependsOn.length})</h4>
                <ul className="cleanup__links">
                  {active.dependsOn.map((k) => (
                    <li key={k} onClick={() => setSelected(k)}>
                      {graph.byKey[k]?.label ?? k}
                    </li>
                  ))}
                  {active.dependsOn.length === 0 && <li className="cleanup__muted">nothing</li>}
                </ul>
                <h4>Used by ({active.dependents.length})</h4>
                <ul className="cleanup__links">
                  {active.dependents.map((k) => (
                    <li key={k} onClick={() => setSelected(k)}>
                      {graph.byKey[k]?.label ?? k}
                    </li>
                  ))}
                  {active.dependents.length === 0 && <li className="cleanup__muted">nothing</li>}
                </ul>
              </>
            ) : (
              <p className="cleanup__muted">
                Pick an object to see what it depends on, what depends on it, and why it counts as used.
              </p>
            )}
          </div>

          <div className="cleanup__pane cleanup__pane--stage">
            <h3>
              <Trash2 size={15} /> Staged ({staged.length})
            </h3>
            {staged.length === 0 ? (
              <p className="cleanup__muted">Nothing staged. Tick an object to queue it for deletion.</p>
            ) : (
              <>
                <ul className="cleanup__links">
                  {staged.map((k) => (
                    <li key={k} onClick={() => setSelected(k)}>
                      {graph.byKey[k]?.label ?? k}
                    </li>
                  ))}
                </ul>
                {impact.length > 0 && (
                  <div className="cleanup__warn">
                    <TriangleAlert size={15} />
                    <span>
                      <strong>{impact.length} object{impact.length === 1 ? '' : 's'} would break.</strong> Deleting the
                      staged set removes something they still reference.
                    </span>
                  </div>
                )}
                <div className="cleanup__actions">
                  <Button size="sm" onClick={clearStage}>
                    Discard
                  </Button>
                  <Button size="sm" variant="primary" disabled title="Deploy is not wired yet — staging only">
                    Deploy to Power BI
                  </Button>
                </div>
                <p className="cleanup__muted cleanup__fineprint">
                  Staging is local and reversible. Deploy is deliberately disabled until deletion is wired through the
                  bridge with snapshot rollback.
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
