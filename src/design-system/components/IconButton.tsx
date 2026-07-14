import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: 'sm' | 'md'
  active?: boolean
  children: ReactNode
}

export function IconButton({
  label,
  size = 'md',
  active,
  className = '',
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      className={`pbs-iconbtn pbs-iconbtn--${size} ${className}`}
      aria-label={label}
      title={label}
      data-active={active ? 'true' : undefined}
      {...rest}
    >
      {children}
    </button>
  )
}
