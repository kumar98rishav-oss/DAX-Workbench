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
}

const measureCount = (m: PbiModel) => m.tables.reduce((n, t) => n + t.measures.length, 0)

function summary(model: PbiModel): string {
  const mc = measureCount(model)
  const parts = [`${model.tables.length} tables`, `${model.relationships.length} relationships`]
  if (mc) parts.push(`${mc} measures`)
  return `Imported “${model.name}” — ${parts.join(', ')}. Sample data generated for preview.`
}

// ---- PBIP (folder) --------------------------------------------------------

export async function parsePbipFolder(files: File[]): Promise<PbiParseResult> {
  const rel = (f: File) => ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, '/')

  const tmdl: TmdlFile[] = []
  let projectName = ''
  for (const f of files) {
    const path = rel(f)
    const lower = path.toLowerCase()
    if (lower.endsWith('.pbip')) projectName ||= f.name.replace(/\.pbip$/i, '')
    if (lower.includes('.semanticmodel/definition/') && lower.endsWith('.tmdl')) {
      tmdl.push({ path, text: await f.text() })
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
  return { model, note: summary(model) }
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

export async function parsePbixFile(file: File): Promise<PbiParseResult> {
  const name = file.name.replace(/\.pbix$/i, '')
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  } catch {
    throw new Error(`“${file.name}” is not a readable Power BI (.pbix) archive.`)
  }

  const keys = Object.keys(entries)

  // Some PBIX embed an editable TMSL schema.
  const schemaKey = keys.find((k) => /(^|\/)DataModelSchema$/i.test(k)) ?? keys.find((k) => /\.bim$/i.test(k))
  if (schemaKey) {
    try {
      const model = parseTmslJson(decodeText(entries[schemaKey]), name)
      if (model.tables.length > 0) return { model, note: summary(model) }
    } catch {
      /* fall through */
    }
  }

  // Newer PBIX keep the model as a binary VertiPaq stream — unreadable here.
  if (keys.some((k) => /(^|\/)DataModel$/i.test(k))) {
    throw new Error(
      'This .pbix stores its data model in Power BI’s binary format, which can’t be read in the browser. Use “Open PBIP” on the matching project folder for a full import.',
    )
  }

  throw new Error('No readable data model was found inside this .pbix.')
}
