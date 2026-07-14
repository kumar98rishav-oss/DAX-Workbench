/**
 * APPLICATION — Plugin registry
 * Collects contributions across extension points and activates plugins against
 * a host bound to a live model getter.
 */
import type { SemanticModel } from '@/domain/model'
import type { AnalystProvider } from '@/application/insights/analyst-provider'
import type {
  CommandContribution,
  ExporterContribution,
  ImporterContribution,
  Plugin,
  PluginHost,
  ThemeContribution,
  ValidationIssue,
  ValidationRule,
  VisualContribution,
} from './types'

export class PluginRegistry {
  readonly plugins: Plugin[] = []
  readonly exporters: ExporterContribution[] = []
  readonly rules: ValidationRule[] = []
  readonly themes: ThemeContribution[] = []
  readonly visuals: VisualContribution[] = []
  readonly importers: ImporterContribution[] = []
  readonly commands: CommandContribution[] = []
  readonly aiProviders: AnalystProvider[] = []

  /** Contributions grouped by contributing plugin id (for the manager UI). */
  readonly byPlugin = new Map<string, string[]>()

  constructor(private getModel: () => SemanticModel) {}

  private hostFor(pluginId: string): PluginHost {
    const note = (what: string) => {
      const list = this.byPlugin.get(pluginId) ?? []
      list.push(what)
      this.byPlugin.set(pluginId, list)
    }
    return {
      registerExporter: (e) => { this.exporters.push(e); note(`exporter: ${e.name}`) },
      registerValidationRule: (r) => { this.rules.push(r); note(`rule: ${r.name}`) },
      registerTheme: (t) => { this.themes.push(t); note(`theme: ${t.name}`) },
      registerVisual: (v) => { this.visuals.push(v); note(`visual: ${v.name}`) },
      registerImporter: (i) => { this.importers.push(i); note(`importer: ${i.name}`) },
      registerCommand: (c) => { this.commands.push(c); note(`command: ${c.title}`) },
      registerAIProvider: (p) => { this.aiProviders.push(p); note(`AI provider: ${p.name}`) },
      getModel: () => this.getModel(),
    }
  }

  use(plugin: Plugin): void {
    if (this.plugins.some((p) => p.id === plugin.id)) return
    this.plugins.push(plugin)
    plugin.activate(this.hostFor(plugin.id))
  }

  runValidations(model: SemanticModel): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    for (const rule of this.rules) {
      try {
        issues.push(...rule.run(model))
      } catch {
        /* a faulty rule shouldn't break validation */
      }
    }
    return issues
  }
}
