/**
 * DAX Workbench — MCP server
 *
 * Exposes a LIVE Power BI model to Claude through the DAX Workbench bridge, so
 * an AI assistant can read the model, run DAX, and — the point of the whole
 * thing — VERIFY a measure against the real engine before it's written.
 *
 * The star tool, pbi_validate_measure, runs the exact same reference checker
 * the desktop app uses (validateReferences), then previews the value on the
 * engine. Trust-but-verify, available to Claude as a tool.
 *
 * Writes are deny-by-default: pbi_write_measure / pbi_delete_measure refuse
 * unless DAXWB_MCP_ALLOW_WRITE=1, and a write validates its DAX first.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { validateReferences } from '@/application/dax/validate'
import type { SemanticModel } from '@/domain/model'
import { bridge, resolveTarget, BridgeError, type RawModel } from './bridge.js'
import { resolveProject, summariseProject, readTmdl, writeTmdl, measureUsage, ProjectError } from './project.js'
import { pipeline, computeNext, slimPlan } from './pipeline.js'

const WRITES_ALLOWED = /^(1|true|yes)$/i.test(process.env.DAXWB_MCP_ALLOW_WRITE ?? '')

// --- helpers ---------------------------------------------------------------

type ToolText = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolText => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolText => ({ content: [{ type: 'text', text }], isError: true })

/** Run a tool body, turning any BridgeError (or other throw) into a clean tool error. */
async function guard(fn: () => Promise<ToolText>): Promise<ToolText> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof BridgeError || e instanceof ProjectError) return fail(e.message)
    return fail(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Project path from the argument, falling back to the DAXWB_PROJECT env var. */
const resolveProjectArg = (projectPath?: string) => resolveProject(projectPath ?? process.env.DAXWB_PROJECT ?? '')

/** Adapt the bridge's raw model to the shape validateReferences reads. */
function toSemanticModel(raw: RawModel): SemanticModel {
  return {
    tables: raw.tables.map((t) => ({
      id: t.name,
      name: t.name,
      role: 'unknown',
      columns: t.columns.map((c) => ({ id: c.name, name: c.name, dataType: 'string', role: 'unknown' })),
      measures: t.measures.map((m) => ({ id: m.name, name: m.name, expression: m.expression ?? '' })),
    })),
    relationships: [],
  } as unknown as SemanticModel
}

const fmtValue = (v: unknown): string =>
  typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(v ?? '(blank)')

const fmtBytes = (b: number): string =>
  b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(0)} KB` : `${b} B`
const fmtPct = (p: number): string => `${(p * 100).toFixed(1)}%`

// --- server ----------------------------------------------------------------

const server = new McpServer({ name: 'dax-workbench', version: '1.0.0' })

server.registerTool(
  'pbi_list_open_models',
  {
    title: 'List open Power BI models',
    description:
      'List the Power BI reports currently open on this machine, with the port and database each other tool needs. Call this first.',
    inputSchema: {},
  },
  () =>
    guard(async () => {
      const models = await bridge.discover()
      if (models.length === 0) return ok('No Power BI report is open. Open one in Power BI Desktop.')
      const lines = models.map((m) => {
        const preview = m.tables.slice(0, 6).join(', ') + (m.tables.length > 6 ? `, +${m.tables.length - 6} more` : '')
        return `• Port ${m.port} — ${m.tableCount} tables, ${m.measureCount} measures\n    tables: ${preview}`
      })
      return ok(
        `${models.length} open Power BI model(s).\n\n${lines.join('\n')}\n\n` +
          `Note: Power BI's engine identifies a model by an internal database id and its tables, not the .pbix file name — so there is no "report name" here. Target a model by its port (omit the port if only one is open).`,
      )
    }),
)

server.registerTool(
  'pbi_get_model',
  {
    title: 'Get the semantic model',
    description:
      'Return the model schema — tables, columns (with data types), measures (with their DAX), and relationships. Use this to ground any DAX you write in names that actually exist.',
    inputSchema: { port: z.number().int().optional().describe('Model port from pbi_list_open_models; omit if only one is open.') },
  },
  ({ port }) =>
    guard(async () => {
      const target = await resolveTarget(port)
      const raw = await bridge.model(target.port, target.database)
      const shaped = {
        tables: raw.tables
          .filter((t) => !t.isHidden)
          .map((t) => ({
            table: t.name,
            columns: t.columns.filter((c) => !c.isHidden).map((c) => `${c.name}${c.dataType ? ` (${c.dataType})` : ''}`),
            measures: t.measures.map((m) => ({
              name: m.name,
              dax: (m.expression ?? '').slice(0, 400),
            })),
          })),
        relationships: (raw.relationships ?? []).map(
          (r) => `${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]${r.isActive === false ? ' (inactive)' : ''}`,
        ),
      }
      return ok(JSON.stringify(shaped, null, 2))
    }),
)

server.registerTool(
  'pbi_run_dax',
  {
    title: 'Run a DAX query',
    description:
      'Execute a DAX query (e.g. an EVALUATE statement) against the live model and return the rows. Read-only. Use for exploring data or checking a calculation.',
    inputSchema: {
      dax: z.string().describe('A full DAX query, usually starting with EVALUATE.'),
      port: z.number().int().optional(),
    },
  },
  ({ dax, port }) =>
    guard(async () => {
      const target = await resolveTarget(port)
      const res = await bridge.dax(dax, target.port)
      const rows = res.rows.slice(0, 50)
      const note = res.rowCount > rows.length ? `\n\n(${res.rowCount} rows total; showing first ${rows.length}.)` : ''
      return ok(`Columns: ${res.columns.join(', ')}\n\n${JSON.stringify(rows, null, 2)}${note}`)
    }),
)

// --- pipeline cockpit (shared with the DAX Workbench UI via the Pipeline Host) ---

server.registerTool(
  'pipeline_get_plan',
  {
    title: 'Get the delivery pipeline plan',
    description:
      'Return the pipeline plan — stages with their enabled skills, flags, gate results and live status (trimmed: no templates/history, logs capped). For a quick "where are we / what next" poll, prefer pipeline_status.',
    inputSchema: {},
  },
  () => guard(async () => ok(JSON.stringify(slimPlan(await pipeline.getPlan()), null, 2))),
)

server.registerTool(
  'pipeline_status',
  {
    title: 'Pipeline status (one-liner)',
    description:
      'The cheap poll: current status, the active stage, and the next action (run/hold/done) in a few lines. Use this between steps instead of re-reading the whole plan.',
    inputSchema: {},
  },
  () =>
    guard(async () => {
      const s = await pipeline.getPlan()
      const cur = s.stages.find((x) => x.id === s.currentStage)
      const nx = computeNext(s)
      const nextLine =
        nx.action === 'run'
          ? `next: run stage ${nx.stage.id} "${nx.stage.name}" (skills: ${nx.stage.skills.join(', ') || 'none'}; gate: ${nx.stage.gate})`
          : nx.action === 'hold'
            ? `next: HOLD — ${nx.reason}`
            : 'next: DONE — all stages passed'
      return ok(
        `status: ${s.status}${s.runToStage != null ? ` (run-to limit: stage ${s.runToStage})` : ''}\n` +
          `current: stage ${s.currentStage}${cur ? ` "${cur.name}" [${cur.state}, gate ${cur.gate.result}]` : ''}\n` +
          nextLine,
      )
    }),
)

server.registerTool(
  'pipeline_control',
  {
    title: 'Resume or pause the pipeline',
    description:
      'Limited self-drive: action "run" resumes the pipeline and clears a stale run-to limiter (use when pipeline_next holds on "run-to" for no reason); "pause" stops before the next stage. Deliberately NOT included: approving sign-offs or releasing breakpoints — those are human gates, only the cockpit can clear them.',
    inputSchema: { action: z.enum(['run', 'pause']) },
  },
  ({ action }) =>
    guard(async () => {
      await pipeline.control({ action })
      return ok(action === 'run' ? 'Pipeline running (run-to limiter cleared).' : 'Pipeline paused.')
    }),
)

server.registerTool(
  'pipeline_next',
  {
    title: 'Next pipeline action',
    description:
      'Return the next stage to run (its enabled skills + the gate to run), honoring pause / run-to / sign-off. Returns {action:"hold"} to wait, or {action:"done"} when finished. Call before each step.',
    inputSchema: {},
  },
  () => guard(async () => ok(JSON.stringify(computeNext(await pipeline.getPlan())))),
)

server.registerTool(
  'pipeline_report',
  {
    title: 'Report a stage result',
    description:
      'Write a stage status, gate result, logs and artifacts — this drives the live cockpit. Set state to "running" when a stage starts and "passed"/"failed" when its gate resolves.',
    inputSchema: {
      stageId: z.number().int(),
      state: z.enum(['running', 'passed', 'failed', 'skipped', 'paused']),
      gateResult: z.enum(['green', 'red', 'hold', 'pending']).optional(),
      logs: z.array(z.string()).optional(),
      artifacts: z.array(z.string()).optional(),
      baselines: z
        .array(z.object({ measure: z.string(), expected: z.number(), tol: z.number().optional() }))
        .describe('Reconciliation baselines (measure name + expected value from profiling). Report at Profile; pipeline_verify EVALUATEs these on the engine later.')
        .optional(),
    },
  },
  ({ stageId, state, gateResult, logs, artifacts, baselines }) =>
    guard(async () => {
      await pipeline.report({ stageId, state, gateResult, logs, artifacts, ...(baselines ? { reconciliation: { baselines } } : {}) })
      return ok(`Stage ${stageId} → ${state}${gateResult ? ` (gate ${gateResult})` : ''}${baselines ? ` · ${baselines.length} baselines stored` : ''}`)
    }),
)

server.registerTool(
  'pipeline_await',
  {
    title: 'Wait for the user',
    description:
      'Check whether the pipeline is still paused/held. Call after pipeline_next returns hold; poll until it returns RESUME.',
    inputSchema: { stageId: z.number().int().optional() },
  },
  () =>
    guard(async () => {
      const s = await pipeline.getPlan()
      return ok(s.status === 'paused' ? 'HOLD (paused by user)' : 'RESUME')
    }),
)

server.registerTool(
  'pipeline_verify',
  {
    title: 'Verify a gate on the engine (host-run)',
    description:
      'Ask the Pipeline HOST to verify a stage gate for real: it EVALUATEs the reconciliation baselines on the live Power BI model and sets the gate green/red from the actual numbers — verified, not asserted. Requires baselines reported earlier (pipeline_report with reconciliation.baselines = [{measure, expected, tol?}]) and the model open in Desktop. Use at the Measures and Integration QA gates instead of self-reporting green.',
    inputSchema: { stageId: z.number().int() },
  },
  ({ stageId }) =>
    guard(async () => {
      const r = await pipeline.verify(stageId)
      const lines = (r.checks ?? []).map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: expected ${c.expected}, engine ${c.actual}`)
      return ok(`Gate ${r.ok ? 'GREEN (verified on engine)' : 'RED'}${r.error ? ` — ${r.error}` : ''}\n${lines.join('\n')}`)
    }),
)

server.registerTool(
  'pbi_validate_measure',
  {
    title: 'Validate a DAX measure (trust-but-verify)',
    description:
      'THE verification tool. Statically checks that a DAX expression references only tables, columns and measures that exist in the live model (catching AI-invented names), then — if valid — evaluates it on the real engine and returns the value. Always run this before proposing or writing a measure.',
    inputSchema: {
      expression: z.string().describe('The measure expression (the right-hand side of a measure, not a full EVALUATE query).'),
      port: z.number().int().optional(),
      extraMeasures: z
        .array(z.string())
        .optional()
        .describe('Names of measures being created alongside this one, so a reference to a sibling is not flagged.'),
    },
  },
  ({ expression, port, extraMeasures }) =>
    guard(async () => {
      const target = await resolveTarget(port)
      const raw = await bridge.model(target.port, target.database)
      const model = toSemanticModel(raw)
      const v = validateReferences(expression, model, extraMeasures ?? [])

      if (!v.ok) {
        const parts: string[] = []
        if (v.unknownTables.length) parts.push(`unknown table(s): ${v.unknownTables.join(', ')}`)
        if (v.unknownColumns.length) parts.push(`unknown column(s): ${v.unknownColumns.join(', ')}`)
        if (v.unknownMeasures.length) parts.push(`unknown measure(s): ${v.unknownMeasures.join(', ')}`)
        return fail(
          `✗ NOT VALID — the expression references names that don't exist in this model:\n  ${parts.join(
            '\n  ',
          )}\n\nNot evaluated. Fix the names against pbi_get_model and re-validate.`,
        )
      }

      try {
        const { value } = await bridge.preview(expression, target.port)
        return ok(`✓ VALID — all references exist, and it evaluates on the engine.\nPreview value: ${fmtValue(value)}`)
      } catch (e) {
        // Names are fine but the engine rejected it (e.g. a type or syntax issue).
        return fail(
          `⚠ References exist, but the engine could not evaluate it:\n  ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }),
)

server.registerTool(
  'pbi_benchmark_dax',
  {
    title: 'Benchmark a DAX query',
    description:
      'Measure how fast a DAX query runs on the real engine — cold-cache by default, minimum of several runs. Use to prove one formulation is faster than another rather than guessing.',
    inputSchema: {
      dax: z.string().describe('A full DAX query (EVALUATE ...) to time.'),
      port: z.number().int().optional(),
      runs: z.number().int().min(1).max(10).optional().describe('How many runs (default 3). The minimum is reported.'),
      clearCache: z.boolean().optional().describe('Clear the engine cache before each run for a cold measurement (default true).'),
    },
  },
  ({ dax, port, runs, clearCache }) =>
    guard(async () => {
      const target = await resolveTarget(port)
      const r = await bridge.time(dax, target.port, runs, clearCache)
      return ok(
        `min ${r.min} ms · median ${r.median} ms over ${r.runs} run(s) · ${r.cold ? 'cold cache' : 'WARM cache (engine refused to clear)'}\n` +
          `rows: ${r.rowCount} · sample value: ${fmtValue(r.value)}\nall runs (ms): ${r.ms.join(', ')}`,
      )
    }),
)

server.registerTool(
  'pbi_analyze_storage',
  {
    title: 'Analyze model storage (VertiPaq)',
    description:
      "The model's in-memory storage footprint — which tables and columns cost the most memory. Read through the same library DAX Studio uses. Use to find optimization targets.",
    inputSchema: { port: z.number().int().optional() },
  },
  ({ port }) =>
    guard(async () => {
      const target = await resolveTarget(port)
      const vpa = await bridge.vertipaq(target.port)
      const tables = [...vpa.tables].sort((a, b) => b.totalSize - a.totalSize).slice(0, 6)
      const cols = [...vpa.columnsList].sort((a, b) => b.totalSize - a.totalSize).slice(0, 10)
      const lines = [
        `Model size ${fmtBytes(vpa.modelSize)} · ${vpa.tableCount} tables · ${vpa.columnCount} columns`,
        '',
        'Biggest tables:',
        ...tables.map(
          (t) => `  ${t.name.padEnd(18)} ${fmtBytes(t.totalSize).padStart(9)}  ${fmtPct(t.percentDb).padStart(6)}  ${t.rows.toLocaleString()} rows`,
        ),
        '',
        'Biggest columns (the optimization targets):',
        ...cols.map(
          (c) =>
            `  ${`${c.table}[${c.column}]`.padEnd(32)} ${fmtBytes(c.totalSize).padStart(9)}  ${fmtPct(c.percentDb).padStart(6)}  card ${c.cardinality.toLocaleString()} · ${c.encoding}`,
        ),
        '',
        'High cardinality + large size usually means a column worth removing, rounding, or splitting.',
      ]
      return ok(lines.join('\n'))
    }),
)

server.registerTool(
  'pbi_write_measure',
  {
    title: 'Create or update a measure (guarded)',
    description:
      `Create or update a measure on the live model. Requires DAXWB_MCP_ALLOW_WRITE=1 (deny-by-default). The DAX is validated first — an expression with invented names is refused, never written.`,
    inputSchema: {
      table: z.string().describe('Home table for the measure, e.g. "_Measures".'),
      name: z.string().describe('Measure name.'),
      dax: z.string().describe('The measure expression.'),
      formatString: z.string().optional().describe('Optional format string, e.g. "#,0" or "0.0%".'),
      port: z.number().int().optional(),
    },
  },
  ({ table, name, dax, formatString, port }) =>
    guard(async () => {
      if (!WRITES_ALLOWED) {
        return fail('Writes are disabled. Set DAXWB_MCP_ALLOW_WRITE=1 in the server environment to allow creating measures.')
      }
      const target = await resolveTarget(port)
      const model = toSemanticModel(await bridge.model(target.port, target.database))
      const v = validateReferences(dax, model, [name])
      if (!v.ok) {
        const bad = [...v.unknownTables, ...v.unknownColumns, ...v.unknownMeasures].join(', ')
        return fail(`Refused to write — the DAX references names that don't exist: ${bad}. Fix and retry.`)
      }
      const res = await bridge.createMeasure({ Table: table, Name: name, Dax: dax, FormatString: formatString, Port: target.port })
      return ok(`✓ Measure ${res.status}: ${res.table}[${res.name}].`)
    }),
)

server.registerTool(
  'pbi_delete_measure',
  {
    title: 'Delete a measure (guarded)',
    description: 'Delete a measure from the live model. Requires DAXWB_MCP_ALLOW_WRITE=1 (deny-by-default).',
    inputSchema: {
      table: z.string(),
      name: z.string(),
      port: z.number().int().optional(),
    },
  },
  ({ table, name, port }) =>
    guard(async () => {
      if (!WRITES_ALLOWED) {
        return fail('Writes are disabled. Set DAXWB_MCP_ALLOW_WRITE=1 in the server environment to allow deleting measures.')
      }
      const target = await resolveTarget(port)
      await bridge.deleteMeasure([{ table, name }], target.port)
      return ok(`✓ Deleted ${table}[${name}] (if it existed).`)
    }),
)

// --- project (as-code) tools: read PBIP/TMDL from disk, no live engine ------

server.registerTool(
  'pbi_open_project',
  {
    title: 'Open a Power BI project (PBIP) from disk',
    description:
      'Read a PBIP project as code — its tables, columns, measures (with display folders) and relationships, parsed from the TMDL files. Use this to work on the model the way source control sees it, and to ground repository-wide refactoring. Pass the path to the .pbip file or its folder (or set DAXWB_PROJECT).',
    inputSchema: { projectPath: z.string().optional().describe('Path to the .pbip file or its folder. Omit to use DAXWB_PROJECT.') },
  },
  ({ projectPath }) =>
    guard(async () => {
      const p = await resolveProjectArg(projectPath)
      const s = await summariseProject(p)
      const tableLines = s.tables.map((t) => `  ${t.name} — ${t.columns} cols, ${t.measures} measures`)
      const measureLines = s.measures.map((m) => `  ${m.table}[${m.name}]${m.displayFolder ? ` · ${m.displayFolder}` : ''}`)
      return ok(
        `Project: ${s.name}\n${s.tables.length} tables · ${s.measures.length} measures · ${s.relationships.length} relationships\n\n` +
          `Tables:\n${tableLines.join('\n')}\n\n` +
          `Relationships:\n${s.relationships.map((r) => `  ${r}`).join('\n') || '  (none)'}\n\n` +
          `Measures:\n${measureLines.join('\n')}`,
      )
    }),
)

server.registerTool(
  'pbi_read_tmdl',
  {
    title: "Read a table's TMDL",
    description:
      'Return the raw TMDL text for one table — its columns, measures and their full DAX. Read this before editing so you work from the exact source.',
    inputSchema: {
      table: z.string().describe('Table name, e.g. "_Measures".'),
      projectPath: z.string().optional(),
    },
  },
  ({ table, projectPath }) =>
    guard(async () => {
      const p = await resolveProjectArg(projectPath)
      const text = await readTmdl(p, table)
      return ok(text.length > 12000 ? `${text.slice(0, 12000)}\n… (truncated)` : text)
    }),
)

server.registerTool(
  'pbi_write_tmdl',
  {
    title: "Write a table's TMDL (guarded)",
    description:
      'Overwrite one table\'s TMDL file — for refactoring the model as code. Requires DAXWB_MCP_ALLOW_WRITE=1. Only overwrites an existing table file, never creates one blindly. Read the file, edit the text, write it back.',
    inputSchema: {
      table: z.string(),
      content: z.string().describe('The full new TMDL content for the table.'),
      projectPath: z.string().optional(),
    },
  },
  ({ table, content, projectPath }) =>
    guard(async () => {
      if (!WRITES_ALLOWED) return fail('Writes are disabled. Set DAXWB_MCP_ALLOW_WRITE=1 to allow editing TMDL files.')
      const p = await resolveProjectArg(projectPath)
      await writeTmdl(p, table, content)
      return ok(`✓ Wrote ${table}.tmdl (${content.length} chars). Reopen the project in Power BI Desktop to load the change.`)
    }),
)

server.registerTool(
  'pbi_measure_usage',
  {
    title: 'Find where a measure/column is used in the report',
    description:
      'Scan the report\'s visuals and list which pages and visuals reference a measure or column by name. "Used in 0 visuals" flags a safe-to-remove candidate. This is report-impact analysis.',
    inputSchema: {
      name: z.string().describe('Measure or column name, e.g. "Gross Margin %".'),
      projectPath: z.string().optional(),
    },
  },
  ({ name, projectPath }) =>
    guard(async () => {
      const p = await resolveProjectArg(projectPath)
      const uses = await measureUsage(p, name)
      if (uses.length === 0) {
        return ok(
          `"${name}" is used in 0 report visuals — nothing would visibly break if you removed it. (Still check whether other measures reference it before deleting.)`,
        )
      }
      const byPage = new Map<string, string[]>()
      for (const u of uses) {
        const arr = byPage.get(u.page) ?? []
        arr.push(u.visualType ?? 'visual')
        byPage.set(u.page, arr)
      }
      const lines = [...byPage.entries()].map(([pg, vs]) => `  Page "${pg}": ${vs.length} visual(s) — ${vs.join(', ')}`)
      return ok(`"${name}" is used in ${uses.length} visual(s) across ${byPage.size} page(s):\n${lines.join('\n')}`)
    }),
)

// --- run -------------------------------------------------------------------
// Everything logs to stderr — stdout is the MCP JSON-RPC channel and must stay clean.
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[dax-workbench-mcp] ready · bridge ${process.env.DAXWB_BRIDGE ?? 'http://127.0.0.1:5177'} · writes ${WRITES_ALLOWED ? 'ENABLED' : 'disabled'}`)
}

main().catch((e) => {
  console.error('[dax-workbench-mcp] fatal:', e)
  process.exit(1)
})
