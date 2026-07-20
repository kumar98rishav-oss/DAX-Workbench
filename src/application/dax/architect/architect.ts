/**
 * APPLICATION — DAX Architect adapter
 * Bridges the ported deterministic engine to DAX Workbench's SemanticModel:
 * builds the engine's table/relationship inputs, runs a natural-language
 * requirement, and returns the measure-branching solution.
 */
import type { Column, SemanticModel } from '@/domain/model'
import type { DatasetData } from '@/application/import/types'
import { DAXEngine } from './engine'

const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Rewrite bare data values in the prompt into "Column = value" so the engine's
 * filter parser resolves them — bridging its schema-only view with real data.
 * e.g. "count shipments where order delivered" → "… where Order_Status = delivered".
 */
function injectFilterColumns(prompt: string, model: SemanticModel, datasets: DatasetData[]): string {
  if (datasets.length === 0) return prompt
  const byId: Record<string, DatasetData> = {}
  for (const d of datasets) byId[d.id] = d

  const entries: { low: string; value: string; column: string }[] = []
  for (const t of model.tables) {
    const data = byId[t.id]
    if (!data) continue
    t.columns.forEach((col, idx) => {
      if (col.dataType !== 'string' || col.role === 'key') return
      if ((col.distinctCount ?? 999) > 40) return
      const seen = new Set<string>()
      for (const row of data.rows) {
        const v = row[idx]
        if (v == null) continue
        const str = String(v)
        if (seen.has(str)) continue
        seen.add(str)
        entries.push({ low: str.toLowerCase(), value: str, column: col.name })
        if (seen.size > 40) break
      }
    })
  }
  entries.sort((a, b) => b.low.length - a.low.length)

  const lower = prompt.toLowerCase()
  const wm = prompt.match(/\b(where|for|with|filtered\s+by|only|containing)\b/i)
  const head = wm ? prompt.slice(0, wm.index) : prompt

  const preds: { column: string; value: string }[] = []
  const usedCols = new Set<string>()
  for (const e of entries) {
    if (e.low.length < 2 || usedCols.has(e.column)) continue
    // If the column is already named, the engine resolves the value natively.
    if (lower.includes(e.column.toLowerCase())) { usedCols.add(e.column); continue }
    if (new RegExp(`(^|[^\\w])${escapeReg(e.low)}(?=[^\\w]|$)`, 'i').test(prompt)) {
      preds.push({ column: e.column, value: e.value })
      usedCols.add(e.column)
    }
  }
  if (preds.length === 0) return prompt

  // Rebuild a clean requirement: aggregation head + canonical filter clause.
  let cleanHead = head
  for (const p of preds) {
    cleanHead = cleanHead.replace(new RegExp(`(^|[^\\w])${escapeReg(p.value.toLowerCase())}(?=[^\\w]|$)`, 'i'), '$1')
  }
  cleanHead = cleanHead.replace(/\b(where|for|with|only|filtered\s+by)\b\s*$/i, '').replace(/\s+/g, ' ').trim()
  if (!cleanHead) cleanHead = `count ${model.tables.find((t) => t.role === 'fact')?.name ?? model.tables[0]?.name ?? ''}`

  return `${cleanHead} where ${preds.map((p) => `${p.column} = ${p.value}`).join(' and ')}`
}

export interface ArchitectStep {
  name: string
  dax: string
  dependsOn: string[]
  stepNumber: number
  title: string
  objectType: string
  reason: string
  formatString?: string
  displayFolder?: string
  homeTable?: string
}

export interface ArchitectSolution {
  goalRestatement: string
  modelNotes: string
  steps: ArchitectStep[]
  finalObject: { name: string; dax: string }
  usageTip: string
  validationErrors: string[]
  resolvedColumns: { role: string; table: string; column: string }[]
}

export interface LintFinding {
  severity: 'ok' | 'info' | 'warning'
  rule?: string
  line?: number
  message: string
}

function engineType(c: Column): string {
  switch (c.dataType) {
    case 'date':
    case 'dateTime':
      return 'Date'
    case 'integer':
      return 'Whole Number'
    case 'decimal':
      return /amount|revenue|sales|price|cost|profit|value|spend|margin|income|budget|balance|gmv/i.test(c.name)
        ? 'Fixed Decimal (Currency)'
        : 'Decimal Number'
    case 'boolean':
      return 'True/False'
    case 'time':
      return 'Time'
    default:
      return 'Text'
  }
}

function modelToInputs(model: SemanticModel): { tables: unknown[]; rels: string } {
  const tables = model.tables.map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => ({ name: c.name, type: engineType(c) })),
  }))

  const nameOf = (tableId: string, colId: string) =>
    model.tables.find((t) => t.id === tableId)?.columns.find((c) => c.id === colId)?.name
  const tblName = (id: string) => model.tables.find((t) => t.id === id)?.name

  const rels = model.relationships
    .map((r) => {
      const ft = tblName(r.fromTable)
      const fc = nameOf(r.fromTable, r.fromColumn)
      const tt = tblName(r.toTable)
      const tc = nameOf(r.toTable, r.toColumn)
      if (!ft || !fc || !tt || !tc) return null
      return `'${ft}'[${fc}] -> '${tt}'[${tc}] (${r.fromCardinality}-to-${r.toCardinality})${r.isActive ? '' : ' (inactive)'}`
    })
    .filter(Boolean)
    .join('\n')

  return { tables, rels }
}

export interface Overrides {
  value?: { table: string; column: string }
  date?: { table: string; column: string }
}

/** Run a natural-language requirement through the deterministic compiler.
 * `skipInjection` bypasses value→column rewriting when the caller has already
 * resolved explicit `where Column = value` predicates (the Intent Engine). */
export function architectSolution(
  model: SemanticModel,
  requirement: string,
  datasets: DatasetData[] = [],
  overrides?: Overrides,
  skipInjection = false,
): ArchitectSolution | null {
  if (!requirement.trim() || model.tables.length === 0) return null
  const req = skipInjection ? requirement : injectFilterColumns(requirement, model, datasets)
  const { tables, rels } = modelToInputs(model)
  try {
    return DAXEngine.generateSolution(tables, rels, req, overrides ? { overrides } : undefined) as ArchitectSolution
  } catch {
    return null
  }
}

/** Best-practice linter for an arbitrary DAX expression. */
export function lintDax(code: string): LintFinding[] {
  try {
    return DAXEngine.lintDax(code) as LintFinding[]
  } catch {
    return []
  }
}
