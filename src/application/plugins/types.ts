/**
 * APPLICATION — Plugin SDK types
 * Extension points a plugin can contribute to, and the sandboxed host API a
 * plugin receives on activation. Built-in features register through the same
 * surface third parties would use.
 */
import type { SemanticModel } from '@/domain/model'
import type { Report } from '@/domain/report'
import type { DatasetData } from '@/application/import/types'
import type { AnalystProvider } from '@/application/insights/analyst-provider'

export interface ExportInput {
  model: SemanticModel
  report: Report
  datasets: DatasetData[]
  name: string
}

export interface ExporterContribution {
  id: string
  name: string
  description: string
  icon: string
  run(input: ExportInput): { filename: string; blob: Blob }
}

export type Severity = 'info' | 'warning' | 'error'
export interface ValidationIssue {
  ruleId: string
  severity: Severity
  message: string
  target?: string
}
export interface ValidationRule {
  id: string
  name: string
  run(model: SemanticModel): ValidationIssue[]
}

export interface ThemeContribution {
  id: string
  name: string
  colors: string[]
}

export interface VisualContribution {
  kind: string
  name: string
  icon: string
}

export interface ImporterContribution {
  id: string
  name: string
  extensions: string[]
}

export interface CommandContribution {
  id: string
  title: string
  run(): void
}

/** The sandboxed API handed to a plugin's activate(). */
export interface PluginHost {
  registerExporter(e: ExporterContribution): void
  registerValidationRule(r: ValidationRule): void
  registerTheme(t: ThemeContribution): void
  registerVisual(v: VisualContribution): void
  registerImporter(i: ImporterContribution): void
  registerCommand(c: CommandContribution): void
  registerAIProvider(p: AnalystProvider): void
  /** Read-only access to the current model. */
  getModel(): SemanticModel
}

export interface Plugin {
  id: string
  name: string
  version: string
  description: string
  author: string
  activate(host: PluginHost): void
}
