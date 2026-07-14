/**
 * INFRASTRUCTURE — Parsing Web Worker
 * Decodes CSV / Excel / Parquet off the main thread, then runs pure schema
 * inference + profiling. Returns a fully profiled dataset.
 */
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { parquetReadObjects } from 'hyparquet'
import { inferDataset } from '@/application/import/infer-schema'
import { extractTables } from '@/application/import/extract-tables'
import type { FileKind, ParsedDataset } from '@/application/import/types'

interface Req {
  id: number
  kind: FileKind
  name: string
  buffer: ArrayBuffer
}

const post = (msg: unknown) =>
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg)

;(self as unknown as { onmessage: ((e: MessageEvent<Req>) => void) | null }).onmessage =
  async (e) => {
    const { id, kind, name, buffer } = e.data
    try {
      const result = await parse(kind, name, buffer)
      post({ id, ok: true, result })
    } catch (err) {
      post({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

async function parse(
  kind: FileKind,
  name: string,
  buffer: ArrayBuffer,
): Promise<ParsedDataset[]> {
  if (kind === 'csv') {
    const text = new TextDecoder().decode(buffer)
    const res = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' })
    const [headers = [], ...rows] = res.data
    return [inferDataset(name, headers, rows)]
  }

  if (kind === 'xlsx') {
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true })
    const datasets: ParsedDataset[] = []
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName]
      if (!sheet) continue
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: true,
        defval: null,
        blankrows: false,
      })
      // One sheet may hold several side-by-side tables.
      for (const table of extractTables(sheetName, grid)) {
        datasets.push(inferDataset(table.name, table.headers, table.rows))
      }
    }
    if (datasets.length === 0) {
      throw new Error('No sheets with data were found in the workbook.')
    }
    return datasets
  }

  // parquet
  const file = {
    byteLength: buffer.byteLength,
    slice: (start: number, end?: number) => buffer.slice(start, end),
  }
  const objs = await parquetReadObjects({ file, utf8: true })
  const headers = objs.length ? Object.keys(objs[0]) : []
  const body = objs.map((o) => headers.map((h) => o[h]))
  return [inferDataset(name, headers, body)]
}
