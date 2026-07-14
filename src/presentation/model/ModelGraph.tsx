import { useEffect, useMemo, useRef, useState } from 'react'
import { KeyRound, Link2, Table2, Calendar, Shapes, Boxes } from 'lucide-react'
import type { Relationship, Table, TableRole } from '@/domain/model'

interface Props {
  tables: Table[]
  relationships: Relationship[]
}

interface Pos {
  x: number
  y: number
}
interface Box extends Pos {
  w: number
  h: number
}

const NODE_W = 232
const HEAD_H = 40
const ROW_H = 22
const MAX_ROWS = 8
const PAD = 10

const roleIcon = (role: TableRole) => {
  switch (role) {
    case 'fact':
      return <Boxes size={15} />
    case 'date':
      return <Calendar size={15} />
    case 'dimension':
      return <Shapes size={15} />
    default:
      return <Table2 size={15} />
  }
}

function nodeHeight(t: Table): number {
  const shown = Math.min(t.columns.length, MAX_ROWS)
  const more = t.columns.length > MAX_ROWS ? 20 : 0
  return HEAD_H + PAD + shown * ROW_H + more
}

/** Deterministic star layout: facts centred, others on a ring around them. */
function layout(tables: Table[]): Record<string, Pos> {
  const facts = tables.filter((t) => t.role === 'fact')
  const others = tables.filter((t) => t.role !== 'fact')
  const pos: Record<string, Pos> = {}

  const cx = 520
  const cy = 380

  if (facts.length <= 1) {
    if (facts[0]) pos[facts[0].id] = { x: cx - NODE_W / 2, y: cy - 90 }
    const R = Math.max(280, 90 + others.length * 26)
    others.forEach((t, i) => {
      const angle = (i / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2
      pos[t.id] = {
        x: cx + Math.cos(angle) * R - NODE_W / 2,
        y: cy + Math.sin(angle) * R * 0.72 - 60,
      }
    })
  } else {
    facts.forEach((t, i) => {
      pos[t.id] = { x: cx - NODE_W / 2, y: 120 + i * 260 }
    })
    others.forEach((t, i) => {
      const side = i % 2 === 0 ? -1 : 1
      const row = Math.floor(i / 2)
      pos[t.id] = { x: cx + side * 340 - NODE_W / 2, y: 100 + row * 240 }
    })
  }
  return pos
}

function edgeAnchors(a: Box, b: Box): { pa: Pos; pb: Pos } {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const dx = bc.x - ac.x
  const dy = bc.y - ac.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      pa: { x: dx > 0 ? a.x + a.w : a.x, y: ac.y },
      pb: { x: dx > 0 ? b.x : b.x + b.w, y: bc.y },
    }
  }
  return {
    pa: { x: ac.x, y: dy > 0 ? a.y + a.h : a.y },
    pb: { x: bc.x, y: dy > 0 ? b.y : b.y + b.h },
  }
}

export function ModelGraph({ tables, relationships }: Props) {
  const [positions, setPositions] = useState<Record<string, Pos>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)

  // (Re)layout when the set of tables changes.
  const sig = tables.map((t) => `${t.id}:${t.role}`).join('|')
  useEffect(() => {
    setPositions(layout(tables))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  const heights = useMemo(() => {
    const m: Record<string, number> = {}
    tables.forEach((t) => (m[t.id] = nodeHeight(t)))
    return m
  }, [tables])

  const boxes: Record<string, Box> = {}
  for (const t of tables) {
    const p = positions[t.id]
    if (p) boxes[t.id] = { ...p, w: NODE_W, h: heights[t.id] }
  }

  // Canvas size from node extents.
  let maxX = 1040
  let maxY = 760
  for (const id in boxes) {
    maxX = Math.max(maxX, boxes[id].x + NODE_W + 80)
    maxY = Math.max(maxY, boxes[id].y + boxes[id].h + 80)
  }

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    const p = positions[id]
    if (!p) return
    setSelected(id)
    drag.current = { id, dx: e.clientX - p.x, dy: e.clientY - p.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    setPositions((prev) => ({
      ...prev,
      [d.id]: { x: e.clientX - d.dx, y: e.clientY - d.dy },
    }))
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const fkColumns = new Set(relationships.map((r) => r.fromColumn))
  const pkColumns = new Set(relationships.map((r) => r.toColumn))

  return (
    <div className="mgraph">
      <div
        className="mgraph__canvas"
        style={{ width: maxX, height: maxY }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <svg className="mgraph__lines" width={maxX} height={maxY}>
          {relationships.map((r) => {
            const a = boxes[r.fromTable]
            const b = boxes[r.toTable]
            if (!a || !b) return null
            const { pa, pb } = edgeAnchors(a, b)
            const midx = (pa.x + pb.x) / 2
            const path = `M ${pa.x} ${pa.y} C ${midx} ${pa.y}, ${midx} ${pb.y}, ${pb.x} ${pb.y}`
            return (
              <g key={r.id}>
                <path
                  className={`mgraph__line ${r.isActive ? 'mgraph__line--active' : 'mgraph__line--inactive'}`}
                  d={path}
                />
                <Card x={pa.x} y={pa.y} text="✱" />
                <Card x={pb.x} y={pb.y} text="1" />
              </g>
            )
          })}
        </svg>

        {tables.map((t) => {
          const p = positions[t.id]
          if (!p) return null
          const shown = t.columns.slice(0, MAX_ROWS)
          return (
            <div
              key={t.id}
              className="mnode"
              data-selected={selected === t.id ? 'true' : undefined}
              style={{ left: p.x, top: p.y, width: NODE_W }}
            >
              <div
                className="mnode__head"
                data-role={t.role}
                onPointerDown={(e) => onPointerDown(e, t.id)}
              >
                {roleIcon(t.role)}
                <span className="mnode__title">{t.name}</span>
                <span className="mnode__rolebadge">{t.role}</span>
              </div>
              <ul className="mnode__cols">
                {shown.map((c) => {
                  const isKey = c.role === 'key' || pkColumns.has(c.id)
                  const isFk = fkColumns.has(c.id)
                  return (
                    <li
                      key={c.id}
                      className="mnode__col"
                      data-key={isKey ? 'true' : undefined}
                      data-fk={isFk ? 'true' : undefined}
                    >
                      <span className="mnode__col-icon">
                        {isKey ? <KeyRound size={13} /> : isFk ? <Link2 size={13} /> : null}
                      </span>
                      <span className="mnode__col-name">{c.name}</span>
                      <span className="mnode__col-type">{c.dataType}</span>
                    </li>
                  )
                })}
                {t.columns.length > MAX_ROWS && (
                  <li className="mnode__more">+{t.columns.length - MAX_ROWS} more columns</li>
                )}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Card({ x, y, text }: { x: number; y: number; text: string }) {
  return (
    <g>
      <rect className="mgraph__card-label" x={x - 9} y={y - 9} width={18} height={18} rx={5} />
      <text className="mgraph__card-text" x={x} y={y}>
        {text}
      </text>
    </g>
  )
}
