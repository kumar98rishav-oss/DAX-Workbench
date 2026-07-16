/**
 * APPLICATION — Assemble an imported PBI project into app state.
 * Turns a parsed PbiModel into datasets (synthetic, referentially-consistent),
 * a typed SemanticModel (roles from the data, relationships + measures from the
 * project), and an auto-generated dashboard.
 */
import type { Column, Measure, Relationship, SemanticModel, Table } from '@/domain/model'
import { emptyModel } from '@/domain/model'
import type { Report } from '@/domain/report'
import { buildModel } from '@/application/model/auto-model'
import { generateLayout } from '@/application/insights/dashboard-generator'
import { inferDataset } from '../infer-schema'
import { slug } from '../import-service'
import type { DatasetData, ParsedDataset } from '../types'
import { synthesize } from './synth'
import type { PbiModel } from './tmdl'

export interface PbiLoad {
  datasets: DatasetData[]
  model: SemanticModel
  report: Report
  hasDashboard: boolean
  realCount: number
}

export function assemblePbiProject(
  pbi: PbiModel,
  layoutId: string,
  realByName: Record<string, ParsedDataset> = {},
): PbiLoad {
  // 1. Per table: use REAL rows from a folder file when available, else fabricate
  //    joinable sample rows. Everything is then profiled like any import.
  const synthRaws = synthesize(pbi)
  const synthByName = new Map(synthRaws.map((r) => [r.name, r]))
  const taken = new Set<string>()
  const datasets: DatasetData[] = []
  let tables: Table[] = []
  const idOf = new Map<string, string>()
  let realCount = 0

  for (const t of pbi.tables) {
    const real = realByName[t.name.toLowerCase()]
    const isReal = !!real && real.rowCount > 0
    let parsed: ParsedDataset | null = null
    if (isReal) parsed = real
    else {
      const raw = synthByName.get(t.name)
      if (raw) parsed = inferDataset(t.name, raw.headers, raw.rows)
    }
    if (!parsed || parsed.columns.length === 0) continue
    if (isReal) realCount++

    let id = slug(t.name)
    const base = id
    let k = 2
    while (taken.has(id)) id = `${base}_${k++}`
    taken.add(id)
    idOf.set(t.name, id)

    const columns: Column[] = parsed.columns.map((c) => ({
      id: `${id}::${slug(c.name)}`,
      name: c.name,
      dataType: c.dataType,
      role: c.role,
      distinctCount: c.profile.distinctCount,
      nullCount: c.profile.nullCount,
      cardinalityRatio: parsed.rowCount ? c.profile.distinctCount / parsed.rowCount : 0,
      sampleValues: c.sampleValues,
    }))
    tables.push({ id, name: t.name, role: 'unknown', columns, measures: [], rowCount: parsed.rowCount, source: { kind: isReal ? 'file' : 'pbi', ref: pbi.name } })
    datasets.push({ id, name: t.name, columns: parsed.columns, rows: parsed.rows, rowCount: parsed.rowCount })
  }

  // 2. Infer roles (fact/dimension/date/key) from the data.
  const built = buildModel(datasets.map((d) => ({ data: d, table: tables.find((t) => t.id === d.id)! })))
  tables = built.tables

  // Keep measure-only tables (a dedicated "_Measure" table has no data columns)
  // so their measures aren't dropped.
  for (const pt of pbi.tables) {
    if (tables.some((t) => t.name === pt.name)) continue
    if (pt.measures.length === 0) continue
    let id = slug(pt.name)
    const base = id
    let k = 2
    while (taken.has(id)) id = `${base}_${k++}`
    taken.add(id)
    idOf.set(pt.name, id)
    tables.push({ id, name: pt.name, role: 'unknown', columns: [], measures: [], rowCount: 0 })
  }

  // 3. Relationships: prefer the project's declared ones, resolved to real ids.
  const colId = (tName: string, cName: string): string | null => {
    const tid = idOf.get(tName)
    if (!tid) return null
    return tables.find((t) => t.id === tid)?.columns.find((c) => c.name === cName)?.id ?? null
  }
  let relationships: Relationship[] = []
  pbi.relationships.forEach((r, ri) => {
    const ft = idOf.get(r.fromTable)
    const tt = idOf.get(r.toTable)
    const fc = colId(r.fromTable, r.fromColumn)
    const tc = colId(r.toTable, r.toColumn)
    if (ft && tt && fc && tc) {
      relationships.push({
        id: `rel_pbi_${ri}`,
        fromTable: ft,
        fromColumn: fc,
        toTable: tt,
        toColumn: tc,
        fromCardinality: 'many',
        toCardinality: 'one',
        isActive: r.isActive,
        crossFilter: r.crossFilter,
        confidence: 1,
      })
    }
  })
  if (relationships.length === 0) relationships = built.relationships

  // 4. Overlay the project's column formats + imported measures onto each table.
  const importedMeasures = new Map<string, Measure[]>()
  const withMeasures = tables.map((t) => {
    const src = pbi.tables.find((pt) => pt.name === t.name)
    if (!src) return t
    const columns = t.columns.map((col) => {
      const sc = src.columns.find((x) => x.name === col.name)
      return sc?.formatString ? { ...col, formatString: sc.formatString } : col
    })
    // Keep formatString / displayFolder EXACTLY as the source has them (undefined
    // when absent) — defaulting here would hide real modelling gaps from the Doctor.
    const measures: Measure[] = src.measures.map((m, mi) => ({
      id: `m_pbi_${t.id}_${mi}`,
      name: m.name,
      expression: m.expression,
      formatString: m.formatString,
      displayFolder: m.displayFolder,
      description: 'Imported from Power BI project',
      isAutoGenerated: false,
    }))
    importedMeasures.set(t.id, measures)
    return { ...t, columns, measures }
  })

  const baseModel: SemanticModel = { ...emptyModel('model', pbi.name), tables: withMeasures, relationships }

  // 5. Auto-generate KPI measures + a dashboard, then merge imported measures back.
  const { page, measures } = generateLayout(baseModel, layoutId)
  const finalTables = baseModel.tables.map((t) => {
    const generated: Measure[] = measures
      .filter((m) => m.tableId === t.id)
      .map((m) => ({
        id: m.id,
        name: m.name,
        expression: m.dax.includes(' = ') ? m.dax.split(' = ').slice(1).join(' = ') : m.dax,
        formatString: m.formatString,
        displayFolder: m.displayFolder,
        description: `Auto-generated ${m.kind} measure`,
        confidence: m.confidence,
        isAutoGenerated: true,
      }))
    const imported = importedMeasures.get(t.id) ?? []
    const genNames = new Set(generated.map((m) => m.name.toLowerCase()))
    return { ...t, measures: [...imported.filter((m) => !genNames.has(m.name.toLowerCase())), ...generated] }
  })

  const report: Report = { id: 'report', name: 'Report', pages: [page], activePageId: page.id, themeId: 'studio' }
  return {
    datasets,
    model: { ...baseModel, tables: finalTables },
    report,
    hasDashboard: (page.visuals?.length ?? 0) > 0,
    realCount,
  }
}
