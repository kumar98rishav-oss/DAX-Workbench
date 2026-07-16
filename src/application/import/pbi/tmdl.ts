/**
 * APPLICATION — TMDL parser (Power BI Project semantic model)
 * Parses the tab-indented TMDL files under a `.SemanticModel/definition/`
 * folder into a neutral model description: tables, columns (typed),
 * measures (DAX), and relationships. Pure — no I/O.
 */
import type { DataType } from '@/domain/model'

export interface PbiColumn {
  name: string
  dataType: DataType
  formatString?: string
  isHidden?: boolean
  summarizeBy?: string
}

export interface PbiMeasure {
  name: string
  expression: string
  formatString?: string
  displayFolder?: string
}

export type SourceKind = 'sql' | 'file' | 'inline' | 'web' | 'other'

export interface PbiSource {
  kind: SourceKind
  file?: string // basename of a referenced Excel/CSV file (kind: 'file')
  detail?: string // human summary, e.g. "SQL · MedLegalBI.dbo.vw_CaseDetails"
}

export interface PbiTable {
  name: string
  columns: PbiColumn[]
  measures: PbiMeasure[]
  isHidden?: boolean
  source?: PbiSource
}

export interface PbiRelationship {
  fromTable: string
  fromColumn: string
  toTable: string
  toColumn: string
  isActive: boolean
  crossFilter: 'single' | 'both'
}

export interface PbiModel {
  name: string
  tables: PbiTable[]
  relationships: PbiRelationship[]
}

/** Map a TMDL / TMSL data type to the app's domain DataType. */
export function mapTmdlType(t: string): DataType {
  switch (t.trim().toLowerCase()) {
    case 'int64':
    case 'integer':
      return 'integer'
    case 'double':
    case 'decimal':
    case 'currency':
      return 'decimal'
    case 'datetime':
      return 'dateTime'
    case 'date':
      return 'date'
    case 'time':
      return 'time'
    case 'boolean':
      return 'boolean'
    case 'string':
    default:
      return 'string'
  }
}

/** Strip surrounding single quotes from a TMDL identifier. */
function unquote(s: string): string {
  const t = s.trim()
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

const indentOf = (line: string): number => {
  let n = 0
  for (const ch of line) {
    if (ch === '\t') n += 1
    else if (ch === ' ') n += 0.25 // tolerate space-indented files
    else break
  }
  return Math.floor(n)
}

/** Split a dotted column reference `Table.Column`, honoring quoted parts. */
export function splitRef(ref: string): { table: string; column: string } | null {
  const s = ref.trim()
  // Quoted table: 'a.b'.Col  or  'a'.'b'
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1)
    if (end === -1) return null
    const table = s.slice(1, end)
    const rest = s.slice(end + 1).replace(/^\s*\.\s*/, '')
    return { table, column: unquote(rest) }
  }
  const dot = s.indexOf('.')
  if (dot === -1) return null
  return { table: unquote(s.slice(0, dot)), column: unquote(s.slice(dot + 1)) }
}

const PROP_KEYS = /^(dataType|formatString|summarizeBy|sourceColumn|lineageTag|isHidden|displayFolder|description|isKey|isNullable|annotation|changedProperty|sortByColumn|dataCategory|isDataTypeInferred|isAvailableInMdx)\b/

/** Classify a table's Power Query (M) source: where does its data come from? */
export function classifySource(m: string): PbiSource {
  const s = m || ''
  if (/\bTable\.FromRows\b|#table\b/.test(s)) return { kind: 'inline', detail: 'Inline data' }
  const fileRef = (s.match(/Excel\.Workbook\s*\(\s*File\.Contents\s*\(\s*"([^"]+)"/i) ?? s.match(/Csv\.Document\s*\(\s*File\.Contents\s*\(\s*"([^"]+)"/i))?.[1]
  if (fileRef) {
    const file = fileRef.replace(/\\/g, '/').split('/').pop() ?? fileRef
    return { kind: 'file', file, detail: `File · ${file}` }
  }
  const sql = s.match(/Sql\.Databases?\s*\(\s*"([^"]+)"(?:\s*,\s*"([^"]+)")?/i)
  if (sql) {
    const db = sql[2] ?? s.match(/\[Name\s*=\s*"([^"]+)"\]/i)?.[1]
    const item = s.match(/Item\s*=\s*"([^"]+)"/i)?.[1]
    return { kind: 'sql', detail: `SQL Server · ${[sql[1], db, item].filter(Boolean).join(' / ')}` }
  }
  if (/\bWeb\.Contents|OData\.Feed\b/.test(s)) return { kind: 'web', detail: 'Web / API' }
  if (/\bOdbc\.|Snowflake\.|AmazonRedshift\.|PostgreSQL\.|MySQL\.|Oracle\.|GoogleBigQuery\./.test(s)) return { kind: 'other', detail: 'Database (ODBC / cloud)' }
  return { kind: 'other', detail: 'Other source' }
}

/** Parse a single `<table>.tmdl` file body. */
export function parseTableTmdl(text: string): PbiTable | null {
  const lines = text.split(/\r?\n/)
  let table: PbiTable | null = null
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.trim()
    const depth = indentOf(raw)

    if (depth === 0 && line.startsWith('table ')) {
      table = { name: unquote(line.slice(6)), columns: [], measures: [] }
      i++
      continue
    }
    if (!table) { i++; continue }

    // Column
    if (depth === 1 && line.startsWith('column ')) {
      const col: PbiColumn = { name: unquote(line.slice(7)), dataType: 'string' }
      i++
      while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) >= 2)) {
        const p = lines[i].trim()
        if (p.startsWith('dataType:')) col.dataType = mapTmdlType(p.slice(9))
        else if (p.startsWith('formatString:')) col.formatString = p.slice(13).trim()
        else if (p.startsWith('summarizeBy:')) col.summarizeBy = p.slice(12).trim()
        else if (p === 'isHidden' || p.startsWith('isHidden:')) col.isHidden = true
        i++
      }
      table.columns.push(col)
      continue
    }

    // Measure — `measure X = expr` (inline) or `measure X =` (block).
    if (depth === 1 && line.startsWith('measure ')) {
      const body = line.slice(8)
      const eq = body.indexOf('=')
      const name = unquote(eq === -1 ? body : body.slice(0, eq))
      const inlineExpr = eq === -1 ? '' : body.slice(eq + 1).trim()
      const meas: PbiMeasure = { name, expression: inlineExpr }
      const exprLines: string[] = inlineExpr ? [inlineExpr] : []
      i++
      while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) >= 2)) {
        const p = lines[i].trim()
        if (p.startsWith('formatString:')) meas.formatString = p.slice(13).trim()
        else if (p.startsWith('displayFolder:')) meas.displayFolder = p.slice(14).trim()
        else if (p && !PROP_KEYS.test(p)) exprLines.push(p) // continuation of the DAX body
        i++
      }
      meas.expression = exprLines.join('\n').trim()
      table.measures.push(meas)
      continue
    }

    // Partition — capture the M source to classify where the data comes from.
    if (depth === 1 && line.startsWith('partition ')) {
      const block: string[] = []
      i++
      while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) >= 2)) { block.push(lines[i]); i++ }
      if (!table.source) table.source = classifySource(block.join('\n'))
      continue
    }

    // Skip hierarchy / annotation blocks and table-level props.
    i++
  }

  return table
}

/** Parse a `relationships.tmdl` file. */
export function parseRelationshipsTmdl(text: string): PbiRelationship[] {
  const lines = text.split(/\r?\n/)
  const rels: PbiRelationship[] = []
  let cur: Partial<PbiRelationship> & { _open?: boolean } = {}

  const flush = () => {
    if (cur.fromTable && cur.fromColumn && cur.toTable && cur.toColumn) {
      rels.push({
        fromTable: cur.fromTable,
        fromColumn: cur.fromColumn,
        toTable: cur.toTable,
        toColumn: cur.toColumn,
        isActive: cur.isActive ?? true,
        crossFilter: cur.crossFilter ?? 'single',
      })
    }
    cur = {}
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('relationship ')) {
      flush()
      cur = { _open: true, isActive: true, crossFilter: 'single' }
    } else if (line.startsWith('fromColumn:')) {
      const r = splitRef(line.slice(11))
      if (r) { cur.fromTable = r.table; cur.fromColumn = r.column }
    } else if (line.startsWith('toColumn:')) {
      const r = splitRef(line.slice(9))
      if (r) { cur.toTable = r.table; cur.toColumn = r.column }
    } else if (line.startsWith('isActive:')) {
      cur.isActive = !/false/i.test(line)
    } else if (line.startsWith('crossFilteringBehavior:')) {
      cur.crossFilter = /both/i.test(line) ? 'both' : 'single'
    }
  }
  flush()
  return rels
}

export interface TmdlFile {
  path: string
  text: string
}

/** Assemble a PbiModel from the TMDL files of a `.SemanticModel/definition`. */
export function parseTmdl(files: TmdlFile[], modelName: string): PbiModel {
  const tables: PbiTable[] = []
  const relationships: PbiRelationship[] = []

  for (const f of files) {
    const lower = f.path.toLowerCase()
    if (lower.endsWith('/relationships.tmdl') || lower.endsWith('relationships.tmdl')) {
      relationships.push(...parseRelationshipsTmdl(f.text))
    } else if (/\/tables\/[^/]+\.tmdl$/.test(lower) || (lower.endsWith('.tmdl') && /^\s*table\s/m.test(f.text))) {
      const t = parseTableTmdl(f.text)
      if (t && t.columns.length + t.measures.length > 0) tables.push(t)
    }
  }

  return { name: modelName, tables, relationships }
}
