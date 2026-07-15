import {
  Sparkles,
  Upload,
  LayoutDashboard,
  FolderOpen,
  FileInput,
  Search,
  // template icons
  ScanText,
  HeartPulse,
  ReceiptText,
  Share2,
  Video,
  Hotel,
  TrendingUp,
  Star,
  UtensilsCrossed,
  SlidersHorizontal,
  GraduationCap,
  Users,
  Wallet,
  FlaskConical,
  GitBranch,
  ShieldCheck,
  DollarSign,
  Boxes,
  Radio,
  LineChart,
  ShoppingCart,
  Truck,
  UserCog,
  Landmark,
  Megaphone,
  Target,
  PackageSearch,
  Headphones,
  Factory,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp } from '@/app/store'
import { Card, EmptyState, Kbd } from '@/design-system/components'
import { TEMPLATES, VERTICALS } from '@/application/templates/catalog'
import './home.css'

const ICONS: Record<string, LucideIcon> = {
  ScanText, HeartPulse, ReceiptText, Share2, Video, Hotel, TrendingUp, Star,
  UtensilsCrossed, SlidersHorizontal, GraduationCap, Users, Wallet, FlaskConical,
  GitBranch, ShieldCheck, DollarSign, Boxes, Radio, LineChart, ShoppingCart,
  Truck, UserCog, LayoutDashboard, Landmark, Megaphone, Target, PackageSearch,
  Headphones, Factory,
}

const grad = (accent: string) =>
  `linear-gradient(140deg, ${accent}, color-mix(in srgb, ${accent} 52%, #0b0e14))`

interface QuickAction {
  id: string
  title: string
  desc: string
  icon: ReactNode
}

const ACTIONS: QuickAction[] = [
  { id: 'import', title: 'Import Data', desc: 'Excel, CSV, Parquet, SQL', icon: <Upload size={22} /> },
  { id: 'new', title: 'New Dashboard', desc: 'Start from a blank canvas', icon: <LayoutDashboard size={22} /> },
  { id: 'pbip', title: 'Open PBIP', desc: 'Power BI project folder', icon: <FolderOpen size={22} /> },
  { id: 'pbix', title: 'Open PBIX', desc: 'Best-effort import', icon: <FileInput size={22} /> },
]

export function HomeScreen() {
  const openStudio = useApp((s) => s.openStudio)
  const setCommandPalette = useApp((s) => s.setCommandPalette)
  const requestImport = useApp((s) => s.requestImport)
  const requestOpenPbip = useApp((s) => s.requestOpenPbip)
  const requestOpenPbix = useApp((s) => s.requestOpenPbix)
  const applyTemplate = useApp((s) => s.applyTemplate)

  const runAction = (id: string, title: string) => {
    if (id === 'import') requestImport()
    else if (id === 'pbip') requestOpenPbip()
    else if (id === 'pbix') requestOpenPbix()
    else openStudio(title === 'New Dashboard' ? 'Untitled Dashboard' : title)
  }

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
          <span className="pbs-home__eyebrow">
            <Sparkles size={14} /> 30 templates · pick one → instant styled dashboard
          </span>
          <h1 className="pbs-home__title">
            Build Power BI solutions <em>at the speed of thought</em>
          </h1>
          <p className="pbs-home__lede">
            Choose a template and Studio generates a themed, data-bound dashboard — or import your
            own data and it detects the schema, writes the DAX, and builds the report automatically.
          </p>
        </section>

        <section className="pbs-home__actions">
          {ACTIONS.map((a) => (
            <Card key={a.id} interactive className="pbs-action" onClick={() => runAction(a.id, a.title)}>
              <span className="pbs-action__icon">{a.icon}</span>
              <span className="pbs-action__title">{a.title}</span>
              <span className="pbs-action__desc">{a.desc}</span>
            </Card>
          ))}
        </section>

        {VERTICALS.map((vertical) => {
          const items = TEMPLATES.filter((t) => t.vertical === vertical)
          return (
            <section className="pbs-home__section" key={vertical}>
              <div className="pbs-section-head">
                <span className="pbs-section-head__title">{vertical}</span>
                <span className="pbs-section-head__link" style={{ color: 'var(--text-subtle)' }}>
                  {items.length} templates
                </span>
              </div>
              <div className="pbs-templates">
                {items.map((t) => {
                  const Icon = ICONS[t.icon] ?? LayoutDashboard
                  return (
                    <Card key={t.id} interactive className="pbs-template" onClick={() => void applyTemplate(t)}>
                      <div className="pbs-template__thumb" style={{ background: grad(t.accent) }}>
                        <Icon size={26} />
                        <span className="pbs-template__mode">{t.mode === 'dark' ? 'Neon' : 'Minimal'}</span>
                      </div>
                      <div className="pbs-template__body">
                        <div className="pbs-template__name">{t.name}</div>
                        <div className="pbs-template__meta">{t.blurb}</div>
                      </div>
                    </Card>
                  )
                })}
              </div>
            </section>
          )
        })}

        <section className="pbs-home__section">
          <div className="pbs-section-head">
            <span className="pbs-section-head__title">Recent</span>
          </div>
          <Card>
            <EmptyState
              icon={<LayoutDashboard size={26} />}
              title="No projects yet"
              description="Pick a template above or import a dataset to generate your first dashboard in seconds."
            />
          </Card>
        </section>
      </div>
    </div>
  )
}
