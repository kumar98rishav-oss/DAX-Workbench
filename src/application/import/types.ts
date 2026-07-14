/**
 * APPLICATION — Import contracts
 * Shared types for the data-import pipeline (parser port ⇄ worker ⇄ UI).
 */
import type { ColumnRole, DataType, Id } from '@/domain/model'

export type FileKind = 'csv' | 'xlsx' | 'parquet'

/** A single bucket in a column's distribution (drives the mini-charts). */
export interface DistBin {
  label: string
  count: number
}

export interface Distribution {
  kind: 'histogram' | 'categorical' | 'boolean' | 'temporal'
  bins: DistBin[]
  /** True when categorical values were truncated to the top-N. */
  truncated?: boolean
}

export interface ColumnProfile {
  distinctCount: number
  nullCount: number
  /** Numeric aggregates (present for integer/decimal). */
  min?: number
  max?: number
  mean?: number
  /** Temporal / textual extremes (ISO strings). */
  minText?: string
  maxText?: string
  distribution: Distribution
}

export interface ProfiledColumn {
  name: string
  dataType: DataType
  role: ColumnRole
  sampleValues: unknown[]
  profile: ColumnProfile
}

/** Fully parsed + profiled dataset returned by the worker. */
export interface ParsedDataset {
  name: string
  columns: ProfiledColumn[]
  /** Row-major, values coerced to their column's inferred type. */
  rows: unknown[][]
  rowCount: number
}

/** Input handed to a FileParser (buffer is transferred to the worker). */
export interface ParseInput {
  kind: FileKind
  name: string
  buffer: ArrayBuffer
}

/** In-memory dataset held by the app (schema in the domain, data here). */
export interface DatasetData {
  id: Id
  name: string
  columns: ProfiledColumn[]
  rows: unknown[][]
  rowCount: number
}
