import { useApp } from '@/app/store'

export function RightPanel() {
  const collapsed = !useApp((s) => s.panels.right)

  return (
    <aside className="pbs-side pbs-side--right" data-collapsed={collapsed}>
      <div className="pbs-side__header">
        <span className="pbs-side__title">Properties</span>
      </div>
      <div className="pbs-side__body pbs-scroll" />
    </aside>
  )
}
