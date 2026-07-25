/**
 * APPLICATION — report-layer usage scan (the other half of "is this unused?")
 *
 * The Analysis Services engine exposes the MODEL only. It has no idea which
 * visual on which page binds a measure, so a measure with zero model dependents
 * may still sit on a dozen cards. Deleting it would break the report silently.
 *
 * This module reads the REPORT layer — from a .pbix archive or a PBIP/PBIR
 * project folder — and counts how many visuals reference each measure and
 * column. Only once that has happened may the Cleanup surface say "unused".
 */
import { unzipSync } from 'fflate'
import { collectFieldRefs, decodeText, type FieldRef } from '@/application/import/pbi/open-project'
import { columnUsageKey, type ReportUsage } from './usage'

export interface ReportScan {
  usage: ReportUsage
  /** Human-readable summary for the UI. */
  note: string
  /** Files that looked like a report but yielded nothing — surfaced honestly. */
  emptyFiles: string[]
}

/** Report-definition files worth parsing, in either PBIX or PBIP/PBIR layout. */
function isReportFile(path: string): boolean {
  // PBIX: the legacy single "Report/Layout" blob (no extension).
  if (/(^|\/)Layout$/i.test(path)) return true
  // PBIP / PBIR: per-visual and per-page JSON under report/definition/**.
  if (/\.json$/i.test(path) && /(^|\/)(report|definition|pages|visuals)(\/|$)/i.test(path)) return true
  // Older PBIP report folders keep a single report.json.
  if (/(^|\/)report\.json$/i.test(path)) return true
  return false
}

/** Fold raw field references into per-object visual-binding counts. */
function tally(refs: FieldRef[]): ReportUsage {
  const measures: Record<string, number> = {}
  const columns: Record<string, number> = {}
  for (const r of refs) {
    if (r.isMeasure) {
      const k = r.property.toLowerCase()
      measures[k] = (measures[k] ?? 0) + 1
    } else {
      const k = columnUsageKey(r.entity, r.property)
      columns[k] = (columns[k] ?? 0) + 1
    }
  }
  return { scanned: true, measures, columns }
}

/**
 * A measure bound to a visual is used, even if nothing in the model references
 * it. Scans every report file it can read and returns the binding counts.
 *
 * Accepts either a single .pbix, or the File[] of a picked PBIP folder.
 */
export async function scanReportFiles(files: File[]): Promise<ReportScan> {
  const refs: FieldRef[] = []
  const emptyFiles: string[] = []
  let sources = 0

  for (const file of files) {
    const name = file.name
    const before = refs.length

    if (/\.pbix$/i.test(name)) {
      let entries: Record<string, Uint8Array>
      try {
        entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
      } catch {
        throw new Error(`“${name}” is not a readable Power BI (.pbix) archive.`)
      }
      for (const [path, bytes] of Object.entries(entries)) {
        if (!isReportFile(path)) continue
        try {
          collectFieldRefs(JSON.parse(decodeText(bytes)), refs)
        } catch {
          /* not JSON, or a binary part — skip it */
        }
      }
      sources++
    } else {
      // PBIP folder: webkitRelativePath carries the path inside the picked folder.
      const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || name
      if (!isReportFile(path)) continue
      try {
        collectFieldRefs(JSON.parse(await file.text()), refs)
        sources++
      } catch {
        /* skip unreadable json */
      }
    }

    if (refs.length === before && /\.pbix$/i.test(name)) emptyFiles.push(name)
  }

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
  const bindings = refs.length

  const note = `${bindings} visual binding${bindings === 1 ? '' : 's'} across ${mCount} measure${
    mCount === 1 ? '' : 's'
  } and ${cCount} column${cCount === 1 ? '' : 's'}.`

  return { usage, note, emptyFiles }
}
