/**
 * Report tests.
 *
 * The report is a file that leaves the app and gets opened by other people, so
 * the risks are different from the screen's: injection through user-typed text,
 * and a summary that flatters the run. Both are pinned here.
 */
import { describe, it, expect } from 'vitest'
import {
  buildCsv, buildReportHtml, csvCell, describeRun, esc, fmtValue, reportFilename,
  type ReportInput,
} from './report'
import type { CheckRun, SavedCheck } from './suite'

const check = (id: string, name: string, table = 'Fact_Sales', over: Partial<SavedCheck> = {}): SavedCheck => ({
  id, name, table, sourceQuery: 'SELECT 1', targetQuery: 'EVALUATE ROW("n",1)',
  keys: [], values: [], tolerance: { absolute: 1e-6, relative: 0 }, enabled: true, ...over,
})

const run = (checkId: string, status: CheckRun['status'], over: Partial<CheckRun> = {}): CheckRun => ({
  checkId, name: checkId, status, durationMs: 12, ranAt: '2026-10-04T18:30:00.000Z', ...over,
})

const input = (checks: SavedCheck[], runs: CheckRun[]): ReportInput => ({
  generatedAt: '2026-10-04T18:45:00.000Z',
  source: { server: 'R1SH4V\\SQLEXPRESS', database: 'SCM_Dashboard', login: 'R1SH4V\\risha', collation: 'SQL_Latin1_General_CP1_CI_AS' },
  model: { refreshedAt: '2026-10-04T10:00:00.000Z' },
  suite: { id: 's', name: 'Checks', checks },
  runs,
})

describe('esc', () => {
  it('neutralises markup', () => {
    expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
  it('escapes quotes and ampersands', () => {
    expect(esc(`a & "b" 'c'`)).toBe('a &amp; &quot;b&quot; &#39;c&#39;')
  })
  it('turns null and undefined into nothing', () => {
    expect(esc(null)).toBe('')
    expect(esc(undefined)).toBe('')
  })
})

describe('csvCell', () => {
  it('quotes a cell containing a comma, quote or newline', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"')
  })
  it('leaves a plain cell alone', () => {
    expect(csvCell('Fact_Sales')).toBe('Fact_Sales')
  })
  it('defuses a cell Excel would run as a formula', () => {
    // A check name or a query is typed by a person; opening the CSV must not
    // execute it.
    for (const evil of ['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(1)']) {
      expect(csvCell(evil).replace(/^"/, '')).toMatch(/^'/)
    }
  })
})

describe('describeRun', () => {
  it('quotes the numbers a scalar check compared', () => {
    const r = run('a', 'pass', {
      evidence: { comparedRows: 1, sourceRows: 1, targetRows: 1,
        values: [{ label: '[RowCount]', source: 19658, target: 19658, delta: 0, status: 'match' }] },
    })
    expect(describeRun(r)).toBe('RowCount 19,658')
  })
  it('shows both sides when they disagree', () => {
    const r = run('a', 'fail', {
      evidence: { comparedRows: 1, sourceRows: 1, targetRows: 1,
        values: [{ label: '[RowCount]', source: 60, target: 61, delta: 1, status: 'mismatch' }] },
    })
    expect(describeRun(r)).toBe('RowCount: source 60, model 61')
  })
  it('explains a check that could not run', () => {
    expect(describeRun(run('a', 'inconclusive', { error: 'Timed out twice' }))).toBe('Timed out twice')
  })
  it('says so plainly for a check that never ran', () => {
    expect(describeRun(undefined)).toBe('Not run')
  })
  it('prints a blank as (blank), not as zero', () => {
    expect(fmtValue(null)).toBe('(blank)')
  })
})

describe('buildReportHtml', () => {
  const ok = input([check('c1', 'Fact_Sales — row count')], [run('c1', 'pass')])

  it('is a complete, self-contained document', () => {
    const html = buildReportHtml(ok)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<style>')
    // Nothing fetched from anywhere: it has to open on a machine with no network.
    expect(html).not.toMatch(/<link[^>]+href=|<script[^>]+src=/)
  })

  it('states the source, the model refresh time and the date', () => {
    const html = buildReportHtml(ok)
    expect(html).toContain('SCM_Dashboard')
    expect(html).toContain('SQL_Latin1_General_CP1_CI_AS')
    expect(html).toContain('2026-10-04 10:00:00 UTC')
  })

  it('says "All clear" only when every check ran and agreed', () => {
    expect(buildReportHtml(ok)).toMatch(/All clear/)
  })

  it('does NOT say all clear when a check could not run', () => {
    // The report is read by people who were not there. A summary that flatters
    // the run is the one thing it must never do.
    const html = buildReportHtml(input(
      [check('c1', 'a'), check('c2', 'b')],
      [run('c1', 'pass'), run('c2', 'inconclusive', { error: 'Timed out' })],
    ))
    expect(html).not.toMatch(/All clear/)
    expect(html).toContain('1 could not run')
  })

  it('headlines a failure as a difference, and an unrun check as incomplete', () => {
    // The pills carry the counts; the headline says what they mean.
    const failed = buildReportHtml(input([check('c1', 'a')], [run('c1', 'fail')]))
    expect(failed).toContain('Differences found')
    const unrun = buildReportHtml(input([check('c1', 'a')], [run('c1', 'inconclusive')]))
    expect(unrun).toContain('result is incomplete')
    expect(unrun).not.toContain('Differences found')
  })

  it('a failure outranks a could-not-run in the headline', () => {
    const html = buildReportHtml(input(
      [check('c1', 'a'), check('c2', 'b')],
      [run('c1', 'fail'), run('c2', 'inconclusive')],
    ))
    expect(html).toContain('Differences found')
    expect(html).toContain('1 failed')
    expect(html).toContain('1 could not run')
  })

  it('lists failures under Needs attention', () => {
    const html = buildReportHtml(input(
      [check('c1', 'Fact_Sales — row count')],
      [run('c1', 'fail', { summary: { matched: 0, mismatched: 1, onlySource: 0, onlyTarget: 0, sourceKeys: 1, targetKeys: 1, sourceDuplicateKeys: 0, targetDuplicateKeys: 0, driftMs: 0 } })],
    ))
    expect(html).toContain('Needs attention')
  })

  it('omits Needs attention when everything passed', () => {
    expect(buildReportHtml(ok)).not.toContain('Needs attention')
  })

  it('carries both queries verbatim', () => {
    const c = check('c1', 'x', 'T', { sourceQuery: 'SELECT COUNT(*) FROM [dbo].[T];', targetQuery: `EVALUATE ROW("n", COUNTROWS('T'))` })
    const html = buildReportHtml(input([c], [run('c1', 'pass')]))
    expect(html).toContain('SELECT COUNT(*) FROM [dbo].[T];')
    // Quotes are entity-escaped, which a browser renders back as the original.
    expect(html).toContain('COUNTROWS(&#39;T&#39;)')
  })

  it('cannot be injected through a check name or a query', () => {
    const c = check('c1', '<img src=x onerror=alert(1)>', 'T', { sourceQuery: '</pre><script>alert(2)</script>' })
    const html = buildReportHtml(input([c], [run('c1', 'pass')]))
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;img src=x')
  })

  it('never contains a password, even if one leaks into the input shape', () => {
    const withSecret = { ...ok, source: { ...ok.source!, password: 'hunter2' } } as unknown as ReportInput
    expect(buildReportHtml(withSecret)).not.toContain('hunter2')
  })

  it('shows a not-run check as not run, not as passed', () => {
    const html = buildReportHtml(input([check('c1', 'a'), check('c2', 'b')], [run('c1', 'pass')]))
    expect(html).toContain('Not run')
  })

  it('handles an empty run without claiming anything', () => {
    const html = buildReportHtml(input([check('c1', 'a')], []))
    expect(html).toContain('No checks have been run')
    expect(html).not.toMatch(/All clear/)
  })
})

describe('buildCsv', () => {
  it('has one row per metric when the numbers were captured', () => {
    const r = run('c1', 'pass', {
      evidence: { comparedRows: 1, sourceRows: 1, targetRows: 1, values: [
        { label: '[First]', source: '2023-01-01', target: '2023-01-01', delta: null, status: 'match' },
        { label: '[Days]', source: 731, target: 731, delta: 0, status: 'match' },
      ] },
    })
    const lines = buildCsv(input([check('c1', 'Fact_Sales — OrderDate range')], [r])).trim().split('\r\n')
    expect(lines).toHaveLength(3) // header + 2 metrics
    expect(lines[1]).toContain('First')
    expect(lines[2]).toContain('Days')
  })

  it('has one row for a check that quoted no numbers', () => {
    const lines = buildCsv(input([check('c1', 'a')], [run('c1', 'pass')])).trim().split('\r\n')
    expect(lines).toHaveLength(2)
  })

  it('records the status word, so "could not run" survives into Excel', () => {
    const csv = buildCsv(input([check('c1', 'a')], [run('c1', 'inconclusive', { error: 'boom' })]))
    expect(csv).toContain('Could not run')
    expect(csv).not.toMatch(/,Passed,/)
  })

  it('defuses a formula in a check name', () => {
    const csv = buildCsv(input([check('c1', '=1+1')], [run('c1', 'pass')]))
    expect(csv).not.toMatch(/,=1\+1,/)
    expect(csv).toContain(`'=1+1`)
  })
})

describe('reportFilename', () => {
  it('names the database and the time, and is filesystem-safe', () => {
    const name = reportFilename('html', { generatedAt: '2026-10-04T18:45:00.000Z', source: { server: 's', database: 'SCM Dash/board', login: 'l' } })
    expect(name).toBe('reconciliation-SCM_Dash_board-2026-10-04-1845.html')
    expect(name).not.toMatch(/[\\/:*?"<>|\s]/)
  })
  it('copes with no source', () => {
    expect(reportFilename('csv', { generatedAt: '2026-10-04T18:45:00.000Z', source: null })).toBe('reconciliation-source-2026-10-04-1845.csv')
  })
})
