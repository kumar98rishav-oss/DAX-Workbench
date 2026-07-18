/**
 * APPLICATION — Live previews on the real engine
 * Builds DEFINE MEASURE queries so Analysis Services can evaluate measures that
 * exist only in the Studio (or only as a suggestion's plan) — the engine
 * computes over the FULL data, so these numbers are exact where the in-browser
 * evaluator's sample-based ones are only indicative. Query-scoped measures
 * override model measures of the same name, so the Studio's current DAX always
 * wins over whatever is already deployed.
 */
import type { SemanticModel } from '@/domain/model'

export interface NamedDax {
  name: string
  dax: string
}

const escapeName = (n: string): string => n.replace(/]/g, ']]')
const escapeTable = (t: string): string => t.replace(/'/g, "''")

/** The subset of `all` that `finalName` transitively depends on (plus itself).
 * Dependencies are found by scanning each expression for `[Name]` references
 * against the POOL's own names — a suggestion's plan steps don't exist in the
 * model yet, so a model-based dependency parser can't see them (that exact miss
 * silently broke branched-chain previews). Defining only the closure keeps one
 * broken, unrelated measure from failing every preview. */
export function dependencyClosure(all: NamedDax[], finalName: string): NamedDax[] {
  const byName = new Map<string, NamedDax>()
  for (const m of all) if (!byName.has(m.name.toLowerCase())) byName.set(m.name.toLowerCase(), m)
  const wanted = new Set<string>()
  const walk = (name: string) => {
    const key = name.toLowerCase()
    if (wanted.has(key)) return
    const m = byName.get(key)
    if (!m) return // lives only in the deployed model — the engine resolves it
    wanted.add(key)
    for (const cand of byName.values()) {
      if (!wanted.has(cand.name.toLowerCase()) && m.dax.includes(`[${cand.name}]`)) walk(cand.name)
    }
  }
  walk(finalName)
  return all.filter((m) => wanted.has(m.name.toLowerCase()))
}

/** A query the bridge's /dax endpoint can run as-is: define the chain, then
 * evaluate the final measure as a single scalar row. */
export function buildDefineQuery(measures: NamedDax[], finalName: string, homeTable: string): string {
  const t = escapeTable(homeTable)
  const seen = new Set<string>()
  const defs: string[] = []
  for (const m of measures) {
    const key = m.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    defs.push(`MEASURE '${t}'[${escapeName(m.name)}] = ${m.dax}`)
  }
  const evaluate = `EVALUATE ROW("v", [${escapeName(finalName)}])`
  return defs.length === 0 ? evaluate : `DEFINE\n${defs.join('\n')}\n${evaluate}`
}

/** All measures currently in the Studio model, flat. */
export function modelMeasures(model: SemanticModel): NamedDax[] {
  return model.tables.flatMap((t) => t.measures.map((m) => ({ name: m.name, dax: m.expression })))
}

/** A table that certainly exists in the deployed model, for DEFINE's home. */
export function defineHomeTable(model: SemanticModel): string | null {
  const t = model.tables.find((x) => x.role === 'fact' && x.columns.length > 0) ?? model.tables.find((x) => x.columns.length > 0)
  return t?.name ?? null
}
