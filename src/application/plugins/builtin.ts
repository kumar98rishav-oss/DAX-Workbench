/**
 * APPLICATION — Built-in plugins
 * Studio's own features, registered through the public Plugin SDK — proving
 * the extension points are load-bearing, not decorative.
 */
import { LocalAnalystProvider } from '@/application/insights/analyst-provider'
import { modelHasDate } from '@/application/dax/factory'
import type { SemanticModel } from '@/domain/model'
import type { Plugin, ValidationIssue } from './types'

/** Tables that exist to hold measures or drive a what-if/field parameter. They
 * have no data of their own and are disconnected on purpose, so structural rules
 * about keys and relationships say nothing useful about them. */
const isHelperTable = (t: SemanticModel['tables'][number]): boolean =>
  t.columns.length === 0 || // a measure-holder table
  t.columns.length === 1 || // single-column what-if / field parameter
  /^_|param|topn|metricsel|slicer|selection/i.test(t.name)

export const coreValidationPlugin: Plugin = {
  id: 'core.validation',
  name: 'Model Validator',
  version: '2.0.0',
  author: 'DAX Workbench',
  // Structure only. Measure quality (formats, DAX shape, folders) belongs to the
  // Model Doctor — two features answering the same question is how they end up
  // contradicting each other.
  description: 'Structural checks: keys, blank columns, orphan tables, date table.',
  activate(host) {
    host.registerValidationRule({
      id: 'missing-key',
      name: 'Table without a key',
      // A many-to-many bridge is keyed by the combination of its columns, not by
      // one of them — "no primary key" is the design, not a defect.
      run: (model) =>
        model.tables
          .filter((t) => t.role !== 'unknown' && !isHelperTable(t) && !/bridge|junction|xref|linktable/i.test(t.name))
          .filter((t) => !t.columns.some((c) => c.role === 'key'))
          .map((t): ValidationIssue => ({ ruleId: 'missing-key', severity: 'warning', message: `“${t.name}” has no primary key column.`, target: t.name })),
    })
    host.registerValidationRule({
      id: 'high-null',
      name: 'High-null column',
      run: (model) => {
        const out: ValidationIssue[] = []
        for (const t of model.tables) {
          const rows = t.rowCount ?? 0
          if (rows === 0) continue
          for (const c of t.columns) {
            if ((c.nullCount ?? 0) / rows > 0.4)
              out.push({ ruleId: 'high-null', severity: 'warning', message: `“${t.name}[${c.name}]” is over 40% blank.`, target: `${t.name}[${c.name}]` })
          }
        }
        return out
      },
    })
    // NOTE: there is deliberately no measure-format rule here. The Model Doctor
    // owns measure quality and knows that a measure returning "Green"/"Amber"/"Red"
    // has no business carrying a numeric format. This rule used to flag exactly
    // those, directly contradicting the Doctor on the same model.
    host.registerValidationRule({
      id: 'orphan-table',
      name: 'Unrelated table',
      run: (model) => {
        const related = new Set(model.relationships.flatMap((r) => [r.fromTable, r.toTable]))
        return model.tables
          .filter((t) => model.tables.length > 1 && !isHelperTable(t) && !related.has(t.id))
          .map((t): ValidationIssue => ({ ruleId: 'orphan-table', severity: 'info', message: `“${t.name}” is not related to any other table.`, target: t.name }))
      },
    })
    host.registerValidationRule({
      id: 'no-date-table',
      name: 'No date table',
      // Same predicate the DAX engine gates time-intelligence on. Checking only
      // role === 'date' claimed there was no date table while the Factory was
      // busy generating YTD off 'Dim_Date'[Date].
      run: (model) =>
        model.tables.length > 0 && !modelHasDate(model)
          ? [{ ruleId: 'no-date-table', severity: 'info', message: 'No date table detected — time-intelligence measures need one.' }]
          : [],
    })
  },
}

export const coreThemePlugin: Plugin = {
  id: 'core.theme',
  name: 'Workbench Theme',
  version: '1.0.0',
  author: 'DAX Workbench',
  description: 'The default monochrome + blue accent theme.',
  activate(host) {
    host.registerTheme({
      id: 'studio',
      name: 'Workbench Default',
      colors: ['#3b6ef6', '#17a673', '#d98a15', '#8b5cf6', '#e5484d', '#0ea5e9', '#ec4899', '#64748b'],
    })
  },
}

export const coreAnalystPlugin: Plugin = {
  id: 'core.analyst',
  name: 'Local Analyst',
  version: '1.0.0',
  author: 'DAX Workbench',
  description: 'The offline heuristic business analyst (LLM providers can replace it).',
  activate(host) {
    host.registerAIProvider(new LocalAnalystProvider())
  },
}

export const coreVisualsPlugin: Plugin = {
  id: 'core.visuals',
  name: 'Core Visuals',
  version: '1.0.0',
  author: 'DAX Workbench',
  description: 'The built-in visual renderers.',
  activate(host) {
    const visuals = [
      ['card', 'KPI Card', 'Hash'],
      ['line', 'Line chart', 'LineChart'],
      ['bar', 'Bar chart', 'BarChart3'],
      ['donut', 'Donut', 'PieChart'],
      ['table', 'Table', 'Table'],
      ['slicer', 'Slicer', 'SlidersHorizontal'],
    ] as const
    for (const [kind, name, icon] of visuals) host.registerVisual({ kind, name, icon })
  },
}

export const BUILTIN_PLUGINS: Plugin[] = [
  coreVisualsPlugin,
  coreValidationPlugin,
  coreAnalystPlugin,
  coreThemePlugin,
]
