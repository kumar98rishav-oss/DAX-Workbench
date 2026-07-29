/**
 * INFRASTRUCTURE — Power BI Desktop bridge client
 * Talks to the local bridge service (tools/pbi-desktop-bridge, a .NET HTTP API
 * on 127.0.0.1:5177). When it's running with a .pbix open, the Studio can read
 * the real model, preview measures on real data, and push measures into Desktop.
 * Every call fails soft — if the bridge is absent, the Studio stays in its
 * in-browser (sample-data) mode.
 */
import { resolveActiveModel } from './model-select'
import type { DesktopModelInfo } from './model-select'
export { modelSignature, modelLabelParts } from './model-select'
export type { DesktopModelInfo } from './model-select'
/** When the app is SERVED BY the bridge itself (the embedded local build on
 * port 5177), talk to our own origin — that also makes it work under any
 * hostname the user reached us by. Otherwise (dev server, hosted site) target
 * the conventional local bridge address. */
export const LOCAL_BRIDGE =
  typeof location !== 'undefined' && location.port === '5177' ? location.origin : 'http://127.0.0.1:5177'

/** Where the bridge is, and the token to reach it if it isn't on this machine.
 * Module-level rather than passed around: every call site already existed and
 * shouldn't have to learn about remote. */
let base = LOCAL_BRIDGE
let token: string | null = null

export function configureBridge(url?: string | null, pairingToken?: string | null): void {
  base = (url || LOCAL_BRIDGE).replace(/\/+$/, '')
  token = pairingToken?.trim() || null
}
export const bridgeBase = (): string => base
export const isRemoteBridge = (): boolean => !/^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/i.test(base)

export interface DesktopStatus {
  bridge: boolean // the bridge service is reachable
  connected: boolean // a .pbix model is open + bound
  database?: string
  port?: number
  /** The machine actually serving it — worth showing when it isn't this one. */
  machine?: string
  /** Every open model the bridge can see — drives the picker when there's more
   * than one, and lets a poll re-bind across a restart. */
  models?: DesktopModelInfo[]
  /** Several models are open and none could be picked automatically. */
  needsChoice?: boolean
  /** The pinned report reappeared on a new port — Desktop restarted and we
   * reconnected without the user doing anything. */
  rebound?: boolean
  /** The open model differs from the one currently loaded in the Workbench —
   * set by the store, surfaced as a "Sync" nudge. */
  stale?: boolean
}

export interface DesktopColumn { name: string; dataType: string }
export interface DesktopMeasure { name: string; expression: string; formatString?: string; displayFolder?: string }
export interface DesktopTable { name: string; isHidden: boolean; columns: DesktopColumn[]; measures: DesktopMeasure[] }
export interface DesktopRelationship { fromTable: string; fromColumn: string; toTable: string; toColumn: string; isActive: boolean }
export interface DesktopModel { database: string; port: number; tables: DesktopTable[]; relationships: DesktopRelationship[] }

async function req<T>(path: string, init?: RequestInit, timeoutMs = 6000): Promise<T> {
  const headers = new Headers(init?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const r = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
  const body = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok || body?.error) throw new Error(body?.error || `Bridge error (HTTP ${r.status})`)
  return body as T
}

export type BridgeTestResult =
  | { ok: true; machine?: string; models: number }
  | { ok: false; kind: 'auth' | 'local-only' | 'http' | 'mixed-content' | 'unreachable'; reason: string }

/** Reach a specific bridge without touching the configured one — the "test this
 * address before I save it" path. Returns a readable reason when it fails. */
export async function testBridge(url: string, pairingToken?: string | null): Promise<BridgeTestResult> {
  const target = url.replace(/\/+$/, '')
  const headers: HeadersInit = pairingToken?.trim() ? { Authorization: `Bearer ${pairingToken.trim()}` } : {}
  try {
    const h = await fetch(`${target}/health`, { headers, signal: AbortSignal.timeout(5000) })
    if (h.status === 401) return { ok: false, kind: 'auth', reason: 'The bridge is running, but that pairing token is wrong.' }
    if (h.status === 403) return { ok: false, kind: 'local-only', reason: 'That bridge only answers its own machine. Ask them to run it again and choose [2].' }
    if (!h.ok) return { ok: false, kind: 'http', reason: `The bridge answered HTTP ${h.status}.` }
    const info = (await h.json()) as { machine?: string }
    const d = await fetch(`${target}/discover`, { headers, signal: AbortSignal.timeout(8000) })
    const models = d.ok ? ((await d.json()) as unknown[]).length : 0
    return { ok: true, machine: info.machine, models }
  } catch {
    // fetch() hides the cause, so name the two that actually happen.
    const mixed = location.protocol === 'https:' && target.startsWith('http://') && !/\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(target)
    return mixed
      ? {
          ok: false,
          kind: 'mixed-content',
          reason: 'Your browser blocked this: a page served over HTTPS cannot call a plain-HTTP address unless it is on your own machine. Use an SSH tunnel (below), or open the Workbench from localhost.',
        }
      : { ok: false, kind: 'unreachable', reason: 'Nothing answered — the request never reached a bridge.' }
  }
}

/** Every open Power BI Desktop model the bridge can see. Never throws — returns
 * null when the bridge itself is unreachable (so callers can tell "no bridge"
 * from "bridge up, nothing open"). */
export async function discoverModels(): Promise<DesktopModelInfo[] | null> {
  try {
    // 2.5s was too tight once discovery started reporting each model's shape:
    // the FIRST call after a model opens has to read its metadata from the
    // engine (cached thereafter), and a real model took ~4s — so every poll
    // timed out and the UI claimed "Bridge not running" while it was healthy.
    return await req<DesktopModelInfo[]>('/discover', undefined, 15000)
  } catch {
    return null
  }
}

/**
 * Is the bridge up, and which model should we talk to? Never throws.
 * `preferredPort`/`preferredSignature` carry the user's earlier choice so a
 * poll doesn't fight it and can re-bind the report across a Desktop restart
 * (the restart changes the port, not the report's shape). When several models
 * are open and none can be picked, `needsChoice` is set and no port is pinned.
 */
export async function probeDesktop(
  preferredPort?: number,
  preferredSignature?: string,
): Promise<DesktopStatus> {
  const models = await discoverModels()
  if (models === null) return { bridge: false, connected: false }
  if (models.length === 0) return { bridge: true, connected: false, models: [] }

  const { model, needsChoice, rebound } = resolveActiveModel(models, preferredPort, preferredSignature)
  let machine: string | undefined
  try { machine = (await req<{ machine?: string }>('/health', undefined, 2000)).machine } catch { /* optional */ }

  if (!model) return { bridge: true, connected: true, models, needsChoice, machine }
  return { bridge: true, connected: true, database: model.database, port: model.port, models, machine, rebound }
}

const GUID = /^[{(]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[)}]?$/i

/** A Desktop model's database name is a GUID — never worth showing. Null when
 * there's nothing human-readable to display. */
export const modelLabel = (database?: string): string | null =>
  !database || GUID.test(database) ? null : database

export const getDesktopModel = (port?: number) => req<DesktopModel>(`/model${port ? `?port=${port}` : ''}`)

export const desktopPreview = (expression: string, port?: number) =>
  req<{ value: unknown }>('/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expression, port }),
  }).then((r) => r.value)

/** Run a scalar DEFINE/EVALUATE query and return the single value — the
 * live-preview path for measures that exist only in the Studio. Longer timeout:
 * the first query after connect pays the formula-engine warm-up. */
export const desktopEvaluateScalar = async (query: string, port?: number): Promise<unknown> => {
  const r = await req<{ columns: string[]; rows: Record<string, unknown>[] }>('/dax', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dax: query, port }),
  }, 15000)
  const row = r.rows[0]
  return row ? row[r.columns[0]] : null
}

export interface DaxTiming {
  ms: number[]
  median: number
  min: number
  runs: number
  rowCount: number
  value: unknown
  /** False when the engine refused to drop its caches — the numbers are then
   * warm-cache and must be labelled as such, never presented as cold. */
  cold: boolean
}

/** Benchmark a query on the real engine. Generous timeout: clearing the cache
 * and running several cold passes is deliberately the slow path. */
export const desktopTimeDax = (dax: string, runs = 3, clearCache = true, port?: number) =>
  req<DaxTiming>('/time', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dax, runs, clearCache, port }),
  }, 120000)

export const desktopRunDax = (dax: string, port?: number) =>
  req<{ columns: string[]; rowCount: number; rows: Record<string, unknown>[] }>('/dax', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dax, port }),
  })

// ---- VertiPaq Analyzer: the model's storage footprint ----------------------
// Shapes mirror the bridge's Vertipaq.cs DTO (camelCase over the wire).

export interface VpColumn {
  table: string
  column: string
  dataType: string
  /** HASH (dictionary-encoded) or VALUE (value-encoded). */
  encoding: string
  cardinality: number
  totalSize: number
  dataSize: number
  dictionarySize: number
  hierarchiesSize: number
  /** Share of the whole model, 0–1. */
  percentDb: number
}

export interface VpTable {
  name: string
  rows: number
  totalSize: number
  columnsSize: number
  percentDb: number
  columns: number
}

export interface VpRelationship { name: string; usedSize: number; missingKeys: boolean }

export interface VpReport {
  database: string
  modelSize: number
  tableCount: number
  columnCount: number
  tables: VpTable[]
  columnsList: VpColumn[]
  relationships: VpRelationship[]
}

/** Read the model's VertiPaq storage metrics. Slow by nature — the engine has
 * to report per-column statistics — so this gets a long timeout and is only
 * ever run on demand, never on a poll. */
export const desktopVertipaq = (port?: number) =>
  req<VpReport>(`/vertipaq${port ? `?port=${port}` : ''}`, undefined, 120000)

/** Create or update a CALCULATED TABLE (e.g. a generated date table) in the
 * live model. relateTable/relateColumn asks the bridge to also mark it as the
 * model's date table and relate it to the reference column (best-effort). */
export const desktopCreateTable = (
  name: string,
  dax: string,
  relateTable?: string,
  relateColumn?: string,
  port?: number,
) =>
  req<{ status: string; table: string; note?: string }>('/table', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, dax, relateTable, relateColumn, port }),
  }, 20000) // the engine materialises the whole table on commit — give it room

/** A measure exactly as it was before deletion — enough to re-create it. */
export interface DeletedMeasureSnapshot {
  table: string
  name: string
  dax: string
  formatString?: string | null
  displayFolder?: string | null
  description?: string | null
}

/**
 * Delete measures from the live model. All or nothing: the bridge locates and
 * snapshots every target before removing any, and rolls back if the single
 * commit fails. The snapshot comes back either way — the engine has no undo,
 * so holding the DAX is the only thing that makes this recoverable.
 */
export const desktopDeleteMeasures = (
  items: { kind: string; table: string; name: string }[],
  port?: number,
) =>
  req<{ status: string; count: number; snapshot: DeletedMeasureSnapshot[] }>(
    '/delete',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items, port }),
    },
    30000,
  )

export const desktopCreateMeasure = (
  table: string,
  name: string,
  dax: string,
  formatString?: string,
  displayFolder?: string,
  port?: number,
) =>
  req<{ status: string; table: string; name: string }>('/measure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ table, name, dax, formatString, displayFolder, port }),
  })
