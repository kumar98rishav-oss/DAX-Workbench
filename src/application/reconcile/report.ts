/**
 * APPLICATION — Reconciliation report (pure)
 *
 * Turns a run into something you can hand to another person: a self-contained
 * HTML document (opens anywhere, prints to PDF) and a CSV for Excel.
 *
 * The report exists so that "what did we test, and what did we find" is a file
 * rather than a memory. Three rules shape it:
 *
 *  - It shows the numbers, not just the verdicts, and carries both queries
 *    verbatim, so a reader can reproduce any line in SSMS and DAX Studio.
 *  - A check that could not run is reported as exactly that. It is never folded
 *    into the passed count — the same rule the screen follows.
 *  - Nothing secret goes in. Server and database are named; no password is ever
 *    stored, so none can leak into a file that gets emailed around.
 */
import {
  groupChecks, summarize, verdict,
  type CheckRun, type CheckStatus, type CheckSuite, type SavedCheck,
} from './suite'

export interface ReportInput {
  /** ISO timestamp of when the report was produced. */
  generatedAt: string
  source: {
    server: string
    database?: string
    login: string
    collation?: string
    version?: string
  } | null
  model: {
    /** Friendly name of the open report, when it has one. */
    label?: string
    /** Latest partition refresh. An Import model is a snapshot, so this is what
     * explains a difference that is nobody's mistake. */
    refreshedAt?: string
  }
  suite: CheckSuite
  runs: CheckRun[]
}

// ── Escaping ────────────────────────────────────────────────────────────────

/** Query text and check names are typed by people and end up inside a document
 * that others will open, so every dynamic string is escaped. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * One CSV cell.
 *
 * Quoted when it holds a comma, quote or newline. A cell that STARTS with
 * = + - or @ is prefixed with an apostrophe: Excel treats it as a formula, and
 * a check name or query is not something that should execute when opened.
 */
export function csvCell(value: unknown): string {
  let s = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 })

/** A value as the report prints it. Fixed locale: a document should read the
 * same on every machine that opens it. */
export function fmtValue(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '(blank)'
  return typeof v === 'number' ? num(v) : v
}

function fmtDelta(d: number | null | undefined): string {
  if (d === null || d === undefined) return '—'
  return Math.abs(d) < 1e-6 ? '0' : num(d)
}

const STATUS_WORD: Record<CheckStatus, string> = {
  pass: 'Passed',
  fail: 'Failed',
  inconclusive: 'Could not run',
}

/** One line saying what was compared. Mirrors the on-screen wording. */
export function describeRun(run?: CheckRun): string {
  if (!run) return 'Not run'
  if (run.error) return run.error
  if (run.refusal) return run.refusal.message

  const values = run.evidence?.values
  if (values?.length) {
    return values
      .map((v) => {
        const label = v.label.replace(/^\[|\]$/g, '')
        const a = fmtValue(v.source)
        const b = fmtValue(v.target)
        return a === b ? `${label} ${a}` : `${label}: source ${a}, model ${b}`
      })
      .join(' · ')
  }

  const s = run.summary
  if (!s) return ''
  if (run.status === 'pass') return `${num(s.matched)} keys compared, all agree`
  const bits: string[] = []
  if (s.mismatched) bits.push(`${num(s.mismatched)} mismatched`)
  if (s.onlySource) bits.push(`${num(s.onlySource)} only in source`)
  if (s.onlyTarget) bits.push(`${num(s.onlyTarget)} only in model`)
  return bits.join(' · ')
}

/** Strip the table prefix the list view also strips, so rows are not the same
 * table name forty times. */
function shortName(name: string, table: string): string {
  const prefix = `${table} — `
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

const stamp = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

/** `reconciliation-<database>-2026-10-04-1830.html` — safe on every filesystem. */
export function reportFilename(ext: 'html' | 'csv', input: Pick<ReportInput, 'generatedAt' | 'source'>): string {
  const d = new Date(input.generatedAt)
  const day = Number.isNaN(d.getTime()) ? 'report' : d.toISOString().slice(0, 16).replace('T', '-').replace(':', '')
  const db = (input.source?.database ?? 'source').replace(/[^A-Za-z0-9_-]+/g, '_')
  return `reconciliation-${db}-${day}.${ext}`
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/**
 * One row per metric where the check quoted its numbers, otherwise one row per
 * check. Flat on purpose: this is the file somebody filters and pivots in Excel.
 */
export function buildCsv(input: ReportInput): string {
  const header = [
    'Table', 'Check', 'Status', 'Metric', 'Source value', 'Model value', 'Difference',
    'Detail', 'Source rows returned', 'Model rows returned', 'Duration ms', 'Ran at (UTC)',
  ]
  const lines = [header.map(csvCell).join(',')]

  for (const g of groupChecks(input.suite.checks)) {
    for (const c of g.checks) {
      const run = input.runs.find((r) => r.checkId === c.id)
      const status = run ? STATUS_WORD[run.status] : 'Not run'
      const name = shortName(c.name, g.table)
      const base = (metric: string, s: string, m: string, d: string) => [
        g.table, name, status, metric, s, m, d,
        describeRun(run),
        run?.evidence ? String(run.evidence.sourceRows) : '',
        run?.evidence ? String(run.evidence.targetRows) : '',
        run ? String(run.durationMs) : '',
        run ? stamp(run.ranAt) : '',
      ]

      const values = run?.evidence?.values
      if (values?.length) {
        for (const v of values) {
          lines.push(base(v.label.replace(/^\[|\]$/g, ''), fmtValue(v.source), fmtValue(v.target), fmtDelta(v.delta)).map(csvCell).join(','))
        }
      } else {
        lines.push(base('', '', '', '').map(csvCell).join(','))
      }
    }
  }
  return lines.join('\r\n') + '\r\n'
}

// ── HTML ────────────────────────────────────────────────────────────────────

const CSS = `
:root{--fg:#1d1c1a;--muted:#6a665f;--line:#dcd8d0;--bg:#fff;--soft:#f6f4ef;--ok:#17703f;--bad:#bb352c;--warn:#9a5f0e;--src:#0f766e;--tgt:#5b3fd6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.page{max-width:60rem;margin:0 auto;padding:2.2rem 1.4rem 4rem}
h1{font-size:1.7rem;margin:0 0 .2rem;letter-spacing:-.01em}
h2{font-size:1.05rem;margin:2.4rem 0 .7rem;padding-bottom:.35rem;border-bottom:1px solid var(--line)}
.sub{color:var(--muted);margin:0}
.verdict{margin-top:1.4rem;padding:1rem 1.2rem;border:1px solid var(--line);border-left-width:5px;border-radius:4px;background:var(--soft)}
.verdict strong{font-size:1.15rem;display:block}
.verdict.ok{border-left-color:var(--ok)}.verdict.bad{border-left-color:var(--bad)}.verdict.warn{border-left-color:var(--warn)}
.counts{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.7rem}
.pill{font-weight:600;font-size:.78rem;padding:.2rem .6rem;border-radius:99px;border:1px solid var(--line);background:#fff}
.pill.ok{color:var(--ok)}.pill.bad{color:var(--bad)}.pill.warn{color:var(--warn)}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:.3rem 1.4rem;margin:0}
dl.meta dt{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;padding-top:.1rem}
dl.meta dd{margin:0;min-width:0;overflow-wrap:anywhere}
.two{display:grid;grid-template-columns:1fr 1fr;gap:1.4rem}
@media(max-width:44rem){.two{grid-template-columns:1fr}}
.side{border:1px solid var(--line);border-radius:4px;padding:.9rem 1rem}
.side h3{margin:0 0 .6rem;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em}
.side.src h3{color:var(--src)}.side.src{border-top:3px solid var(--src)}
.side.tgt h3{color:var(--tgt)}.side.tgt{border-top:3px solid var(--tgt)}
table{border-collapse:collapse;width:100%;margin:.3rem 0 1rem;table-layout:fixed}
.group th:nth-child(1){width:30%}.group th:nth-child(2){width:11rem}.group th:nth-child(4){width:5.5rem}
td{overflow-wrap:anywhere}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
td.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.group{margin-top:1.4rem;break-inside:avoid}
.group h3{margin:0 0 .2rem;font-size:.98rem;display:flex;gap:.6rem;align-items:baseline}
.group h3 small{color:var(--muted);font-weight:400}
.st{font-weight:700;white-space:nowrap}.st.pass{color:var(--ok)}.st.fail{color:var(--bad)}.st.inconclusive{color:var(--warn)}.st.none{color:var(--muted)}
.attn{border:1px solid var(--line);border-radius:4px;padding:.8rem 1rem;margin:.6rem 0;background:#fff}
.attn b{display:block;margin-bottom:.15rem}
pre{margin:.3rem 0 0;padding:.7rem .85rem;background:var(--soft);border:1px solid var(--line);border-radius:3px;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,Menlo,Consolas,monospace}
.q h4{margin:1.1rem 0 .1rem;font-size:.9rem}
.q .label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.q .label.src{color:var(--src)}.q .label.tgt{color:var(--tgt)}
ul.notes{margin:.2rem 0;padding-left:1.1rem;color:#3a3732}
ul.notes li{margin:.35rem 0}
footer{margin-top:3rem;color:var(--muted);font-size:.78rem}
@media print{.page{padding:0}.group,.attn,pre{break-inside:avoid}h2{break-after:avoid}}
`

function metaRows(rows: [string, string | undefined][]): string {
  return `<dl class="meta">${rows
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('')}</dl>`
}

export function buildReportHtml(input: ReportInput): string {
  const { suite, runs, source, model } = input
  const counts = summarize(runs)
  const clear = runs.length > 0 && counts.failed === 0 && counts.inconclusive === 0
  const tone = runs.length === 0 ? 'warn' : clear ? 'ok' : counts.failed > 0 ? 'bad' : 'warn'
  // The pills beneath carry the counts, so the headline says what the counts
  // MEAN rather than repeating them. Only an unqualified pass reads as clear.
  const headline = runs.length === 0
    ? 'No checks have been run.'
    : clear
      ? verdict({ startedAt: '', finishedAt: '', runs, ...counts })
      : counts.failed > 0
        ? 'Differences found — the model and source do not fully agree.'
        : 'Some checks could not run — the result is incomplete.'
  const totalMs = runs.reduce((a, r) => a + r.durationMs, 0)
  const groups = groupChecks(suite.checks)
  const byId = new Map(runs.map((r) => [r.checkId, r]))

  // ── Results by table ──
  const resultBlocks = groups.map((g) => {
    const rs = g.checks.map((c) => byId.get(c.id))
    const bad = rs.filter((r) => r?.status === 'fail').length
    const unknown = rs.filter((r) => r?.status === 'inconclusive').length
    const ran = rs.filter(Boolean).length
    const state: CheckStatus | 'none' = bad > 0 ? 'fail' : unknown > 0 ? 'inconclusive' : ran > 0 ? 'pass' : 'none'
    const label = state === 'none' ? 'Not run' : state === 'pass' ? 'All passed' : [bad && `${bad} failed`, unknown && `${unknown} could not run`].filter(Boolean).join(', ')
    const rows = g.checks.map((c) => {
      const run = byId.get(c.id)
      const st = run?.status ?? 'none'
      return `<tr><td>${esc(shortName(c.name, g.table))}</td>` +
        `<td class="st ${st}">${esc(run ? STATUS_WORD[run.status] : 'Not run')}</td>` +
        `<td>${esc(describeRun(run))}</td>` +
        `<td class="r">${run ? `${num(run.durationMs)} ms` : ''}</td></tr>`
    }).join('')
    return `<section class="group"><h3>${esc(g.table)} <span class="st ${state}">${esc(label)}</span><small>${g.checks.length} check${g.checks.length === 1 ? '' : 's'}</small></h3>` +
      `<table><thead><tr><th>Check</th><th>Result</th><th>What was compared</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>`
  }).join('')

  // ── Needs attention ──
  const trouble = suite.checks
    .map((c) => ({ c, run: byId.get(c.id) }))
    .filter((x): x is { c: SavedCheck; run: CheckRun } => !!x.run && x.run.status !== 'pass')
  const attention = trouble.length === 0 ? '' :
    `<h2>Needs attention</h2>` + trouble.map(({ c, run }) =>
      `<div class="attn"><b>${esc(c.table ?? 'Other')} — ${esc(shortName(c.name, c.table ?? ''))} ` +
      `<span class="st ${run.status}">${esc(STATUS_WORD[run.status])}</span></b>${esc(describeRun(run))}</div>`).join('')

  // ── Appendix: the queries, verbatim ──
  const appendix = groups.map((g) => g.checks.map((c) => {
    const run = byId.get(c.id)
    return `<div class="q"><h4>${esc(g.table)} — ${esc(shortName(c.name, g.table))}</h4>` +
      `<span class="label src">Source · SQL Server</span><pre>${esc(c.sourceQuery)}</pre>` +
      `<span class="label tgt">Model · DAX</span><pre>${esc(c.targetQuery)}</pre>` +
      (run?.evidence ? `<div class="sub">Returned ${run.evidence.sourceRows} row(s) from the source and ${run.evidence.targetRows} from the model.</div>` : '') +
      `</div>`
  }).join('')).join('')

  const tol = suite.checks[0]?.tolerance
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Reconciliation report — ${esc(source?.database ?? 'source')}</title><style>${CSS}</style></head><body><div class="page">` +
    `<h1>Reconciliation report</h1>` +
    `<p class="sub">Power BI model against its SQL Server source · generated ${esc(stamp(input.generatedAt))}</p>` +
    `<div class="verdict ${tone}"><strong>${esc(headline)}</strong>` +
    (runs.length > 0 ? `<div class="counts">` +
      `<span class="pill ok">${counts.passed} passed</span>` +
      (counts.failed > 0 ? `<span class="pill bad">${counts.failed} failed</span>` : '') +
      (counts.inconclusive > 0 ? `<span class="pill warn">${counts.inconclusive} could not run</span>` : '') +
      `<span class="pill">${runs.length} checks · ${(totalMs / 1000).toFixed(1)} s</span></div>` : '') +
    `</div>` +

    `<h2>What was compared</h2><div class="two">` +
    `<div class="side src"><h3>Source · SQL Server</h3>${metaRows([
      ['Server', source?.server], ['Database', source?.database], ['Login', source?.login],
      ['Collation', source?.collation], ['Version', source?.version],
    ])}</div>` +
    `<div class="side tgt"><h3>Model · Power BI</h3>${metaRows([
      ['Report', model.label ?? 'Open Power BI Desktop model'],
      ['Last refreshed', model.refreshedAt ? stamp(model.refreshedAt) : undefined],
    ])}</div></div>` +

    attention +
    `<h2>Results by table</h2>${resultBlocks || '<p class="sub">The suite has no checks.</p>'}` +

    `<h2>How to read this</h2><ul class="notes">` +
    `<li>Each check ran one query on SQL Server and one on the Power BI model, then compared the answers. The queries are listed in full below, so any line can be reproduced in SSMS and DAX Studio.</li>` +
    `<li>The model is an Import snapshot taken at its last refresh; the source is live. A difference can mean the model is behind rather than wrong.</li>` +
    `<li>"Could not run" means the check was not evaluated (for example a timeout, or a comparison refused because it would have been misleading). It is not counted as passed.</li>` +
    (tol ? `<li>Numbers are treated as equal within ${tol.absolute} to absorb floating-point rounding between engines; whole counts differ by at least 1 and are not affected.</li>` : '') +
    `<li>Model tables are paired to SQL objects as shown in the queries. Confirm each points at the object you intended.</li>` +
    `</ul>` +

    `<h2>Appendix — queries</h2>${appendix || '<p class="sub">None.</p>'}` +
    `<footer>Produced by DAX Workbench. Source access is read-only; no credentials are stored in this file.</footer>` +
    `</div></body></html>`
}
