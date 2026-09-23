/**
 * Pipeline Host client + next-action logic for the MCP tools.
 * Talks to the standalone Pipeline Host (tools/pipeline-host/server.mjs) over HTTP,
 * so Claude and the DAX Workbench UI share one live pipeline state.
 */
const HOST = process.env.DAXWB_PIPELINE_URL ?? 'http://127.0.0.1:5178'

export interface PipelineSkill { ref: string; order: number; enabled: boolean }
export interface PipelineStage {
  id: number
  name: string
  state: string
  requiresSignoff: boolean
  approved?: boolean
  breakpoint?: boolean
  branch?: { onFail: number | null }
  skills: PipelineSkill[]
  gate: { type: string; result: string }
  logs: string[]
  artifacts: string[]
}
export interface PipelineState {
  status: string
  currentStage: number
  runToStage: number | null
  bpReleased?: number[]
  stages: PipelineStage[]
}

export const pipeline = {
  async getPlan(): Promise<PipelineState> {
    const r = await fetch(`${HOST}/pipeline`)
    if (!r.ok) throw new Error(`Pipeline Host returned ${r.status}. Is it running? (node tools/pipeline-host/server.mjs)`)
    return (await r.json()) as PipelineState
  },
  async report(body: unknown): Promise<unknown> {
    const r = await fetch(`${HOST}/pipeline/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`Pipeline Host returned ${r.status}`)
    return r.json()
  },
  /** Limited control: run/pause only. Breakpoints and sign-offs stay human (cockpit-only). */
  async control(body: { action: 'run' | 'pause' }): Promise<unknown> {
    const r = await fetch(`${HOST}/pipeline/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`Pipeline Host returned ${r.status}`)
    return r.json()
  },
  /** Ask the HOST to verify a stage's gate on the live engine (EVALUATE baselines via the bridge). */
  async verify(stageId: number): Promise<{ ok: boolean; checks: { name: string; expected: number | null; actual: number | null; ok: boolean }[]; error: string | null }> {
    const r = await fetch(`${HOST}/pipeline/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId }),
    })
    if (!r.ok) throw new Error(`Pipeline Host returned ${r.status}`)
    return r.json() as Promise<{ ok: boolean; checks: { name: string; expected: number | null; actual: number | null; ok: boolean }[]; error: string | null }>
  },
}

/**
 * The plan trimmed for the agent: drop cockpit-only baggage (templates, history,
 * custom-skill registry, paths) and cap logs — pipeline_get_plan was shipping
 * ~1,800 lines per call, most of it irrelevant to "what do I do next".
 */
export function slimPlan(s: PipelineState): unknown {
  const full = s as PipelineState & Record<string, unknown>
  return {
    status: full.status,
    mode: full['mode'],
    currentStage: full.currentStage,
    runToStage: full.runToStage,
    source: full['source'],
    reconciliation: full['reconciliation'],
    assumptions: full['assumptions'],
    stages: s.stages.map((st) => ({
      id: st.id,
      name: st.name,
      state: st.state,
      requiresSignoff: st.requiresSignoff,
      approved: st.approved,
      breakpoint: st.breakpoint,
      branch: st.branch,
      skills: st.skills.filter((k) => k.enabled).map((k) => k.ref),
      gate: st.gate,
      logs: st.logs.slice(-3),
      artifacts: st.artifacts,
    })),
  }
}

type NextAction =
  | { action: 'run'; stage: { id: number; name: string; skills: string[]; gate: string } }
  | { action: 'hold'; reason: string; stageId?: number }
  | { action: 'done' }

/**
 * The next thing Claude should do, honoring pause / run-to / breakpoints /
 * sign-off / disabled skills, and routing to a stage's on-fail branch when set.
 */
export function computeNext(s: PipelineState): NextAction {
  const run = (st: PipelineStage): NextAction => ({
    action: 'run',
    stage: { id: st.id, name: st.name, skills: st.skills.filter((k) => k.enabled).map((k) => k.ref), gate: st.gate.type },
  })

  if (s.status === 'paused') return { action: 'hold', reason: 'Pipeline is paused' }

  // on-fail branch: a failed stage with a branch target routes to remediation first
  const failed = s.stages.find((st) => st.state === 'failed')
  if (failed && failed.branch && failed.branch.onFail != null) {
    const target = s.stages.find((st) => st.id === failed.branch!.onFail)
    if (target && target.state !== 'passed') return run(target)
  }

  const limit = s.runToStage ?? Number.POSITIVE_INFINITY
  const next = s.stages.find((st) => st.state !== 'passed' && st.state !== 'skipped')
  if (!next) return { action: 'done' }
  if (next.id > limit) return { action: 'hold', reason: `Reached run-to-stage ${limit}` }
  if (next.breakpoint && !(s.bpReleased ?? []).includes(next.id)) return { action: 'hold', reason: 'Breakpoint', stageId: next.id }
  if (next.requiresSignoff && !next.approved) return { action: 'hold', reason: 'Awaiting sign-off', stageId: next.id }
  return run(next)
}
