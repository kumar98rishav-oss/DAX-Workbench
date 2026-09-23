/**
 * PBIP project access — the model and report AS CODE, read straight from disk.
 * This is what lets Claude do repository-wide work (refactor TMDL, trace a
 * measure's report usage) without a live engine. It's file-based, so it never
 * touches the running bridge or the live model.
 *
 * Safety: every path is resolved and confined to the project folder — a table
 * name with a slash or `..` is rejected, so a write can't escape the project.
 */
import { promises as fs } from 'node:fs'
import { join, dirname, basename, resolve, sep } from 'node:path'

export class ProjectError extends Error {}

export interface ProjectPaths {
  root: string
  name: string
  modelDir: string
  reportDir: string
  tablesDir: string
}

/** Accept either the `.pbip` file or the folder that contains it. */
export async function resolveProject(projectPath: string): Promise<ProjectPaths> {
  if (!projectPath || !projectPath.trim()) {
    throw new ProjectError('No project path given. Pass the path to the .pbip file or its folder (or set DAXWB_PROJECT).')
  }
  let root = resolve(projectPath)
  const stat = await fs.stat(root).catch(() => null)
  if (!stat) throw new ProjectError(`Path not found: ${projectPath}`)
  if (stat.isFile()) {
    if (!root.toLowerCase().endsWith('.pbip')) throw new ProjectError(`Not a .pbip file: ${projectPath}`)
    root = dirname(root)
  }
  const entries = await fs.readdir(root, { withFileTypes: true })
  const model = entries.find((e) => e.isDirectory() && e.name.endsWith('.SemanticModel'))
  const report = entries.find((e) => e.isDirectory() && e.name.endsWith('.Report'))
  if (!model) throw new ProjectError(`No *.SemanticModel folder under ${root} — is this a PBIP project?`)
  const modelDir = join(root, model.name)
  return {
    root,
    name: basename(root),
    modelDir,
    reportDir: report ? join(root, report.name) : '',
    tablesDir: join(modelDir, 'definition', 'tables'),
  }
}

export interface TmdlMeasure {
  table: string
  name: string
  displayFolder?: string
}
export interface ProjectSummary {
  name: string
  tables: { name: string; columns: number; measures: number }[]
  measures: TmdlMeasure[]
  relationships: string[]
}

const MEASURE_RE = /^\s*measure\s+(?:'([^']+)'|([A-Za-z_][\w ]*?))\s*=/
const COLUMN_RE = /^\s*column\s+(?:'([^']+)'|[A-Za-z_][\w ]*)/
const TABLE_RE = /^\s*table\s+(?:'([^']+)'|(\S+))/

/** Parse every table's TMDL into a compact summary (names, not full DAX). */
export async function summariseProject(p: ProjectPaths): Promise<ProjectSummary> {
  const files = (await fs.readdir(p.tablesDir).catch(() => [] as string[])).filter((f) => f.endsWith('.tmdl'))
  const tables: ProjectSummary['tables'] = []
  const measures: TmdlMeasure[] = []

  for (const file of files) {
    const text = await fs.readFile(join(p.tablesDir, file), 'utf8')
    const lines = text.split(/\r?\n/)
    let tableName = basename(file, '.tmdl')
    let cols = 0
    let meas = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const tm = TABLE_RE.exec(line)
      if (tm && /^\s*table\s/.test(line)) tableName = (tm[1] ?? tm[2]).trim()
      if (COLUMN_RE.test(line)) cols++
      const mm = MEASURE_RE.exec(line)
      if (mm) {
        meas++
        const name = (mm[1] ?? mm[2]).trim()
        let folder: string | undefined
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const fm = /^\s*displayFolder:\s*(.+)$/.exec(lines[j])
          if (fm) {
            folder = fm[1].trim()
            break
          }
          if (/^\s*measure\s/.test(lines[j]) || /^\s*column\s/.test(lines[j])) break
        }
        measures.push({ table: tableName, name, displayFolder: folder })
      }
    }
    tables.push({ name: tableName, columns: cols, measures: meas })
  }

  const relText = await fs.readFile(join(p.modelDir, 'definition', 'relationships.tmdl'), 'utf8').catch(() => '')
  const relationships: string[] = []
  for (const b of relText.split(/\n\s*relationship\s/).slice(1)) {
    const from = /fromColumn:\s*(.+)/.exec(b)?.[1]?.trim()
    const to = /toColumn:\s*(.+)/.exec(b)?.[1]?.trim()
    if (from && to) relationships.push(`${from} → ${to}`)
  }

  return { name: p.name, tables, measures, relationships }
}

/** Resolve a table's TMDL path, confined to the project's tables folder. */
function safeTablePath(p: ProjectPaths, table: string): string {
  if (/[\\/]|\.\./.test(table)) throw new ProjectError('Invalid table name — no slashes or "..".')
  const file = table.toLowerCase().endsWith('.tmdl') ? table : `${table}.tmdl`
  const base = resolve(p.tablesDir)
  const full = resolve(base, file)
  if (full !== join(base, file) || !full.startsWith(base + sep)) {
    throw new ProjectError('Resolved path escapes the project.')
  }
  return full
}

export async function readTmdl(p: ProjectPaths, table: string): Promise<string> {
  const full = safeTablePath(p, table)
  return fs.readFile(full, 'utf8').catch(() => {
    throw new ProjectError(`No TMDL file for table "${table}". Use pbi_open_project to see the table names.`)
  })
}

export async function writeTmdl(p: ProjectPaths, table: string, content: string): Promise<void> {
  if (!content || !content.trim()) throw new ProjectError('Refusing to write empty TMDL content.')
  const full = safeTablePath(p, table)
  await fs.stat(full).catch(() => {
    throw new ProjectError(`No existing TMDL file for table "${table}" — refusing to create a new one blindly.`)
  })
  await fs.writeFile(full, content, 'utf8')
}

export interface Usage {
  page: string
  visualType?: string
  visualId: string
}

/** Which report visuals reference a measure or column by name (report-impact). */
export async function measureUsage(p: ProjectPaths, name: string): Promise<Usage[]> {
  if (!p.reportDir) return []
  const pagesDir = join(p.reportDir, 'definition', 'pages')
  const pageDirs = (await fs.readdir(pagesDir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory())
  const target = name.toLowerCase()
  const usages: Usage[] = []

  for (const pd of pageDirs) {
    let pageName = pd.name
    const pageJson = await fs.readFile(join(pagesDir, pd.name, 'page.json'), 'utf8').catch(() => '')
    const dn = /"displayName"\s*:\s*"([^"]+)"/.exec(pageJson)?.[1]
    if (dn) pageName = dn

    const visualsDir = join(pagesDir, pd.name, 'visuals')
    const visualDirs = (await fs.readdir(visualsDir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory())
    for (const vd of visualDirs) {
      const vtext = await fs.readFile(join(visualsDir, vd.name, 'visual.json'), 'utf8').catch(() => '')
      if (!vtext) continue
      const props = [...vtext.matchAll(/"Property"\s*:\s*"([^"]+)"/g)].map((m) => m[1].toLowerCase())
      if (props.includes(target)) {
        usages.push({ page: pageName, visualType: /"visualType"\s*:\s*"([^"]+)"/.exec(vtext)?.[1], visualId: vd.name })
      }
    }
  }
  return usages
}
