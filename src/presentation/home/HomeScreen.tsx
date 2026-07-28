import {
  Sparkles,
  Palette,
  ArrowUpRight,
  MonitorCheck,
  ChevronDown,
  Upload,
  FolderOpen,
  FileInput,
  Check,
  Loader2,
  RefreshCw,
  Cable,
  Download,
  ShieldCheck,
  Heart,
  Linkedin,
  Mail,
  Sigma,
  Factory,
  Stethoscope,
  Zap,
  Gauge,
  CalendarDays,
  BrainCircuit,
  Lock,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useApp } from '@/app/store'
import { modelLabel, modelLabelParts, LOCAL_BRIDGE } from '@/infrastructure/desktop/desktop-client'
import { WaveSea } from './WaveSea'
import './home.css'

const BRIDGE_DOWNLOAD = '/download/DAX-Workbench-Bridge.exe'
const BRIDGE_SIZE = '83 MB'
const LINKEDIN = 'https://www.linkedin.com/in/rishav98kumar'
const EMAIL = 'Kumar98rishav@gmail.com'

interface StartOption {
  id: string
  title: string
  desc: string
  icon: ReactNode
}

const OTHER_WAYS: StartOption[] = [
  { id: 'import', title: 'Import data', desc: 'Excel, CSV or Parquet', icon: <Upload size={16} /> },
  { id: 'pbip', title: 'Open PBIP', desc: 'Power BI project folder', icon: <FolderOpen size={16} /> },
  { id: 'pbix', title: 'Open PBIX', desc: 'Best-effort — no data', icon: <FileInput size={16} /> },
]

const FEATURES = [
  {
    id: 'ai',
    icon: <BrainCircuit size={22} />,
    name: 'AI Generate',
    tag: 'New',
    line: 'Describe the measure in plain English. DeepSeek reads your live schema and writes schema-grounded DAX — no hallucinated column names.',
    accent: 'purple',
  },
  {
    id: 'architect',
    icon: <Sigma size={22} />,
    name: 'DAX Architect',
    tag: null,
    line: 'Ranked pattern suggestions — not one guess, but a scored list. You pick the one that fits your model best.',
    accent: 'blue',
  },
  {
    id: 'factory',
    icon: <Factory size={22} />,
    name: 'Measure Factory',
    tag: null,
    line: 'Pick one field and get its full analytical suite: Total, YTD, QTD, YoY, MoM %, moving average, running total, rank.',
    accent: 'blue',
  },
  {
    id: 'optimizer',
    icon: <Zap size={22} />,
    name: 'DAX Optimizer',
    tag: null,
    line: 'Rewrites slow DAX patterns into the shape the engine handles best — then times before and after on your real data.',
    accent: 'blue',
  },
  {
    id: 'doctor',
    icon: <Stethoscope size={22} />,
    name: 'Model Doctor',
    tag: null,
    line: 'Audits the live model for missing formats, dangerous FILTERs, and silent errors. Fixes applied in one click.',
    accent: 'blue',
  },
  {
    id: 'kpi',
    icon: <Gauge size={22} />,
    name: 'Live KPI Board',
    tag: null,
    line: "Every measure you create becomes a live answer on a 12-card board. Computed by Power BI's own engine, not estimated.",
    accent: 'blue',
  },
  {
    id: 'dates',
    icon: <CalendarDays size={22} />,
    name: 'Date Table Builder',
    tag: null,
    line: 'Build a proper date table over your fact column\'s real range. Pick columns, set fiscal year, deploy as a calculated table.',
    accent: 'blue',
  },
]

const TRUST = [
  { icon: <Lock size={13} />, label: 'No account, ever' },
  { icon: <ShieldCheck size={13} />, label: 'Data stays on your machine' },
  { icon: <MonitorCheck size={13} />, label: 'No telemetry' },
  { icon: <Check size={13} />, label: 'You control every write' },
]

export function HomeScreen() {
  const openStudio = useApp((s) => s.openStudio)
  const requestImport = useApp((s) => s.requestImport)
  const requestOpenPbip = useApp((s) => s.requestOpenPbip)
  const requestOpenPbix = useApp((s) => s.requestOpenPbix)
  const desktop = useApp((s) => s.desktop)
  const importing = useApp((s) => s.importing)
  const refreshDesktop = useApp((s) => s.refreshDesktop)
  const toggleRemote = useApp((s) => s.toggleRemote)
  const bridgeUrl = useApp((s) => s.bridgeUrl)
  const syncFromDesktop = useApp((s) => s.syncFromDesktop)
  const chooseModel = useApp((s) => s.chooseModel)

  const models = desktop.models ?? []
  const showPicker = desktop.needsChoice || (desktop.connected && models.length > 1)

  const [menuOpen, setMenuOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void refreshDesktop()
    const t = setInterval(() => void refreshDesktop(), 4000)
    return () => clearInterval(t)
  }, [refreshDesktop])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const connect = () => {
    void (async () => {
      await refreshDesktop()
      if (useApp.getState().desktop.connected) void syncFromDesktop()
    })()
  }

  const pick = (o: StartOption) => {
    setMenuOpen(false)
    if (o.id === 'import') requestImport()
    else if (o.id === 'pbip') requestOpenPbip()
    else if (o.id === 'pbix') requestOpenPbix()
    else openStudio('Untitled Dashboard')
  }

  const steps = [
    {
      label: 'Download & run the bridge',
      done: desktop.bridge,
      hint: <>One file, {BRIDGE_SIZE}. No installer — .NET is bundled inside.</>,
      action: !desktop.bridge && (
        <a className="pbs-download" href={BRIDGE_DOWNLOAD} download>
          <Download size={15} /> Download bridge
          <span className="pbs-download__size">Windows · {BRIDGE_SIZE}</span>
        </a>
      ),
    },
    {
      label: 'Open your report in Power BI Desktop',
      done: desktop.connected,
      hint: <>Open any <code>.pbix</code>. The Workbench finds the model automatically.</>,
      action: null,
    },
    {
      label: 'Click Connect above',
      done: false,
      hint: <>The Workbench reads your tables, rows, and measures — then keeps them in sync.</>,
      action: null,
    },
  ]

  const label = modelLabel(desktop.database)
  const remote = bridgeUrl !== LOCAL_BRIDGE
  const status = desktop.connected
    ? { cls: 'live', text: remote ? `Live · ${desktop.machine ?? 'remote machine'}` : label ? `Live · ${label}` : 'Live · model connected' }
    : desktop.bridge
      ? { cls: 'waiting', text: remote ? 'Remote bridge up — waiting for a model' : 'Bridge running — open a .pbix in Desktop' }
      : { cls: 'off', text: 'Bridge not running' }

  return (
    <div className="pbs-home pbs-scroll">
      <WaveSea />

      {/* ── Sticky topbar ── */}
      <div className="pbs-home__topbar">
        <span className="pbs-home__brand">
          <span className="pbs-home__logo"><Sparkles size={16} /></span>
          DAX Workbench
        </span>
        <span style={{ flex: 1 }} />
        <a
          className="pbs-sister"
          href="https://bi-visual-design-02.onrender.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="pbs-sister__icon"><Palette size={14} /></span>
          <span className="pbs-sister__label">
            BI Visual Design
            <span className="pbs-sister__hint">style your report visuals</span>
          </span>
          <ArrowUpRight size={14} className="pbs-sister__arrow" />
        </a>
      </div>

      <div className="pbs-home__inner">

        {/* ── Hero ── */}
        <section className="pbs-home__hero">
          <span className="pbs-status" data-state={status.cls}>
            <span className="pbs-status__dot" />
            {status.text}
          </span>

          <h1 className="pbs-home__title">
            Build better DAX,<br />
            against your <em>real</em> model
          </h1>
          <p className="pbs-home__lede">
            A Power BI External Tool that reads your live model, generates and
            optimises measures, and deploys them straight back — powered by AI
            and your own engine.
          </p>

          {/* CTA glass */}
          <div className="pbs-glass">
            <div className="pbs-home__cta">
              <button
                className="pbs-connect"
                onClick={connect}
                disabled={importing}
                data-live={desktop.connected}
              >
                {importing
                  ? <><Loader2 size={18} className="pbs-spin" /> Syncing model…</>
                  : desktop.connected
                    ? <><MonitorCheck size={18} /> Sync {label ?? 'live model'}</>
                    : <><MonitorCheck size={18} /> Connect to Power BI Desktop</>
                }
              </button>

              <div className="pbs-menu" ref={menuRef}>
                <button
                  className="pbs-menu__btn"
                  onClick={() => {
                    const r = menuRef.current?.getBoundingClientRect()
                    setDropUp(!!r && r.bottom + 270 > window.innerHeight)
                    setMenuOpen((o) => !o)
                  }}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                >
                  Other ways to start
                  <ChevronDown size={15} style={{ transform: menuOpen ? 'rotate(180deg)' : undefined }} />
                </button>
                {menuOpen && (
                  <div className={`pbs-menu__pop${dropUp ? ' pbs-menu__pop--up' : ''}`} role="menu">
                    {OTHER_WAYS.map((o) => (
                      <button key={o.id} className="pbs-menu__item" role="menuitem" onClick={() => pick(o)}>
                        <span className="pbs-menu__icon">{o.icon}</span>
                        <span className="pbs-menu__body">
                          <span className="pbs-menu__title">{o.title}</span>
                          <span className="pbs-menu__desc">{o.desc}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Model changed under us (a restart into a different report, or the
                user switched .pbix) — the loaded model is now out of date. */}
            {desktop.stale && !importing && (
              <button className="pbs-remsg pbs-remsg--warn" onClick={() => void syncFromDesktop()}>
                <RefreshCw size={14} /> The open report changed — sync to refresh
              </button>
            )}

            {/* Multi-report picker: several .pbix open, or a chance to switch. */}
            {showPicker && (
              <div className="pbs-picker">
                <div className="pbs-picker__hd">
                  {desktop.needsChoice
                    ? `${models.length} reports open — choose one`
                    : 'Open reports'}
                </div>
                {models.map((m) => {
                  const active = desktop.port === m.port
                  const name = modelLabel(m.database)
                  const preview = (m.tables ?? []).slice(0, 3).join(', ')
                  return (
                    <button
                      key={m.port}
                      className="pbs-picker__row"
                      data-active={active}
                      onClick={() => {
                        if (active) return
                        chooseModel(m.port)
                        void syncFromDesktop()
                      }}
                    >
                      <span className="pbs-picker__main">
                        <span className="pbs-picker__name">{name ?? `Report on port ${m.port}`}</span>
                        <span className="pbs-picker__meta">
                          {modelLabelParts(m)}{preview ? ` — ${preview}${(m.tables?.length ?? 0) > 3 ? '…' : ''}` : ''}
                        </span>
                      </span>
                      {active ? <span className="pbs-picker__on">Connected</span> : <span className="pbs-picker__go">Connect →</span>}
                    </button>
                  )
                })}
              </div>
            )}

            {/* trust chips */}
            <div className="pbs-glass__chips">
              {TRUST.map((t) => (
                <span key={t.label} className="pbs-gchip">
                  {t.icon} {t.label}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ── Feature grid ── */}
        <section className="pbs-features">
          <p className="pbs-features__label">What's inside</p>
          <div className="pbs-features__grid">
            {FEATURES.map((f) => (
              <article key={f.id} className="pbs-feat" data-accent={f.accent}>
                <div className="pbs-feat__top">
                  <span className="pbs-feat__icon">{f.icon}</span>
                  {f.tag && <span className="pbs-feat__tag">{f.tag}</span>}
                </div>
                <h3 className="pbs-feat__name">{f.name}</h3>
                <p className="pbs-feat__line">{f.line}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── Connect setup ── */}
        {!desktop.connected && (
          <section className="pbs-panel">
            <div className="pbs-panel__head">
              <span className="pbs-panel__icon"><Cable size={18} /></span>
              <div>
                <h2 className="pbs-panel__title">Three steps to connect</h2>
                <p className="pbs-panel__sub">
                  A small local bridge lets the Workbench talk to Power BI Desktop's Analysis Services engine — the same way Tabular Editor and DAX Studio do. Your data never leaves your machine.
                </p>
              </div>
              <span className="pbs-panel__pill" data-state={status.cls}>
                <span className="pbs-status__dot" />
                {status.cls === 'live' ? 'Connected' : status.cls === 'waiting' ? 'Almost there' : 'Not set up'}
              </span>
            </div>

            <ol className="pbs-steps">
              {steps.map((s, i) => (
                <li className="pbs-step" key={s.label} data-done={s.done}>
                  <span className="pbs-step__mark">{s.done ? <Check size={13} /> : i + 1}</span>
                  <div className="pbs-step__body">
                    <span className="pbs-step__label">{s.label}</span>
                    <span className="pbs-step__hint">{s.hint}</span>
                    {s.action}
                  </div>
                </li>
              ))}
            </ol>

            <p className="pbs-panel__foot">
              <ShieldCheck size={13} />
              <span>
                The bridge binds to loopback only and accepts calls from this site alone.{' '}
                <button className="pbs-inlinelink" onClick={() => toggleRemote(true)}>
                  Model on another machine?
                </button>
              </span>
            </p>
          </section>
        )}

        {/* ── Footer ── */}
        <footer className="pbs-footer">
          <p className="pbs-footer__love">
            Designed with <Heart size={13} className="pbs-footer__heart" /> by Rishav K.
          </p>
          <div className="pbs-footer__links">
            <a className="pbs-footer__link" href={LINKEDIN} target="_blank" rel="noopener noreferrer">
              <Linkedin size={14} /> linkedin.com/in/rishav98kumar
            </a>
            <a className="pbs-footer__link" href={`mailto:${EMAIL}?subject=DAX%20Workbench%20feedback`}>
              <Mail size={14} /> {EMAIL}
            </a>
          </div>
          <p className="pbs-footer__legal">
            © 2026 DAX Workbench · Built by Rishav K. · Not affiliated with Microsoft. Power BI is a trademark of Microsoft Corporation.
          </p>
        </footer>
      </div>
    </div>
  )
}
