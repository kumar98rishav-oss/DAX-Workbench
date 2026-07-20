import { X, Puzzle, ShieldCheck } from 'lucide-react'
import { useApp } from '@/app/store'
import { IconButton } from '@/design-system/components'
import { pluginRegistry } from '@/app/plugins'
import './plugins.css'

const SEV_ORDER = { error: 0, warning: 1, info: 2 } as const

export function PluginsDialog() {
  const open = useApp((s) => s.pluginsOpen)
  const toggle = useApp((s) => s.togglePlugins)
  const toggleDoctor = useApp((s) => s.toggleDoctor)
  const model = useApp((s) => s.model)

  if (!open) return null

  const r = pluginRegistry
  const issues = [...r.runValidations(model)].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])

  const stats = [
    { n: r.plugins.length, label: 'Plugins' },
    { n: r.exporters.length, label: 'Exporters' },
    { n: r.rules.length, label: 'Rules' },
    { n: r.visuals.length, label: 'Visuals' },
  ]

  return (
    <div className="plugins__scrim" onMouseDown={(e) => e.target === e.currentTarget && toggle(false)}>
      <div className="plugins" role="dialog" aria-modal="true" aria-label="Plugins and model health">
        <div className="plugins__head">
          <div>
            <div className="plugins__title">Plugins & Model Health</div>
            <div className="plugins__sub">The Workbench's features run on its own plugin SDK</div>
          </div>
          <IconButton label="Close" onClick={() => toggle(false)}>
            <X size={18} />
          </IconButton>
        </div>

        <div className="plugins__body pbs-scroll">
          <div className="plugins__stats">
            {stats.map((s) => (
              <div className="plugins__stat" key={s.label}>
                <b>{s.n}</b>
                <span>{s.label}</span>
              </div>
            ))}
          </div>

          <div className="plugins__section-title">
            <ShieldCheck size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
            Model Health {issues.length > 0 && `· ${issues.length} issue${issues.length === 1 ? '' : 's'}`}
          </div>
          <p className="plugins__hint">
            Structure only — keys, blank columns, orphan tables, a date table. Measure quality lives in the{' '}
            <button className="plugins__link" onClick={() => { toggle(false); toggleDoctor(true) }}>Model Doctor</button>.
          </p>
          {model.tables.length === 0 ? (
            <div className="health-issue" data-sev="info"><span className="health-issue__dot" />Connect to Power BI Desktop, or import data, to run model checks.</div>
          ) : issues.length === 0 ? (
            <div className="health-ok"><ShieldCheck size={16} /> Structure looks sound — keys, relationships and date table all check out.</div>
          ) : (
            issues.map((iss, i) => (
              <div key={i} className="health-issue" data-sev={iss.severity}>
                <span className="health-issue__dot" />
                {iss.message}
              </div>
            ))
          )}

          <div className="plugins__section-title">
            <Puzzle size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
            Installed Plugins
          </div>
          {r.plugins.map((p) => (
            <div key={p.id} className="plugin-card">
              <div className="plugin-card__head">
                <span className="plugin-card__name">{p.name}</span>
                <span className="plugin-card__ver">v{p.version}</span>
                <span className="plugin-card__author">{p.author}</span>
              </div>
              <div className="plugin-card__desc">{p.description}</div>
              <div className="plugin-card__contribs">
                {(r.byPlugin.get(p.id) ?? []).map((c, i) => (
                  <span key={i} className="plugin-chip">{c}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
