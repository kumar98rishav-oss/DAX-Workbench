import type { HTMLAttributes, ReactNode } from 'react'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
  children: ReactNode
}

export function Card({
  interactive,
  className = '',
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={`pbs-card ${interactive ? 'pbs-card--interactive' : ''} ${className}`}
      {...rest}
    >
      {children}
    </div>
  )
}
