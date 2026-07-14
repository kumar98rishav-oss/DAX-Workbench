import { useEffect, useRef, useState } from 'react'
import type { Visual } from '@/domain/report'
import type { QueryCtx } from '@/application/query/query-engine'
import { resolveVisual } from './resolve'
import type { VisualData } from './resolve'
import { compact, formatMeasure, prettyLabel } from './format'
import './visuals.css'

const VIZ = [
  'var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)',
  'var(--viz-5)', 'var(--viz-6)', 'var(--viz-7)', 'var(--viz-8)',
]

function useSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, ...size }
}

/** The public entry: resolve + render a visual by kind. */
export function VisualRenderer({ visual, ctx }: { visual: Visual; ctx: QueryCtx }) {
  const data = resolveVisual(visual, ctx)

  if (data.type === 'card') {
    return (
      <div className="viz viz--card">
        <span className="viz-card__label">{visual.title}</span>
        <span className="viz-card__value">{formatMeasure(data.value, data.kind, { compact: true })}</span>
      </div>
    )
  }

  return (
    <div className="viz">
      <div className="viz__title">{visual.title}</div>
      <div className="viz__body">
        <VisualBody visual={visual} data={data} />
      </div>
    </div>
  )
}

function VisualBody({ visual, data }: { visual: Visual; data: VisualData }) {
  if (data.type === 'empty') return <div className="viz__empty">{data.reason}</div>
  if (data.type === 'slicer') return <SlicerViz items={data.items} />
  if (data.type === 'rank') return <RankViz data={data} />
  if (data.type === 'series') {
    if (visual.kind === 'line') return <LineViz data={data} />
    if (visual.kind === 'donut' || visual.kind === 'pie') return <DonutViz data={data} />
    return <BarViz data={data} />
  }
  return null
}

// ---------------------------------------------------------------------------
// Line
// ---------------------------------------------------------------------------
function LineViz({ data }: { data: Extract<VisualData, { type: 'series' }> }) {
  const { ref, w, h } = useSize()
  const pts = data.points
  const values = pts.map((p) => p.value)
  const max = Math.max(...values, 1)
  const min = Math.min(0, ...values)
  const pad = { l: 6, r: 6, t: 10, b: 20 }
  const iw = Math.max(1, w - pad.l - pad.r)
  const ih = Math.max(1, h - pad.t - pad.b)
  const n = pts.length
  const xat = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const yat = (v: number) => pad.t + ih - ((v - min) / (max - min || 1)) * ih
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${xat(i).toFixed(1)},${yat(p.value).toFixed(1)}`).join(' ')
  const area = `${line} L${xat(n - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${xat(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`
  const ticks = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1]

  return (
    <div className="viz-chart" ref={ref}>
      {w > 0 && (
        <svg width={w} height={h}>
          <defs>
            <linearGradient id="viz-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--viz-1)" stopOpacity="0.24" />
              <stop offset="100%" stopColor="var(--viz-1)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#viz-area)" />
          <path d={line} fill="none" stroke="var(--viz-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {ticks.map((i) => (
            <text key={i} className="viz-axis" x={xat(i)} y={h - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {prettyLabel(pts[i].label)}
            </text>
          ))}
        </svg>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bar (horizontal)
// ---------------------------------------------------------------------------
function BarViz({ data }: { data: Extract<VisualData, { type: 'series' }> }) {
  const max = Math.max(...data.points.map((p) => p.value), 1)
  return (
    <div className="viz-bars">
      {data.points.map((p, i) => (
        <div className="viz-bar" key={p.label}>
          <span className="viz-bar__label" title={p.label}>{prettyLabel(p.label)}</span>
          <div className="viz-bar__track">
            <div
              className="viz-bar__fill"
              style={{ width: `${(p.value / max) * 100}%`, background: VIZ[i % VIZ.length] }}
            />
          </div>
          <span className="viz-bar__val">{formatMeasure(p.value, data.kind, { compact: true })}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Donut
// ---------------------------------------------------------------------------
function DonutViz({ data }: { data: Extract<VisualData, { type: 'series' }> }) {
  let slices = data.points.slice(0, 6)
  const rest = data.points.slice(6).reduce((s, p) => s + p.value, 0)
  if (rest > 0) slices = [...slices, { label: 'Others', value: rest }]
  const total = slices.reduce((s, p) => s + p.value, 0) || 1
  const r = 42
  const C = 2 * Math.PI * r
  let offset = 0

  return (
    <div className="viz-donut">
      <svg viewBox="0 0 120 120" className="viz-donut__svg">
        <g transform="rotate(-90 60 60)">
          {slices.map((s, i) => {
            const len = (s.value / total) * C
            const el = (
              <circle
                key={s.label}
                cx={60}
                cy={60}
                r={r}
                fill="none"
                stroke={VIZ[i % VIZ.length]}
                strokeWidth={16}
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-offset}
              />
            )
            offset += len
            return el
          })}
        </g>
      </svg>
      <ul className="viz-legend">
        {slices.map((s, i) => (
          <li key={s.label}>
            <span className="viz-legend__dot" style={{ background: VIZ[i % VIZ.length] }} />
            <span className="viz-legend__label" title={s.label}>{prettyLabel(s.label)}</span>
            <span className="viz-legend__val">{Math.round((s.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ranked table
// ---------------------------------------------------------------------------
function RankViz({ data }: { data: Extract<VisualData, { type: 'rank' }> }) {
  const max = Math.max(...data.points.map((p) => p.value), 1)
  return (
    <div className="viz-rank">
      {data.points.map((p, i) => (
        <div className="viz-rank__row" key={p.label}>
          <span className="viz-rank__num">{i + 1}</span>
          <span className="viz-rank__label" title={p.label}>{prettyLabel(p.label)}</span>
          <div className="viz-rank__bar">
            <div className="viz-rank__fill" style={{ width: `${(p.value / max) * 100}%` }} />
          </div>
          <span className="viz-rank__val">{formatMeasure(p.value, data.kind, { compact: true })}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Slicer
// ---------------------------------------------------------------------------
function SlicerViz({ items }: { items: string[] }) {
  return (
    <div className="viz-slicer">
      {items.slice(0, 12).map((it) => (
        <button className="viz-slicer__chip" key={it}>
          {prettyLabel(it)}
        </button>
      ))}
    </div>
  )
}

export { compact }
