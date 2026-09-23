import { create } from 'zustand'
import {
  getPipeline,
  controlPipeline,
  streamPipeline,
  getSkills,
  getSkillMeta,
  verifyGate,
  type PipelineState,
  type SkillGroup,
  type SkillMeta,
} from '@/infrastructure/desktop/pipeline-client'

interface PipelineStore {
  state: PipelineState | null
  catalog: SkillGroup[]
  skillMeta: Record<string, SkillMeta>
  connected: boolean
  error: string | null
  connect(): void
  run(): void
  pause(): void
  resume(): void
  runTo(stageId: number): void
  runStage(stageId: number): void
  reset(): void
  setMode(mode: 'default' | 'custom'): void
  reorderStages(order: number[]): void
  toggleSkill(stageId: number, ref: string): void
  addSkill(stageId: number, ref: string): void
  removeSkill(stageId: number, ref: string): void
  moveSkill(fromStageId: number, toStageId: number, ref: string): void
  renameStage(stageId: number, name: string): void
  setDescription(stageId: number, text: string): void
  setSource(kind: 'data' | 'pbip', path: string): void
  newProject(path: string): void
  verify(stageId: number): void
  setSignoff(stageId: number, value: boolean): void
  approve(stageId: number): void
  approveAndContinue(stageId: number): void
  toggleBreakpoint(stageId: number): void
  setBranch(stageId: number, onFail: number | null): void
  addStage(name: string): void
  removeStage(stageId: number): void
  saveTemplate(name: string): void
  loadTemplate(name: string): void
  deleteTemplate(name: string): void
  saveRun(): void
  loadHistory(id: string): void
  addCustomSkill(ref: string, group: string): void
  removeCustomSkill(ref: string): void
}

let unsub: (() => void) | null = null

export const usePipeline = create<PipelineStore>((set) => ({
  state: null,
  catalog: [],
  skillMeta: {},
  connected: false,
  error: null,
  connect() {
    getPipeline()
      .then((s) => set({ state: s, connected: true, error: null }))
      .catch(() => set({ connected: false, error: 'Pipeline Host not running — start it with:  node tools/pipeline-host/server.mjs' }))
    getSkills().then((c) => set({ catalog: c })).catch(() => { /* tray optional */ })
    getSkillMeta().then((m) => set({ skillMeta: m })).catch(() => { /* meta optional */ })
    if (unsub) unsub()
    try {
      unsub = streamPipeline((s) => set({ state: s, connected: true, error: null }))
    } catch {
      /* SSE unsupported — polling GET still works */
    }
  },
  run() { void controlPipeline({ action: 'run' }) },
  pause() { void controlPipeline({ action: 'pause' }) },
  resume() { void controlPipeline({ action: 'continue' }) },
  runTo(stageId) { void controlPipeline({ action: 'runTo', stageId }) },
  runStage(stageId) { void controlPipeline({ action: 'runStage', stageId }) },
  reset() { void controlPipeline({ action: 'reset' }) },
  setMode(mode) { void controlPipeline({ action: 'setMode', mode }) },
  reorderStages(order) { void controlPipeline({ action: 'reorder', order }) },
  toggleSkill(stageId, ref) { void controlPipeline({ action: 'toggleSkill', stageId, ref }) },
  addSkill(stageId, ref) { void controlPipeline({ action: 'addSkill', stageId, ref }) },
  removeSkill(stageId, ref) { void controlPipeline({ action: 'removeSkill', stageId, ref }) },
  moveSkill(fromStageId, toStageId, ref) { void controlPipeline({ action: 'moveSkill', fromStageId, toStageId, ref }) },
  renameStage(stageId, name) { void controlPipeline({ action: 'renameStage', stageId, name }) },
  setDescription(stageId, text) { void controlPipeline({ action: 'setDescription', stageId, text }) },
  setSource(kind, path) { void controlPipeline({ action: 'setSource', kind, path }) },
  newProject(path) { void controlPipeline({ action: 'newProject', path }) },
  verify(stageId) { void verifyGate(stageId) },
  setSignoff(stageId, value) { void controlPipeline({ action: 'setSignoff', stageId, value }) },
  approve(stageId) { void controlPipeline({ action: 'approve', stageId }) },
  approveAndContinue(stageId) { void controlPipeline({ action: 'approveAndContinue', stageId }) },
  toggleBreakpoint(stageId) { void controlPipeline({ action: 'toggleBreakpoint', stageId }) },
  setBranch(stageId, onFail) { void controlPipeline({ action: 'setBranch', stageId, onFail }) },
  addStage(name) { void controlPipeline({ action: 'addStage', name }) },
  removeStage(stageId) { void controlPipeline({ action: 'removeStage', stageId }) },
  saveTemplate(name) { void controlPipeline({ action: 'saveTemplate', name }) },
  loadTemplate(name) { void controlPipeline({ action: 'loadTemplate', name }) },
  deleteTemplate(name) { void controlPipeline({ action: 'deleteTemplate', name }) },
  saveRun() { void controlPipeline({ action: 'saveRun' }) },
  loadHistory(id) { void controlPipeline({ action: 'loadHistory', id }) },
  addCustomSkill(ref, group) { void controlPipeline({ action: 'addCustomSkill', ref, group }) },
  removeCustomSkill(ref) { void controlPipeline({ action: 'removeCustomSkill', ref }) },
}))
