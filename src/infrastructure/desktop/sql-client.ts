/**
 * INFRASTRUCTURE — SQL Server, through the bridge
 *
 * The browser cannot open a database connection, so every call here goes to the
 * local bridge, which holds the driver. Same shape as desktop-client: fail soft,
 * readable errors, no silent fallbacks.
 */
import { bridgeBase } from './desktop-client'

export interface SqlConnection {
  server: string
  database?: string
  /** 'integrated' (the default, and the recommendation — nothing is stored) or 'sql'. */
  auth?: 'integrated' | 'sql'
  user?: string
  /** Held in memory for the session only; never written to disk. */
  password?: string
  trustServerCertificate?: boolean
  timeoutSec?: number
}

export interface SqlTestResult {
  server: string
  database?: string
  login: string
  /** e.g. SQL_Latin1_General_CP1_CI_AS — the CI/CS suffix decides whether key
   * comparison should fold case. */
  collation?: string
  version: string
}

export interface SqlSchemaColumn {
  name: string
  dataType: string
  nullable: boolean
}

export interface SqlSchemaObject {
  schema: string
  name: string
  kind: 'table' | 'view'
  columns: SqlSchemaColumn[]
  /** Declared primary key in key order; empty for a view. The only trustworthy
   * statement of a table's grain available without asking the user. */
  primaryKey?: string[]
}

export interface SqlQueryResult {
  columns: string[]
  rowCount: number
  rows: Record<string, unknown>[]
  truncated: boolean
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const r = await fetch(`${bridgeBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const parsed = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok || parsed?.error) throw new Error(parsed?.error || `Bridge error (HTTP ${r.status})`)
  return parsed as T
}

export const sqlTest = (connection: SqlConnection) =>
  post<SqlTestResult>('/sql/test', { connection }, 45_000)

export const sqlSchema = (connection: SqlConnection) =>
  post<SqlSchemaObject[]>('/sql/schema', { connection }, 60_000)

/** Run one read-only statement. The bridge refuses anything else with a 400 and
 * an explanation, which surfaces here as a thrown Error. */
export const sqlQuery = (connection: SqlConnection, sql: string, rowCap = 100_000) =>
  post<SqlQueryResult>('/sql/query', { connection, sql, rowCap }, 180_000)

// ── Saved suites ────────────────────────────────────────────────────────────

/** Saved checks live in %LOCALAPPDATA%\DAX Workbench, beside the pipeline's
 * state — so they survive a cleared browser and do not depend on where the exe
 * was launched from. The bridge holds the JSON verbatim; the shape belongs to
 * the application layer. */
export const getSuites = async <T>(): Promise<T[]> => {
  const r = await fetch(`${bridgeBase()}/suites`, { signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`Could not read saved checks (HTTP ${r.status})`)
  const parsed = await r.json().catch(() => [])
  return Array.isArray(parsed) ? (parsed as T[]) : []
}

export const putSuites = async <T>(suites: T[]): Promise<void> => {
  const r = await fetch(`${bridgeBase()}/suites`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(suites),
    signal: AbortSignal.timeout(20_000),
  })
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `Could not save checks (HTTP ${r.status})`)
  }
}

// ── Model side ──────────────────────────────────────────────────────────────

export interface ModelSource {
  name: string
  isHidden: boolean
  /** 'query' = Power Query (has a source we can reconcile against).
   * 'calculated' = derived in the model; there is no SQL object behind it. */
  kind: 'query' | 'calculated' | 'none' | 'other'
  mode?: string
  /** The partition's M text. Parsed in the UI to suggest a SQL object. */
  expression?: string
  /** Import models hold a snapshot: a difference may mean "stale", not "wrong". */
  refreshedAt?: string
}

export const getModelSources = async (port?: number) => {
  const r = await fetch(`${bridgeBase()}/sources${port ? `?port=${port}` : ''}`, {
    signal: AbortSignal.timeout(30_000),
  })
  const parsed = (await r.json().catch(() => ({}))) as { tables?: ModelSource[]; error?: string }
  if (!r.ok || parsed.error) throw new Error(parsed.error || `Bridge error (HTTP ${r.status})`)
  return parsed.tables ?? []
}

/**
 * Pull the SQL object a table loads from out of its Power Query text.
 *
 * Only a suggestion — Power Query can rename, filter and merge, so the mapping
 * is always shown to the user for confirmation rather than applied silently.
 * Returns null when the M does not look like a plain SQL Server read.
 */
export function suggestSqlObject(m?: string): { schema?: string; object: string } | null {
  if (!m || !/Sql\.Databases?\s*\(/.test(m)) return null
  // Item is the table/view; Schema is optional.
  const item = m.match(/\[\s*(?:[^\]]*?,\s*)?Item\s*=\s*"([^"]+)"/)?.[1]
      ?? m.match(/Item\s*=\s*"([^"]+)"/)?.[1]
  if (!item) return null
  const schema = m.match(/Schema\s*=\s*"([^"]+)"/)?.[1]
  return { schema, object: item }
}
