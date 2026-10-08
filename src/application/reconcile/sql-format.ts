/**
 * APPLICATION — SQL formatter
 *
 * Indents a hand-written reconciliation query so it can be read, reviewed and
 * pasted into a report as evidence. A query that has to be defended in front of
 * a client should not look like it was typed into a chat box.
 *
 * THE SAFETY RULE, which shapes the whole implementation: formatting must never
 * change what the query MEANS. A formatter that silently alters a `WHERE`
 * clause is far worse than no formatter at all — it would quietly invalidate
 * the one thing this tool exists to establish.
 *
 * So everything that could carry meaning is MASKED before a single character is
 * moved: string literals, bracketed and quoted identifiers, and comments are
 * replaced by sentinels, re-inserted verbatim at the end, and never inspected
 * in between. `'home & kitchen'` cannot be case-folded, `-- DROP` cannot become
 * code, and `[Group By]` cannot be mistaken for a clause.
 *
 * That property is tested directly rather than assumed: the test suite asserts
 * that the masked token stream is IDENTICAL before and after formatting, for
 * every case. Whitespace may move; nothing else may.
 */

const INDENT = '    '

/** Clauses that begin a new line at the top level. Order matters: the
 * two-word forms must be tried before their first words. */
const CLAUSES = [
  'INNER JOIN', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
  'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'OUTER APPLY', 'CROSS APPLY',
  'GROUP BY', 'ORDER BY', 'UNION ALL', 'PARTITION BY',
  'SELECT', 'FROM', 'WHERE', 'HAVING', 'JOIN', 'UNION', 'EXCEPT', 'INTERSECT',
  'ON', 'WITH',
] as const

/** Words uppercased for readability. Purely cosmetic — a masked identifier can
 * never reach this list, so a column genuinely named "order" is safe. */
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'JOIN', 'INNER',
  'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'APPLY', 'ON', 'AS', 'AND', 'OR',
  'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'DISTINCT', 'TOP', 'UNION', 'ALL', 'EXCEPT',
  'INTERSECT', 'WITH', 'OVER', 'PARTITION', 'ASC', 'DESC', 'CAST', 'CONVERT',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'ISNULL',
  'YEAR', 'MONTH', 'DAY', 'DATEPART', 'DATEADD', 'DATEDIFF', 'GETDATE',
  'LEFT_', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'DESC_',
])

interface Masked {
  text: string
  literals: string[]
}

/**
 * Replace every span whose contents must survive untouched with a sentinel.
 *
 * The sentinel is \u0001<n>\u0002 — control characters, so it cannot collide
 * with anything a person would type, and digits only, so the keyword pass
 * cannot match inside it.
 */
function mask(sql: string): Masked {
  const literals: string[] = []
  let out = ''
  let i = 0

  const take = (end: number) => {
    literals.push(sql.slice(i, end))
    out += `\u0001${literals.length - 1}\u0002`
    i = end
  }

  while (i < sql.length) {
    const c = sql[i]

    // '...' with '' as the escape, which is why this scans rather than regexes.
    if (c === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") { j++; break }
        j++
      }
      take(j)
      continue
    }

    if (c === '[') {
      const j = sql.indexOf(']', i)
      take(j < 0 ? sql.length : j + 1)
      continue
    }

    if (c === '"') {
      const j = sql.indexOf('"', i + 1)
      take(j < 0 ? sql.length : j + 1)
      continue
    }

    if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i)
      take(j < 0 ? sql.length : j)
      continue
    }

    if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2)
      take(j < 0 ? sql.length : j + 2)
      continue
    }

    out += c
    i++
  }

  return { text: out, literals }
}

const unmask = (text: string, literals: string[]) =>
  text.replace(/\u0001(\d+)\u0002/g, (_, n) => literals[Number(n)] ?? '')

/** Split into atoms — words, sentinels, operators, punctuation — so line
 * decisions are made on whole tokens and never mid-identifier. */
function atomize(text: string): string[] {
  return text.match(/\u0001\d+\u0002|[A-Za-z_][A-Za-z0-9_@$#]*|\d+\.?\d*|<>|<=|>=|!=|\|\||[(),;.*+\-/%=<>&~^]|\S/g) ?? []
}

/** Does the atom run starting at `i` spell `phrase`? */
function matchPhrase(atoms: string[], i: number, phrase: string): number {
  const want = phrase.split(' ')
  for (let k = 0; k < want.length; k++) {
    if ((atoms[i + k] ?? '').toUpperCase() !== want[k]) return 0
  }
  return want.length
}

export function formatSql(sql: string): string {
  if (!sql.trim()) return sql

  const { text, literals } = mask(sql)
  const atoms = atomize(text)
  if (atoms.length === 0) return sql

  const lines: string[] = []
  let line = ''
  let depth = 0          // parenthesis nesting
  let indent = 0         // current logical indent
  let caseDepth = 0      // CASE blocks open at this paren depth
  let inSelectList = false
  let listIndent = 0

  const flush = () => {
    if (line.trim()) lines.push(INDENT.repeat(Math.max(0, indent)) + line.trim())
    line = ''
  }

  /** Words that take a space before an opening paren, because they are
   * operators or clauses rather than function names: `a IN (1,2)` reads wrong
   * as `a IN(1,2)`, while `SUM (x)` reads wrong as a function call. */
  const SPACED_PAREN = new Set([
    'IN', 'AND', 'OR', 'NOT', 'ON', 'BY', 'VALUES', 'THEN', 'ELSE', 'WHEN',
    'BETWEEN', 'LIKE', 'EXISTS', 'ALL', 'ANY', 'SOME', 'UNION', 'SELECT',
    'WHERE', 'HAVING', 'AS', 'FROM', 'JOIN', 'CASE', 'END', 'OVER',
  ])

  /** After these, a + or - is a SIGN on the next number, not an operator
   * between two operands — so it binds tight: `THEN -50000`, not `THEN - 50000`. */
  const UNARY_AFTER = new Set([
    '(', ',', '=', '<', '>', '<=', '>=', '<>', '!=', '+', '-', '*', '/', '%',
    'THEN', 'ELSE', 'WHEN', 'AND', 'OR', 'NOT', 'BY', 'RETURN', 'CASE', 'SELECT',
  ])

  let prev = ''
  let tightNext = false

  /** Append with a space unless the join would read wrong. */
  const push = (atom: string) => {
    const noSpaceBefore =
      tightNext ||
      /^[),.;]$/.test(atom) ||
      // A function call: the name and its paren are one thing.
      (atom === '(' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(prev) && !SPACED_PAREN.has(prev.toUpperCase()))
    const noSpaceAfter = /[(.]$/.test(line.trimEnd())
    if (line === '' || noSpaceBefore || noSpaceAfter) line += atom
    else line += ' ' + atom
    tightNext = (atom === '+' || atom === '-') && (prev === '' || UNARY_AFTER.has(prev.toUpperCase()))
    prev = atom
  }

  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i]
    const up = a.toUpperCase()

    // ── CASE blocks ───────────────────────────────────────────────────────
    if (up === 'CASE') {
      flush()
      push('CASE')
      flush()
      caseDepth++
      indent++
      continue
    }
    if (up === 'WHEN' && caseDepth > 0) { flush(); push('WHEN'); continue }
    if (up === 'ELSE' && caseDepth > 0) { flush(); push('ELSE'); continue }
    if (up === 'END' && caseDepth > 0) {
      flush()
      caseDepth--
      indent--
      push('END')
      continue
    }

    // ── Top-level clauses ─────────────────────────────────────────────────
    if (depth === 0 && caseDepth === 0) {
      let hit = ''
      let span = 0
      for (const clause of CLAUSES) {
        const n = matchPhrase(atoms, i, clause)
        if (n > 0) { hit = clause; span = n; break }
      }

      if (hit) {
        flush()
        // ON belongs to the JOIN above it, so it sits one level in; every other
        // clause is a top-level statement of its own.
        indent = hit === 'ON' ? 1 : 0
        line = hit
        i += span - 1
        inSelectList = hit === 'SELECT' || hit === 'GROUP BY' || hit === 'ORDER BY'
        listIndent = 1
        if (inSelectList) { flush(); indent = listIndent }
        continue
      }

      // AND / OR start their own line inside WHERE and ON.
      if ((up === 'AND' || up === 'OR') && !inSelectList) {
        flush()
        push(up)
        continue
      }
    }

    // ── List separators ───────────────────────────────────────────────────
    if (a === ',' && depth === 0 && caseDepth === 0 && inSelectList) {
      push(',')
      flush()
      continue
    }

    if (a === '(') { depth++; push('('); continue }
    if (a === ')') { depth = Math.max(0, depth - 1); push(')'); continue }
    if (a === ';') { push(';'); flush(); continue }

    push(KEYWORDS.has(up) && /^[A-Za-z_]/.test(a) ? up : a)
  }
  flush()

  return unmask(lines.join('\n'), literals).replace(/[ \t]+$/gm, '')
}
