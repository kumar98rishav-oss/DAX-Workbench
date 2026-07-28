/**
 * APPLICATION — VertiPaq insights
 * Turns the bridge's raw storage metrics into the handful of statements a
 * modeller can act on. Pure and I/O-free so the thresholds are unit-testable.
 *
 * The rules encode how VertiPaq actually stores data:
 *  - Compression is per-COLUMN, so a model's size is a column problem, never a
 *    row-count problem. A 60M-row fact table with 8 low-cardinality columns can
 *    be smaller than a 100k-row table carrying one unique text key.
 *  - Cardinality (distinct values), not row count, drives dictionary size.
 *  - A high-cardinality column that nothing references is pure waste — it costs
 *    memory and refresh time and buys nothing.
 */
import type { VpReport, VpColumn, VpTable } from '@/infrastructure/desktop/desktop-client'

export interface VpFinding {
  id: string
  severity: 'high' | 'medium' | 'low'
  title: string
  /** The object this is about, e.g. "Fact_Claims[ClaimNumber]". */
  target: string
  /** Bytes this finding is about — used to rank and to show the prize. */
  bytes: number
  /** What it is, why it costs, and what to do — in that order. */
  detail: string
}

export const KB = 1024
export const MB = 1024 * 1024

/** Human byte size. Deliberately coarse — nobody needs 3 decimals of KB. */
export function formatBytes(n: number): string {
  if (n >= MB) return `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB`
  if (n >= KB) return `${Math.round(n / KB)} KB`
  return `${n} B`
}

export const formatPct = (v: number): string => `${(v * 100).toFixed(1)}%`

/** Cardinality per row — 1.0 means every value is unique (a key). */
export function uniqueness(col: VpColumn, tableRows: number): number {
  if (tableRows <= 0) return 0
  return Math.min(1, col.cardinality / tableRows)
}

export interface InsightOptions {
  /** Measures + columns actually referenced somewhere, lowercased "table[col]".
   * When supplied, unreferenced expensive columns get flagged. Without it that
   * rule stays silent rather than guessing — same rule as the Cleanup tab:
   * never claim "unused" without evidence. */
  referenced?: Set<string>
}

const key = (t: string, c: string): string => `${t}[${c}]`.toLowerCase()

/**
 * A column that is SUPPOSED to be unique, where "near-unique is expensive" is
 * not advice — it's a description of a correct design. Flagging these is the
 * fastest way to lose a modeller's trust:
 *  - the Date column of a date table (unique by definition, and required),
 *  - the primary key of a dimension (unique by definition, and needed for the
 *    relationship it serves).
 * A high-cardinality column on a FACT table is a different story: that one is
 * usually a degenerate dimension nobody needs at full precision.
 */
export function isLegitimateKey(col: VpColumn, tableRows: number, allTables: VpTable[]): boolean {
  const t = col.table.toLowerCase()
  const c = col.column.toLowerCase()

  // A date column in something that looks like a date table.
  const dateTable = /date|calendar|dim[_ ]?date/.test(t)
  const dateCol = /^(date|datekey|full ?date)$/.test(c) || col.dataType.toLowerCase().includes('date')
  if (dateTable && dateCol) return true

  // A dimension's own key: the table is small relative to the model's facts,
  // the column name ends in an id-ish suffix, and its stem echoes the table
  // name ("Dim_Patient" → "PatientID"). The echo check is what keeps this from
  // excusing every id-ish column on every small table.
  const biggest = Math.max(...allTables.map((x) => x.rows), 1)
  const isSmallTable = tableRows <= biggest * 0.25
  const endsIdLike = /(id|key|code|no|number)$/.test(c)
  const tableStem = t.replace(/^(dim|fact|bridge)[_ ]?/, '').replace(/[^a-z]/g, '')
  const colStem = c.replace(/(id|key|code|no|number)$/, '').replace(/[^a-z]/g, '')
  const echoesTable =
    colStem.length === 0 || // "Dim_Patient"."ID"
    (tableStem.length >= 3 && (tableStem.startsWith(colStem) || colStem.startsWith(tableStem)))
  return isSmallTable && endsIdLike && echoesTable
}

/**
 * Rank what is worth fixing. Ordered by bytes within severity, because a
 * "high severity" finding worth 3 KB is noise on a 2 GB model.
 */
export function analyzeStorage(report: VpReport, opts: InsightOptions = {}): VpFinding[] {
  const findings: VpFinding[] = []
  const rowsByTable = new Map(report.tables.map((t) => [t.name, t.rows]))
  const model = Math.max(report.modelSize, 1)

  for (const c of report.columnsList) {
    const target = `${c.table}[${c.column}]`
    const rows = rowsByTable.get(c.table) ?? 0
    const share = c.totalSize / model
    const uniq = uniqueness(c, rows)
    const legitKey = isLegitimateKey(c, rows, report.tables)

    // ONE finding per column, with every reason merged. Emitting a separate
    // finding per rule made the same column appear three times, which reads as
    // noise and buries the columns that only trip one rule.
    const reasons: string[] = []
    let severity: VpFinding['severity'] = 'low'
    let title = ''

    if (share >= 0.05 && c.totalSize >= 64 * KB) {
      title = 'Column dominates the model'
      severity = share >= 0.1 ? 'high' : 'medium'
      reasons.push(
        `it holds ${formatPct(share)} of the entire model across ` +
        `${c.cardinality.toLocaleString()} distinct values`,
      )
    }

    // High cardinality only matters where it is not the point of the column.
    if (uniq >= 0.9 && rows >= 1000 && c.totalSize >= 32 * KB && !legitKey) {
      if (!title) title = 'Near-unique column is expensive'
      if (share >= 0.05) severity = 'high'
      else if (severity !== 'high') severity = 'medium'
      reasons.push(
        `almost every row has a distinct value (${c.cardinality.toLocaleString()} over ` +
        `${rows.toLocaleString()} rows), so the dictionary cannot compress it`,
      )
    }

    if (c.dictionarySize > c.dataSize * 2 && c.dictionarySize >= 32 * KB) {
      if (!title) title = 'Dictionary larger than the data'
      if (severity === 'low') severity = 'medium'
      reasons.push(
        `its value dictionary (${formatBytes(c.dictionarySize)}) is more than twice the ` +
        `column data (${formatBytes(c.dataSize)}) — typical of long text values`,
      )
    }

    // Expensive AND nothing references it — only when we have real evidence.
    const unreferenced =
      !!opts.referenced && c.totalSize >= 32 * KB && !opts.referenced.has(key(c.table, c.column))
    if (unreferenced) {
      title = 'Expensive column with no references found'
      severity = share >= 0.03 ? 'high' : 'medium'
      reasons.push('nothing in the scanned model or report refers to it')
    }

    if (reasons.length === 0) continue

    const advice = unreferenced
      ? 'Verify before removing — a column can still be used by a slicer, an RLS rule or a ' +
        'calculation group that was not scanned.'
      : legitKey
        ? 'This looks like a key the model needs, so removing it is not the answer — but it is ' +
          'worth knowing what it costs.'
        : 'If it is not needed at full precision, reducing its cardinality — or removing it — ' +
          'is the biggest saving available on this column.'

    findings.push({
      id: `col:${target}`,
      severity,
      title,
      target,
      bytes: c.totalSize,
      detail: `${formatBytes(c.totalSize)} — ${reasons.join('; ')}. ${advice}`,
    })
  }

  const rank = { high: 0, medium: 1, low: 2 }
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || b.bytes - a.bytes)
}

export interface StorageSummary {
  modelSize: number
  tableCount: number
  columnCount: number
  relationshipCount: number
  /** Bytes held by relationships — usually small, occasionally not. */
  relationshipSize: number
  /** The single largest column, the usual answer to "why is this model big?". */
  largestColumn: VpColumn | null
  largestTable: VpTable | null
  /** Share of the model held by the top 10 columns — a concentration measure.
   * High means a few columns dominate, so there are few things to fix. */
  top10Share: number
}

export function summarize(report: VpReport): StorageSummary {
  const cols = [...report.columnsList].sort((a, b) => b.totalSize - a.totalSize)
  const model = Math.max(report.modelSize, 1)
  const top10 = cols.slice(0, 10).reduce((n, c) => n + c.totalSize, 0)
  return {
    modelSize: report.modelSize,
    tableCount: report.tableCount,
    columnCount: report.columnCount,
    relationshipCount: report.relationships.length,
    relationshipSize: report.relationships.reduce((n, r) => n + r.usedSize, 0),
    largestColumn: cols[0] ?? null,
    largestTable: [...report.tables].sort((a, b) => b.totalSize - a.totalSize)[0] ?? null,
    top10Share: top10 / model,
  }
}
