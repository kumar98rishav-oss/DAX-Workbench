/**
 * UI client for the Pipeline Host — the standalone local service
 * (tools/pipeline-host/server.mjs) that holds the shared pipeline state.
 */
const HOST = 'http://127.0.0.1:5178'

export interface PipelineSkill { ref: string; order: number; enabled: boolean }
export interface PipelineStage {
  id: number
  name: string
  state: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'paused'
  requiresSignoff: boolean
  approved?: boolean
  breakpoint?: boolean
  branch?: { onFail: number | null }
  description?: string
  skills: PipelineSkill[]
  gate: { type: string; result: 'green' | 'red' | 'hold' | 'pending'; checks?: { name: string; expected: number | null; actual: number | null; ok: boolean }[] }
  logs: string[]
  artifacts: string[]
}
export interface PipelineTemplate { name: string; stages: PipelineStage[] }
export interface PipelineRun { id: string; at: string; status: string; stages: PipelineStage[] }
export interface PipelineState {
  pipelineId: string
  project: string
  status: 'idle' | 'running' | 'paused' | 'held' | 'done' | 'failed'
  mode: 'default' | 'custom'
  currentStage: number
  runToStage: number | null
  bpReleased?: number[]
  reconciliation: { rows: Record<string, number>; sums: Record<string, number>; baselines?: { measure: string; expected: number; tol?: number }[] }
  assumptions: string[]
  templates: PipelineTemplate[]
  history: PipelineRun[]
  customSkills: { ref: string; group: string }[]
  statePath?: string
  source?: { kind: 'data' | 'pbip'; path: string }
  stages: PipelineStage[]
}
export interface SkillGroup { group: string; skills: string[] }
export interface SkillMeta { kind: string; path: string; about: string }

export const getPipeline = (): Promise<PipelineState> => fetch(`${HOST}/pipeline`).then((r) => r.json())
export const getSkills = (): Promise<SkillGroup[]> => fetch(`${HOST}/skills`).then((r) => r.json())
export const getSkillMeta = (): Promise<Record<string, SkillMeta>> => fetch(`${HOST}/skill-meta`).then((r) => r.json())
export const verifyGate = (stageId: number): Promise<{ ok: boolean; checks: { name: string; expected: number | null; actual: number | null; ok: boolean }[]; error: string | null }> =>
  fetch(`${HOST}/pipeline/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stageId }) }).then((r) => r.json())

export const controlPipeline = (body: Record<string, unknown>): Promise<PipelineState> =>
  fetch(`${HOST}/pipeline/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())

/** Subscribe to live state pushes (SSE). Returns an unsubscribe function. */
export const streamPipeline = (onState: (s: PipelineState) => void): (() => void) => {
  const es = new EventSource(`${HOST}/pipeline/stream`)
  es.onmessage = (e) => {
    try { onState(JSON.parse(e.data) as PipelineState) } catch { /* ignore malformed frame */ }
  }
  return () => es.close()
}
