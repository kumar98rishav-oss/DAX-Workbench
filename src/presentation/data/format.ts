import type { DataType } from '@/domain/model'

export function isNumericType(t: DataType): boolean {
  return t === 'integer' || t === 'decimal'
}

/** Human-readable rendering of a coerced cell value for the grid. */
export function formatCell(value: unknown, type: DataType): string {
  if (value === null || value === undefined) return '—'
  switch (type) {
    case 'integer':
      return typeof value === 'number' ? value.toLocaleString() : String(value)
    case 'decimal':
      return typeof value === 'number'
        ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : String(value)
    case 'boolean':
      return value ? 'True' : 'False'
    default:
      return String(value)
  }
}

export interface TypeMeta {
  label: string
  variant: 'number' | 'text' | 'date' | 'bool'
}

export function typeMeta(t: DataType): TypeMeta {
  switch (t) {
    case 'integer':
      return { label: '# Int', variant: 'number' }
    case 'decimal':
      return { label: '# Dec', variant: 'number' }
    case 'date':
      return { label: 'Date', variant: 'date' }
    case 'dateTime':
      return { label: 'DateTime', variant: 'date' }
    case 'boolean':
      return { label: 'Bool', variant: 'bool' }
    default:
      return { label: 'Text', variant: 'text' }
  }
}
