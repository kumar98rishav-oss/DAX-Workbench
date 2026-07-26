import type { UsageGraph, UsageNode } from '@/application/dax/usage'

interface Props {
  graph: UsageGraph
  node: UsageNode
  onPick: (key: string) => void
}

const NODE_W = 188
const NODE_H = 46
const GAP_Y = 16
const COL_GAP = 78
const PAD = 14
const MAX_PER_SIDE = 6

/** Short, human label for a Power BI visual type id. */
export function visualLabel(t: string): string {
  const known: Record<string, string> = {
    card: 'Card',
    multiRowCard: 'Multi-row card',
    kpi: 'KPI',
    table: 'Table',
    tableEx: 'Table',
    pivotTable: 'Matrix',
    matrix: 'Matrix',
    slicer: 'Slicer',
    textbox: 'Text box',
    lineChart: 'Line',
    areaChart: 'Area',
    barChart: 'Bar',
    columnChart: 'Column',
    clusteredBarChart: 'Clustered bar',
    clusteredColumnChart: 'Clustered column',
    stackedBarChart: 'Stacked bar',
    stackedColumnChart: 'Stacked column',
    lineClusteredColumnComboChart: 'Line + column',
    pieChart: 'Pie',
    donutChart: 'Donut',
    treemap: 'Treemap',
    map: 'Map',
    filledMap: 'Filled map',
    scatterChart: 'Scatter',
    gauge: 'Gauge',
    funnel: 'Funnel',
    waterfallChart: 'Waterfall',
    ribbonChart: 'Ribbon',
    actionButton: 'Button',
    shape: 'Shape',
  }
  if (known[t]) return known[t]
  // Fall back to de-camel-casing whatever Power BI called it.
  const spaced = t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const KIND_FILL: Record<string, string> = {
  measure: 'var(--viz-1)',
  column: 'var(--viz-3)',
  table: 'var(--viz-5)',
  visual: 'var(--viz-7)',
}

function truncate(s: string, max = 24): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/**
 * What feeds this object, and where it ends up. Left column is what it depends
 * on, centre is the object itself, right is everything that would break if it
 * were deleted — dependent objects first, then the visuals that bind it.
 */
export function DependencyFlow({ graph, node, onPick }: Props) {
  const left = node.dependsOn.map((k) => graph.byKey[k]).filter(Boolean)
  const rightObjects = node.dependents.map((k) => graph.byKey[k]).filter(Boolean)

  // Visuals are collapsed to one chip per page so the diagram stays readable.
  const byPage = new Map<string, string[]>()
  for (const p of node.placements) {
    const list = byPage.get(p.page) ?? []
    if (!list.includes(p.visualType)) list.push(p.visualType)
    byPage.set(p.page, list)
  }
  const visualChips = [...byPage].map(([page, types]) => ({
    label: page,
    sub: types.map(visualLabel).slice(0, 2).join(', ') + (types.length > 2 ? ` +${types.length - 2}` : ''),
  }))

  const leftShown = left.slice(0, MAX_PER_SIDE)
  const rightShown = [
    ...rightObjects.slice(0, MAX_PER_SIDE).map((n) => ({ key: n.key, label: n.label, sub: n.kind, kind: n.kind })),
    ...visualChips.slice(0, MAX_PER_SIDE).map((v) => ({ key: '', label: v.label, sub: v.sub, kind: 'visual' })),
  ].slice(0, MAX_PER_SIDE + 2)

  const rows = Math.max(leftShown.length, rightShown.length, 1)
  const height = rows * NODE_H + (rows - 1) * GAP_Y + PAD * 2
  const width = NODE_W * 3 + COL_GAP * 2 + PAD * 2

  const colX = [PAD, PAD + NODE_W + COL_GAP, PAD + (NODE_W + COL_GAP) * 2]
  const centreY = height / 2 - NODE_H / 2

  /** Stack a column vertically, centred against the middle node. */
  const yFor = (i: number, count: number) => {
    const block = count * NODE_H + (count - 1) * GAP_Y
    return height / 2 - block / 2 + i * (NODE_H + GAP_Y)
  }

  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const mx = (x1 + x2) / 2
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
  }

  return (
    <div className="depflow">
      <div className="depflow__legend">
        <span><i style={{ background: 'var(--viz-3)' }} /> column</span>
        <span><i style={{ background: 'var(--viz-1)' }} /> measure</span>
        <span><i style={{ background: 'var(--viz-5)' }} /> table</span>
        <span><i style={{ background: 'var(--viz-7)' }} /> report page</span>
      </div>

      <svg className="depflow__svg" viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={`Dependency flow for ${node.label}`}>
        <defs>
          <marker id="depflow-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
          </marker>
        </defs>

        {/* edges in first, so nodes paint over their ends */}
        {leftShown.map((n, i) => (
          <path key={`e-l-${n.key}`} className="depflow__edge"
                d={curve(colX[0] + NODE_W, yFor(i, leftShown.length) + NODE_H / 2, colX[1], centreY + NODE_H / 2)}
                markerEnd="url(#depflow-arrow)" />
        ))}
        {rightShown.map((r, i) => (
          <path key={`e-r-${r.key || r.label}-${i}`} className="depflow__edge"
                d={curve(colX[1] + NODE_W, centreY + NODE_H / 2, colX[2], yFor(i, rightShown.length) + NODE_H / 2)}
                markerEnd="url(#depflow-arrow)" />
        ))}

        {/* depends on */}
        {leftShown.map((n, i) => (
          <g key={n.key} className="depflow__node" onClick={() => onPick(n.key)} role="button" tabIndex={0}
             onKeyDown={(e) => e.key === 'Enter' && onPick(n.key)}>
            <rect x={colX[0]} y={yFor(i, leftShown.length)} width={NODE_W} height={NODE_H} rx="12" />
            <rect x={colX[0]} y={yFor(i, leftShown.length)} width="5" height={NODE_H} rx="2.5"
                  fill={KIND_FILL[n.kind]} />
            <text x={colX[0] + 16} y={yFor(i, leftShown.length) + 20} className="depflow__label">
              {truncate(n.label)}
            </text>
            <text x={colX[0] + 16} y={yFor(i, leftShown.length) + 36} className="depflow__sub">{n.kind}</text>
          </g>
        ))}

        {/* the selected object */}
        <g className="depflow__node depflow__node--self">
          <rect x={colX[1]} y={centreY} width={NODE_W} height={NODE_H} rx="12" />
          <rect x={colX[1]} y={centreY} width="5" height={NODE_H} rx="2.5" fill={KIND_FILL[node.kind]} />
          <text x={colX[1] + 16} y={centreY + 20} className="depflow__label">{truncate(node.label)}</text>
          <text x={colX[1] + 16} y={centreY + 36} className="depflow__sub">
            {node.kind} · {node.state === 'referenced' ? 'in use' : node.state === 'unused' ? 'unused' : 'unproven'}
          </text>
        </g>

        {/* used by */}
        {rightShown.map((r, i) => (
          <g key={`${r.key || r.label}-${i}`} className="depflow__node"
             onClick={() => r.key && onPick(r.key)} role={r.key ? 'button' : undefined}
             tabIndex={r.key ? 0 : undefined}
             onKeyDown={(e) => r.key && e.key === 'Enter' && onPick(r.key)}>
            <rect x={colX[2]} y={yFor(i, rightShown.length)} width={NODE_W} height={NODE_H} rx="12" />
            <rect x={colX[2]} y={yFor(i, rightShown.length)} width="5" height={NODE_H} rx="2.5"
                  fill={KIND_FILL[r.kind] ?? KIND_FILL.visual} />
            <text x={colX[2] + 16} y={yFor(i, rightShown.length) + 20} className="depflow__label">
              {truncate(r.label)}
            </text>
            <text x={colX[2] + 16} y={yFor(i, rightShown.length) + 36} className="depflow__sub">
              {truncate(r.sub, 26)}
            </text>
          </g>
        ))}

        {leftShown.length === 0 && (
          <text x={colX[0] + NODE_W / 2} y={height / 2} className="depflow__empty" textAnchor="middle">
            depends on nothing
          </text>
        )}
        {rightShown.length === 0 && (
          <text x={colX[2] + NODE_W / 2} y={height / 2} className="depflow__empty" textAnchor="middle">
            nothing uses it
          </text>
        )}
      </svg>

      {(left.length > leftShown.length || rightObjects.length > MAX_PER_SIDE) && (
        <p className="depflow__more">
          Showing the first {MAX_PER_SIDE} on each side
          {left.length > leftShown.length && ` — ${left.length - leftShown.length} more upstream`}
          {rightObjects.length > MAX_PER_SIDE && ` — ${rightObjects.length - MAX_PER_SIDE} more downstream`}.
        </p>
      )}
    </div>
  )
}
