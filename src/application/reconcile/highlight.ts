/**
 * APPLICATION — Syntax highlighting for the two query panes
 *
 * A tokenizer, not a parser. It needs to colour a half-written query while
 * someone is typing it, so it must never fail and never reorder: whatever it
 * cannot classify comes back as plain text.
 *
 * TWO INVARIANTS, both tested directly:
 *
 *   1. LOSSLESS. Joining every token's text reproduces the input exactly,
 *      character for character. The highlight layer sits behind a transparent
 *      textarea and the two must align to the pixel, so a tokenizer that
 *      swallowed a space would visibly tear the caret away from the text.
 *
 *   2. ESCAPED. Everything reaching the DOM is HTML-escaped first. The input is
 *      user-typed and ends up in innerHTML, so `<img onerror=…>` in a WHERE
 *      clause is a script injection unless this is airtight.
 *
 * SQL and DAX disagree about quoting in a way that matters for colour:
 *
 *            SQL                        DAX
 *   '...'    string literal             TABLE NAME
 *   "..."    quoted identifier          string literal
 *   [...]    identifier                 column / measure
 *
 * Colouring 'Fact_Sales' as a string in DAX would be wrong and misleading, so
 * the two have separate literal rules rather than one shared guess.
 */

export type TokenKind =
  | 'keyword'
  | 'function'
  | 'string'
  | 'number'
  | 'comment'
  | 'identifier'
  | 'operator'
  | 'plain'

export interface Token {
  kind: TokenKind
  text: string
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'JOIN', 'INNER',
  'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'APPLY', 'ON', 'AS', 'AND', 'OR',
  'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'DISTINCT', 'TOP', 'UNION', 'ALL', 'EXCEPT',
  'INTERSECT', 'WITH', 'OVER', 'PARTITION', 'ASC', 'DESC', 'INTO', 'VALUES',
  'PERCENT', 'TIES', 'OFFSET', 'FETCH', 'NEXT', 'ROWS', 'ONLY', 'DECLARE',
])

const SQL_FUNCTIONS = new Set([
  'SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'COUNT_BIG', 'STDEV', 'VAR',
  'YEAR', 'MONTH', 'DAY', 'DATEPART', 'DATEADD', 'DATEDIFF', 'GETDATE',
  'EOMONTH', 'DATEFROMPARTS', 'CAST', 'CONVERT', 'TRY_CAST', 'TRY_CONVERT',
  'COALESCE', 'NULLIF', 'ISNULL', 'IIF', 'CHOOSE',
  'LEN', 'LTRIM', 'RTRIM', 'TRIM', 'UPPER', 'LOWER', 'SUBSTRING', 'REPLACE',
  'CONCAT', 'LEFT', 'RIGHT', 'CHARINDEX', 'FORMAT', 'STRING_AGG',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD',
  'ABS', 'ROUND', 'FLOOR', 'CEILING', 'POWER', 'SQRT', 'SIGN',
  'HASHBYTES', 'CHECKSUM', 'NEWID',
])

const DAX_KEYWORDS = new Set([
  'EVALUATE', 'DEFINE', 'MEASURE', 'VAR', 'RETURN', 'ORDER', 'BY', 'START',
  'AT', 'ASC', 'DESC', 'COLUMN', 'TABLE', 'IN', 'NOT', 'AND', 'OR',
])

/** The DAX function catalogue already exists for autocomplete; importing the
 * names keeps one source of truth rather than a second drifting list. */
import { DAX_FUNCTIONS } from '@/application/dax/functions'

const DAX_FUNCTION_NAMES = new Set(DAX_FUNCTIONS.map((f) => f.name.toUpperCase()))

// ── Tokenizers ──────────────────────────────────────────────────────────────

const WORD = /[A-Za-z_][A-Za-z0-9_@$#.]*/y
const NUMBER = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const SPACE = /\s+/y
const OPERATOR = /<>|<=|>=|!=|\|\||&&|[+\-*/%=<>&|^~!]/y

/** Is the next non-space character an opening paren? Decides function vs
 * identifier, which is how both engines read it too. */
function callAhead(src: string, from: number): boolean {
  let i = from
  while (i < src.length && /\s/.test(src[i])) i++
  return src[i] === '('
}

function tokenize(src: string, dialect: 'sql' | 'dax'): Token[] {
  const out: Token[] = []
  const push = (kind: TokenKind, text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.kind === kind && kind === 'plain') last.text += text
    else out.push({ kind, text })
  }

  const keywords = dialect === 'sql' ? SQL_KEYWORDS : DAX_KEYWORDS
  const functions = dialect === 'sql' ? SQL_FUNCTIONS : DAX_FUNCTION_NAMES

  let i = 0
  while (i < src.length) {
    const c = src[i]

    // Comments — both dialects use -- and /* */
    if (c === '-' && src[i + 1] === '-') {
      const nl = src.indexOf('\n', i)
      const end = nl < 0 ? src.length : nl
      push('comment', src.slice(i, end))
      i = end
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close < 0 ? src.length : close + 2
      push('comment', src.slice(i, end))
      i = end
      continue
    }

    // Single quotes: a STRING in SQL, a TABLE NAME in DAX.
    if (c === "'") {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue }
        if (src[j] === "'") { j++; break }
        j++
      }
      push(dialect === 'sql' ? 'string' : 'identifier', src.slice(i, j))
      i = j
      continue
    }

    // Double quotes: a quoted IDENTIFIER in SQL, a STRING in DAX.
    if (c === '"') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') { j += 2; continue }
        if (src[j] === '"') { j++; break }
        j++
      }
      push(dialect === 'sql' ? 'identifier' : 'string', src.slice(i, j))
      i = j
      continue
    }

    // Bracketed identifier in both.
    if (c === '[') {
      const close = src.indexOf(']', i)
      const end = close < 0 ? src.length : close + 1
      push('identifier', src.slice(i, end))
      i = end
      continue
    }

    SPACE.lastIndex = i
    const sp = SPACE.exec(src)
    if (sp) { push('plain', sp[0]); i = SPACE.lastIndex; continue }

    NUMBER.lastIndex = i
    const num = NUMBER.exec(src)
    if (num) { push('number', num[0]); i = NUMBER.lastIndex; continue }

    WORD.lastIndex = i
    const word = WORD.exec(src)
    if (word) {
      const text = word[0]
      const up = text.toUpperCase()
      i = WORD.lastIndex
      if (functions.has(up) && callAhead(src, i)) push('function', text)
      else if (keywords.has(up)) push('keyword', text)
      // A name followed by "(" is a call even if we have never heard of it —
      // user-defined functions and anything missing from the catalogue still
      // read as calls, which is what the person typing expects.
      else if (callAhead(src, i)) push('function', text)
      else push('plain', text)
      continue
    }

    OPERATOR.lastIndex = i
    const op = OPERATOR.exec(src)
    if (op) { push('operator', op[0]); i = OPERATOR.lastIndex; continue }

    push('plain', c)
    i++
  }

  return out
}

export const tokenizeSql = (src: string) => tokenize(src, 'sql')
export const tokenizeDax = (src: string) => tokenize(src, 'dax')

// ── Rendering ───────────────────────────────────────────────────────────────

/** Escape before anything reaches innerHTML. The input is user-typed; without
 * this, a query is an injection vector. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function highlightHtml(src: string, dialect: 'sql' | 'dax'): string {
  const tokens = dialect === 'sql' ? tokenizeSql(src) : tokenizeDax(src)
  let html = ''
  for (const t of tokens) {
    const escaped = escapeHtml(t.text)
    html += t.kind === 'plain' ? escaped : `<span class="tok tok--${t.kind}">${escaped}</span>`
  }
  // A trailing newline collapses in a <pre>, which would leave the highlight
  // one line shorter than the textarea and scroll them out of step.
  return html + '\n'
}
