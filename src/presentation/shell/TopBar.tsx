import {
  Sparkles,
  PanelLeft,
  PanelRight,
  PanelBottom,
  Sun,
  Moon,
  Search,
  ChevronRight,
  Wand2,
  Download,
} from 'lucide-react'
import { useApp } from '@/app/store'
import { IconButton, Kbd, Segmented } from '@/design-system/components'
import type { StudioMode } from '@/app/store'

const MODE_OPTIONS: { value: StudioMode; label: string }[] = [
  { value: 'kpi', label: 'KPI' },
  { value: 'data', label: 'Data' },
  { value: 'model', label: 'Model' },
  { value: 'dax', label: 'DAX' },
]

export function TopBar() {
  const projectName = useApp((s) => s.projectName)
  const mode = useApp((s) => s.mode)
  const setMode = useApp((s) => s.setMode)
  const theme = useApp((s) => s.theme)
  const toggleTheme = useApp((s) => s.toggleTheme)
  const panels = useApp((s) => s.panels)
  const togglePanel = useApp((s) => s.togglePanel)
  const setCommandPalette = useApp((s) => s.setCommandPalette)
  const goHome = useApp((s) => s.goHome)
  const toggleAnalyst = useApp((s) => s.toggleAnalyst)
  const analystOpen = useApp((s) => s.analystOpen)
  const toggleExport = useApp((s) => s.toggleExport)

  return (
    <header className="pbs-topbar">
      <button className="pbs-topbar__brand" onClick={goHome} title="Home">
        <span className="pbs-topbar__logo">
          <Sparkles size={15} />
        </span>
        BI Design Studio
      </button>

      <span className="pbs-topbar__divider" />

      <div className="pbs-topbar__project">
        <span className="pbs-topbar__crumb">Projects</span>
        <ChevronRight size={14} className="pbs-topbar__crumb" />
        <span>{projectName ?? 'Untitled'}</span>
      </div>

      <span className="pbs-topbar__spacer" />

      <button
        className="pbs-topbar__cmd"
        onClick={() => setCommandPalette(true)}
        aria-label="Open command palette"
      >
        <Search size={15} />
        <span className="pbs-topbar__cmd-label">Search or run a command</span>
        <Kbd keys={['Ctrl', 'K']} />
      </button>

      <Segmented
        options={MODE_OPTIONS}
        value={mode}
        onChange={setMode}
        ariaLabel="Studio mode"
      />

      <span className="pbs-topbar__divider" />

      <IconButton
        label="Ask the Analyst"
        active={analystOpen}
        onClick={() => toggleAnalyst()}
      >
        <Wand2 size={17} />
      </IconButton>

      <IconButton label="Export" onClick={() => toggleExport(true)}>
        <Download size={17} />
      </IconButton>

      <IconButton
        label="Toggle assets panel"
        active={panels.left}
        onClick={() => togglePanel('left')}
      >
        <PanelLeft size={17} />
      </IconButton>
      <IconButton
        label="Toggle insights panel"
        active={panels.bottom}
        onClick={() => togglePanel('bottom')}
      >
        <PanelBottom size={17} />
      </IconButton>
      <IconButton
        label="Toggle properties panel"
        active={panels.right}
        onClick={() => togglePanel('right')}
      >
        <PanelRight size={17} />
      </IconButton>

      <span className="pbs-topbar__divider" />

      <IconButton
        label={theme === 'light' ? 'Dark theme' : 'Light theme'}
        onClick={toggleTheme}
      >
        {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
      </IconButton>
    </header>
  )
}
