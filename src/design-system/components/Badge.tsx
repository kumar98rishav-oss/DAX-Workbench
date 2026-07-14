import type { ReactNode } from 'react'

interface BadgeProps {
  children: ReactNode
  variant?: 'neutral' | 'accent' | 'success' | 'warning'
}

export function Badge({ children, variant = 'neutral' }: BadgeProps) {
  const cls = variant === 'neutral' ? '' : `pbs-badge--${variant}`
  return <span className={`pbs-badge ${cls}`}>{children}</span>
}
