import { useEffect, useMemo, useState } from 'react'
import { Eraser, Undo2, Redo2, Trash2, TriangleAlert, ShieldCheck, CircleHelp, FileSearch, FolderSearch, Search, X } from 'lucide-react'
import { useApp } from '@/app/store'
import { Badge, Button, EmptyState, Segmented } from '@/design-system/components'
import {
  buildUsageGraph,
  cascadeImpact,
  type ObjectKind,
  type UsageNode,
  type UsageState,
} from '@/application/dax/usage'
import { DependencyFlow, visualLabel } from './DependencyFlow'
import { DeployDialog } from './DeployDialog'
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

  const reportUsage = useApp((s) => s.reportUsage)
  const reportScanNote = useApp((s) => s.reportScanNote)
  const reportScanning = useApp((s) => s.reportScanning)
  const requestReportScan = useApp((s) => s.requestReportScan)
  const requestReportFolderScan = useApp((s) => s.requestReportFolderScan)
  const clearReportUsage = useApp((s) => s.clearReportUsage)
  const deployCleanup = useApp((s) => s.deployCleanup)
  const restoreDeleted = useApp((s) => s.restoreDeleted)
  const dismissCleanupResult = useApp((s) => s.dismissCleanupResult)
  const cleanupDeploying = useApp((s) => s.cleanupDeploying)
  const cleanupResult = useApp((s) => s.cleanupResult)
  const desktopConnected = useApp((s) => s.desktop.connected)
  const [confirmDeploy, setConfirmDeploy] = useState(false)

  // "Unused" is only reachable once the report layer has actually been read.
  const graph = useMemo(() => buildUsageGraph(model, reportUsage), [model, reportUsage])

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

  // Escape closes the inspector — it covers most of the page when open.
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])
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
          {graph.scanned ? (
            <span className="cleanup__stat cleanup__stat--unused">
              <strong>{counts.unused}</strong> unused
            </span>
          ) : (
            <span className="cleanup__stat cleanup__stat--warn">
              <strong>{counts['no-model-refs']}</strong> no model refs
            </span>
          )}
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

      {!graph.scanned ? (
        <div className="cleanup__notice">
          <CircleHelp size={15} />
          <span>
            <strong>Report layer not scanned.</strong> The Analysis Services engine exposes the model only — it cannot
            see which visuals bind a measure. Objects below are marked <em>no model refs</em>, never <em>unused</em>:
            nothing in the model references them, but a report page still might.
          </span>
          <span className="cleanup__notice-actions">
            <Button size="sm" icon={<FileSearch size={15} />} onClick={requestReportScan} disabled={reportScanning}>
              {reportScanning ? 'Scanning…' : 'Scan .pbix'}
            </Button>
            <Button size="sm" icon={<FolderSearch size={15} />} onClick={requestReportFolderScan} disabled={reportScanning}>
              {reportScanning ? 'Scanning…' : 'Scan PBIP folder'}
            </Button>
          </span>
        </div>
      ) : (
        <div className="cleanup__notice cleanup__notice--ok">
          <ShieldCheck size={15} />
          <span>
            <strong>Report layer scanned.</strong> {reportScanNote} A measure bound to any visual counts as used, so
            objects marked <em>unused</em> below are unreferenced by both the model and the report.
          </span>
          <Button size="sm" onClick={clearReportUsage}>
            Clear
          </Button>
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

        {active && (
          <button className="cleanup__scrim" aria-label="Close details" onClick={() => setSelected(null)} />
        )}
        <aside className={`cleanup__aside ${active ? 'is-wide' : ''}`}>
          {active ? (
            <div className="cleanup__detail">
              <header className="cleanup__detailhead">
                <div>
                  <h3>{active.label}</h3>
                  <div className="cleanup__meta">
                    <Badge variant={STATE_VARIANT[active.state]}>{STATE_LABEL[active.state]}</Badge>
                    <span className="cleanup__muted">{active.kind}</span>
                    {active.reportRefs > 0 && (
                      <span className="cleanup__muted">
                        · {active.reportRefs} binding{active.reportRefs === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </div>
                <button className="cleanup__close" aria-label="Close details" onClick={() => setSelected(null)}>
                  <X size={16} />
                </button>
              </header>

              {active.reasons.length > 0 && (
                <ul className="cleanup__reasons">
                  {active.reasons.map((r) => (
                    <li key={r}>
                      <ShieldCheck size={13} /> {r}
                    </li>
                  ))}
                </ul>
              )}

              <h4>Dependency flow</h4>
              <DependencyFlow graph={graph} node={active} onPick={setSelected} />

              <h4>Where it appears in the report</h4>
              {!graph.scanned ? (
                <p className="cleanup__muted">
                  Scan a report above and this will list every page and visual that binds it.
                </p>
              ) : active.placements.length === 0 ? (
                <p className="cleanup__muted">No visual on any scanned page binds it.</p>
              ) : (
                <div className="cleanup__tablewrap">
                  <table className="cleanup__table">
                    <thead>
                      <tr>
                        <th>Page</th>
                        <th>Visual</th>
                      </tr>
                    </thead>
                    <tbody>
                      {active.placements.map((p) => (
                        <tr key={`${p.page}-${p.visualType}`}>
                          <td>{p.page}</td>
                          <td>
                            <span className="cleanup__vtype">{visualLabel(p.visualType)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {active.kind === 'measure' && (
                <>
                  <h4>DAX</h4>
                  {active.dax?.trim() ? (
                    <pre className="cleanup__dax">
                      <code>{active.dax.trim()}</code>
                    </pre>
                  ) : (
                    <p className="cleanup__muted">No expression available for this measure.</p>
                  )}
                </>
              )}

              {staged.length > 0 && (
                <div className="cleanup__stagebar">
                  <Trash2 size={15} />
                  <span>
                    <strong>{staged.length}</strong> staged
                    {impact.length > 0 && ` · ${impact.length} would break`}
                  </span>
                  <Button size="sm" onClick={clearStage}>
                    Discard
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setConfirmDeploy(true)}
                    disabled={!desktopConnected || cleanupDeploying}
                    title={desktopConnected ? 'Delete the staged measures from the live model' : 'Connect to Power BI Desktop first'}
                  >
                    Deploy to Power BI
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="cleanup__pane cleanup__pane--stage">
              <h3>
                <Trash2 size={15} /> Staged ({staged.length})
              </h3>
              {staged.length === 0 ? (
                <p className="cleanup__muted">
                  Pick an object to see what it depends on, where it appears in the report, and its DAX.
                </p>
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
                        <strong>{impact.length} object{impact.length === 1 ? '' : 's'} would break.</strong> Deleting
                        the staged set removes something they still reference.
                      </span>
                    </div>
                  )}
                  <div className="cleanup__actions">
                    <Button size="sm" onClick={clearStage}>
                      Discard
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => setConfirmDeploy(true)}
                      disabled={!desktopConnected || cleanupDeploying}
                      title={desktopConnected ? 'Delete the staged measures from the live model' : 'Connect to Power BI Desktop first'}
                    >
                      Deploy to Power BI
                    </Button>
                  </div>
                  <p className="cleanup__muted cleanup__fineprint">
                    Staging is local and reversible. Deploy deletes measures from the live model — all or nothing,
                    with a snapshot kept so they can be restored.
                  </p>
                </>
              )}
            </div>
          )}
        </aside>
      </div>

      {confirmDeploy && (
        <DeployDialog
          graph={graph}
          staged={staged}
          impact={impact}
          busy={cleanupDeploying}
          onCancel={() => setConfirmDeploy(false)}
          onConfirm={() => {
            void deployCleanup().then(() => setConfirmDeploy(false))
          }}
        />
      )}

      {cleanupResult && (
        <div className="cleanup__result" role="status">
          <ShieldCheck size={16} />
          <span>
            Deleted <strong>{cleanupResult.deleted}</strong> measure{cleanupResult.deleted === 1 ? '' : 's'}. A
            snapshot of their DAX is held for this session only.
          </span>
          <Button size="sm" onClick={() => void restoreDeleted()} disabled={cleanupDeploying}>
            {cleanupDeploying ? 'Restoring…' : 'Restore them'}
          </Button>
          <button className="cleanup__close" aria-label="Dismiss" onClick={dismissCleanupResult}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
