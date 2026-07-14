import { useEffect, useRef, useState } from 'react'
import type { Visual } from '@/domain/report'
import type { QueryCtx } from '@/application/query/query-engine'
import { resolveVisual } from './resolve'
import type { VisualData } from './resolve'
import { formatMeasure, prettyLabel } from './format'
import './visuals.css'

const VIZ = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)', 'var(--viz-7)', 'var(--viz-8)']

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

export function VisualRenderer({ visual, ctx }: { visual: Visual; ctx: QueryCtx }) {
  const data = resolveVisual(visual, ctx)
  const kind = visual.kind

  if (kind === 'card' || kind === 'kpi') {
    if (data.type === 'card')
      return (
        <div className="viz viz--card">
          <span className="viz-card__label">{visual.title}</span>
          <span className="viz-card__value">{formatMeasure(data.value, data.kind, { compact: true })}</span>
        </div>
      )
  }

  if (kind === 'text' && data.type === 'text') {
    return (
      <div className="viz-text">
        <div className="viz-text__title">{data.title}</div>
        {data.subtitle && <div className="viz-text__sub">{data.subtitle}</div>}
      </div>
    )
  }

  return (
    <div className="viz">
      <div className="viz__title">{visual.title}</div>
      <div className="viz__body">
        <Body visual={visual} data={data} />
      </div>
    </div>
  )
}

function Body({ visual, data }: { visual: Visual; data: VisualData }) {
  if (data.type === 'empty') return <div className="viz__empty">{data.reason}</div>
  const k = visual.kind
  if (data.type === 'multi') return <MultiCard data={data} />
  if (data.type === 'matrix') return <MatrixViz data={data} />
  if (data.type === 'scatter') return <ScatterViz data={data} />
  if (data.type === 'rank') return <RankViz data={data} />
  if (data.type === 'slicer') return <SlicerViz items={data.items} />
  if (data.type === 'card') return <GaugeViz value={data.value} kind={data.kind} />
  if (data.type === 'series') {
    if (k === 'line' || k === 'area') return <LineViz data={data} area={k === 'area'} />
    if (k === 'donut' || k === 'pie') return <DonutViz data={data} pie={k === 'pie'} />
    if (k === 'funnel') return <FunnelViz data={data} />
    if (k === 'treemap') return <TreemapViz data={data} />
    if (k === 'waterfall') return <WaterfallViz data={data} />
    if (k === 'column' || k === 'stackedBar') return <ColumnViz data={data} />
    return <BarViz data={data} />
  }
  return null
}

type Series = Extract<VisualData, { type: 'series' }>

// ---------------- Line / Area ----------------
function LineViz({ data, area }: { data: Series; area?: boolean }) {
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
  const fill = `${line} L${xat(n - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${xat(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`
  const ticks = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1]
  return (
    <div className="viz-chart" ref={ref}>
      {w > 0 && (
        <svg width={w} height={h}>
          <defs>
            <linearGradient id="viz-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--viz-1)" stopOpacity={area ? 0.34 : 0.22} />
              <stop offset="100%" stopColor="var(--viz-1)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={fill} fill="url(#viz-area)" />
          <path d={line} fill="none" stroke="var(--viz-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {ticks.map((i) => (
            <text key={i} className="viz-axis" x={xat(i)} y={h - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{prettyLabel(pts[i].label)}</text>
          ))}
        </svg>
      )}
    </div>
  )
}

// ---------------- Column (vertical) ----------------
function ColumnViz({ data }: { data: Series }) {
  const { ref, w, h } = useSize()
  const pts = data.points
  const max = Math.max(...pts.map((p) => p.value), 1)
  const pad = { l: 6, r: 6, t: 12, b: 22 }
  const iw = Math.max(1, w - pad.l - pad.r)
  const ih = Math.max(1, h - pad.t - pad.b)
  const n = pts.length
  const band = iw / Math.max(1, n)
  const bw = band * 0.62
  return (
    <div className="viz-chart" ref={ref}>
      {w > 0 && (
        <svg width={w} height={h}>
          {pts.map((p, i) => {
            const bh = (p.value / max) * ih
            const x = pad.l + i * band + (band - bw) / 2
            return <rect key={i} x={x} y={pad.t + ih - bh} width={bw} height={bh} rx={2} fill="var(--viz-1)" opacity={0.9} />
          })}
          {pts.map((p, i) => (n <= 8 || i % Math.ceil(n / 6) === 0) && (
            <text key={`t${i}`} className="viz-axis" x={pad.l + i * band + band / 2} y={h - 6} textAnchor="middle">{prettyLabel(p.label).slice(0, 6)}</text>
          ))}
        </svg>
      )}
    </div>
  )
}

// ---------------- Bar (horizontal) ----------------
function BarViz({ data }: { data: Series }) {
  const max = Math.max(...data.points.map((p) => p.value), 1)
  return (
    <div className="viz-bars">
      {data.points.map((p, i) => (
        <div className="viz-bar" key={p.label}>
          <span className="viz-bar__label" title={p.label}>{prettyLabel(p.label)}</span>
          <div className="viz-bar__track"><div className="viz-bar__fill" style={{ width: `${(p.value / max) * 100}%`, background: VIZ[i % VIZ.length] }} /></div>
          <span className="viz-bar__val">{formatMeasure(p.value, data.kind, { compact: true })}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------- Donut / Pie ----------------
function DonutViz({ data, pie }: { data: Series; pie?: boolean }) {
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
            const el = <circle key={s.label} cx={60} cy={60} r={r} fill="none" stroke={VIZ[i % VIZ.length]} strokeWidth={pie ? 84 : 16} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />
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

// ---------------- Funnel ----------------
function FunnelViz({ data }: { data: Series }) {
  const max = Math.max(...data.points.map((p) => p.value), 1)
  return (
    <div className="viz-funnel">
      {data.points.map((p, i) => (
        <div className="viz-funnel__row" key={p.label}>
          <span className="viz-funnel__bar" style={{ width: `${(p.value / max) * 100}%`, background: VIZ[i % VIZ.length] }}>
            <span className="viz-funnel__label">{prettyLabel(p.label)}</span>
          </span>
          <span className="viz-funnel__val">{formatMeasure(p.value, data.kind, { compact: true })}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------- Treemap (slice layout) ----------------
interface TRect { label: string; value: number; x: number; y: number; w: number; h: number; i: number }
function slice(items: { label: string; value: number; i: number }[], x: number, y: number, w: number, h: number, horiz: boolean, out: TRect[]) {
  if (items.length === 0) return
  if (items.length === 1) { out.push({ ...items[0], x, y, w, h }); return }
  const total = items.reduce((s, it) => s + it.value, 0) || 1
  let acc = 0, cut = 0
  for (let k = 0; k < items.length; k++) { acc += items[k].value; cut = k + 1; if (acc >= total / 2) break }
  const a = items.slice(0, cut), b = items.slice(cut)
  const frac = a.reduce((s, it) => s + it.value, 0) / total
  if (horiz) {
    slice(a, x, y, w * frac, h, !horiz, out)
    slice(b, x + w * frac, y, w * (1 - frac), h, !horiz, out)
  } else {
    slice(a, x, y, w, h * frac, !horiz, out)
    slice(b, x, y + h * frac, w, h * (1 - frac), !horiz, out)
  }
}
function TreemapViz({ data }: { data: Series }) {
  const { ref, w, h } = useSize()
  const items = data.points.slice(0, 12).map((p, i) => ({ label: p.label, value: Math.max(p.value, 0.0001), i }))
  const out: TRect[] = []
  if (w > 0 && items.length) slice(items, 0, 0, w, h, true, out)
  return (
    <div className="viz-chart" ref={ref}>
      {out.map((r) => (
        <div key={r.i} className="viz-treemap__cell" style={{ left: r.x, top: r.y, width: Math.max(0, r.w - 2), height: Math.max(0, r.h - 2), background: VIZ[r.i % VIZ.length] }} title={`${r.label}: ${formatMeasure(r.value, data.kind)}`}>
          {r.w > 52 && r.h > 26 && <span className="viz-treemap__label">{prettyLabel(r.label)}</span>}
        </div>
      ))}
    </div>
  )
}

// ---------------- Waterfall ----------------
function WaterfallViz({ data }: { data: Series }) {
  const { ref, w, h } = useSize()
  const pts = data.points
  let cum = 0
  const steps = pts.map((p) => { const start = cum; cum += p.value; return { label: p.label, start, end: cum } })
  const max = Math.max(cum, 1)
  const pad = { l: 6, r: 6, t: 12, b: 22 }
  const iw = Math.max(1, w - pad.l - pad.r)
  const ih = Math.max(1, h - pad.t - pad.b)
  const band = iw / Math.max(1, steps.length)
  const bw = band * 0.6
  return (
    <div className="viz-chart" ref={ref}>
      {w > 0 && (
        <svg width={w} height={h}>
          {steps.map((s, i) => {
            const y0 = pad.t + ih - (s.end / max) * ih
            const y1 = pad.t + ih - (s.start / max) * ih
            const x = pad.l + i * band + (band - bw) / 2
            return <rect key={i} x={x} y={Math.min(y0, y1)} width={bw} height={Math.max(2, Math.abs(y1 - y0))} rx={2} fill="var(--viz-1)" opacity={0.85} />
          })}
          {steps.map((s, i) => (steps.length <= 8 || i % Math.ceil(steps.length / 6) === 0) && (
            <text key={`t${i}`} className="viz-axis" x={pad.l + i * band + band / 2} y={h - 6} textAnchor="middle">{prettyLabel(s.label).slice(0, 6)}</text>
          ))}
        </svg>
      )}
    </div>
  )
}

// ---------------- Gauge ----------------
function GaugeViz({ value, kind }: { value: number; kind: Series['kind'] }) {
  const frac = kind === 'ratio' ? Math.max(0, Math.min(1, value)) : 0.66
  const r = 52
  const C = Math.PI * r // semicircle
  return (
    <div className="viz-gauge">
      <svg viewBox="0 0 130 78" className="viz-gauge__svg">
        <path d="M 13 65 A 52 52 0 0 1 117 65" fill="none" stroke="var(--surface-2)" strokeWidth={12} strokeLinecap="round" />
        <path d="M 13 65 A 52 52 0 0 1 117 65" fill="none" stroke="var(--viz-1)" strokeWidth={12} strokeLinecap="round" strokeDasharray={`${frac * C} ${C}`} />
      </svg>
      <div className="viz-gauge__value">{formatMeasure(value, kind, { compact: true })}</div>
    </div>
  )
}

// ---------------- Scatter ----------------
function ScatterViz({ data }: { data: Extract<VisualData, { type: 'scatter' }> }) {
  const { ref, w, h } = useSize()
  const xs = data.points.map((p) => p.x), ys = data.points.map((p) => p.y)
  const xmax = Math.max(...xs, 1), ymax = Math.max(...ys, 1)
  const pad = { l: 28, r: 8, t: 8, b: 22 }
  const iw = Math.max(1, w - pad.l - pad.r), ih = Math.max(1, h - pad.t - pad.b)
  return (
    <div className="viz-chart" ref={ref}>
      {w > 0 && (
        <svg width={w} height={h}>
          <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + ih} stroke="var(--border)" />
          <line x1={pad.l} y1={pad.t + ih} x2={pad.l + iw} y2={pad.t + ih} stroke="var(--border)" />
          {data.points.map((p, i) => (
            <circle key={i} cx={pad.l + (p.x / xmax) * iw} cy={pad.t + ih - (p.y / ymax) * ih} r={5} fill="var(--viz-1)" opacity={0.7}>
              <title>{`${p.label}\n${data.xName}: ${p.x}\n${data.yName}: ${p.y}`}</title>
            </circle>
          ))}
          <text className="viz-axis" x={pad.l + iw} y={h - 6} textAnchor="end">{data.xName}</text>
          <text className="viz-axis" x={4} y={pad.t + 8} transform={`rotate(-90 10 ${pad.t + 8})`}>{data.yName}</text>
        </svg>
      )}
    </div>
  )
}

// ---------------- Matrix ----------------
function MatrixViz({ data }: { data: Extract<VisualData, { type: 'matrix' }> }) {
  return (
    <div className="viz-matrix">
      <div className="viz-matrix__row viz-matrix__row--head" style={{ gridTemplateColumns: `1.4fr repeat(${data.columns.length}, 1fr)` }}>
        <span>{data.catName}</span>
        {data.columns.map((c) => <span key={c.name} className="viz-matrix__num">{c.name}</span>)}
      </div>
      <div className="viz-matrix__body">
        {data.rows.map((r) => (
          <div key={r.label} className="viz-matrix__row" style={{ gridTemplateColumns: `1.4fr repeat(${data.columns.length}, 1fr)` }}>
            <span className="viz-matrix__label" title={r.label}>{prettyLabel(r.label)}</span>
            {r.values.map((v, i) => <span key={i} className="viz-matrix__num">{formatMeasure(v, data.columns[i].kind, { compact: true })}</span>)}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------- Multi-row card ----------------
function MultiCard({ data }: { data: Extract<VisualData, { type: 'multi' }> }) {
  return (
    <div className="viz-multi">
      {data.items.map((it) => (
        <div key={it.name} className="viz-multi__row">
          <span className="viz-multi__name">{it.name}</span>
          <span className="viz-multi__val">{formatMeasure(it.value, it.kind, { compact: true })}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------- Ranked table ----------------
function RankViz({ data }: { data: Extract<VisualData, { type: 'rank' }> }) {
  const max = Math.max(...data.points.map((p) => p.value), 1)
  return (
    <div className="viz-rank">
      {data.points.map((p, i) => (
        <div className="viz-rank__row" key={p.label}>
          <span className="viz-rank__num">{i + 1}</span>
          <span className="viz-rank__label" title={p.label}>{prettyLabel(p.label)}</span>
          <div className="viz-rank__bar"><div className="viz-rank__fill" style={{ width: `${(p.value / max) * 100}%` }} /></div>
          <span className="viz-rank__val">{formatMeasure(p.value, data.kind, { compact: true })}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------- Slicer ----------------
function SlicerViz({ items }: { items: string[] }) {
  return (
    <div className="viz-slicer">
      {items.slice(0, 14).map((it) => (
        <button className="viz-slicer__chip" key={it}>{prettyLabel(it)}</button>
      ))}
    </div>
  )
}
