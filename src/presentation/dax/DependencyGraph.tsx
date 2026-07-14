import { useMemo } from 'react'
import type { SemanticModel } from '@/domain/model'
import { parseDependencies } from '@/application/dax/dependencies'
import './dependency-graph.css'

interface Props {
  expression: string
  name: string
  model: SemanticModel
}

const TYPE_COLOR: Record<string, string> = {
  column: 'var(--viz-1)',
  table: 'var(--viz-2)',
  measure: 'var(--viz-4)',
}

const clip = (s: string, n = 20) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function DependencyGraph({ expression, name, model }: Props) {
  const deps = useMemo(() => parseDependencies(expression, model, name), [expression, model, name])

  const nodes = [
    ...deps.columns.map((c) => ({ label: `${c.table}[${c.column}]`, type: 'column' as const })),
    ...deps.measures.map((m) => ({ label: m, type: 'measure' as const })),
    ...deps.tables.map((t) => ({ label: t, type: 'table' as const })),
  ]
  const shown = nodes.slice(0, 8)
  const extra = nodes.length - shown.length

  const W = 460
  const H = 220
  const cx = W / 2
  const cy = H / 2
  const rx = 168
  const ry = 78

  const pos = shown.map((n, i) => {
    const a = shown.length === 1 ? -Math.PI / 2 : (i / shown.length) * Math.PI * 2 - Math.PI / 2
    return { ...n, x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry }
  })

  const nodeBox = (label: string) => Math.min(150, clip(label).length * 6.6 + 20)

  return (
    <div className="depgraph">
      <svg viewBox={`0 0 ${W} ${H}`} className="depgraph__svg" preserveAspectRatio="xMidYMid meet">
        {pos.map((n, i) => (
          <line key={`l${i}`} x1={cx} y1={cy} x2={n.x} y2={n.y} stroke="var(--border-strong)" strokeWidth={1.2} />
        ))}
        {/* dependency nodes */}
        {pos.map((n, i) => {
          const w = nodeBox(n.label)
          return (
            <g key={`n${i}`}>
              <rect x={n.x - w / 2} y={n.y - 12} width={w} height={24} rx={12} fill="var(--surface)" stroke={TYPE_COLOR[n.type]} strokeWidth={1.5} />
              <circle cx={n.x - w / 2 + 11} cy={n.y} r={3.5} fill={TYPE_COLOR[n.type]} />
              <text x={n.x - w / 2 + 20} y={n.y} className="depgraph__nlabel" dominantBaseline="central">{clip(n.label)}</text>
            </g>
          )
        })}
        {/* center measure node */}
        <rect x={cx - 78} y={cy - 16} width={156} height={32} rx={8} fill="var(--accent)" />
        <text x={cx} y={cy} className="depgraph__center" textAnchor="middle" dominantBaseline="central">{clip(name, 22)}</text>
      </svg>

      <div className="depgraph__legend">
        <span><i style={{ background: 'var(--viz-1)' }} /> Column</span>
        <span><i style={{ background: 'var(--viz-4)' }} /> Measure</span>
        <span><i style={{ background: 'var(--viz-2)' }} /> Table</span>
        {extra > 0 && <span className="depgraph__more">+{extra} more</span>}
      </div>

      {deps.functions.length > 0 && (
        <div className="depgraph__fns">
          {deps.functions.map((f) => (
            <span key={f} className="depgraph__fn">{f}</span>
          ))}
        </div>
      )}
      {nodes.length === 0 && <div className="depgraph__empty">No table or column dependencies detected.</div>}
    </div>
  )
}
