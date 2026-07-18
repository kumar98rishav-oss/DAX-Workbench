/**
 * INFRASTRUCTURE — Power BI Desktop bridge client
 * Talks to the local bridge service (tools/pbi-desktop-bridge, a .NET HTTP API
 * on 127.0.0.1:5177). When it's running with a .pbix open, the Studio can read
 * the real model, preview measures on real data, and push measures into Desktop.
 * Every call fails soft — if the bridge is absent, the Studio stays in its
 * in-browser (sample-data) mode.
 */
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
          reason: 'Your browser blocked this: a page served over HTTPS cannot call a plain-HTTP address unless it is on your own machine. Use an SSH tunnel (below), or open Studio from localhost.',
        }
      : { ok: false, kind: 'unreachable', reason: 'Nothing answered — the request never reached a bridge.' }
  }
}

/** Is the bridge up, and is a model open? Never throws. */
export async function probeDesktop(): Promise<DesktopStatus> {
  try {
    // The bridge serialises camelCase — reading Port/Database here left the port
    // undefined, so every later call silently fell back to the bridge picking a
    // model for us. That's only correct while exactly one .pbix is open.
    const list = await req<{ port: number; database: string }[]>('/discover', undefined, 2500)
    if (list.length === 0) return { bridge: true, connected: false }
    let machine: string | undefined
    try { machine = (await req<{ machine?: string }>('/health', undefined, 2000)).machine } catch { /* optional */ }
    return { bridge: true, connected: true, database: list[0].database, port: list[0].port, machine }
  } catch {
    return { bridge: false, connected: false }
  }
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

export const desktopRunDax = (dax: string, port?: number) =>
  req<{ columns: string[]; rowCount: number; rows: Record<string, unknown>[] }>('/dax', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dax, port }),
  })

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
