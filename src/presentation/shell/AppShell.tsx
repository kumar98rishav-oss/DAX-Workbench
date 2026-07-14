import { useApp } from '@/app/store'
import { TopBar } from './TopBar'
import { LeftSidebar } from './LeftSidebar'
import { RightPanel } from './RightPanel'
import { BottomPanel } from './BottomPanel'
import { CanvasStage } from './CanvasStage'
import { DataView } from '@/presentation/data/DataView'
import { ModelView } from '@/presentation/model/ModelView'
import { DaxView } from '@/presentation/dax/DaxView'
import './shell.css'

export function AppShell() {
  const mode = useApp((s) => s.mode)

  return (
    <div className="pbs-shell">
      <TopBar />
      <div className="pbs-shell__body">
        <LeftSidebar />
        <div className="pbs-shell__center">
          {mode === 'design' && <CanvasStage />}
          {mode === 'data' && <DataView />}
          {mode === 'model' && <ModelView />}
          {mode === 'dax' && <DaxView />}
          <BottomPanel />
        </div>
        <RightPanel />
      </div>
    </div>
  )
}
