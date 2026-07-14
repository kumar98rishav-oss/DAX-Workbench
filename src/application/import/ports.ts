/**
 * APPLICATION — Import ports (interfaces the infrastructure implements).
 */
import type { ParseInput, ParsedDataset } from './types'

export interface FileParserPort {
  /**
   * Parse + profile a file buffer. Heavy work; runs in a Web Worker.
   * Returns one dataset per table found — a CSV/Parquet yields one, a
   * multi-sheet workbook yields one per sheet (or per side-by-side table).
   */
  parse(input: ParseInput): Promise<ParsedDataset[]>
}
