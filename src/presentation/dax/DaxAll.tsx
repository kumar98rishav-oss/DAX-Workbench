import { useMemo, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import type { SemanticModel } from '@/domain/model'

/** Every measure in the model with its DAX, in one scrollable list — the view
 * you want when you're reading a model rather than editing one measure. */
export function DaxAll({
  model,
  selectedId,
  onSelect,
}: {
  model: SemanticModel
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  const rows = useMemo(
    () =>
      model.tables.flatMap((t) =>
        t.measures.map((m) => ({
          id: m.id,
          name: m.name,
          table: t.name,
          dax: m.expression,
          format: m.formatString,
        })),
      ),
    [model],
  )

  const needle = q.trim().toLowerCase()
  const shown = needle
    ? rows.filter((r) => r.name.toLowerCase().includes(needle) || r.dax.toLowerCase().includes(needle))
    : rows

  const copy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600)
    })
  }

  const copyAll = () =>
    copy(shown.map((r) => `// ${r.table}[${r.name}]\n${r.name} = ${r.dax}`).join('\n\n'), '__all__')

  return (
    <div className="dall">
      <div className="dall__head">
        <input
          className="dax-ref__search"
          placeholder="Search measures or DAX…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="dall__meta">
          <span>{shown.length} of {rows.length} measures</span>
          {shown.length > 0 && (
            <button className="opt__copy" onClick={copyAll}>
              {copied === '__all__' ? <Check size={13} /> : <Copy size={13} />}
              {copied === '__all__' ? 'Copied' : 'Copy all'}
            </button>
          )}
        </div>
      </div>

      <div className="dall__list pbs-scroll">
        {shown.map((r) => (
          <div
            key={r.id}
            className="dall__item"
            data-active={r.id === selectedId ? 'true' : undefined}
            onClick={() => onSelect(r.id)}
          >
            <div className="dall__top">
              <span className="dall__name">{r.name}</span>
              <button
                className="opt__copy"
                onClick={(e) => {
                  e.stopPropagation()
                  copy(r.dax, r.id)
                }}
                title="Copy this DAX"
              >
                {copied === r.id ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
            <div className="dall__table">{r.table}{r.format ? ` · ${r.format}` : ''}</div>
            <pre className="dall__dax">{r.dax}</pre>
          </div>
        ))}
        {shown.length === 0 && (
          <p className="dall__empty">{rows.length === 0 ? 'No measures yet.' : 'Nothing matches that search.'}</p>
        )}
      </div>
    </div>
  )
}
