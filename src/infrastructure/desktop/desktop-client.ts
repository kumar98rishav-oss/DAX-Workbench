/**
 * INFRASTRUCTURE — Power BI Desktop bridge client
 * Talks to the local bridge service (tools/pbi-desktop-bridge, a .NET HTTP API
 * on 127.0.0.1:5177). When it's running with a .pbix open, the Studio can read
 * the real model, preview measures on real data, and push measures into Desktop.
 * Every call fails soft — if the bridge is absent, the Studio stays in its
 * in-browser (sample-data) mode.
 */
const BASE = 'http://127.0.0.1:5177'

export interface DesktopStatus {
  bridge: boolean // the local bridge service is reachable
  connected: boolean // a .pbix model is open + bound
  database?: string
  port?: number
}

export interface DesktopColumn { name: string; dataType: string }
export interface DesktopMeasure { name: string; expression: string; formatString?: string; displayFolder?: string }
export interface DesktopTable { name: string; isHidden: boolean; columns: DesktopColumn[]; measures: DesktopMeasure[] }
export interface DesktopRelationship { fromTable: string; fromColumn: string; toTable: string; toColumn: string; isActive: boolean }
export interface DesktopModel { database: string; port: number; tables: DesktopTable[]; relationships: DesktopRelationship[] }

async function req<T>(path: string, init?: RequestInit, timeoutMs = 6000): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const body = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok || body?.error) throw new Error(body?.error || `Bridge error (HTTP ${r.status})`)
  return body as T
}

/** Is the bridge up, and is a model open? Never throws. */
export async function probeDesktop(): Promise<DesktopStatus> {
  try {
    const list = await req<{ Port: number; Database: string }[]>('/discover', undefined, 1500)
    return list.length > 0
      ? { bridge: true, connected: true, database: list[0].Database, port: list[0].Port }
      : { bridge: true, connected: false }
  } catch {
    return { bridge: false, connected: false }
  }
}

export const getDesktopModel = (port?: number) => req<DesktopModel>(`/model${port ? `?port=${port}` : ''}`)

export const desktopPreview = (expression: string, port?: number) =>
  req<{ value: unknown }>('/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expression, port }),
  }).then((r) => r.value)

export const desktopRunDax = (dax: string, port?: number) =>
  req<{ columns: string[]; rowCount: number; rows: Record<string, unknown>[] }>('/dax', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dax, port }),
  })

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
