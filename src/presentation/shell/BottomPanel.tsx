import { useState } from 'react'
import { Lightbulb, FunctionSquare, TableProperties } from 'lucide-react'
import { useApp } from '@/app/store'
import { DataGrid } from '@/presentation/data/DataGrid'

type Tab = 'insights' | 'dax' | 'data'

const TABS: { id: Tab; label: string; icon: typeof Lightbulb }[] = [
  { id: 'insights', label: 'Insights', icon: Lightbulb },
  { id: 'dax', label: 'DAX', icon: FunctionSquare },
  { id: 'data', label: 'Data Preview', icon: TableProperties },
]

export function BottomPanel() {
  const collapsed = !useApp((s) => s.panels.bottom)
  const datasets = useApp((s) => s.datasets)
  const activeId = useApp((s) => s.activeDatasetId)
  const [tab, setTab] = useState<Tab>('insights')
  const active = datasets.find((d) => d.id === activeId) ?? datasets[0]

  return (
    <section className="pbs-bottom" data-collapsed={collapsed}>
      <div className="pbs-bottom__tabs">
        {TABS.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              className="pbs-bottom__tab"
              data-active={tab === t.id ? 'true' : undefined}
              onClick={() => setTab(t.id)}
            >
              <Icon size={15} />
              {t.label}
            </button>
          )
        })}
      </div>

      <div
        className={`pbs-bottom__body ${tab === 'data' ? 'pbs-bottom__body--flush' : 'pbs-scroll'}`}
      >
        {tab === 'insights' && (
          <ul style={{ display: 'grid', gap: 10, listStyle: 'none' }}>
            <InsightRow text="Revenue grew 12.4% QoQ, driven by the West region." tone="up" />
            <InsightRow text="Gross margin dipped 1.8 pts as COGS outpaced sales." tone="down" />
            <InsightRow text="3 of 42 columns look like unused foreign keys." tone="info" />
          </ul>
        )}
        {tab === 'dax' && (
          <pre
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-base)',
              color: 'var(--text)',
              lineHeight: 1.7,
              margin: 0,
            }}
          >
{`Total Revenue =
    SUMX (
        Sales,
        Sales[Quantity] * Sales[Unit Price]
    )`}
          </pre>
        )}
        {tab === 'data' &&
          (active ? (
            <DataGrid columns={active.columns} rows={active.rows} compact />
          ) : (
            <div style={{ padding: 'var(--space-4)', color: 'var(--text-muted)', fontSize: 'var(--text-md)' }}>
              Import a dataset to preview rows here.
            </div>
          ))}
      </div>
    </section>
  )
}

function InsightRow({ text, tone }: { text: string; tone: 'up' | 'down' | 'info' }) {
  const color =
    tone === 'up' ? 'var(--success)' : tone === 'down' ? 'var(--danger)' : 'var(--accent)'
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 'var(--text-md)',
        color: 'var(--text)',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
        }}
      />
      {text}
    </li>
  )
}
