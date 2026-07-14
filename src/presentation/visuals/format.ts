import type { MeasureKind } from '@/application/insights/kpi-engine'

function fmt(v: number, digits: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: digits })
}

/** Short form for KPI cards and axis ticks (4.8M, 1.2K). */
export function compact(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return fmt(v, a < 10 && !Number.isInteger(v) ? 1 : 0)
}

export function formatMeasure(
  v: number,
  kind: MeasureKind,
  opts: { compact?: boolean } = {},
): string {
  if (kind === 'ratio') return `${(v * 100).toFixed(1)}%`
  const num = opts.compact
    ? compact(v)
    : fmt(v, kind === 'currency' ? 0 : kind === 'count' || kind === 'quantity' ? 0 : 2)
  return kind === 'currency' ? `$${num}` : num
}

/** Prettify a time-bucket label (2024-08 → Aug 2024). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function prettyLabel(label: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(label)
  if (m) return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1].slice(2)}`
  if (label.length > 16) return `${label.slice(0, 15)}…`
  return label
}
