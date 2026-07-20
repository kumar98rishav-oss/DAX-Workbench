/**
 * APPLICATION — Built-in plugins
 * Studio's own features, registered through the public Plugin SDK — proving
 * the extension points are load-bearing, not decorative.
 */
import { LocalAnalystProvider } from '@/application/insights/analyst-provider'
import {
  toTMDL,
  toMarkdown,
  toThemeJSON,
  toProjectJSON,
  toTabularEditorScript,
  toInteractiveHTML,
  buildPBIP,
} from '@/application/export/exporters'
import { createZip } from '@/infrastructure/export/zip'
import { modelHasDate } from '@/application/dax/factory'
import type { SemanticModel } from '@/domain/model'
import type { Plugin, ValidationIssue } from './types'

const textBlob = (content: string, mime: string) => new Blob([content], { type: `${mime};charset=utf-8` })

export const coreExportersPlugin: Plugin = {
  id: 'core.exporters',
  name: 'Open-format Exporters',
  version: '1.0.0',
  author: 'DAX Workbench',
  description: 'Export the model and report to TMDL, PBIP, HTML, Markdown, theme, script, and JSON.',
  activate(host) {
    host.registerExporter({
      id: 'tmdl', name: 'TMDL', icon: 'FileCode2',
      description: 'Tabular Model Definition Language.',
      run: ({ model, name }) => ({ filename: `${name}.tmdl`, blob: textBlob(toTMDL(model), 'text/plain') }),
    })
    host.registerExporter({
      id: 'pbip', name: 'PBIP Project (.zip)', icon: 'FolderArchive',
      description: 'Power BI Project folder bundled as a zip.',
      run: ({ model, report, name }) => ({ filename: `${name}.pbip.zip`, blob: createZip(buildPBIP(model, report, name)) }),
    })
    host.registerExporter({
      id: 'html', name: 'Interactive HTML', icon: 'Globe',
      description: 'Self-contained dashboard page with data inlined.',
      run: ({ model, report, datasets, name }) => ({ filename: `${name}.html`, blob: textBlob(toInteractiveHTML(model, report, datasets), 'text/html') }),
    })
    host.registerExporter({
      id: 'markdown', name: 'Markdown docs', icon: 'FileText',
      description: 'Model documentation.',
      run: ({ model, report, name }) => ({ filename: `${name}.md`, blob: textBlob(toMarkdown(model, report), 'text/markdown') }),
    })
    host.registerExporter({
      id: 'tabular', name: 'Tabular Editor script', icon: 'Terminal',
      description: 'C# script that recreates every measure.',
      run: ({ model, name }) => ({ filename: `${name}-measures.csx`, blob: textBlob(toTabularEditorScript(model), 'text/plain') }),
    })
    host.registerExporter({
      id: 'theme', name: 'Theme JSON', icon: 'Palette',
      description: 'A Power BI theme matching the Workbench.',
      run: () => ({ filename: 'studio-theme.json', blob: textBlob(toThemeJSON(), 'application/json') }),
    })
    host.registerExporter({
      id: 'json', name: 'Project JSON', icon: 'Braces',
      description: 'Portable model + report JSON.',
      run: ({ model, report, name }) => ({ filename: `${name}.json`, blob: textBlob(toProjectJSON(model, report), 'application/json') }),
    })
  },
}

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
  coreExportersPlugin,
  coreVisualsPlugin,
  coreValidationPlugin,
  coreAnalystPlugin,
  coreThemePlugin,
]
