/**
 * APPLICATION — Import use-case
 * Turns a File into a domain Table (schema) + DatasetData (rows), using the
 * FileParserPort. Returns a typed Result rather than throwing.
 */
import type { Column, Table } from '@/domain/model'
import { Err, Ok } from '@/shared/result'
import type { Result } from '@/shared/result'
import type { FileParserPort } from './ports'
import type { DatasetData, FileKind } from './types'

const EXT_TO_KIND: Record<string, FileKind> = {
  csv: 'csv',
  tsv: 'csv',
  txt: 'csv',
  xlsx: 'xlsx',
  xls: 'xlsx',
  xlsm: 'xlsx',
  parquet: 'parquet',
  pqt: 'parquet',
}

export const slug = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'field'

export interface ImportedDataset {
  table: Table
  data: DatasetData
}

export class ImportService {
  constructor(private readonly parser: FileParserPort) {}

  async importFile(file: File): Promise<Result<ImportedDataset[]>> {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const kind = EXT_TO_KIND[ext]
    if (!kind) {
      return Err(`Unsupported file type “.${ext}”. Try CSV, Excel, or Parquet.`)
    }

    let buffer: ArrayBuffer
    try {
      buffer = await file.arrayBuffer()
    } catch {
      return Err(`Could not read “${file.name}”.`)
    }

    const name = file.name.replace(/\.[^.]+$/, '') || file.name

    try {
      const parsedList = await this.parser.parse({ kind, name, buffer })

      const out: ImportedDataset[] = []
      const takenIds = new Set<string>()

      for (const parsed of parsedList) {
        if (parsed.columns.length === 0) continue

        // Unique id per table within this file.
        let id = slug(parsed.name)
        const base = id
        let n = 2
        while (takenIds.has(id)) id = `${base}_${n++}`
        takenIds.add(id)

        const columns: Column[] = parsed.columns.map((c) => ({
          id: `${id}::${slug(c.name)}`,
          name: c.name,
          dataType: c.dataType,
          role: c.role,
          distinctCount: c.profile.distinctCount,
          nullCount: c.profile.nullCount,
          cardinalityRatio: parsed.rowCount ? c.profile.distinctCount / parsed.rowCount : 0,
          sampleValues: c.sampleValues,
        }))

        const table: Table = {
          id,
          name: parsed.name,
          role: 'unknown',
          columns,
          measures: [],
          rowCount: parsed.rowCount,
          source: { kind, ref: file.name },
        }

        const data: DatasetData = {
          id,
          name: parsed.name,
          columns: parsed.columns,
          rows: parsed.rows,
          rowCount: parsed.rowCount,
        }

        out.push({ table, data })
      }

      if (out.length === 0) {
        return Err(`“${file.name}” had no columns to import.`)
      }

      return Ok(out)
    } catch (e) {
      return Err(e instanceof Error ? e.message : `Failed to parse “${file.name}”.`)
    }
  }
}
