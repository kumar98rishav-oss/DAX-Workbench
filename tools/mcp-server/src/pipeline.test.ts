/**
 * The pipeline's correctness core. computeNext decides what Claude does next,
 * and every hold reason here is a promise the cockpit makes to the user
 * (pause, run-to, breakpoint, sign-off). If this drifts, the pipeline runs a
 * stage it shouldn't — the one thing a gated pipeline must never do.
 */
import { describe, it, expect } from 'vitest'
import { computeNext, slimPlan, type PipelineState, type PipelineStage } from './pipeline'

function stage(id: number, over: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id,
    name: `S${id}`,
    state: 'pending',
    requiresSignoff: false,
    skills: [],
    gate: { type: `gate${id}`, result: 'pending' },
    logs: [],
    artifacts: [],
    ...over,
  }
}
function state(stages: PipelineStage[], over: Partial<PipelineState> = {}): PipelineState {
  return { status: 'idle', currentStage: 0, runToStage: null, stages, ...over }
}

describe('computeNext — the next action', () => {
  it('runs the first pending stage, passing its enabled skills and gate type', () => {
    const s = state([
      stage(0, { skills: [{ ref: 'a', order: 0, enabled: true }, { ref: 'b', order: 1, enabled: false }] }),
      stage(1),
    ])
    expect(computeNext(s)).toEqual({ action: 'run', stage: { id: 0, name: 'S0', skills: ['a'], gate: 'gate0' } })
  })

  it('skips passed stages and runs the next one', () => {
    const s = state([stage(0, { state: 'passed' }), stage(1)])
    expect(computeNext(s)).toMatchObject({ action: 'run', stage: { id: 1 } })
  })

  it('treats skipped stages as done-with', () => {
    const s = state([stage(0, { state: 'skipped' }), stage(1)])
    expect(computeNext(s)).toMatchObject({ action: 'run', stage: { id: 1 } })
  })

  it('returns done when every stage is passed or skipped', () => {
    const s = state([stage(0, { state: 'passed' }), stage(1, { state: 'skipped' })])
    expect(computeNext(s)).toEqual({ action: 'done' })
  })

  it('holds when the pipeline is paused — before anything else', () => {
    const s = state([stage(0)], { status: 'paused' })
    expect(computeNext(s)).toEqual({ action: 'hold', reason: 'Pipeline is paused' })
  })

  it('holds at the run-to limit (does not run past it)', () => {
    const s = state([stage(0, { state: 'passed' }), stage(1, { state: 'passed' }), stage(2)], { runToStage: 1 })
    expect(computeNext(s)).toEqual({ action: 'hold', reason: 'Reached run-to-stage 1' })
  })

  it('runs a stage that is within the run-to limit', () => {
    const s = state([stage(0), stage(1), stage(2)], { runToStage: 1 })
    expect(computeNext(s)).toMatchObject({ action: 'run', stage: { id: 0 } })
  })

  it('holds at an unreleased breakpoint, naming the stage', () => {
    const s = state([stage(0, { breakpoint: true })])
    expect(computeNext(s)).toEqual({ action: 'hold', reason: 'Breakpoint', stageId: 0 })
  })

  it('runs through a released breakpoint', () => {
    const s = state([stage(0, { breakpoint: true })], { bpReleased: [0] })
    expect(computeNext(s)).toMatchObject({ action: 'run', stage: { id: 0 } })
  })

  it('holds for sign-off when the stage requires it and is not approved', () => {
    const s = state([stage(0, { requiresSignoff: true })])
    expect(computeNext(s)).toEqual({ action: 'hold', reason: 'Awaiting sign-off', stageId: 0 })
  })

  it('runs a sign-off stage once approved', () => {
    const s = state([stage(0, { requiresSignoff: true, approved: true })])
    expect(computeNext(s)).toMatchObject({ action: 'run', stage: { id: 0 } })
  })

  it('routes a failed stage to its on-fail branch for remediation', () => {
    const s = state([
      stage(0, { state: 'passed' }),
      stage(1, { state: 'failed', branch: { onFail: 5 } }),
      stage(2),
      stage(5, { name: 'Remediate' }),
    ])
    expect(computeNext(s)).toMatchObject({ action: 'run', stage: { id: 5, name: 'Remediate' } })
  })

  it('ignores an on-fail branch whose target is already passed', () => {
    const s = state([
      stage(0, { state: 'failed', branch: { onFail: 5 } }),
      stage(1),
      stage(5, { state: 'passed' }),
    ])
    // Branch target passed → fall through to the normal next non-passed stage (0 is failed, not passed).
    expect(computeNext(s)).toMatchObject({ action: 'run', stage: { id: 0 } })
  })

  it('pause beats a pending breakpoint/branch (paused is checked first)', () => {
    const s = state([stage(0, { state: 'failed', branch: { onFail: 5 } }), stage(5)], { status: 'paused' })
    expect(computeNext(s)).toEqual({ action: 'hold', reason: 'Pipeline is paused' })
  })
})

describe('slimPlan — trims the plan for the agent', () => {
  it('drops cockpit baggage, filters disabled skills to refs, caps logs to 3', () => {
    const full = {
      ...state([
        stage(0, {
          skills: [{ ref: 'x', order: 0, enabled: true }, { ref: 'y', order: 1, enabled: false }],
          logs: ['l1', 'l2', 'l3', 'l4'],
        }),
      ]),
      templates: [{ big: 'baggage' }],
      history: [{ lots: 'of it' }],
      customSkills: [{ registry: 'stuff' }],
    } as unknown as PipelineState
    const slim = slimPlan(full) as { templates?: unknown; history?: unknown; stages: { skills: string[]; logs: string[] }[] }
    expect(slim.templates).toBeUndefined()
    expect(slim.history).toBeUndefined()
    expect(slim.stages[0].skills).toEqual(['x']) // enabled only, as refs
    expect(slim.stages[0].logs).toEqual(['l2', 'l3', 'l4']) // last 3
  })
})
