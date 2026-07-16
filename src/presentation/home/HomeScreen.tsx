import {
  Sparkles,
  Search,
  MonitorCheck,
  ChevronDown,
  Upload,
  LayoutDashboard,
  FolderOpen,
  FileInput,
  Check,
  Loader2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useApp } from '@/app/store'
import { modelLabel } from '@/infrastructure/desktop/desktop-client'
import { Kbd } from '@/design-system/components'
import './home.css'

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
  { id: 'new', title: 'New dashboard', desc: 'Start from a blank canvas', icon: <LayoutDashboard size={16} /> },
]

export function HomeScreen() {
  const openStudio = useApp((s) => s.openStudio)
  const setCommandPalette = useApp((s) => s.setCommandPalette)
  const requestImport = useApp((s) => s.requestImport)
  const requestOpenPbip = useApp((s) => s.requestOpenPbip)
  const requestOpenPbix = useApp((s) => s.requestOpenPbix)
  const desktop = useApp((s) => s.desktop)
  const importing = useApp((s) => s.importing)
  const refreshDesktop = useApp((s) => s.refreshDesktop)
  const syncFromDesktop = useApp((s) => s.syncFromDesktop)

  const [menuOpen, setMenuOpen] = useState(false)
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

  const steps = [
    {
      label: 'Local bridge running',
      done: desktop.bridge,
      hint: <>Run <code>tools/pbi-desktop-bridge/run.cmd</code></>,
    },
    {
      label: 'A model open in Power BI Desktop',
      done: desktop.connected,
      hint: <>Open any <code>.pbix</code> — Studio finds it automatically</>,
    },
    {
      label: 'Sync it into Studio',
      done: false,
      hint: <>Real rows, real measures, real DAX previews</>,
    },
  ]

  const label = modelLabel(desktop.database)
  const status = desktop.connected
    ? { cls: 'live', text: label ? `Live · ${label}` : 'Live · model connected' }
    : desktop.bridge
      ? { cls: 'waiting', text: 'Bridge running — waiting for a model' }
      : { cls: 'off', text: 'Bridge not running' }

  return (
    <div className="pbs-home pbs-scroll">
      <div className="pbs-home__topbar">
        <span className="pbs-home__brand">
          <span className="pbs-home__logo">
            <Sparkles size={16} />
          </span>
          Power BI Studio
        </span>
        <span style={{ flex: 1 }} />
        <button className="pbs-topbar__cmd" onClick={() => setCommandPalette(true)}>
          <Search size={15} />
          <span className="pbs-topbar__cmd-label">Search</span>
          <Kbd keys={['Ctrl', 'K']} />
        </button>
      </div>

      <div className="pbs-home__inner">
        <section className="pbs-home__hero">
          <span className="pbs-status" data-state={status.cls}>
            <span className="pbs-status__dot" />
            {status.text}
          </span>
          <h1 className="pbs-home__title">
            Work on your <em>real</em> Power BI model
          </h1>
          <p className="pbs-home__lede">
            Studio reads the model open in Power BI Desktop — real rows, real measures, real values —
            builds the DAX, and writes it straight back. Nothing is estimated.
          </p>

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
              <button className="pbs-menu__btn" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen} aria-haspopup="menu">
                Other ways to start
                <ChevronDown size={15} style={{ transform: menuOpen ? 'rotate(180deg)' : undefined }} />
              </button>
              {menuOpen && (
                <div className="pbs-menu__pop" role="menu">
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
        </section>

        <ol className="pbs-steps">
          {steps.map((s, i) => (
            <li className="pbs-step" key={s.label} data-done={s.done}>
              <span className="pbs-step__mark">{s.done ? <Check size={13} /> : i + 1}</span>
              <span className="pbs-step__body">
                <span className="pbs-step__label">{s.label}</span>
                <span className="pbs-step__hint">{s.hint}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
