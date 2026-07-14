import { KeyRound, Sigma, Calendar } from 'lucide-react'
import type { ProfiledColumn } from '@/application/import/types'
import { typeMeta } from './format'

interface Props {
  column: ProfiledColumn
  compact?: boolean
}

/** A grid header cell: name, type badge, key/measure hints, and a mini
 *  distribution chart derived from the column profile. */
export function ColumnProfileHeader({ column, compact }: Props) {
  const meta = typeMeta(column.dataType)
  const { distinctCount, nullCount } = column.profile

  return (
    <div className="dg-head">
      <div className="dg-head__top">
        <span className="dg-head__name" title={column.name}>
          {column.role === 'key' && <KeyRound size={12} className="dg-head__roleicon" />}
          {column.role === 'measureCandidate' && (
            <Sigma size={12} className="dg-head__roleicon" />
          )}
          {column.role === 'date' && <Calendar size={12} className="dg-head__roleicon" />}
          {column.name}
        </span>
        <span className={`dg-badge dg-badge--${meta.variant}`}>{meta.label}</span>
      </div>

      {!compact && (
        <>
          <MiniDist column={column} />
          <div className="dg-head__stats">
            <span>{distinctCount.toLocaleString()} distinct</span>
            {nullCount > 0 && <span className="dg-head__null">{nullCount.toLocaleString()} null</span>}
          </div>
        </>
      )}
    </div>
  )
}

function MiniDist({ column }: { column: ProfiledColumn }) {
  const bins = column.profile.distribution.bins
  if (bins.length === 0) return <div className="dg-dist" />
  const max = Math.max(...bins.map((b) => b.count), 1)
  return (
    <div className="dg-dist" role="img" aria-label={`${column.name} distribution`}>
      {bins.map((b, i) => (
        <span
          key={i}
          className="dg-dist__bar"
          style={{ height: `${Math.max(6, (b.count / max) * 100)}%` }}
          title={`${b.label}: ${b.count.toLocaleString()}`}
        />
      ))}
    </div>
  )
}
