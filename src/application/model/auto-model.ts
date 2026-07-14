/**
 * APPLICATION — Auto-Model Engine (pure)
 * Given the imported datasets, discovers the tabular model:
 *   • primary keys (unique, non-null columns)
 *   • foreign keys + relationships (name affinity × value containment)
 *   • table roles (fact / dimension / date)
 *
 * Framework-free and deterministic so it can run in a worker or a test.
 */
import type {
  Cardinality,
  Column,
  DataType,
  Id,
  Relationship,
  Table,
  TableRole,
} from '@/domain/model'
import type { DatasetData, ProfiledColumn } from '@/application/import/types'

export interface ModelInput {
  table: Table
  data: DatasetData
}

export interface ModelResult {
  tables: Table[]
  relationships: Relationship[]
  primaryKeys: Record<Id, Id | null> // tableId -> columnId
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isNumeric = (t: DataType) => t === 'integer' || t === 'decimal'
const isTemporal = (t: DataType) => t === 'date' || t === 'dateTime'

/** Are two column types join-compatible? */
function compatible(a: DataType, b: DataType): boolean {
  if (a === b) return true
  if (isNumeric(a) && isNumeric(b)) return true
  if (isTemporal(a) && isTemporal(b)) return true
  return false
}

/** Normalise a value for cross-column matching (temporal → date only). */
function matchKey(value: unknown, type: DataType): string | null {
  if (value === null || value === undefined) return null
  if (isTemporal(type)) return String(value).slice(0, 10)
  return String(value)
}

const KEY_NAME = /(^id$|_id$|^.*id$|key|code|_no$|number)/i

function distinctSet(rows: unknown[][], colIndex: number, type: DataType): Set<string> {
  const set = new Set<string>()
  for (const r of rows) {
    const k = matchKey(r[colIndex], type)
    if (k !== null) set.add(k)
  }
  return set
}

// ---------------------------------------------------------------------------
// Primary keys
// ---------------------------------------------------------------------------

interface KeyInfo {
  columnId: Id
  columnIndex: number
  name: string
  type: DataType
  values: Set<string>
}

function findPrimaryKey(input: ModelInput): KeyInfo | null {
  const { table, data } = input
  const rowCount = data.rowCount
  if (rowCount === 0) return null

  const candidates: { idx: number; col: Column; prof: ProfiledColumn; score: number }[] = []
  data.columns.forEach((prof, idx) => {
    const col = table.columns[idx]
    if (!col) return
    const unique = prof.profile.distinctCount === rowCount
    const noNulls = prof.profile.nullCount === 0
    if (!unique || !noNulls) return
    // Score: prefer id-named integer/string keys.
    let score = 0
    if (KEY_NAME.test(col.name)) score += 3
    if (col.dataType === 'integer') score += 2
    if (col.dataType === 'string') score += 1
    if (isTemporal(col.dataType)) score += 1
    candidates.push({ idx, col, prof, score })
  })
  if (candidates.length === 0) return null

  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  return {
    columnId: best.col.id,
    columnIndex: best.idx,
    name: best.col.name,
    type: best.col.dataType,
    values: distinctSet(data.rows, best.idx, best.col.dataType),
  }
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

function nameAffinity(fkName: string, pk: KeyInfo, pkTableName: string): number {
  const f = fkName.toLowerCase()
  const k = pk.name.toLowerCase()
  if (f === k) return 1
  if (f === `${pkTableName.toLowerCase()}id` || f === `${pkTableName.toLowerCase()}_id`) return 0.9
  if (f.includes(k) || k.includes(f)) return 0.6
  return 0
}

function detectRelationships(
  inputs: ModelInput[],
  keys: Map<Id, KeyInfo>,
): Relationship[] {
  const rels: Relationship[] = []

  for (const child of inputs) {
    const childPk = keys.get(child.table.id)

    child.data.columns.forEach((prof, idx) => {
      const col = child.table.columns[idx]
      if (!col) return
      // A PK column isn't its own FK.
      if (childPk && col.id === childPk.columnId) return
      // Only key-ish / low-cardinality columns are FK candidates.
      const distinct = prof.profile.distinctCount
      if (distinct === 0) return

      let best: { parent: ModelInput; pk: KeyInfo; confidence: number } | null = null

      for (const parent of inputs) {
        if (parent.table.id === child.table.id) continue
        const pk = keys.get(parent.table.id)
        if (!pk) continue
        if (!compatible(col.dataType, pk.type)) continue
        // FK must not have more distinct values than the PK domain.
        if (distinct > pk.values.size * 1.05 + 1) continue

        const affinity = nameAffinity(col.name, pk, parent.table.name)

        // Value containment: share of this column's values found in the PK.
        const childValues = distinctSet(child.data.rows, idx, col.dataType)
        if (childValues.size === 0) continue
        let hit = 0
        for (const v of childValues) if (pk.values.has(v)) hit++
        const containment = hit / childValues.size

        // Accept on strong containment, or decent containment + name affinity.
        const accept = containment >= 0.85 || (containment >= 0.5 && affinity >= 0.6)
        if (!accept) continue

        const confidence = Math.min(1, containment * 0.7 + affinity * 0.3)
        if (!best || confidence > best.confidence) {
          best = { parent, pk, confidence }
        }
      }

      if (best) {
        rels.push({
          id: `rel__${child.table.id}_${col.name}__${best.parent.table.id}`,
          fromTable: child.table.id,
          fromColumn: col.id,
          toTable: best.parent.table.id,
          toColumn: best.pk.columnId,
          fromCardinality: 'many' as Cardinality,
          toCardinality: 'one' as Cardinality,
          isActive: true,
          crossFilter: 'single',
          confidence: Number(best.confidence.toFixed(2)),
        })
      }
    })
  }

  // Keep at most one active relationship per (child table → parent table) pair;
  // extra ones become inactive (Power BI's single-active-path rule).
  const seenPair = new Set<string>()
  for (const r of rels) {
    const pair = `${r.fromTable}->${r.toTable}`
    if (seenPair.has(pair)) r.isActive = false
    else seenPair.add(pair)
  }

  return rels
}

// ---------------------------------------------------------------------------
// Table roles
// ---------------------------------------------------------------------------

const DATE_ATTRS = /(year|quarter|month|week|day|date|fiscal|period)/i

function looksLikeDateTable(input: ModelInput, pk: KeyInfo | null): boolean {
  if (pk && isTemporal(pk.type)) {
    const dateCols = input.table.columns.filter(
      (c) => isTemporal(c.dataType) || DATE_ATTRS.test(c.name),
    ).length
    if (dateCols >= Math.max(2, input.table.columns.length * 0.5)) return true
  }
  return false
}

function classify(
  inputs: ModelInput[],
  keys: Map<Id, KeyInfo>,
  rels: Relationship[],
): Map<Id, TableRole> {
  const roles = new Map<Id, TableRole>()
  const hasOutgoing = new Set(rels.map((r) => r.fromTable))
  const isReferenced = new Set(rels.map((r) => r.toTable))

  for (const input of inputs) {
    const id = input.table.id
    const pk = keys.get(id) ?? null
    const measureCount = input.data.columns.filter(
      (c) => c.role === 'measureCandidate',
    ).length

    let role: TableRole = 'unknown'
    if (looksLikeDateTable(input, pk)) role = 'date'
    else if (hasOutgoing.has(id) && measureCount >= 1) role = 'fact'
    else if (isReferenced.has(id)) role = 'dimension'
    else if (hasOutgoing.has(id)) role = 'fact'
    else if (measureCount >= 2 && input.data.rowCount > 50) role = 'fact'
    else role = 'dimension'

    roles.set(id, role)
  }
  return roles
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function buildModel(inputs: ModelInput[]): ModelResult {
  const keys = new Map<Id, KeyInfo>()
  const primaryKeys: Record<Id, Id | null> = {}

  for (const input of inputs) {
    const pk = findPrimaryKey(input)
    primaryKeys[input.table.id] = pk?.columnId ?? null
    if (pk) keys.set(input.table.id, pk)
  }

  const relationships = detectRelationships(inputs, keys)
  const roles = classify(inputs, keys, relationships)

  // Produce updated tables: set role + mark the PK column's role as 'key'.
  const tables = inputs.map((input) => {
    const pk = keys.get(input.table.id)
    const columns = input.table.columns.map((c) =>
      pk && c.id === pk.columnId ? { ...c, role: 'key' as const } : c,
    )
    return {
      ...input.table,
      role: roles.get(input.table.id) ?? 'unknown',
      columns,
    }
  })

  return { tables, relationships, primaryKeys }
}
