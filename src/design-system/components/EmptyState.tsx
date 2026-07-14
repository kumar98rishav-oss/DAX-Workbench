import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description?: string
  action?: ReactNode
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="pbs-empty">
      <div className="pbs-empty__icon">{icon}</div>
      <div className="pbs-empty__title">{title}</div>
      {description && <p className="pbs-empty__desc">{description}</p>}
      {action}
    </div>
  )
}
