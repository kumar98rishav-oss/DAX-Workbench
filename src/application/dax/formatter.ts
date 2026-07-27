/**
 * DAX expression formatter.
 * Produces indented, keyword-uppercased DAX matching daxformatter.com style.
 *
 * Rules:
 *  - Known DAX function/keyword names → UPPERCASE
 *  - Function calls with ≥2 args OR any nested function call → multi-line
 *  - Single-arg with no nested call → compact:  SUM ( Sales[Amount] )
 *  - VAR/RETURN blocks get dedicated lines
 *  - Binary operators spaced:  x = y,  x <> y,  x && y
 */

const IND = '    '

/** All built-in DAX function / keyword names that should be uppercased. */
const DAX_KW = new Set([
  'CALCULATE','CALCULATETABLE','FILTER','ALL','ALLEXCEPT','ALLSELECTED',
  'ALLNOBLANKROW','VALUES','DISTINCT','DISTINCTCOUNT','DISTINCTCOUNTNOBLANK',
  'SUM','SUMX','AVERAGE','AVERAGEX','COUNT','COUNTA','COUNTX','COUNTROWS',
  'COUNTBLANK','MAX','MAXX','MIN','MINX','MEDIAN','MEDIANX',
  'IF','IFERROR','SWITCH','COALESCE','IIF',
  'TRUE','FALSE','BLANK','ISBLANK','ISNUMBER','ISTEXT','ISERROR',
  'ISLOGICAL','ISNONTEXT','ISODD','ISEVEN','HASONEVALUE','HASONEFILTER',
  'ISFILTERED','ISCROSSFILTERED','ISINSCOPE','ISSELECTEDMEASURE',
  'RELATED','RELATEDTABLE','EARLIER','EARLIEST',
  'YEAR','MONTH','DAY','HOUR','MINUTE','SECOND','DATE','TIME',
  'TODAY','NOW','WEEKDAY','WEEKNUM','ISOWEEKNUM','EOMONTH','EDATE',
  'DATESYTD','DATESQTD','DATESMTD','SAMEPERIODLASTYEAR',
  'PREVIOUSYEAR','PREVIOUSMONTH','PREVIOUSQUARTER','PREVIOUSDAY',
  'NEXTYEAR','NEXTMONTH','NEXTQUARTER','NEXTDAY',
  'DATEADD','DATESBETWEEN','DATESINPERIOD','PARALLELPERIOD',
  'STARTOFYEAR','STARTOFMONTH','STARTOFQUARTER',
  'ENDOFYEAR','ENDOFMONTH','ENDOFQUARTER',
  'CALENDARAUTO','CALENDAR','TOTALYTD','TOTALQTD','TOTALMTD',
  'OPENINGBALANCEYEAR','CLOSINGBALANCEYEAR','DATEVALUE',
  'DIVIDE','POWER','SQRT','ABS','INT','ROUND','ROUNDUP','ROUNDDOWN',
  'MOD','TRUNC','CEILING','FLOOR','SIGN','RAND','RANDBETWEEN',
  'EXP','LN','LOG','LOG10','PI','QUOTIENT',
  'CONCATENATE','CONCATENATEX','FORMAT','LEFT','RIGHT','MID','LEN',
  'UPPER','LOWER','TRIM','SUBSTITUTE','REPLACE','FIND','SEARCH',
  'TEXT','VALUE','FIXED','EXACT','REPT','UNICODE','UNICHAR',
  'CODE','CHAR','CLEAN','COMBINEVALUES',
  'RANKX','TOPN','TOPNSKIP','SAMPLE',
  'ADDCOLUMNS','SELECTCOLUMNS','SUMMARIZE','SUMMARIZECOLUMNS',
  'GROUPBY','CROSSJOIN','UNION','INTERSECT','EXCEPT',
  'ROW','DATATABLE','GENERATESERIES','SEQUENCE',
  'CONTAINSROW','CONTAINS','CONTAINSSTRING','CONTAINSSTRINGEXACT',
  'KEEPFILTERS','REMOVEFILTERS','USERELATIONSHIP','CROSSFILTER','TREATAS',
  'SELECTEDVALUE','SELECTEDMEASURE','SELECTEDMEASURENAME',
  'FIRSTNONBLANK','LASTNONBLANK','FIRSTNONBLANKVALUE','LASTNONBLANKVALUE',
  'NAMEOF','LOOKUPVALUE','GENERATE','GENERATEALL',
  'NATURALINNERJOIN','NATURALLEFTOUTERJOIN',
  'MATCHBY','WINDOW','RANK','ROWNUMBER','OFFSET',
  'EXPAND','EXPANDALL','COLLAPSE','COLLAPSEALL',
  'MAXA','MINA','AVERAGEA','GEOMEAN','GEOMEANX',
  'NOT','AND','OR','IN',
  'VAR','RETURN',
])

// ── Tokeniser ────────────────────────────────────────────────────────────────

type TK =
  | { k: 'word';    v: string }   // identifier / keyword
  | { k: 'colref';  v: string }   // Table[Col] or [Measure]
  | { k: 'string';  v: string }   // "..."
  | { k: 'num';     v: string }   // 123, 1.5
  | { k: 'op';      v: string }   // +  -  *  /  =  <>  &&  ...
  | { k: 'comment'; v: string }   // // ...  or  /* ... */
  | { k: 'lp' }                   // (
  | { k: 'rp' }                   // )
  | { k: 'lc' }                   // {
  | { k: 'rc' }                   // }
  | { k: 'comma' }
  | { k: 'semi' }                 // ;  (EVALUATE queries)
  | { k: 'other'; v: string }

function tokenize(src: string): TK[] {
  const out: TK[] = []
  let i = 0
  const n = src.length

  while (i < n) {
    const c = src[i]

    // whitespace — discard (we rebuild spacing)
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue }

    // line comment
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2
      while (j < n && src[j] !== '\n') j++
      out.push({ k: 'comment', v: src.slice(i, j) }); i = j; continue
    }

    // block comment
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < n - 1 && !(src[j] === '*' && src[j + 1] === '/')) j++
      out.push({ k: 'comment', v: src.slice(i, j + 2) }); i = j + 2; continue
    }

    // string literal — "" escape inside
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (src[j] === '"' && src[j + 1] === '"') { j += 2; continue }
        if (src[j] === '"') { j++; break }
        j++
      }
      out.push({ k: 'string', v: src.slice(i, j) }); i = j; continue
    }

    // word — could be Table immediately followed by [Column]
    if (/[A-Za-z_$@]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_.$ ]/.test(src[j]) && src[j] !== '\n') {
        // stop at space unless we'll see a [ (allow "Table Name[Col]")
        if (src[j] === ' ') {
          // peek ahead past spaces to see if '[' is coming
          let k = j + 1
          while (k < n && src[k] === ' ') k++
          if (src[k] === '[') { j = k; break }
          break
        }
        j++
      }
      // table[column] ref?
      if (j < n && src[j] === '[') {
        let k = j + 1
        while (k < n && src[k] !== ']') k++
        out.push({ k: 'colref', v: src.slice(i, k + 1) }); i = k + 1
      } else {
        out.push({ k: 'word', v: src.slice(i, j) }); i = j
      }
      continue
    }

    // bare column ref  [Measure]
    if (c === '[') {
      let j = i + 1
      while (j < n && src[j] !== ']') j++
      out.push({ k: 'colref', v: src.slice(i, j + 1) }); i = j + 1; continue
    }

    // number
    if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < n && /[0-9.]/.test(src[j])) j++
      if (j < n && (src[j] === 'e' || src[j] === 'E')) {
        j++
        if (j < n && (src[j] === '+' || src[j] === '-')) j++
        while (j < n && /[0-9]/.test(src[j])) j++
      }
      out.push({ k: 'num', v: src.slice(i, j) }); i = j; continue
    }

    // two-char operators
    if (i + 1 < n) {
      const two = src.slice(i, i + 2)
      if (['<>', '<=', '>=', '&&', '||', ':='].includes(two)) {
        out.push({ k: 'op', v: two }); i += 2; continue
      }
    }

    // single-char
    if (c === '(') { out.push({ k: 'lp' });    i++; continue }
    if (c === ')') { out.push({ k: 'rp' });    i++; continue }
    if (c === '{') { out.push({ k: 'lc' });    i++; continue }
    if (c === '}') { out.push({ k: 'rc' });    i++; continue }
    if (c === ',') { out.push({ k: 'comma' }); i++; continue }
    if (c === ';') { out.push({ k: 'semi' });  i++; continue }
    if ('=<>+-*/^&|!%'.includes(c)) { out.push({ k: 'op', v: c }); i++; continue }

    out.push({ k: 'other', v: c }); i++
  }

  return out
}

// ── Formatter ────────────────────────────────────────────────────────────────

/** Look ahead from `from` (just after an open-paren) to decide line-breaking. */
function shouldBreak(toks: TK[], from: number): boolean {
  let depth = 0
  let commas = 0
  let nestedFunc = false

  for (let j = from; j < toks.length; j++) {
    const t = toks[j]
    if (t.k === 'lp') {
      depth++
      if (depth === 1) {
        // Was the token before this `(` a word? → nested function call
        const prev = toks[j - 1]
        if (prev?.k === 'word') nestedFunc = true
      }
    } else if (t.k === 'rp') {
      if (depth === 0) break
      depth--
    } else if (t.k === 'comma' && depth === 0) {
      commas++
    }
  }

  return commas > 0 || nestedFunc
}

interface Frame { ml: boolean; d: number }

function renderTokens(toks: TK[]): string {
  const parts: string[] = []
  const stack: Frame[] = []
  let d = 0         // current indent depth
  let needSp = false // whether the next value token needs a leading space

  const add = (s: string) => { parts.push(s); needSp = false }
  const sp  = () => { if (needSp) { parts.push(' '); needSp = false } }

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]

    // ── VAR — start on its own line ───────────────────────────────────────
    if (tok.k === 'word' && tok.v.toUpperCase() === 'VAR') {
      const last = parts[parts.length - 1] ?? ''
      if (last && !last.endsWith('\n')) add('\n')
      add('VAR '); needSp = false; continue
    }

    // ── RETURN — its own line, indent expression below ────────────────────
    if (tok.k === 'word' && tok.v.toUpperCase() === 'RETURN') {
      const last = parts[parts.length - 1] ?? ''
      if (last && !last.endsWith('\n')) add('\n')
      // Increment d so that function calls inside the RETURN body are
      // indented relative to RETURN, not relative to the outer level.
      d++
      add('RETURN\n' + IND.repeat(d)); needSp = false; continue
    }

    // ── Function call: WORD immediately followed by LPAREN ────────────────
    if (tok.k === 'word' && toks[i + 1]?.k === 'lp') {
      sp()
      const up = tok.v.toUpperCase()
      const name = DAX_KW.has(up) ? up : tok.v
      const ml = shouldBreak(toks, i + 2)
      stack.push({ ml, d })
      d++
      add(name + ' (')
      if (ml) { add('\n' + IND.repeat(d)) } else { add(' ') }
      needSp = false
      i++ // skip lparen
      continue
    }

    // ── Bare LPAREN (not after word) ──────────────────────────────────────
    if (tok.k === 'lp') {
      sp()
      const ml = shouldBreak(toks, i + 1)
      stack.push({ ml, d })
      d++
      add('(')
      if (ml) { add('\n' + IND.repeat(d)) } else { add(' ') }
      needSp = false
      continue
    }

    // ── RPAREN ────────────────────────────────────────────────────────────
    if (tok.k === 'rp') {
      const frame = stack.pop()
      d = frame ? frame.d : Math.max(0, d - 1)
      if (frame?.ml) {
        add('\n' + IND.repeat(d) + ')')
      } else {
        // Avoid double-space when parens are empty: "FUNC ( )" not "FUNC (  )"
        const lastPart = parts[parts.length - 1] ?? ''
        const lastChar = lastPart[lastPart.length - 1] ?? ''
        add(lastChar === ' ' ? ')' : ' )')
      }
      needSp = true
      continue
    }

    // ── LCURLY  { ─────────────────────────────────────────────────────────
    if (tok.k === 'lc') {
      sp()
      add('{ '); needSp = false; continue
    }

    // ── RCURLY  } ─────────────────────────────────────────────────────────
    if (tok.k === 'rc') {
      add(' }'); needSp = true; continue
    }

    // ── COMMA ─────────────────────────────────────────────────────────────
    if (tok.k === 'comma') {
      const frame = stack[stack.length - 1]
      if (frame?.ml) {
        add(',\n' + IND.repeat(d))
      } else {
        add(', ')
      }
      needSp = false
      continue
    }

    // ── SEMICOLON ─────────────────────────────────────────────────────────
    if (tok.k === 'semi') {
      add('\n'); needSp = false; continue
    }

    // ── OPERATOR ──────────────────────────────────────────────────────────
    if (tok.k === 'op') {
      add(' ' + tok.v + ' '); needSp = false; continue
    }

    // ── COMMENT ───────────────────────────────────────────────────────────
    if (tok.k === 'comment') {
      const last = parts[parts.length - 1] ?? ''
      if (last && !last.endsWith('\n')) add('\n' + IND.repeat(d))
      add(tok.v + '\n' + IND.repeat(d)); needSp = false; continue
    }

    // ── WORD (not a function call) ────────────────────────────────────────
    if (tok.k === 'word') {
      sp()
      const up = tok.v.toUpperCase()
      add(DAX_KW.has(up) ? up : tok.v)
      needSp = true
      continue
    }

    // ── COLREF, NUM, STRING, OTHER ────────────────────────────────────────
    sp()
    if (tok.k === 'colref' || tok.k === 'num' || tok.k === 'string' || tok.k === 'other') {
      add(tok.v)
    }
    needSp = true
  }

  return parts.join('').trim()
}

// ── Public API ───────────────────────────────────────────────────────────────

export function formatDax(expression: string): string {
  if (!expression.trim()) return expression
  try {
    return renderTokens(tokenize(expression))
  } catch {
    // never corrupt the user's expression — return original on any error
    return expression
  }
}
