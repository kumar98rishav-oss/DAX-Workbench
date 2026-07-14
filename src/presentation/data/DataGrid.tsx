import { useEffect, useRef, useState } from 'react'
import type { ProfiledColumn } from '@/application/import/types'
import { ColumnProfileHeader } from './ColumnProfileHeader'
import { formatCell, isNumericType } from './format'

interface Props {
  columns: ProfiledColumn[]
  rows: unknown[][]
  compact?: boolean
}

const ROW_H = 32
const OVERSCAN = 8

/**
 * Windowed data grid — renders only the visible row range so a dataset with
 * hundreds of thousands of rows scrolls without lag. Sticky profiled header.
 */
export function DataGrid({ columns, rows, compact }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(480)
  const rafRef = useRef(0)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => setViewport(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = rootRef.current
    if (!el) return
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => setScrollTop(el.scrollTop))
  }

  const total = rows.length
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const visibleCount = Math.ceil(viewport / ROW_H) + OVERSCAN * 2
  const end = Math.min(total, start + visibleCount)
  const topPad = start * ROW_H
  const bottomPad = Math.max(0, (total - end) * ROW_H)

  const colWidth = compact ? 148 : 180
  const template = `56px repeat(${columns.length}, ${colWidth}px)`
  const innerWidth = 56 + columns.length * colWidth

  const slice: JSX.Element[] = []
  for (let i = start; i < end; i++) {
    const row = rows[i]
    slice.push(
      <div className="dg__row" style={{ gridTemplateColumns: template }} key={i}>
        <div className="dg__idx">{i + 1}</div>
        {columns.map((c, ci) => {
          const v = row[ci]
          const numeric = isNumericType(c.dataType)
          return (
            <div
              className="dg__cell"
              data-num={numeric ? 'true' : undefined}
              data-null={v === null || v === undefined ? 'true' : undefined}
              key={ci}
              title={v === null || v === undefined ? '' : String(v)}
            >
              {formatCell(v, c.dataType)}
            </div>
          )
        })}
      </div>,
    )
  }

  return (
    <div className="dg" ref={rootRef} onScroll={onScroll}>
      <div className="dg__inner" style={{ width: innerWidth }}>
        <div
          className={`dg__header ${compact ? 'dg__header--compact' : ''}`}
          style={{ gridTemplateColumns: template }}
        >
          <div className="dg__idxhead">#</div>
          {columns.map((c) => (
            <ColumnProfileHeader column={c} compact={compact} key={c.name} />
          ))}
        </div>
        <div style={{ height: topPad }} />
        {slice}
        <div style={{ height: bottomPad }} />
      </div>
    </div>
  )
}
