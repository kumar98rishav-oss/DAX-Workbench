import { useState } from 'react'
import { Share2, Wand2, Upload, GitMerge, Network } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, EmptyState } from '@/design-system/components'
import { ModelGraph } from './ModelGraph'
import type { Relationship, Table } from '@/domain/model'
import './model.css'

// ---------------------------------------------------------------------------
// Relationship list — mirrors Power BI's Manage Relationships table
// ---------------------------------------------------------------------------

function cardinalitySymbol(r: Relationship): string {
  const from = r.fromCardinality === 'many' ? '✱' : '1'
  const to = r.toCardinality === 'many' ? '✱' : '1'
  const arrow = r.crossFilter === 'both' ? '◄►' : '◄'
  return `${from}  ${arrow}  ${to}`
}

function RelationshipList({ tables, relationships }: { tables: Table[]; relationships: Relationship[] }) {
  const tableById = new Map(tables.map((t) => [t.id, t]))
  const colName = (tableId: string, colId: string): string => {
    const t = tableById.get(tableId)
    return t?.columns.find((c) => c.id === colId)?.name ?? colId
  }
  const tableName = (id: string) => tableById.get(id)?.name ?? id

  if (relationships.length === 0) {
    return (
      <div className="rellist__empty">No relationships detected in this model.</div>
    )
  }

  return (
    <div className="rellist pbs-scroll">
      <table className="rellist__table">
        <thead>
          <tr>
            <th>From: table (column)</th>
            <th>Relationship</th>
            <th>To: table (column)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {relationships.map((r) => (
            <tr key={r.id} className={r.isActive ? '' : 'rellist__row--inactive'}>
              <td>
                <span className="rellist__tname">{tableName(r.fromTable)}</span>
                <span className="rellist__col"> ({colName(r.fromTable, r.fromColumn)})</span>
              </td>
              <td className="rellist__symbol">{cardinalitySymbol(r)}</td>
              <td>
                <span className="rellist__tname">{tableName(r.toTable)}</span>
                <span className="rellist__col"> ({colName(r.toTable, r.toColumn)})</span>
              </td>
              <td>
                <span className={`rellist__status rellist__status--${r.isActive ? 'active' : 'inactive'}`}>
                  {r.isActive ? 'Active' : 'Inactive'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ModelView
// ---------------------------------------------------------------------------

export function ModelView() {
  const tables = useApp((s) => s.model.tables)
  const relationships = useApp((s) => s.model.relationships)
  const runAutoModel = useApp((s) => s.runAutoModel)
  const requestImport = useApp((s) => s.requestImport)
  const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph')

  if (tables.length === 0) {
    return (
      <div className="modelview">
        <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
          <EmptyState
            icon={<Share2 size={26} />}
            title="No model yet"
            description="Import data and the Workbench will detect keys, relationships, and the fact/dimension structure automatically."
            action={
              <Button variant="primary" icon={<Upload size={16} />} onClick={requestImport}>
                Import data
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  const active = relationships.filter((r) => r.isActive).length
  const facts = tables.filter((t) => t.role === 'fact').length
  const dims = tables.filter((t) => t.role === 'dimension').length

  return (
    <div className="modelview">
      <div className="modelview__toolbar">
        <div className="modelview__stats">
          <span className="modelview__stat">
            <strong>{tables.length}</strong> tables
          </span>
          <span className="modelview__stat">
            <strong>{active}</strong> relationships
          </span>
          <span className="modelview__stat">
            <strong>{facts}</strong> facts · <strong>{dims}</strong> dimensions
          </span>
        </div>
        <div className="modelview__spacer" />
        <div className="modelview__toggle">
          <button
            className="modelview__toggle-btn"
            data-active={viewMode === 'graph'}
            onClick={() => setViewMode('graph')}
            title="Diagram view"
          >
            <Network size={14} /> Diagram
          </button>
          <button
            className="modelview__toggle-btn"
            data-active={viewMode === 'list'}
            onClick={() => setViewMode('list')}
            title="Relationships list"
          >
            <GitMerge size={14} /> Relationships
          </button>
        </div>
        <Button size="sm" icon={<Wand2 size={15} />} onClick={runAutoModel}>
          Re-run auto-model
        </Button>
      </div>
      {viewMode === 'graph'
        ? <ModelGraph tables={tables} relationships={relationships} />
        : <RelationshipList tables={tables} relationships={relationships} />
      }
    </div>
  )
}
