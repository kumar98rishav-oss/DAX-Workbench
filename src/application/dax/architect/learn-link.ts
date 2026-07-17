/**
 * APPLICATION — "Learn in DAX Architect" link builder
 * DAX Architect (https://dax-architect.onrender.com) is the standalone learning
 * tool this Studio's deterministic engine was originally ported from. It restores
 * a whole model from a share link: `#m=` + base64(JSON {tables, rels, requirement}).
 * This builds that link from the Studio's live SemanticModel, so one click drops
 * the user into the Architect with their own tables, types and relationships
 * already in place.
 */
import type { SemanticModel, DataType } from '@/domain/model'

export const ARCHITECT_URL = 'https://dax-architect.onrender.com/'

/** The Architect's exact DATA_TYPES entries — anything else gets normalised on
 * its side, but sending the precise names keeps the round trip lossless. */
const TYPE_MAP: Record<DataType, string> = {
  integer: 'Whole Number',
  decimal: 'Decimal Number',
  string: 'Text',
  date: 'Date',
  dateTime: 'DateTime',
  time: 'Time',
  boolean: 'Boolean (True/False)',
}

const CURRENCY = /amount|revenue|sales|price|cost|profit|value|spend|margin|income|budget|balance|billed|paid|fee|settlement|collection/i

/** Build the Architect share URL for the current model, or null when there's
 * nothing to send. `requirement` (the user's current prompt) rides along so the
 * Architect opens mid-thought, not blank. */
export function buildArchitectLearnUrl(model: SemanticModel, requirement?: string): string | null {
  const tables = model.tables.filter((t) => t.columns.length > 0)
  if (tables.length === 0) return null

  const payloadTables = tables.map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => ({
      name: c.name,
      type:
        c.dataType === 'decimal' && CURRENCY.test(c.name)
          ? 'Fixed Decimal (Currency)'
          : TYPE_MAP[c.dataType] ?? 'Text',
    })),
  }))

  // The Architect addresses relationships by INDEX into its tables/columns
  // arrays, so resolve the Studio's id-based ones against the filtered list.
  const rels: { t1: number; c1: number; t2: number; c2: number; card: string; active: boolean }[] = []
  for (const r of model.relationships) {
    const t1 = tables.findIndex((t) => t.id === r.fromTable)
    const t2 = tables.findIndex((t) => t.id === r.toTable)
    if (t1 < 0 || t2 < 0) continue
    const c1 = tables[t1].columns.findIndex((c) => c.id === r.fromColumn)
    const c2 = tables[t2].columns.findIndex((c) => c.id === r.toColumn)
    if (c1 < 0 || c2 < 0) continue
    rels.push({ t1, c1, t2, c2, card: 'many-to-one', active: r.isActive !== false })
  }

  const data: Record<string, unknown> = { tables: payloadTables, rels }
  const req = requirement?.trim()
  if (req) data.requirement = req

  // Same unicode-safe base64 the Architect itself uses to encode share links.
  const hash = '#m=' + btoa(unescape(encodeURIComponent(JSON.stringify(data))))
  const url = ARCHITECT_URL + hash
  // The Architect refuses to GENERATE links past 30k; mirror that on the way in.
  // Falling back to a plain open still lands the user in the tool, just blank.
  return url.length > 30000 ? ARCHITECT_URL : url
}
