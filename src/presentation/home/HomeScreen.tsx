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
  Cable,
  Download,
  ShieldCheck,
  KeyRound,
  Home,
  WifiOff,
  Lock,
  EyeOff,
  MousePointerClick,
  Database,
  Sigma,
  Factory,
  Stethoscope,
  Zap,
  Gauge,
  CalendarDays,
  Heart,
  Linkedin,
  Mail,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useApp } from '@/app/store'
import { modelLabel, LOCAL_BRIDGE } from '@/infrastructure/desktop/desktop-client'
import { WaveSea } from './WaveSea'
import './home.css'

// Served from the site itself, so this works on localhost and in production alike.
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

/** Everything that isn't the live connector. Real, but secondary. */
const OTHER_WAYS: StartOption[] = [
  { id: 'import', title: 'Import data', desc: 'Excel, CSV or Parquet', icon: <Upload size={16} /> },
  { id: 'pbip', title: 'Open PBIP', desc: 'Power BI project folder', icon: <FolderOpen size={16} /> },
  { id: 'pbix', title: 'Open PBIX', desc: 'Best-effort — no data', icon: <FileInput size={16} /> },
]

// Every line here is a claim about the code, so keep it to what the code does.
// Notably NOT "works offline": this page is served over the web. The honest
// version is stronger anyway — the page comes down, nothing goes back up.
const PRIVACY = [
  {
    icon: <KeyRound size={15} />,
    title: 'No account, no sign-in, no server of ours',
    body: 'There is nothing to register for and nowhere for your data to be sent. The Workbench has no backend — it is a page that runs in your browser.',
  },
  {
    icon: <Home size={15} />,
    title: 'One network call, and it goes to your own machine',
    body: 'The Workbench makes exactly one kind of request: to the bridge at 127.0.0.1:5177. Your tables, rows and measures are read there and stay in your browser\'s memory.',
  },
  {
    icon: <WifiOff size={15} />,
    title: 'The bridge cannot be reached from outside',
    body: 'It binds to loopback only, so it is invisible to your network and the internet — and it never makes an outbound call of its own. It talks to Power BI Desktop and nothing else.',
  },
  {
    icon: <Lock size={15} />,
    title: 'Only this site can use your bridge',
    body: 'It answers an exact list of origins, never a wildcard. Another website cannot reach it, even while it is running.',
  },
  {
    icon: <EyeOff size={15} />,
    title: 'No telemetry of any kind',
    body: 'No analytics, no error reporting, no third-party scripts, no external fonts. Nothing about you or your model is measured, because nothing is sent.',
  },
  {
    icon: <MousePointerClick size={15} />,
    title: 'Your model changes only when you ask',
    body: 'Measures are written to Desktop when you press Push, Deploy or a Doctor fix — never in the background. Every write is a normal edit you can undo in Desktop.',
  },
]

const PILLARS = [
  {
    id: 'dax',
    icon: <Sigma size={20} />,
    name: 'DAX Architect',
    blurb: 'Describe the measure in plain English. The Workbench ranks the ways to build it and you pick.',
    points: [
      'Ranked suggestions, not one guess — you choose',
      'Deterministic: no LLM writes your DAX',
      'Branched plans build the base measures too',
      'Every preview computed on the real engine',
    ],
  },
  {
    id: 'factory',
    icon: <Factory size={20} />,
    name: 'Measure Factory',
    blurb: 'Pick one field and get its whole analytical suite in a single pass, ready to deploy.',
    points: [
      'Total, average, YTD/QTD/MTD, prior year',
      'YoY %, MoM %, moving average, running total',
      '% of total and rank — previewed before deploy',
      'Deploys with the base measures it branches from',
    ],
  },
  {
    id: 'optimizer',
    icon: <Zap size={20} />,
    name: 'DAX Optimizer',
    blurb: 'Rewrites a measure into the shape the engine handles best — then proves it on your data.',
    points: [
      'Whole-table FILTER → a pushed-down predicate',
      'COUNTROWS(FILTER) → CALCULATE, SUMX → SUM',
      'Timed before/after with the caches cleared',
      'Values compared — and "no change required" when clean',
    ],
  },
  {
    id: 'doctor',
    icon: <Stethoscope size={20} />,
    name: 'Model Doctor',
    blurb: 'Audits the live model for what renders badly, scales badly, or breaks quietly.',
    points: [
      'Missing format strings — fixed in one click',
      'FILTER over a whole fact table, with a rewrite',
      'Division that should be DIVIDE()',
      'Exports a Markdown data dictionary',
    ],
  },
  {
    id: 'kpi',
    icon: <Gauge size={20} />,
    name: 'KPI Answers',
    blurb: 'The measures you create become live answers — no chart building, no field wells.',
    points: [
      'A 12-card board that fills itself as you create',
      'Matrix and table: pick rows, columns, measures',
      'Every value computed by Power BI’s own engine',
      'Click a card to open its DAX underneath',
    ],
  },
  {
    id: 'dates',
    icon: <CalendarDays size={20} />,
    name: 'Date table builder',
    blurb: 'A proper date table over your fact table’s real range, deployed as a calculated table.',
    points: [
      'Pick exactly the columns you want',
      'Fiscal year start, sortable month/weekday keys',
      'Ranges over a real fact column’s MIN/MAX',
      'Relationship wired up automatically',
    ],
  },
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

  const [menuOpen, setMenuOpen] = useState(false)
  // Open upward when there isn't room below — otherwise the last items land
  // beneath the fold (or, before the z-fix, under the connect panel).
  const [dropUp, setDropUp] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Poll while we're on Home so the steps tick over as the user starts the
  // bridge / opens a model, without them having to click anything.
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

  // Downloading and running are one step from the bridge's point of view — it's
  // either answering on 5177 or it isn't.
  const steps = [
    {
      label: 'Download the bridge',
      done: desktop.bridge,
      body: (
        <>
          One file, {BRIDGE_SIZE}. No installer, and nothing else to install — the .NET runtime is
          already inside it.
        </>
      ),
    },
    {
      label: 'Run it',
      done: desktop.bridge,
      body: (
        <>
          Double-click it and leave the small window open. Windows will warn that it's from an
          unknown publisher — choose <strong>More info → Run anyway</strong>. It listens on{' '}
          <code>127.0.0.1:5177</code> and only ever talks to your own machine.
        </>
      ),
    },
    {
      label: 'Open your report in Power BI Desktop',
      done: desktop.connected,
      body: <>Open any <code>.pbix</code>. The Workbench finds the model on its own — nothing to configure.</>,
    },
    {
      label: 'Connect',
      done: false,
      body: (
        <>
          This page notices the bridge on its own and reads your tables, rows and measures. Prefer to
          start from Desktop? The bridge can add <strong>DAX Workbench</strong> to Power BI's{' '}
          <strong>External Tools</strong> ribbon — one click there opens the Workbench already
          attached to the report you're in.
        </>
      ),
    },
  ]

  const label = modelLabel(desktop.database)
  const remote = bridgeUrl !== LOCAL_BRIDGE
  const status = desktop.connected
    ? { cls: 'live', text: remote ? `Live · ${desktop.machine ?? 'remote machine'}` : label ? `Live · ${label}` : 'Live · model connected' }
    : desktop.bridge
      ? { cls: 'waiting', text: remote ? 'Remote bridge up — waiting for a model' : 'Bridge running — waiting for a model' }
      : { cls: 'off', text: remote ? 'Remote bridge unreachable' : 'Bridge not running' }

  return (
    <div className="pbs-home pbs-scroll">
      <WaveSea />
      <div className="pbs-home__topbar">
        <span className="pbs-home__brand">
          <span className="pbs-home__logo">
            <Sparkles size={16} />
          </span>
          DAX Workbench
        </span>
        <span style={{ flex: 1 }} />
        {/* Sister tool: the report-design companion. Ctrl+K still opens search —
            its handler is global — the landing just doesn't need the bar. */}
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
        <section className="pbs-home__hero">
          <span className="pbs-status" data-state={status.cls}>
            <span className="pbs-status__dot" />
            {status.text}
          </span>
          <h1 className="pbs-home__title">
            Write DAX against your <em>real</em> model
          </h1>
          <p className="pbs-home__lede">
            A measure workbench that launches from Power BI Desktop's own ribbon. It reads the model
            you have open — real tables, real rows, real measures — writes the DAX, checks it on
            Microsoft's engine, optimizes it, and deploys it straight back. Nothing is estimated.
          </p>

          {/* The glass panel — their prompt box, our connect box. */}
          <div className="pbs-glass">
          <div className="pbs-home__cta">
            <button className="pbs-connect" onClick={connect} disabled={importing} data-live={desktop.connected}>
              {importing ? <Loader2 size={18} className="pbs-spin" /> : <MonitorCheck size={18} />}
              {importing
                ? 'Syncing your model…'
                : desktop.connected
                  ? `Sync ${label ?? 'live model'}`
                  : 'Connect to Power BI Desktop'}
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
          <div className="pbs-glass__chips">
            <span className="pbs-gchip"><b>Architect</b> · plain English in, ranked DAX out</span>
            <span className="pbs-gchip"><b>Optimizer</b> · rewrites, then times the proof</span>
            <span className="pbs-gchip"><b>Factory</b> · a whole suite per field</span>
            <span className="pbs-gchip"><b>KPI</b> · live answers, not charts to build</span>
            <span className="pbs-gchip">Data stays on your machine</span>
          </div>
          </div>
        </section>

        {/* One box: everything needed to get the live connection up. */}
        <section className="pbs-panel">
          <div className="pbs-panel__head">
            <span className="pbs-panel__icon"><Cable size={18} /></span>
            <div>
              <h2 className="pbs-panel__title">Connect to Power BI Desktop</h2>
              <p className="pbs-panel__sub">
                Power BI Desktop runs a private Analysis Services engine behind your report. A small
                local bridge lets the Workbench talk to it — the same way Tabular Editor and DAX Studio do.
                Your data never leaves this machine.
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
                  <span className="pbs-step__hint">{s.body}</span>
                  {i === 0 && !desktop.bridge && (
                    <a className="pbs-download" href={BRIDGE_DOWNLOAD} download>
                      <Download size={15} />
                      Download the bridge
                      <span className="pbs-download__size">Windows · {BRIDGE_SIZE}</span>
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ol>

          <p className="pbs-panel__foot">
            <ShieldCheck size={13} />
            <span>
              The bridge runs entirely on your machine. It listens on loopback only, accepts calls
              from this site alone, and uploads nothing anywhere. It can read your model and write
              measures into it — that is what makes the Workbench work — so only ever run a copy you
              downloaded from here.{' '}
              <button className="pbs-inlinelink" onClick={() => toggleRemote(true)}>
                The report is on another machine?
              </button>
            </span>
          </p>

          {/* Always reachable — you may want the file to send to someone else for the
              remote connector, even while your own bridge is running. */}
          <div className="pbs-panel__grab">
            <a className="pbs-inlinelink" href={BRIDGE_DOWNLOAD} download>
              <Download size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              Download the bridge{desktop.bridge ? ' again' : ''}
            </a>
            <span className="pbs-panel__grabnote">Windows · {BRIDGE_SIZE} · send it to whoever has the report open</span>
          </div>
        </section>

        {/* The three things the tool is for. */}
        <section className="pbs-pillars">
          {PILLARS.map((p) => (
            <article className="pbs-pillar" key={p.id}>
              <span className="pbs-pillar__icon">{p.icon}</span>
              <h3 className="pbs-pillar__name">{p.name}</h3>
              <p className="pbs-pillar__blurb">{p.blurb}</p>
              <ul className="pbs-pillar__list">
                {p.points.map((pt) => (
                  <li key={pt}>
                    <Check size={13} />
                    <span>{pt}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>

        <p className="pbs-alsoline">
          Around them — <strong>All DAX</strong>, every measure in the model in one searchable,
          copyable list; a <strong>Data</strong> preview with column profiling; and{' '}
          <strong>Model</strong>, with star-schema detection and a relationship graph. Working on
          someone else's report? The <strong>remote connector</strong> reaches a model open on
          another machine.
        </p>

        {/* Privacy — the reason a stranger can afford to run this. */}
        <section className="pbs-privacy">
          <div className="pbs-privacy__head">
            <span className="pbs-privacy__icon"><ShieldCheck size={20} /></span>
            <h2 className="pbs-privacy__title">Your data never leaves your computer</h2>
            <p className="pbs-privacy__lede">
              Not a promise in a policy — a consequence of how it is built. Here is every place your
              data can go.
            </p>
          </div>

          <div className="pbs-boundary">
            <span className="pbs-boundary__tag">Your computer</span>
            <div className="pbs-boundary__row">
              <div className="pbs-node">
                <Database size={16} />
                <strong>Power BI Desktop</strong>
                <span>your model and its rows</span>
              </div>
              <span className="pbs-boundary__link" aria-hidden="true" />
              <div className="pbs-node">
                <Cable size={16} />
                <strong>The bridge</strong>
                <span>127.0.0.1:5177</span>
              </div>
              <span className="pbs-boundary__link" aria-hidden="true" />
              <div className="pbs-node">
                <Sparkles size={16} />
                <strong>The Workbench</strong>
                <span>running in your browser</span>
              </div>
            </div>
          </div>
          <p className="pbs-boundary__note">
            The only thing that ever crosses that line is this page, downloaded once. Nothing goes
            back the other way — there is no server of ours to send it to.
          </p>

          <ul className="pbs-privacy__list">
            {PRIVACY.map((p) => (
              <li className="pbs-priv" key={p.title}>
                <span className="pbs-priv__icon">{p.icon}</span>
                <div>
                  <span className="pbs-priv__title">{p.title}</span>
                  <span className="pbs-priv__body">{p.body}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <footer className="pbs-footer">
          <p className="pbs-footer__love">
            Designed with <Heart size={13} className="pbs-footer__heart" /> by Rishav K.
          </p>
          <p className="pbs-footer__ask">Love to hear about your experience.</p>
          <div className="pbs-footer__links">
            <a className="pbs-footer__link" href={LINKEDIN} target="_blank" rel="noopener noreferrer">
              <Linkedin size={14} /> linkedin.com/in/rishav98kumar
            </a>
            <a className="pbs-footer__link" href={`mailto:${EMAIL}?subject=DAX%20Workbench%20feedback`}>
              <Mail size={14} /> {EMAIL}
            </a>
          </div>
          <p className="pbs-footer__legal">
            © 2026 DAX Workbench. All rights reserved. Built by Rishav K. Not affiliated with or
            endorsed by Microsoft. Power BI is a trademark of Microsoft Corporation.
          </p>
        </footer>
      </div>
    </div>
  )
}
