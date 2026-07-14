import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'subtle'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  iconRight?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`pbs-btn pbs-btn--${variant} pbs-btn--${size} ${className}`}
      {...rest}
    >
      {icon && <span className="pbs-btn__icon">{icon}</span>}
      {children && <span className="pbs-btn__label">{children}</span>}
      {iconRight && <span className="pbs-btn__icon">{iconRight}</span>}
    </button>
  )
}
