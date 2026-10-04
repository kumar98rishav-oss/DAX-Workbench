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
  Zap,
  BrainCircuit,
  Lock,
  Workflow,
  ArrowLeftRight,
  ListChecks,
  Link2,
  ScanSearch,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useApp } from '@/app/store'
import { modelLabel, modelLabelParts, LOCAL_BRIDGE } from '@/infrastructure/desktop/desktop-client'
import { WaveSea } from './WaveSea'
import './home.css'

// Served from GitHub Releases, not from this site: the binary is ~85 MB and
// committing each build to the repo added that much to git history forever.
// `releases/latest` always resolves to the newest published build.
const BRIDGE_DOWNLOAD = 'https://github.com/kumar98rishav-oss/DAX-Workbench/releases/latest/download/DAX-Workbench-Bridge.exe'
const BRIDGE_SIZE = '89 MB'
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

// The first card spans two columns (.pbs-feat:first-child), so one featured
// card plus seven fills three rows of the grid exactly.
const FEATURES = [
  {
    id: 'reconcile',
    icon: <ArrowLeftRight size={22} />,
    name: 'Reconciliation',
    tag: 'New',
    line: 'Compare the live model against SQL Server and drill to where they part company — total, then year, then month, then the one product that is off. A matching grand total proves very little: offsetting errors cancel, and only the slice shows it.',
    accent: 'purple',
  },
  {
    id: 'suites',
    icon: <ListChecks size={22} />,
    name: 'Check suites',
    tag: 'New',
    line: 'Point it at a model and it drafts the checks — row count, date coverage, duplicate keys — for every table at once. Save them and re-run the set after each refresh.',
    accent: 'purple',
  },
  {
    id: 'integrity',
    icon: <Link2 size={22} />,
    name: 'Integrity checks',
    tag: 'New',
    line: 'Orphaned keys are the failure nothing else catches: counts agree, totals agree, and revenue sits quietly under (Blank) in the report. One check per relationship.',
    accent: 'purple',
  },
  {
    id: 'honest',
    icon: <ScanSearch size={22} />,
    name: 'It shows its working',
    tag: null,
    line: 'Every result carries the two queries that produced it and the numbers each returned. Copy them into SSMS and DAX Studio and get the same answer — nothing has to be taken on trust.',
    accent: 'purple',
  },
  {
    id: 'pipeline',
    icon: <Workflow size={22} />,
    name: 'Delivery Pipeline',
    tag: null,
    line: "An 11-stage cockpit your AI agent drives over MCP — profile, model, measures, report, QA — with breakpoints, sign-offs and on-fail branches. The gates don't take the agent's word for it: the host re-runs the numbers on your live engine and only goes green when they reconcile.",
    accent: 'blue',
  },
  {
    id: 'ai',
    icon: <BrainCircuit size={22} />,
    name: 'AI Generate',
    tag: null,
    line: 'Describe a measure in plain English. The AI reads your live schema and writes DAX grounded in it — invented table, column and measure names are caught before anything is written.',
    accent: 'blue',
  },
  {
    id: 'optimizer',
    icon: <Zap size={22} />,
    name: 'DAX Optimizer',
    tag: null,
    line: 'Rewrites slow patterns into the shape the engine handles best, then times both versions cold on your real data and refuses to call a win it cannot measure.',
    accent: 'blue',
  },
]

const TRUST = [
  { icon: <Lock size={13} />, label: 'No account, ever' },
  { icon: <ShieldCheck size={13} />, label: 'Runs on your machine' },
  { icon: <MonitorCheck size={13} />, label: 'No telemetry' },
  { icon: <Check size={13} />, label: 'Read-only on your database' },
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
  // Several reports open and none picked yet: the bridge IS connected, but we
  // are NOT bound to a model — saying "Live" there would be a lie.
  const status = desktop.needsChoice
    ? { cls: 'waiting', text: `${models.length} reports open — choose one` }
    : desktop.connected
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
            Build your Power BI model.<br />
            <em>Prove</em> it against the source.
          </h1>
          <p className="pbs-home__lede">
            A Power BI External Tool that reconciles your live model against SQL Server —
            row counts, duplicate keys, date coverage, orphaned keys — and saves those
            checks as a suite you re-run after every refresh. Build measures with AI and
            deploy them straight into Desktop. All of it on your machine, nothing uploaded.
          </p>

          {/* CTA glass */}
          <div className="pbs-glass">
            <div className="pbs-home__cta">
              <button
                className="pbs-connect"
                onClick={connect}
                disabled={importing || desktop.needsChoice}
                data-live={desktop.connected && !desktop.needsChoice}
              >
                {importing
                  ? <><Loader2 size={18} className="pbs-spin" /> Syncing model…</>
                  : desktop.needsChoice
                    ? <><MonitorCheck size={18} /> Choose a report below</>
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
          {/* The grid names the eight worth leading with; the rest are real and
              shipped, and belong on one line rather than in eight more cards. */}
          <p className="pbs-alsoline">
            Also in the box — <strong>Measure Factory</strong> (one field, its whole
            analytical suite), <strong>DAX Architect</strong> (ranked pattern suggestions,
            not one guess), <strong>Model Doctor</strong>, <strong>Date Table Builder</strong>,
            a <strong>cleanup</strong> pass that proves a measure is unused by scanning the
            report before offering to delete it, and <strong>PBIP / TMDL</strong> import.
          </p>
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
                The bridge binds to loopback only and accepts calls from this site alone.
                Reconciliation connects to SQL Server with your own Windows account and
                runs read-only: every statement is checked before a connection is opened,
                and anything but a single <code>SELECT</code> is refused.{' '}
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
