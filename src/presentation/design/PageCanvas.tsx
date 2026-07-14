import { useEffect, useRef, useState } from 'react'
import type { Page, Rect, Visual } from '@/domain/report'
import type { QueryCtx } from '@/application/query/query-engine'
import { useApp } from '@/app/store'
import { VisualRenderer } from '@/presentation/visuals/VisualRenderer'
import './design.css'

interface Props {
  page: Page
  ctx: QueryCtx
}

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const GRID = 8
const SNAP = 6
const MIN = 80

interface DragState {
  mode: 'move' | 'resize'
  handle?: Handle
  id: string
  sx: number
  sy: number
  start: Rect
  moved: boolean
}

function snapAxis(pos: number, size: number, targets: number[]): { pos: number; guide: number | null } {
  const anchors = [pos, pos + size / 2, pos + size]
  let best: { d: number; pos: number; guide: number } | null = null
  for (const a of anchors) {
    for (const t of targets) {
      const d = Math.abs(a - t)
      if (d <= SNAP && (!best || d < best.d)) best = { d, pos: pos + (t - a), guide: t }
    }
  }
  if (best) return { pos: best.pos, guide: best.guide }
  return { pos: Math.round(pos / GRID) * GRID, guide: null }
}

export function PageCanvas({ page, ctx }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(1200)
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null })
  const dragRef = useRef<DragState | null>(null)

  const selectedId = useApp((s) => s.selectedVisualId)
  const selectVisual = useApp((s) => s.selectVisual)
  const beginChange = useApp((s) => s.beginChange)
  const setVisualRect = useApp((s) => s.setVisualRect)
  const deleteVisual = useApp((s) => s.deleteVisual)
  const duplicateVisual = useApp((s) => s.duplicateVisual)
  const nudgeVisual = useApp((s) => s.nudgeVisual)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setAvail(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keyboard: delete / nudge / duplicate for the selected visual.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = useApp.getState().selectedVisualId
      if (!id) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteVisual(id)
      } else if (e.key === 'Escape') {
        selectVisual(null)
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        duplicateVisual(id)
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault()
        const step = e.shiftKey ? GRID : 1
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
        if (d) nudgeVisual(id, d[0], d[1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteVisual, duplicateVisual, nudgeVisual, selectVisual])

  const scale = Math.min(1.2, Math.max(0.25, (avail - 56) / page.width))

  const begin = (e: React.PointerEvent, id: string, mode: 'move' | 'resize', handle?: Handle) => {
    e.stopPropagation()
    const v = page.visuals.find((x) => x.id === id)
    if (!v) return
    selectVisual(id)
    dragRef.current = { mode, handle, id, sx: e.clientX, sy: e.clientY, start: v.rect, moved: false }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* pointer capture unsupported — drag still works via stage listeners */
    }
  }

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dx = (e.clientX - d.sx) / scale
    const dy = (e.clientY - d.sy) / scale
    if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 3) return
    if (!d.moved) {
      d.moved = true
      beginChange()
    }

    const siblings = page.visuals.filter((v) => v.id !== d.id)
    const xs = [0, page.width / 2, page.width, ...siblings.flatMap((v) => [v.rect.x, v.rect.x + v.rect.w / 2, v.rect.x + v.rect.w])]
    const ys = [0, page.height / 2, page.height, ...siblings.flatMap((v) => [v.rect.y, v.rect.y + v.rect.h / 2, v.rect.y + v.rect.h])]

    let rect: Rect
    let gx: number | null = null
    let gy: number | null = null

    if (d.mode === 'move') {
      const sx = snapAxis(d.start.x + dx, d.start.w, xs)
      const sy = snapAxis(d.start.y + dy, d.start.h, ys)
      rect = { x: Math.max(0, sx.pos), y: Math.max(0, sy.pos), w: d.start.w, h: d.start.h }
      gx = sx.guide
      gy = sy.guide
    } else {
      const h = d.handle!
      let { x, y, w, h: hh } = d.start
      if (h.includes('e')) w = d.start.w + dx
      if (h.includes('s')) hh = d.start.h + dy
      if (h.includes('w')) {
        x = d.start.x + dx
        w = d.start.w - dx
      }
      if (h.includes('n')) {
        y = d.start.y + dy
        hh = d.start.h - dy
      }
      x = Math.round(x / GRID) * GRID
      y = Math.round(y / GRID) * GRID
      w = Math.max(MIN, Math.round(w / GRID) * GRID)
      hh = Math.max(MIN, Math.round(hh / GRID) * GRID)
      rect = { x: Math.max(0, x), y: Math.max(0, y), w, h: hh }
    }

    setVisualRect(d.id, rect)
    setGuides({ x: gx, y: gy })
  }

  const onUp = () => {
    dragRef.current = null
    setGuides({ x: null, y: null })
  }

  return (
    <div className="pcanvas" ref={ref}>
      <div className="pcanvas__sizer" style={{ width: page.width * scale, height: page.height * scale }}>
        <div
          className="pcanvas__stage"
          style={{ width: page.width, height: page.height, transform: `scale(${scale})` }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerDown={() => selectVisual(null)}
        >
          {page.visuals.map((v) => {
            const selected = v.id === selectedId
            return (
              <div
                key={v.id}
                className="pcanvas__visual"
                data-selected={selected ? 'true' : undefined}
                style={{ left: v.rect.x, top: v.rect.y, width: v.rect.w, height: v.rect.h }}
                onPointerDown={(e) => begin(e, v.id, 'move')}
              >
                <div className="pcanvas__content">
                  <VisualRenderer visual={v} ctx={ctx} />
                </div>
                {selected && (
                  <div className="pcanvas__select" style={{ borderWidth: 2 / scale }}>
                    {HANDLES.map((h) => (
                      <div
                        key={h}
                        className={`pcanvas__handle pcanvas__handle--${h}`}
                        style={{ width: 10 / scale, height: 10 / scale }}
                        onPointerDown={(e) => begin(e, v.id, 'resize', h)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {guides.x !== null && (
            <div className="pcanvas__guide pcanvas__guide--v" style={{ left: guides.x, width: 1 / scale }} />
          )}
          {guides.y !== null && (
            <div className="pcanvas__guide pcanvas__guide--h" style={{ top: guides.y, height: 1 / scale }} />
          )}
        </div>
      </div>
    </div>
  )
}
