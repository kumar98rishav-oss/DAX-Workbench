import { useApp } from '@/app/store'
import { TopBar } from './TopBar'
import { LeftSidebar } from './LeftSidebar'
import { RightPanel } from './RightPanel'
import { BottomPanel } from './BottomPanel'
import { DataView } from '@/presentation/data/DataView'
import { ReconcileView } from '@/presentation/reconcile/ReconcileView'
import { ModelView } from '@/presentation/model/ModelView'
import { CleanupView } from '@/presentation/cleanup/CleanupView'
import { DaxView } from '@/presentation/dax/DaxView'
import { PipelinePanel } from '@/presentation/pipeline/PipelinePanel'
import './shell.css'

export function AppShell() {
  const mode = useApp((s) => s.mode)

  return (
    <div className="pbs-shell">
      <TopBar />
      <div className="pbs-shell__body">
        <LeftSidebar />
        <div className="pbs-shell__center">
          {mode === 'reconcile' && <ReconcileView />}
          {mode === 'data' && <DataView />}
          {mode === 'model' && <ModelView />}
          {mode === 'cleanup' && <CleanupView />}
          {mode === 'dax' && <DaxView />}
          {mode === 'pipeline' && <PipelinePanel />}
          <BottomPanel />
        </div>
        <RightPanel />
      </div>
    </div>
  )
}
