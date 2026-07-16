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
import type { Plugin, ValidationIssue } from './types'

const textBlob = (content: string, mime: string) => new Blob([content], { type: `${mime};charset=utf-8` })

export const coreExportersPlugin: Plugin = {
  id: 'core.exporters',
  name: 'Open-format Exporters',
  version: '1.0.0',
  author: 'BI Design Studio',
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
      description: 'A Power BI theme matching Studio.',
      run: () => ({ filename: 'studio-theme.json', blob: textBlob(toThemeJSON(), 'application/json') }),
    })
    host.registerExporter({
      id: 'json', name: 'Project JSON', icon: 'Braces',
      description: 'Portable model + report JSON.',
      run: ({ model, report, name }) => ({ filename: `${name}.json`, blob: textBlob(toProjectJSON(model, report), 'application/json') }),
    })
  },
}

export const coreValidationPlugin: Plugin = {
  id: 'core.validation',
  name: 'Model Validator',
  version: '1.0.0',
  author: 'BI Design Studio',
  description: 'Best-practice checks: keys, nulls, formats, orphan tables, date table.',
  activate(host) {
    host.registerValidationRule({
      id: 'missing-key',
      name: 'Table without a key',
      run: (model) =>
        model.tables
          .filter((t) => t.role !== 'unknown' && !t.columns.some((c) => c.role === 'key'))
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
    host.registerValidationRule({
      id: 'measure-format',
      name: 'Measure without format string',
      run: (model) =>
        model.tables.flatMap((t) =>
          t.measures
            .filter((m) => !m.formatString)
            .map((m): ValidationIssue => ({ ruleId: 'measure-format', severity: 'info', message: `Measure “${m.name}” has no format string.`, target: m.name })),
        ),
    })
    host.registerValidationRule({
      id: 'orphan-table',
      name: 'Unrelated table',
      run: (model) => {
        const related = new Set(model.relationships.flatMap((r) => [r.fromTable, r.toTable]))
        return model.tables
          .filter((t) => model.tables.length > 1 && !related.has(t.id))
          .map((t): ValidationIssue => ({ ruleId: 'orphan-table', severity: 'info', message: `“${t.name}” is not related to any other table.`, target: t.name }))
      },
    })
    host.registerValidationRule({
      id: 'no-date-table',
      name: 'No date table',
      run: (model) =>
        model.tables.length > 0 && !model.tables.some((t) => t.role === 'date')
          ? [{ ruleId: 'no-date-table', severity: 'info', message: 'No date table detected — time-intelligence measures need one.' }]
          : [],
    })
  },
}

export const coreThemePlugin: Plugin = {
  id: 'core.theme',
  name: 'Studio Theme',
  version: '1.0.0',
  author: 'BI Design Studio',
  description: 'The default monochrome + blue accent theme.',
  activate(host) {
    host.registerTheme({
      id: 'studio',
      name: 'Studio Default',
      colors: ['#3b6ef6', '#17a673', '#d98a15', '#8b5cf6', '#e5484d', '#0ea5e9', '#ec4899', '#64748b'],
    })
  },
}

export const coreAnalystPlugin: Plugin = {
  id: 'core.analyst',
  name: 'Local Analyst',
  version: '1.0.0',
  author: 'BI Design Studio',
  description: 'The offline heuristic business analyst (LLM providers can replace it).',
  activate(host) {
    host.registerAIProvider(new LocalAnalystProvider())
  },
}

export const coreVisualsPlugin: Plugin = {
  id: 'core.visuals',
  name: 'Core Visuals',
  version: '1.0.0',
  author: 'BI Design Studio',
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
