/**
 * Thin typed client over the DAX Workbench bridge's local HTTP API
 * (127.0.0.1:5177). Every MCP tool goes through here, so bridge-down and
 * no-model-open failures produce ONE clear, actionable message instead of a
 * raw fetch error.
 */
const BASE = (process.env.DAXWB_BRIDGE ?? 'http://127.0.0.1:5177').replace(/\/+$/, '')

/** A failure the user can act on (bridge not running, no report open, engine error). */
export class BridgeError extends Error {}

export interface OpenModel {
  port: number
  database: string
  workspace?: string
  tableCount: number
  measureCount: number
  tables: string[]
}

export interface VpaColumn {
  table: string
  column: string
  dataType: string
  encoding: string
  cardinality: number
  totalSize: number
  percentDb: number
}
export interface VpaTable {
  name: string
  rows: number
  totalSize: number
  percentDb: number
}
export interface Vpax {
  modelSize: number
  tableCount: number
  columnCount: number
  tables: VpaTable[]
  columnsList: VpaColumn[]
}

export interface RawModel {
  tables: {
    name: string
    isHidden?: boolean
    columns: { name: string; dataType?: string; isHidden?: boolean }[]
    measures: { name: string; expression?: string; isHidden?: boolean }[]
  }[]
  relationships?: {
    fromTable: string
    fromColumn: string
    toTable: string
    toColumn: string
    isActive?: boolean
  }[]
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(BASE + path, opts)
  } catch (e) {
    throw new BridgeError(
      `DAX Workbench isn't reachable at ${BASE}. Open Power BI Desktop and launch DAX Workbench from the External Tools ribbon, then try again.` +
        (e instanceof Error ? ` (${e.message})` : ''),
    )
  }
  const text = await resp.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!resp.ok) {
    const b = body as { error?: unknown; message?: unknown } | null
    const msg = (b && (b.error ?? b.message)) ?? `HTTP ${resp.status}`
    throw new BridgeError(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return body as T
}

export const bridge = {
  discover: () => req<OpenModel[]>('/discover'),
  model: (port: number, database: string) =>
    req<RawModel>(`/model?port=${port}&database=${encodeURIComponent(database)}`),
  dax: (dax: string, port: number) =>
    req<{ columns: string[]; rowCount: number; rows: Record<string, unknown>[] }>('/dax', post({ Dax: dax, Port: port })),
  preview: (expression: string, port: number) =>
    req<{ value: unknown }>('/preview', post({ Expression: expression, Port: port })),
  vertipaq: (port: number) => req<Vpax>(`/vertipaq?port=${port}`),
  time: (dax: string, port: number, runs?: number, clearCache?: boolean) =>
    req<{ ms: number[]; median: number; min: number; runs: number; rowCount: number; value: unknown; cold: boolean }>(
      '/time',
      post({ Dax: dax, Port: port, Runs: runs, ClearCache: clearCache }),
    ),
  createMeasure: (m: { Table: string; Name: string; Dax: string; FormatString?: string; Port: number }) =>
    req<{ status: string; table: string; name: string }>('/measure', post(m)),
  deleteMeasure: (items: { table: string; name: string }[], port: number) =>
    req<unknown>(
      '/delete',
      // The bridge tags each item with a Kind and refuses anything but "measure".
      post({ Items: items.map((i) => ({ Kind: 'measure', Table: i.table, Name: i.name })), Port: port }),
    ),
}

/**
 * Resolve which open model a tool should act on. An explicit port wins; with a
 * single report open we use it; with several we refuse and list them, so a
 * write never lands on the wrong model by accident.
 */
export async function resolveTarget(port?: number): Promise<OpenModel> {
  const models = await bridge.discover()
  if (models.length === 0) {
    throw new BridgeError('No Power BI report is open. Open one in Power BI Desktop, then try again.')
  }
  if (port != null) {
    const found = models.find((m) => m.port === port)
    if (!found) {
      throw new BridgeError(`No open model on port ${port}. Open models are on: ${models.map((m) => m.port).join(', ')}.`)
    }
    return found
  }
  if (models.length > 1) {
    const list = models.map((m) => `${m.tables[0] ?? 'report'} (port ${m.port}, ${m.tableCount} tables)`).join('; ')
    throw new BridgeError(`More than one report is open — pass an explicit "port". Open: ${list}.`)
  }
  return models[0]
}
