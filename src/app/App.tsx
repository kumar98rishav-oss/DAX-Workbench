import { useEffect, useMemo } from 'react'
import { useApp } from './store'
import { buildCommands } from './commands'
import { HomeScreen } from '@/presentation/home/HomeScreen'
import { AppShell } from '@/presentation/shell/AppShell'
import { ImportHost } from '@/presentation/data/ImportHost'
import { ImportPreviewDialog } from '@/presentation/data/ImportPreviewDialog'
import { PbixFallbackDialog } from '@/presentation/data/PbixFallbackDialog'
import { PbipSourceDialog } from '@/presentation/data/PbipSourceDialog'
import { RemoteBridgeDialog } from '@/presentation/data/RemoteBridgeDialog'
import { MeasureFactoryDialog } from '@/presentation/dax/MeasureFactoryDialog'
import { ModelDoctorDialog } from '@/presentation/dax/ModelDoctorDialog'
import { DateTableDialog } from '@/presentation/dax/DateTableDialog'
import { AnalystPanel } from '@/presentation/analyst/AnalystPanel'
import { PluginsDialog } from '@/presentation/plugins/PluginsDialog'
import { CommandPalette } from '@/design-system/components'

export function App() {
  const view = useApp((s) => s.view)
  const paletteOpen = useApp((s) => s.commandPaletteOpen)
  const setCommandPalette = useApp((s) => s.setCommandPalette)

  // Rebuild commands when the palette opens so hints reflect current state.
  const commands = useMemo(() => buildCommands(), [paletteOpen])

  // Global keyboard shortcuts: ⌘K palette, ⌘Z / ⌘⇧Z undo-redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommandPalette(!useApp.getState().commandPaletteOpen)
      } else if (mod && e.key.toLowerCase() === 'z') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        if (e.shiftKey) useApp.getState().redo()
        else useApp.getState().undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        useApp.getState().redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCommandPalette])

  return (
    <>
      {view === 'home' ? <HomeScreen /> : <AppShell />}
      <ImportHost />
      <ImportPreviewDialog />
      <PbixFallbackDialog />
      <PbipSourceDialog />
      <RemoteBridgeDialog />
      <MeasureFactoryDialog />
      <ModelDoctorDialog />
      <DateTableDialog />
      <AnalystPanel />
      <PluginsDialog />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setCommandPalette(false)}
      />
    </>
  )
}
