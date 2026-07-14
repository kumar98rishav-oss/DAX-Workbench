import type { ReactNode } from 'react'

interface TooltipProps {
  label: string
  children: ReactNode
}

/** Lightweight CSS-only tooltip for hover affordances. */
export function Tooltip({ label, children }: TooltipProps) {
  return (
    <span className="pbs-tooltip">
      {children}
      <span className="pbs-tooltip__bubble" role="tooltip">
        {label}
      </span>
    </span>
  )
}
