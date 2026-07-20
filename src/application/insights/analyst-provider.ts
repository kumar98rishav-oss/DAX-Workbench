/**
 * APPLICATION — Analyst provider port
 * Abstracts the analyst so a real LLM can be plugged in later (or shipped as a
 * plugin) without touching the UI. The default is a fully-local heuristic.
 */
import type { SemanticModel } from '@/domain/model'
import type { DatasetData } from '@/application/import/types'
import { askLocalAnalyst } from './analyst'
import type { AnalystTurn } from './analyst'

export interface AnalystContext {
  model: SemanticModel
  datasets: DatasetData[]
}

export interface AnalystProvider {
  id: string
  name: string
  ask(question: string, ctx: AnalystContext): Promise<AnalystTurn>
}

export class LocalAnalystProvider implements AnalystProvider {
  id = 'local'
  name = 'Workbench Analyst (local)'
  async ask(question: string, ctx: AnalystContext): Promise<AnalystTurn> {
    return askLocalAnalyst(question, ctx.model, ctx.datasets)
  }
}
