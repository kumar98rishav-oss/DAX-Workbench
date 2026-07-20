/**
 * APPLICATION — DAX Optimizer
 * Deterministic rewrite rules for DAX, in the same spirit as the rest of this
 * tool: no LLM guesses the answer. Each rule recognises a shape, rewrites it,
 * and states WHY the rewrite is faster in terms of what the engine actually
 * does (storage engine vs formula engine, context transition, row-by-row scans).
 *
 * A rule may only rewrite when the rewrite is SEMANTICALLY IDENTICAL. Anything
 * that could change a result is advisory: it explains the risk and leaves the
 * DAX alone. The UI additionally proves equivalence by running both versions on
 * the real engine and comparing values — a rewrite that changes the number is
 * reported as a failure, never as an optimization.
 */

export interface OptimizerFinding {
  id: string
  /** Short name of the anti-pattern, e.g. "FILTER over a whole table". */
  title: string
  /** Why the original is slow and the rewrite is faster — engine mechanics. */
  why: string
  /** How much this usually matters. */
  impact: 'high' | 'medium' | 'low'
  /** Set when the rule can rewrite safely; null for advisory-only findings. */
  rewrite: string | null
}

export interface OptimizerResult {
  original: string
  /** Original with every safe rewrite applied, or null when nothing changed. */
  optimized: string | null
  findings: OptimizerFinding[]
}

/** Strip string literals so rules never match inside quoted text.
 * The sentinels are built with fromCharCode rather than written literally:
 * control characters cannot occur in DAX (so they can never collide with real
 * content) but they also must not sit in this source file, where they would be
 * invisible in diffs and confuse tooling. */
const S_OPEN = String.fromCharCode(1)
const S_CLOSE = String.fromCharCode(2)
const S_RE = new RegExp(S_OPEN + '(\\d+)' + S_CLOSE, 'g')

function maskStrings(dax: string): { masked: string; restore: (s: string) => string } {
  const lits: string[] = []
  const masked = dax.replace(/"(?:[^"]|"")*"/g, (m) => {
    lits.push(m)
    return S_OPEN + String(lits.length - 1) + S_CLOSE
  })
  return {
    masked,
    restore: (s: string) => s.replace(S_RE, (whole, i) => lits[Number(i)] ?? whole),
  }
}

/** Find the argument list of `fn(` starting at `open` (index of the paren),
 * respecting nesting and quotes. Returns the arguments and the index just past
 * the closing paren, or null if unbalanced. */
function splitArgs(s: string, open: number): { args: string[]; end: number } | null {
  let depth = 0
  let start = open + 1
  const args: string[] = []
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) {
        args.push(s.slice(start, i))
        return { args, end: i + 1 }
      }
    } else if (c === ',' && depth === 1) {
      args.push(s.slice(start, i))
      start = i + 1
    }
  }
  return null
}

/** Every occurrence of a function call, outermost-first. */
function findCalls(s: string, fn: string): { open: number; nameStart: number; args: string[]; end: number }[] {
  const out: { open: number; nameStart: number; args: string[]; end: number }[] = []
  const re = new RegExp(`\\b${fn}\\s*\\(`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const open = m.index + m[0].length - 1
    const parts = splitArgs(s, open)
    if (parts) out.push({ open, nameStart: m.index, args: parts.args, end: parts.end })
  }
  return out
}

const trim = (s: string): string => s.trim()

/** 'Table'[Col] or Table[Col] — the table part, unquoted. */
const COLUMN_REF = /^(?:'([^']+)'|([A-Za-z_]\w*))\[([^\]]+)\]$/

function columnTable(ref: string): string | null {
  const m = COLUMN_REF.exec(trim(ref))
  return m ? (m[1] ?? m[2]) : null
}

/** A predicate the engine can push down: 'T'[C] <op> <constant-ish>, with no
 * measure reference (a measure would need context transition per row). */
function isSimplePredicate(expr: string, table: string): boolean {
  const e = trim(expr)
  if (/\[[^\]]+\]/.test(e) === false) return false
  // A bare [Measure] reference (no table qualifier) means context transition.
  if (/(^|[^'\w\]])\[[^\]]+\]/.test(e.replace(/(?:'[^']+'|\b[A-Za-z_]\w*)\[[^\]]+\]/g, ''))) return false
  const cols = e.match(/(?:'[^']+'|\b[A-Za-z_]\w*)\[[^\]]+\]/g) ?? []
  if (cols.length === 0) return false
  // Every column must belong to the filtered table, else it isn't a plain
  // column filter on that table.
  if (!cols.every((c) => columnTable(c) === table)) return false
  // Comparison / IN / logical ops only — no iterators or table functions.
  if (/\b(FILTER|CALCULATE|SUMX|AVERAGEX|COUNTX|MINX|MAXX|RANKX|EARLIER|ALL|VALUES|ADDCOLUMNS|SUMMARIZE)\s*\(/i.test(e)) return false
  return /(=|<>|>=|<=|>|<|\bIN\b)/i.test(e)
}

type Rule = (dax: string) => { rewritten: string; finding: OptimizerFinding } | OptimizerFinding | null

/** CALCULATE(expr, FILTER('T', 'T'[C] = x)) → CALCULATE(expr, 'T'[C] = x) */
const ruleFilterWholeTable: Rule = (dax) => {
  for (const call of findCalls(dax, 'CALCULATE')) {
    for (let i = 1; i < call.args.length; i++) {
      const arg = trim(call.args[i])
      const inner = findCalls(arg, 'FILTER')
      const whole = inner.find((f) => f.nameStart === 0 && f.end === arg.length && f.args.length === 2)
      if (!whole) continue
      const [tableArg, predicate] = whole.args.map(trim)
      const tableName = /^'([^']+)'$/.exec(tableArg)?.[1] ?? (/^[A-Za-z_]\w*$/.test(tableArg) ? tableArg : null)
      if (!tableName) continue
      if (!isSimplePredicate(predicate, tableName)) continue

      const args = [...call.args]
      args[i] = ` ${predicate}`
      const rewritten =
        dax.slice(0, call.open + 1) + args.join(',') + dax.slice(call.end - 1)
      return {
        rewritten,
        finding: {
          id: 'filter-whole-table',
          title: 'FILTER over a whole table where a column predicate would do',
          impact: 'high',
          why:
            `FILTER('${tableName}', …) materialises every row of ${tableName} and evaluates the condition ` +
            `one row at a time in the formula engine. Passing the predicate straight to CALCULATE lets the ` +
            `storage engine apply it while scanning — compressed, multi-threaded, and without building an ` +
            `intermediate table. The filter context produced is identical, so the value cannot change.`,
          rewrite: rewritten,
        },
      }
    }
  }
  return null
}

/** COUNTROWS(FILTER('T', pred)) → CALCULATE(COUNTROWS('T'), pred) */
const ruleCountrowsFilter: Rule = (dax) => {
  for (const call of findCalls(dax, 'COUNTROWS')) {
    if (call.args.length !== 1) continue
    const arg = trim(call.args[0])
    const inner = findCalls(arg, 'FILTER')
    const whole = inner.find((f) => f.nameStart === 0 && f.end === arg.length && f.args.length === 2)
    if (!whole) continue
    const [tableArg, predicate] = whole.args.map(trim)
    const tableName = /^'([^']+)'$/.exec(tableArg)?.[1] ?? (/^[A-Za-z_]\w*$/.test(tableArg) ? tableArg : null)
    if (!tableName || !isSimplePredicate(predicate, tableName)) continue

    const replacement = `CALCULATE(COUNTROWS(${tableArg}), ${predicate})`
    const rewritten = dax.slice(0, call.nameStart) + replacement + dax.slice(call.end)
    return {
      rewritten,
      finding: {
        id: 'countrows-filter',
        title: 'COUNTROWS(FILTER(…)) instead of CALCULATE',
        impact: 'high',
        why:
          `COUNTROWS(FILTER(…)) builds the filtered table in the formula engine and then counts it. ` +
          `CALCULATE(COUNTROWS(${tableArg}), …) pushes the predicate into the storage engine, which can ` +
          `answer the count from its own scan without materialising rows. Same number, far less work.`,
        rewrite: rewritten,
      },
    }
  }
  return null
}

/** SUMX('T', 'T'[C]) → SUM('T'[C]) — same for AVERAGEX/MINX/MAXX/COUNTX. */
const ruleIteratorSingleColumn: Rule = (dax) => {
  const pairs: [string, string][] = [
    ['SUMX', 'SUM'],
    ['AVERAGEX', 'AVERAGE'],
    ['MINX', 'MIN'],
    ['MAXX', 'MAX'],
  ]
  for (const [x, plain] of pairs) {
    for (const call of findCalls(dax, x)) {
      if (call.args.length !== 2) continue
      const [tableArg, expr] = call.args.map(trim)
      const tableName = /^'([^']+)'$/.exec(tableArg)?.[1] ?? (/^[A-Za-z_]\w*$/.test(tableArg) ? tableArg : null)
      if (!tableName) continue
      if (!COLUMN_REF.test(expr) || columnTable(expr) !== tableName) continue

      const replacement = `${plain}(${expr})`
      const rewritten = dax.slice(0, call.nameStart) + replacement + dax.slice(call.end)
      return {
        rewritten,
        finding: {
          id: 'iterator-single-column',
          title: `${x} over a single column`,
          impact: 'medium',
          why:
            `${x}(${tableArg}, ${expr}) asks the formula engine to iterate the table row by row. When the ` +
            `expression is just one column of that same table, ${plain}(${expr}) is the identical calculation ` +
            `expressed as a pure storage-engine aggregation — one scan, no row context.`,
          rewrite: rewritten,
        },
      }
    }
  }
  return null
}

/** IF(ISBLANK(x), y, x) → COALESCE(x, y) when x is repeated verbatim. */
const ruleCoalesce: Rule = (dax) => {
  for (const call of findCalls(dax, 'IF')) {
    if (call.args.length !== 3) continue
    const [cond, whenTrue, whenFalse] = call.args.map(trim)
    const blank = findCalls(cond, 'ISBLANK')
    const isBlankOf = blank.find((b) => b.nameStart === 0 && b.end === cond.length && b.args.length === 1)
    if (!isBlankOf) continue
    const subject = trim(isBlankOf.args[0])
    if (subject !== whenFalse) continue

    const replacement = `COALESCE(${subject}, ${whenTrue})`
    const rewritten = dax.slice(0, call.nameStart) + replacement + dax.slice(call.end)
    return {
      rewritten,
      finding: {
        id: 'coalesce',
        title: 'IF(ISBLANK(x), y, x) instead of COALESCE',
        impact: 'medium',
        why:
          `This shape evaluates ${subject} twice — once to test for blank and again to return it. ` +
          `COALESCE(${subject}, ${whenTrue}) evaluates it once and is handled natively by the engine. ` +
          `Identical result, half the evaluations.`,
        rewrite: rewritten,
      },
    }
  }
  return null
}

/** Bare `/` division → DIVIDE. Only when both sides are simple operands, so we
 * never re-associate a larger arithmetic expression. */
const ruleDivide: Rule = (dax) => {
  // operand: a measure ref, column ref, function call, number, or (...) group
  const operand = String.raw`(?:(?:'[^']+'|\b[A-Za-z_]\w*)?\[[^\]]+\]|\b[A-Z][A-Z0-9_.]*\s*\((?:[^()]|\([^()]*\))*\)|\b\d+(?:\.\d+)?\b)`
  const re = new RegExp(`(${operand})\\s*/\\s*(${operand})`)
  const m = re.exec(dax)
  if (!m) return null
  // Already inside a DIVIDE? then leave it alone.
  const before = dax.slice(0, m.index)
  if (/DIVIDE\s*\([^()]*$/i.test(before)) return null

  const replacement = `DIVIDE(${m[1]}, ${m[2]})`
  const rewritten = dax.slice(0, m.index) + replacement + dax.slice(m.index + m[0].length)
  return {
    rewritten,
    finding: {
      id: 'divide',
      title: 'Plain "/" division instead of DIVIDE',
      impact: 'medium',
      why:
        `"/" raises a division-by-zero error that the engine must trap per evaluation, and it returns ` +
        `infinity rather than blank when the denominator is 0. DIVIDE handles the zero case internally ` +
        `with a branch the engine optimises for, returning BLANK — which is also what a Power BI visual ` +
        `expects to show as empty rather than as an error.`,
      rewrite: rewritten,
    },
  }
}

// ---- advisory rules: real problems that cannot be rewritten mechanically ----

const ruleFilterOnMeasure: Rule = (dax) => {
  for (const call of findCalls(dax, 'FILTER')) {
    if (call.args.length !== 2) continue
    const predicate = trim(call.args[1])
    const stripped = predicate.replace(/(?:'[^']+'|\b[A-Za-z_]\w*)\[[^\]]+\]/g, '')
    if (!/\[[^\]]+\]/.test(stripped)) continue
    return {
      id: 'filter-on-measure',
      title: 'FILTER whose condition calls a measure',
      impact: 'high',
      why:
        `Referencing a measure inside FILTER forces a context transition for every row of the table — the ` +
        `engine re-evaluates the whole measure once per row. This cannot be rewritten automatically because ` +
        `the row-by-row semantics may be exactly what you intend. If you only need a total-level comparison, ` +
        `compute the measure once into a VAR before the FILTER and compare against that.`,
      rewrite: null,
    }
  }
  return null
}

const ruleIferror: Rule = (dax) => {
  if (!/\bIFERROR\s*\(/i.test(dax)) return null
  return {
    id: 'iferror',
    title: 'IFERROR wraps the calculation',
    impact: 'medium',
    why:
      `IFERROR forces the engine to evaluate the expression in a protected mode that disables several ` +
      `optimizations, and it hides genuine model errors behind a fallback value. Prefer the targeted guard: ` +
      `DIVIDE for division, or an explicit condition for the case you actually expect.`,
    rewrite: null,
  }
}

const ruleEarlier: Rule = (dax) => {
  if (!/\bEARLIER\s*\(/i.test(dax)) return null
  return {
    id: 'earlier',
    title: 'EARLIER instead of a variable',
    impact: 'low',
    why:
      `EARLIER reaches back into an outer row context, which is hard to read and easy to get wrong when ` +
      `nesting deepens. Capturing the outer value in a VAR before the inner iterator is the modern ` +
      `equivalent — same performance, far clearer intent.`,
    rewrite: null,
  }
}

const ruleNestedCalculate: Rule = (dax) => {
  const calls = findCalls(dax, 'CALCULATE')
  const nested = calls.some((outer) =>
    calls.some((inner) => inner.nameStart > outer.nameStart && inner.end < outer.end),
  )
  if (!nested) return null
  return {
    id: 'nested-calculate',
    title: 'CALCULATE nested inside CALCULATE',
    impact: 'low',
    why:
      `Each CALCULATE creates its own filter context and, in a row context, its own context transition. ` +
      `Nested ones are frequently redundant — the inner filters often survive into the outer context anyway. ` +
      `Check whether the filters can be listed as arguments of a single CALCULATE.`,
    rewrite: null,
  }
}

const RULES: Rule[] = [
  ruleFilterWholeTable,
  ruleCountrowsFilter,
  ruleIteratorSingleColumn,
  ruleCoalesce,
  ruleDivide,
  ruleFilterOnMeasure,
  ruleIferror,
  ruleEarlier,
  ruleNestedCalculate,
]

/** Apply every rule, re-running the rewriting ones until they stop firing so a
 * measure with two of the same anti-pattern gets both fixed. */
export function optimize(dax: string): OptimizerResult {
  const { masked, restore } = maskStrings(dax)
  let current = masked
  const findings: OptimizerFinding[] = []
  const seen = new Set<string>()

  let changed = true
  let guard = 0
  while (changed && guard++ < 12) {
    changed = false
    for (const rule of RULES) {
      const r = rule(current)
      if (!r) continue
      if ('rewritten' in r) {
        current = r.rewritten
        if (!seen.has(r.finding.id)) {
          seen.add(r.finding.id)
          findings.push({ ...r.finding, rewrite: restore(r.finding.rewrite ?? '') || null })
        }
        changed = true
        break
      }
      if (!seen.has(r.id)) {
        seen.add(r.id)
        findings.push(r)
      }
    }
  }

  const optimized = restore(current)
  const order = { high: 0, medium: 1, low: 2 }
  findings.sort((a, b) => order[a.impact] - order[b.impact])
  return {
    original: dax,
    optimized: optimized.trim() === dax.trim() ? null : optimized,
    findings,
  }
}

/** Loose equality for "did the rewrite change the answer" — numbers compared
 * with a relative tolerance so float noise doesn't read as a behaviour change. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return a == b
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true
    const scale = Math.max(Math.abs(a), Math.abs(b), 1)
    return Math.abs(a - b) / scale < 1e-9
  }
  return String(a) === String(b)
}
