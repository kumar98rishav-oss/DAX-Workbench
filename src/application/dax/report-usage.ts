/**
 * APPLICATION — report-layer usage scan (the other half of "is this unused?")
 *
 * The Analysis Services engine exposes the MODEL only. It has no idea which
 * visual on which page binds a measure, so a measure with zero model dependents
 * may still sit on a dozen cards. Deleting it would break the report silently.
 *
 * This module reads the REPORT layer — from a .pbix archive or a PBIP/PBIR
 * project folder — and records WHERE each measure and column is used: the page
 * and the visual type. Only once that has happened may Cleanup say "unused".
 */
import { unzipSync } from 'fflate'
import { collectFieldRefs, decodeText, type FieldRef } from '@/application/import/pbi/open-project'
import { columnUsageKey, type ReportUsage, type VisualPlacement } from './usage'

export interface ReportScan {
  usage: ReportUsage
  /** Human-readable summary for the UI. */
  note: string
}

/** A field reference plus where in the report it was found. */
interface PlacedRef extends FieldRef {
  page: string
  visualType: string
}

/** Refs found outside a visual (bookmarks, report-level filters) still count as
 *  usage — deleting the object would break them — but have no visual to name. */
const NON_VISUAL = '__nonvisual__'

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- PBIX ------

/**
 * PBIX keeps the whole report in one `Report/Layout` blob:
 * `{ sections: [ { displayName, visualContainers: [ { config: "<json>" } ] } ] }`
 * — note `config` is JSON serialised *into a string*.
 */
function collectFromLayout(layout: unknown, out: PlacedRef[]): void {
  const root = layout as { sections?: unknown[] } | null
  if (!root?.sections) return

  for (const s of root.sections) {
    const section = s as { displayName?: string; name?: string; visualContainers?: unknown[] }
    const page = section.displayName || section.name || 'Unnamed page'

    for (const c of section.visualContainers ?? []) {
      const container = c as { config?: string }
      const cfg = typeof container.config === 'string' ? parse(container.config) : container.config
      if (!cfg) continue
      const visualType =
        ((cfg as { singleVisual?: { visualType?: string } }).singleVisual?.visualType) || 'visual'

      const refs: FieldRef[] = []
      collectFieldRefs(cfg, refs)
      for (const r of refs) out.push({ ...r, page, visualType })
    }
  }
}

// ------------------------------------------------------------ PBIP / PBIR ---

const pageIdOf = (path: string): string | null => /pages\/([^/]+)\//i.exec(path)?.[1] ?? null

/**
 * PBIP splits the report into files:
 *   definition/pages/<id>/page.json                     -> displayName
 *   definition/pages/<id>/visuals/<id>/visual.json      -> visual.visualType + bindings
 */
function collectFromPbipParts(parts: { path: string; json: unknown }[], out: PlacedRef[]): void {
  // Pass 1: page id -> display name.
  const pageNames = new Map<string, string>()
  for (const { path, json } of parts) {
    if (!/(^|\/)page\.json$/i.test(path)) continue
    const id = pageIdOf(path)
    const name = (json as { displayName?: string; name?: string })?.displayName
    if (id && name) pageNames.set(id, name)
  }

  // Pass 2: visuals, then everything else (bookmarks, filters).
  for (const { path, json } of parts) {
    if (/(^|\/)page\.json$/i.test(path)) continue

    const refs: FieldRef[] = []
    collectFieldRefs(json, refs)
    if (refs.length === 0) continue

    if (/(^|\/)visual\.json$/i.test(path)) {
      const id = pageIdOf(path)
      const page = (id && pageNames.get(id)) || 'Unnamed page'
      const visualType = (json as { visual?: { visualType?: string } })?.visual?.visualType || 'visual'
      for (const r of refs) out.push({ ...r, page, visualType })
    } else {
      for (const r of refs) out.push({ ...r, page: NON_VISUAL, visualType: NON_VISUAL })
    }
  }
}

// --------------------------------------------------------------- shared -----

/** Report-definition files worth parsing, in either PBIX or PBIP/PBIR layout. */
function isReportFile(path: string): boolean {
  if (/(^|\/)Layout$/i.test(path)) return true
  if (/\.json$/i.test(path) && /(^|\/)(report|definition|pages|visuals)(\/|$)/i.test(path)) return true
  if (/(^|\/)report\.json$/i.test(path)) return true
  return false
}

/** Fold placed references into counts plus per-object placement lists. */
function tally(refs: PlacedRef[]): ReportUsage {
  const measures: Record<string, number> = {}
  const columns: Record<string, number> = {}
  const measurePlacements: Record<string, VisualPlacement[]> = {}
  const columnPlacements: Record<string, VisualPlacement[]> = {}

  const push = (
    counts: Record<string, number>,
    places: Record<string, VisualPlacement[]>,
    key: string,
    r: PlacedRef,
  ) => {
    counts[key] = (counts[key] ?? 0) + 1
    if (r.page === NON_VISUAL) return // real usage, but nothing to show on a page
    const list = (places[key] ??= [])
    // One row per page+visual pair; repeat bindings in the same visual are one.
    if (!list.some((p) => p.page === r.page && p.visualType === r.visualType)) {
      list.push({ page: r.page, visualType: r.visualType })
    }
  }

  for (const r of refs) {
    if (r.isMeasure) push(measures, measurePlacements, r.property.toLowerCase(), r)
    else push(columns, columnPlacements, columnUsageKey(r.entity, r.property), r)
  }
  return { scanned: true, measures, columns, measurePlacements, columnPlacements }
}

/**
 * A measure bound to a visual is used, even if nothing in the model references
 * it. Accepts a single .pbix, or the File[] of a picked PBIP folder.
 */
export async function scanReportFiles(files: File[]): Promise<ReportScan> {
  const refs: PlacedRef[] = []
  const pbipParts: { path: string; json: unknown }[] = []
  let sources = 0

  for (const file of files) {
    if (/\.pbix$/i.test(file.name)) {
      let entries: Record<string, Uint8Array>
      try {
        entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
      } catch {
        throw new Error(`“${file.name}” is not a readable Power BI (.pbix) archive.`)
      }
      for (const [path, bytes] of Object.entries(entries)) {
        if (!isReportFile(path)) continue
        const json = parse(decodeText(bytes))
        if (!json) continue
        if (/(^|\/)Layout$/i.test(path)) collectFromLayout(json, refs)
        else pbipParts.push({ path, json })
      }
      sources++
      continue
    }

    // PBIP folder: webkitRelativePath carries the path inside the picked folder.
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    if (!isReportFile(path)) continue
    const json = parse(await file.text())
    if (!json) continue
    pbipParts.push({ path, json })
    sources++
  }

  if (pbipParts.length > 0) collectFromPbipParts(pbipParts, refs)

  if (sources === 0) {
    throw new Error(
      'No report definition found. Pick a .pbix file, or the PBIP project folder that contains the *.Report folder.',
    )
  }

  // FAIL CLOSED. Zero bindings is indistinguishable from a parse we got wrong —
  // a wrong encoding, an unfamiliar layout, a future format. Reporting
  // scanned:true here would mark every measure in the model "unused" on the
  // strength of a silent failure, which is precisely the mistake this whole
  // surface exists to prevent. Absence of evidence is not evidence of absence.
  if (refs.length === 0) {
    throw new Error(
      'Read the report, but found no field bindings in it. That usually means the report format was not understood, ' +
        'so nothing has been marked unused. Try the PBIP project folder instead.',
    )
  }

  const usage = tally(refs)
  const mCount = Object.keys(usage.measures).length
  const cCount = Object.keys(usage.columns).length
  const pages = new Set(refs.filter((r) => r.page !== NON_VISUAL).map((r) => r.page)).size

  const note =
    `${refs.length} visual binding${refs.length === 1 ? '' : 's'} across ${mCount} measure${
      mCount === 1 ? '' : 's'
    } and ${cCount} column${cCount === 1 ? '' : 's'}` + (pages ? ` on ${pages} page${pages === 1 ? '' : 's'}.` : '.')

  return { usage, note }
}
