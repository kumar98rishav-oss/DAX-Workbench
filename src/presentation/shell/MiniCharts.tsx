/**
 * Lightweight SVG chart stand-ins for the wireframe preview.
 * Real visuals arrive with the Visual Plugin renderers (milestone M3).
 */

export function MiniLine() {
  // A gentle upward series with a soft area fill.
  const pts = [8, 22, 16, 34, 28, 46, 40, 58, 52, 70, 66, 82]
  const w = 100
  const h = 56
  const max = 90
  const step = w / (pts.length - 1)
  const coords = pts.map((p, i) => [i * step, h - (p / max) * h] as const)
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ')
  const area = `${line} L${w},${h} L0,${h} Z`

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="pbs-chart">
      <defs>
        <linearGradient id="pbs-line-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--viz-1)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--viz-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#pbs-line-fill)" />
      <path
        d={line}
        fill="none"
        stroke="var(--viz-1)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export function MiniBars() {
  const bars = [64, 82, 48, 70, 38]
  const gap = 8
  const w = 100
  const h = 56
  const bw = (w - gap * (bars.length - 1)) / bars.length
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="pbs-chart">
      {bars.map((b, i) => {
        const bh = (b / 100) * h
        return (
          <rect
            key={i}
            x={i * (bw + gap)}
            y={h - bh}
            width={bw}
            height={bh}
            rx="1.5"
            fill={i === 1 ? 'var(--viz-1)' : 'var(--viz-8)'}
            opacity={i === 1 ? 1 : 0.55}
          />
        )
      })}
    </svg>
  )
}
