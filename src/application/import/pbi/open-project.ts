/**
 * APPLICATION — Read a Power BI project into a neutral PbiModel.
 * PBIP: a picked folder (File[] with webkitRelativePath) whose
 *   `*.SemanticModel/definition/**.tmdl` files describe the model.
 * PBIX: a single .pbix (a zip). Its model is usually a binary VertiPaq blob we
 *   cannot read in-browser; if a TMSL `DataModelSchema` is present we parse it,
 *   otherwise we fail with guidance to use the .pbip project.
 */
import { unzipSync } from 'fflate'
import { parseTmdl, mapTmdlType } from './tmdl'
import type { PbiModel, PbiRelationship, PbiTable, TmdlFile } from './tmdl'

export interface PbiParseResult {
  model: PbiModel
  note: string
  /** Data files found in the dropped folder (Excel/CSV/Parquet) to bind as real rows. */
  dataFiles?: File[]
}

/** Returned when a .pbix has no readable model — the UI offers next steps. */
export interface PbixFallback {
  fallback: string
  pages: number
}

export type PbixResult = PbiParseResult | PbixFallback

const measureCount = (m: PbiModel) => m.tables.reduce((n, t) => n + t.measures.length, 0)

function summary(model: PbiModel): string {
  const mc = measureCount(model)
  const parts = [`${model.tables.length} tables`, `${model.relationships.length} relationships`]
  if (mc) parts.push(`${mc} measures`)
  return `Imported the MODEL of “${model.name}” — ${parts.join(', ')}. ⚠ A project file carries no row data, so sample data was generated — measure values are ILLUSTRATIVE, not your source numbers. Use “Import Data” to bind the real Excel/CSV/SQL export.`
}

/** Honest post-bind summary: how many tables got REAL data vs sample. */
export function pbipSummary(model: PbiModel, realTables: number): string {
  const total = model.tables.length
  const sample = total - realTables
  const parts = [`${realTables}/${total} tables with REAL data`]
  if (sample > 0) parts.push(`${sample} sample`)
  const tail =
    sample > 0
      ? ` Sample tables come from a database/API a browser can’t reach — attach a CSV/Excel export (or run the data bridge) for real numbers.`
      : ' 🎉'
  return `Imported “${model.name}” — ${parts.join(', ')}.${tail}`
}

// ---- PBIP (folder) --------------------------------------------------------

export async function parsePbipFolder(files: File[]): Promise<PbiParseResult> {
  const rel = (f: File) => ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, '/')

  const tmdl: TmdlFile[] = []
  const dataFiles: File[] = []
  let projectName = ''
  for (const f of files) {
    const path = rel(f)
    const lower = path.toLowerCase()
    if (lower.endsWith('.pbip')) projectName ||= f.name.replace(/\.pbip$/i, '')
    if (lower.includes('.semanticmodel/definition/') && lower.endsWith('.tmdl')) {
      tmdl.push({ path, text: await f.text() })
    } else if (/\.(xlsx|xls|xlsm|csv|tsv|parquet|pqt)$/i.test(lower)) {
      dataFiles.push(f) // real data present in the folder (Excel_Sources, bridge output, …)
    }
  }

  if (tmdl.length === 0) {
    throw new Error(
      'No semantic model found. Select the folder that contains the “.pbip” file (its “*.SemanticModel/definition” folder holds the TMDL model).',
    )
  }

  if (!projectName) {
    const seg = files
      .map(rel)
      .flatMap((p) => p.split('/'))
      .find((s) => /\.semanticmodel$/i.test(s))
    projectName = seg ? seg.replace(/\.SemanticModel$/i, '') : 'Imported model'
  }

  const model = parseTmdl(tmdl, projectName)
  if (model.tables.length === 0) throw new Error('The project’s semantic model had no readable tables.')
  return { model, note: summary(model), dataFiles }
}

// ---- PBIX (zip) -----------------------------------------------------------

function decodeText(bytes: Uint8Array): string {
  // TMSL in a PBIX is UTF-16LE with a BOM; JSON elsewhere is UTF-8.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  return new TextDecoder('utf-8').decode(bytes)
}

/** Parse a TMSL / model.bim JSON document into a PbiModel. */
export function parseTmslJson(text: string, name: string): PbiModel {
  const doc = JSON.parse(text) as Record<string, unknown>
  const model = (doc.model ?? doc) as Record<string, unknown>
  const rawTables = (model.tables as Record<string, unknown>[]) ?? []

  const tables: PbiTable[] = rawTables.map((t) => ({
    name: String(t.name ?? 'Table'),
    isHidden: Boolean(t.isHidden),
    columns: (((t.columns as Record<string, unknown>[]) ?? [])
      .filter((c) => (c.type ?? 'data') !== 'rowNumber')
      .map((c) => ({
        name: String(c.name ?? 'Column'),
        dataType: mapTmdlType(String(c.dataType ?? 'string')),
        formatString: c.formatString ? String(c.formatString) : undefined,
        isHidden: Boolean(c.isHidden),
      }))),
    measures: (((t.measures as Record<string, unknown>[]) ?? []).map((m) => ({
      name: String(m.name ?? 'Measure'),
      expression: Array.isArray(m.expression) ? (m.expression as string[]).join('\n') : String(m.expression ?? ''),
      formatString: m.formatString ? String(m.formatString) : undefined,
      displayFolder: m.displayFolder ? String(m.displayFolder) : undefined,
    }))),
  }))

  const relationships: PbiRelationship[] = (((model.relationships as Record<string, unknown>[]) ?? []).map((r) => ({
    fromTable: String(r.fromTable ?? ''),
    fromColumn: String(r.fromColumn ?? ''),
    toTable: String(r.toTable ?? ''),
    toColumn: String(r.toColumn ?? ''),
    isActive: r.isActive !== false,
    crossFilter: (String(r.crossFilteringBehavior ?? '').toLowerCase().includes('both') ? 'both' : 'single') as 'single' | 'both',
  })).filter((r) => r.fromTable && r.toTable))

  return { name, tables: tables.filter((t) => t.columns.length + t.measures.length > 0), relationships }
}

// ---- best-effort schema reconstruction from the report's field references ----

interface FieldRef { entity: string; property: string; isMeasure: boolean }

function guessType(name: string): PbiTable['columns'][number]['dataType'] {
  const n = name.toLowerCase()
  if (/date|time|day|month|year|quarter|week/.test(n)) return /year|month|quarter|week|day.?num/.test(n) ? 'integer' : 'date'
  if (/amount|revenue|sales|price|cost|value|spend|margin|rate|ratio|percent|avg|average/.test(n)) return 'decimal'
  if (/qty|quantity|count|boxes|units|orders|number|num$|total/.test(n)) return 'integer'
  return 'string'
}

/** Recursively collect Power BI field references (`{Column|Measure:{Expression:{SourceRef:{Entity}},Property}}`). */
function collectFieldRefs(node: unknown, out: FieldRef[], depth = 0): void {
  if (depth > 40 || !node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  for (const kind of ['Column', 'Measure'] as const) {
    const f = obj[kind] as Record<string, unknown> | undefined
    if (f && typeof f === 'object') {
      const property = f.Property
      const entity = ((f.Expression as Record<string, unknown> | undefined)?.SourceRef as Record<string, unknown> | undefined)?.Entity
      if (typeof property === 'string' && typeof entity === 'string') {
        out.push({ entity, property, isMeasure: kind === 'Measure' })
      }
    }
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length > 20 && (v.includes('SourceRef') || v.includes('"Column"') || v.includes('"Measure"'))) {
      try { collectFieldRefs(JSON.parse(v), out, depth + 1) } catch { /* not JSON */ }
    } else if (v && typeof v === 'object') {
      collectFieldRefs(v, out, depth + 1)
    }
  }
}

/** Rebuild a model skeleton from the fields the report actually uses. */
function reconstructFromReport(entries: Record<string, Uint8Array>, name: string): PbiModel | null {
  const refs: FieldRef[] = []
  for (const [k, bytes] of Object.entries(entries)) {
    if (!/report|layout|visual|page/i.test(k)) continue
    if (!/\.json$/i.test(k) && !/(^|\/)Layout$/i.test(k)) continue
    try { collectFieldRefs(JSON.parse(decodeText(bytes)), refs) } catch { /* skip */ }
  }
  if (refs.length === 0) return null

  const byTable = new Map<string, { cols: Set<string>; meas: Set<string> }>()
  for (const r of refs) {
    if (!byTable.has(r.entity)) byTable.set(r.entity, { cols: new Set(), meas: new Set() })
    const e = byTable.get(r.entity)!
    if (r.isMeasure) e.meas.add(r.property)
    else e.cols.add(r.property)
  }

  const tables: PbiTable[] = [...byTable].map(([tName, { cols, meas }]) => ({
    name: tName,
    columns: [...cols].map((c) => ({ name: c, dataType: guessType(c) })),
    // The report references a measure by name but not its DAX — leave a stub the user can fill.
    measures: [...meas].map((m) => ({ name: m, expression: 'BLANK() /* reconstructed — original DAX not in the .pbix report */' })),
  }))

  const totalCols = tables.reduce((n, t) => n + t.columns.length, 0)
  if (tables.length === 0 || totalCols < 1) return null
  return { name, tables, relationships: [] }
}

function countPages(entries: Record<string, Uint8Array>): number {
  const newPages = Object.keys(entries).filter((k) => /Report\/definition\/pages\/[^/]+\/page\.json$/i.test(k)).length
  if (newPages) return newPages
  try {
    const layoutKey = Object.keys(entries).find((k) => /(^|\/)Layout$/i.test(k))
    if (layoutKey) {
      const layout = JSON.parse(decodeText(entries[layoutKey])) as { sections?: unknown[] }
      return layout.sections?.length ?? 0
    }
  } catch { /* ignore */ }
  return 0
}

export async function parsePbixFile(file: File): Promise<PbixResult> {
  const name = file.name.replace(/\.pbix$/i, '')
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  } catch {
    throw new Error(`“${file.name}” is not a readable Power BI (.pbix) archive.`)
  }

  const keys = Object.keys(entries)

  // 1) Some PBIX embed an editable TMSL schema — a full, faithful import.
  const schemaKey = keys.find((k) => /(^|\/)DataModelSchema$/i.test(k)) ?? keys.find((k) => /\.bim$/i.test(k))
  if (schemaKey) {
    try {
      const model = parseTmslJson(decodeText(entries[schemaKey]), name)
      if (model.tables.length > 0) return { model, note: summary(model) }
    } catch { /* fall through */ }
  }

  // 2) Best-effort: reconstruct the schema from the fields the report uses.
  try {
    const reconstructed = reconstructFromReport(entries, name)
    if (reconstructed) {
      const mc = reconstructed.tables.reduce((n, t) => n + t.measures.length, 0)
      return {
        model: reconstructed,
        note: `Reconstructed “${name}” from the report — ${reconstructed.tables.length} tables${mc ? `, ${mc} measures (stubs)` : ''}. The data model is binary, so types + sample data are inferred.`,
      }
    }
  } catch { /* fall through */ }

  // 3) Nothing readable — hand back an actionable fallback (binary VertiPaq model).
  return {
    fallback:
      'This .pbix stores its data model in Power BI’s binary format (XPress9-compressed), which can’t be read in the browser. Open the matching .pbip project folder for a full import, or import the underlying data directly.',
    pages: countPages(entries),
  }
}
