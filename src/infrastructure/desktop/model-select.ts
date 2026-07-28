/**
 * INFRASTRUCTURE — Desktop model selection (pure)
 * Deciding WHICH open Power BI Desktop model to talk to, when more than one is
 * open and when the one we picked moves. Kept free of fetch/DOM so the whole
 * decision is unit-testable — the bit that used to silently take `list[0]`.
 *
 * Two facts drive the design:
 *   1. A Desktop model's port is ephemeral — it changes every time Desktop
 *      restarts, even for the same report. So a pinned port cannot survive a
 *      restart.
 *   2. The database name is a fresh GUID each session, so it can't identify a
 *      report across restarts either.
 * What IS stable for a given report is its shape — its table names and counts.
 * So we pin a *signature* computed from that, and re-resolve the live port each
 * poll by matching it.
 */

export interface DesktopModelInfo {
  port: number
  database: string
  /** Metadata the bridge reads cheaply during discovery, for disambiguation. */
  tableCount?: number
  measureCount?: number
  /** A few user-visible table names — the human-readable part of the picker. */
  tables?: string[]
}

/** A restart-stable fingerprint of a model: its shape, not its session identity.
 * Two windows of the same report collide on purpose — they ARE the same model,
 * and re-pinning to either is correct. */
export function modelSignature(m: DesktopModelInfo): string {
  const tables = (m.tables ?? []).map((t) => t.toLowerCase()).sort()
  return `t${m.tableCount ?? tables.length}:m${m.measureCount ?? 0}:${tables.join('|')}`
}

export interface Resolution {
  /** The model to talk to, or null when the choice is ambiguous / nothing open. */
  model: DesktopModelInfo | null
  /** True when several models are open and none can be picked automatically. */
  needsChoice: boolean
  /** True when we kept the pinned report but on a NEW port — i.e. Desktop
   * restarted and we reconnected without the user lifting a finger. */
  rebound: boolean
}

/**
 * Pick the active model from everything currently open, honouring an earlier
 * choice. Precedence, most-specific first:
 *   1. The exact port we were on, if it's still alive — nothing changed.
 *   2. The pinned report's signature, if it now matches exactly one model —
 *      this is the restart case: same report, new port. (Ambiguous if it
 *      matches several, e.g. the report opened twice.)
 *   3. Exactly one model open — no ambiguity to resolve.
 *   4. Otherwise the user must choose.
 */
export function resolveActiveModel(
  models: DesktopModelInfo[],
  preferredPort?: number,
  preferredSignature?: string,
): Resolution {
  if (models.length === 0) return { model: null, needsChoice: false, rebound: false }

  if (preferredPort != null) {
    const onPort = models.find((m) => m.port === preferredPort)
    if (onPort) return { model: onPort, needsChoice: false, rebound: false }
  }

  if (preferredSignature) {
    const bySig = models.filter((m) => modelSignature(m) === preferredSignature)
    if (bySig.length === 1) return { model: bySig[0], needsChoice: false, rebound: preferredPort != null }
  }

  if (models.length === 1) return { model: models[0], needsChoice: false, rebound: false }

  return { model: null, needsChoice: true, rebound: false }
}

/** A short human label for a model in the picker, e.g. "21 tables · 48 measures". */
export function modelLabelParts(m: DesktopModelInfo): string {
  const parts: string[] = []
  if (m.tableCount != null) parts.push(`${m.tableCount} table${m.tableCount === 1 ? '' : 's'}`)
  if (m.measureCount != null) parts.push(`${m.measureCount} measure${m.measureCount === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
