import { TriangleAlert, Trash2, X } from 'lucide-react'
import { Button } from '@/design-system/components'
import type { UsageGraph, UsageNode } from '@/application/dax/usage'

interface Props {
  graph: UsageGraph
  staged: string[]
  impact: string[]
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Measures whose usage is INDIRECT and therefore unprovable from the report.
 * A what-if or field parameter is driven by a slicer, not bound by name, so it
 * can look unused when it is load-bearing. Worth naming before a delete.
 */
function slicerDriven(node: UsageNode): boolean {
  const dax = (node.dax ?? '').toUpperCase()
  return /\bSELECTEDVALUE\s*\(/.test(dax) || /\bGENERATESERIES\s*\(/.test(dax)
}

export function DeployDialog({ graph, staged, impact, busy, onCancel, onConfirm }: Props) {
  const nodes = staged.map((k) => graph.byKey[k]).filter(Boolean)
  const measures = nodes.filter((n) => n.kind === 'measure')
  const others = nodes.filter((n) => n.kind !== 'measure')
  const risky = measures.filter(slicerDriven)
  const breaks = impact.map((k) => graph.byKey[k]).filter(Boolean)

  return (
    <div className="impdlg__scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="impdlg impdlg--wide" role="dialog" aria-modal="true" aria-label="Deploy deletions">
        <div className="impdlg__head">
          <div>
            <div className="impdlg__title">
              Delete {measures.length} measure{measures.length === 1 ? '' : 's'} from the live model?
            </div>
            <div className="impdlg__sub">
              This writes to the model Power BI Desktop currently has open.
            </div>
          </div>
          <button className="cleanup__close" aria-label="Cancel" onClick={onCancel} disabled={busy}>
            <X size={16} />
          </button>
        </div>

        <div className="impdlg__body pbs-scroll">
          <div className="dep__note">
            <TriangleAlert size={15} />
            <span>
              <strong>The engine has no undo.</strong> The Workbench keeps a snapshot of every deleted measure's
              DAX so it can be put back, but only while this session is open. Save nothing in Desktop until you are
              sure.
            </span>
          </div>

          {breaks.length > 0 && (
            <div className="dep__note dep__note--stop">
              <TriangleAlert size={15} />
              <span>
                <strong>{breaks.length} object{breaks.length === 1 ? '' : 's'} will break.</strong>{' '}
                {breaks.slice(0, 6).map((n) => n.label).join(', ')}
                {breaks.length > 6 && ` and ${breaks.length - 6} more`} reference something in this batch.
              </span>
            </div>
          )}

          {risky.length > 0 && (
            <div className="dep__note dep__note--warn">
              <TriangleAlert size={15} />
              <span>
                <strong>{risky.length} may be slicer-driven.</strong>{' '}
                {risky.map((n) => n.label).join(', ')} use SELECTEDVALUE or GENERATESERIES, the signature of
                what-if and field parameters. Those are driven by a slicer rather than bound to a visual by name,
                so the report scan cannot prove they are unused. Check them by hand.
              </span>
            </div>
          )}

          {others.length > 0 && (
            <div className="dep__note dep__note--warn">
              <TriangleAlert size={15} />
              <span>
                <strong>{others.length} non-measure object{others.length === 1 ? '' : 's'} will be skipped.</strong>{' '}
                {others.map((n) => n.label).join(', ')} — columns and tables carry relationships and hierarchies
                that cannot be restored from a snapshot, so deleting them is not supported here.
              </span>
            </div>
          )}

          <h4 className="dep__h">To be deleted</h4>
          <ul className="dep__list">
            {measures.map((n) => (
              <li key={n.key}>
                <span className="dep__name">{n.label}</span>
                <span className="dep__where">
                  {n.reportRefs > 0
                    ? `${n.reportRefs} visual binding${n.reportRefs === 1 ? '' : 's'}`
                    : graph.scanned
                      ? 'no visual binds it'
                      : 'report not scanned'}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="impdlg__foot">
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Trash2 size={15} />}
            onClick={onConfirm}
            disabled={busy || measures.length === 0}
          >
            {busy ? 'Deleting…' : `Delete ${measures.length} measure${measures.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
