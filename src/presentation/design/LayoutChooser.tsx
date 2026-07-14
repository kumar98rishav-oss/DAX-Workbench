import { X, Check, LayoutTemplate } from 'lucide-react'
import { useApp } from '@/app/store'
import { IconButton } from '@/design-system/components'
import { LAYOUTS } from '@/application/insights/dashboard-generator'
import './layout-chooser.css'

const A = 'var(--accent)'
const M = 'var(--border-strong)'
const S = 'var(--accent-soft)'

/** Small wireframe of each layout's structure. */
function Wireframe({ id }: { id: string }) {
  const box = (x: number, y: number, w: number, h: number, fill: string, key: string) => (
    <rect key={key} x={x} y={y} width={w} height={h} rx={2.5} fill={fill} />
  )
  const kpis4 = [8, 54, 100, 146].map((x, i) => box(x, 8, 40, 16, A, `k${i}`))
  const shapes: JSX.Element[] = []
  switch (id) {
    case 'executive':
      shapes.push(...kpis4, box(8, 32, 120, 42, M, 'a'), box(134, 32, 58, 42, M, 'b'), box(8, 82, 54, 30, M, 'c'), box(70, 82, 54, 30, M, 'd'), box(132, 82, 60, 30, M, 'e'))
      break
    case 'right-filter':
      shapes.push(box(150, 8, 42, 104, S, 'p'), ...[8, 50, 92].map((x, i) => box(x, 8, 38, 16, A, `k${i}`)), box(8, 30, 82, 40, M, 'a'), box(94, 30, 48, 40, M, 'b'), box(8, 76, 82, 36, M, 'c'), box(94, 76, 48, 36, M, 'd'))
      break
    case 'top-filter':
      shapes.push(box(8, 8, 184, 12, S, 'f'), ...[8, 54, 100, 146].map((x, i) => box(x, 26, 40, 14, A, `k${i}`)), box(8, 46, 120, 34, M, 'a'), box(134, 46, 58, 34, M, 'b'), box(8, 84, 90, 28, M, 'c'), box(102, 84, 90, 28, M, 'd'))
      break
    case 'kpi-focus':
      shapes.push(...[8, 72, 136].flatMap((x, i) => [box(x, 8, 56, 20, A, `k${i}`), box(x, 32, 56, 20, A, `k2${i}`)]), box(8, 58, 88, 54, M, 'a'), box(100, 58, 92, 54, M, 'b'))
      break
    case 'chart-grid':
      shapes.push(...[8, 72, 136].flatMap((x, i) => [box(x, 8, 56, 48, M, `g${i}`), box(x, 60, 56, 52, M, `g2${i}`)]))
      break
    case 'table-report':
      shapes.push(...kpis4, box(8, 32, 120, 80, M, 'a'), box(134, 32, 58, 38, M, 'b'), box(134, 74, 58, 38, M, 'c'))
      break
  }
  return (
    <svg viewBox="0 0 200 120" className="lchooser__thumb" preserveAspectRatio="none">
      {shapes}
    </svg>
  )
}

export function LayoutChooser() {
  const open = useApp((s) => s.layoutChooserOpen)
  const toggle = useApp((s) => s.toggleLayoutChooser)
  const applyLayout = useApp((s) => s.applyLayout)
  const current = useApp((s) => s.layoutId)

  if (!open) return null

  return (
    <div className="lchooser__scrim" onMouseDown={(e) => e.target === e.currentTarget && toggle(false)}>
      <div className="lchooser" role="dialog" aria-modal="true" aria-label="Choose a layout">
        <div className="lchooser__head">
          <div>
            <div className="lchooser__title">Choose a layout</div>
            <div className="lchooser__sub">Same data, different structure — pick how the dashboard reads</div>
          </div>
          <IconButton label="Close" onClick={() => toggle(false)}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="lchooser__grid pbs-scroll">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              className="lchooser__card"
              data-active={l.id === current ? 'true' : undefined}
              onClick={() => {
                applyLayout(l.id)
                toggle(false)
              }}
            >
              <Wireframe id={l.id} />
              <div className="lchooser__name">
                <LayoutTemplate size={14} style={{ color: 'var(--accent)' }} />
                {l.name}
                {l.id === current && <Check size={15} className="lchooser__check" />}
              </div>
              <div className="lchooser__desc">{l.description}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
