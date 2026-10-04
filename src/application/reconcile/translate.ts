/**
 * APPLICATION — Draft one query from the other (pure)
 *
 * This does NOT claim the two queries are equivalent. The tool's whole premise
 * is that the user asserts equivalence, because a measure's value depends on
 * filter context, relationships and RLS that no translator can see. What this
 * does is save typing: it drafts a starting query, in the other dialect, which
 * the user then READS, EDITS and runs. What executes is still what is on screen.
 *
 * Because of that, the rule here is the same as everywhere else in this feature:
 * when it does not fully understand the input it REFUSES and says why, rather
 * than emitting something plausible. A confident wrong draft is worse than no
 * draft, since the user would run it believing the tool understood.
 *
 * Scope is deliberately the shape mid-level reconciliation actually uses:
 * one table, optional INNER JOINs on a key, GROUP BY, simple aggregates and
 * date parts. Anything past that is refused by name.
 */

export interface TranslateContext {
  /** Active many-to-one relationships, used to justify RELATED() and to build a
   * JOIN in the other direction. Without them a join is still translated, but
   * the note says it could not be verified. */
  relationships?: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }[]
  /** Model table names, so `dbo.Fact_sales` can be emitted with the model's own
   * capitalisation rather than the SQL author's. */
  modelTables?: string[]
  /** Schema to qualify generated SQL with. */
  schema?: string
}

export type Translation =
  | { ok: true; query: string; notes: string[] }
  | { ok: false; reason: string; hint?: string }

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Strip comments and the trailing semicolon, without touching string literals. */
function scrub(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") { j++; break }
        j++
      }
      out += sql.slice(i, j); i = j; continue
    }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; out += ' '; continue }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2; out += ' '; continue
    }
    out += c; i++
  }
  return out.replace(/;\s*$/, '').trim()
}

/** Split on commas that are not inside parentheses or a string. */
function splitTop(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) { current += c; if (c === "'" && s[i + 1] !== "'") inStr = false; continue }
    if (c === "'") { inStr = true; current += c; continue }
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue }
    current += c
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

const unquoteSql = (s: string) => s.trim().replace(/^\[(.*)\]$/s, '$1').replace(/^"(.*)"$/s, '$1')

/** One identifier: a bracketed name (which may contain spaces) or a bare word.
 * Written out rather than `[\w ]+` so an alias is never swallowed — `Fact AS F`
 * must not parse as a table literally called "Fact AS F". */
const IDENT = String.raw`(?:\[[^\]]+\]|"[^"]+"|\w+)`

/** `[schema.]table [AS] [alias]` */
function parseTableRef(raw: string): { table: string; alias?: string } | null {
  const m = raw.trim().match(new RegExp(`^(?:${IDENT}\\s*\\.\\s*)?(${IDENT})(?:\\s+(?:AS\\s+)?(\\w+))?$`, 'i'))
  return m ? { table: unquoteSql(m[1]), alias: m[2] } : null
}

const balanced = (s: string) => (s.match(/\(/g)?.length ?? 0) === (s.match(/\)/g)?.length ?? 0)

/** Peel a trailing output name off a select item, but only when what remains
 * has balanced parentheses — otherwise `COUNT(DISTINCT x)` would split into
 * `COUNT(DISTINCT` plus an "alias". */
function splitAlias(raw: string): { expr: string; alias?: string } {
  const m = raw.match(new RegExp(`^([\\s\\S]+?)\\s+(?:AS\\s+)?(${IDENT})\\s*$`, 'i'))
  if (m && balanced(m[1])) return { expr: m[1].trim(), alias: unquoteSql(m[2]) }
  return { expr: raw.trim() }
}
const daxTable = (n: string) => `'${n.replace(/'/g, "''")}'`
const daxCol = (t: string, c: string) => `${daxTable(t)}[${c.replace(/]/g, ']]')}]`
const sqlIdent = (n: string) => `[${n.replace(/]/g, ']]')}]`

/** Emit the model's own spelling of a table name when we know it. */
function modelName(raw: string, ctx: TranslateContext): string {
  const hit = ctx.modelTables?.find((t) => t.toLowerCase() === raw.toLowerCase())
  return hit ?? raw
}

// ── SQL → DAX ───────────────────────────────────────────────────────────────

/** Constructs with no faithful DAX counterpart at this scope. Named one by one
 * so the refusal tells the user which thing stopped it. */
const SQL_UNSUPPORTED: [RegExp, string][] = [
  [/\bWITH\b[\s\S]*\bAS\s*\(/i, 'a common table expression (WITH …)'],
  [/\b(UNION|INTERSECT|EXCEPT)\b/i, 'a set operation (UNION / INTERSECT / EXCEPT)'],
  [/\bHAVING\b/i, 'a HAVING clause'],
  [/\bOVER\s*\(/i, 'a window function (… OVER (…))'],
  [/\b(LEFT|RIGHT|FULL|CROSS)\s+(OUTER\s+)?(JOIN|APPLY)\b/i, 'an outer or cross join'],
  [/\b(PIVOT|UNPIVOT)\b/i, 'PIVOT / UNPIVOT'],
  [/\bCASE\s+WHEN\b/i, 'a CASE expression'],
  [/\bTOP\b/i, 'TOP (row limiting has no comparison-safe DAX equivalent here)'],
]

interface SelectItem {
  /** Output name. */
  alias: string
  expr: string
}

type Resolved =
  | { kind: 'col'; table: string; column: string; viaJoin: boolean }
  | { kind: 'datepart'; fn: 'YEAR' | 'MONTH' | 'DAY'; table: string; column: string; viaJoin: boolean }
  | { kind: 'agg'; fn: string; table?: string; column?: string; distinct?: boolean }

export function sqlToDax(sql: string, ctx: TranslateContext = {}): Translation {
  const text = scrub(sql)
  if (!text) return { ok: false, reason: 'There is no SQL to translate.' }
  if (!/^SELECT\b/i.test(text)) {
    return { ok: false, reason: 'Only a SELECT statement can be translated.' }
  }
  for (const [re, what] of SQL_UNSUPPORTED) {
    if (re.test(text)) {
      return {
        ok: false,
        reason: `This uses ${what}, which has no dependable DAX equivalent at this level.`,
        hint: 'Write the DAX side by hand — the comparison does not care how each side was produced.',
      }
    }
  }
  if ((text.match(/\bSELECT\b/gi) ?? []).length > 1) {
    return { ok: false, reason: 'This contains a subquery, which is not translated.', hint: 'Write the DAX side by hand.' }
  }

  // ── Clause split ──
  const m = text.match(
    /^SELECT\s+(?<sel>[\s\S]+?)\s+FROM\s+(?<from>[\s\S]+?)(?:\s+WHERE\s+(?<where>[\s\S]+?))?(?:\s+GROUP\s+BY\s+(?<group>[\s\S]+?))?(?:\s+ORDER\s+BY\s+(?<order>[\s\S]+?))?$/i,
  )
  if (!m?.groups) return { ok: false, reason: 'The statement could not be parsed into SELECT / FROM clauses.' }
  const { sel, from, where, group, order } = m.groups as Record<string, string | undefined>

  // ── FROM + INNER JOINs ──
  const fromText = (from ?? '').trim()
  const joinSplit = fromText.split(/\s+(?:INNER\s+)?JOIN\s+/i)
  const baseRaw = joinSplit[0].trim()
  const baseRef = parseTableRef(baseRaw)
  if (!baseRef) return { ok: false, reason: `Could not read the table name in "FROM ${baseRaw}".` }
  const baseTable = modelName(baseRef.table, ctx)
  const aliases = new Map<string, { table: string; viaJoin: boolean }>()
  aliases.set((baseRef.alias ?? baseRef.table).toLowerCase(), { table: baseTable, viaJoin: false })

  const joins: { table: string }[] = []
  for (const part of joinSplit.slice(1)) {
    const onAt = part.search(/\s+ON\s+/i)
    if (onAt < 0) return { ok: false, reason: 'A JOIN has no ON clause. Only "INNER JOIN t AS a ON x = y" is translated.' }
    const ref = parseTableRef(part.slice(0, onAt))
    const on = part.slice(onAt).replace(/^\s+ON\s+/i, '')
    if (!ref || !/^[\w.[\]" ]+=[\w.[\]" ]+$/.test(on.trim())) {
      return { ok: false, reason: 'A JOIN clause could not be read. Only "INNER JOIN t AS a ON x = y" is translated.' }
    }
    const table = modelName(ref.table, ctx)
    aliases.set((ref.alias ?? ref.table).toLowerCase(), { table, viaJoin: true })
    joins.push({ table })
  }

  // ── Resolve one expression ──
  const resolveCol = (raw: string): { table: string; column: string; viaJoin: boolean } | null => {
    const cm = raw.trim().match(new RegExp(`^(?:(\\w+)\\s*\\.\\s*)?(${IDENT})$`))
    if (!cm) return null
    const column = unquoteSql(cm[2])
    if (cm[1]) {
      const a = aliases.get(cm[1].toLowerCase())
      return a ? { table: a.table, column, viaJoin: a.viaJoin } : null
    }
    return { table: baseTable, column, viaJoin: false }
  }

  const resolve = (expr: string): Resolved | null => {
    const e = expr.trim()
    const dp = e.match(/^(YEAR|MONTH|DAY)\s*\(([\s\S]+)\)$/i)
    if (dp) {
      const c = resolveCol(dp[2])
      return c ? { kind: 'datepart', fn: dp[1].toUpperCase() as 'YEAR', ...c } : null
    }
    if (/^COUNT\s*\(\s*\*\s*\)$/i.test(e)) return { kind: 'agg', fn: 'COUNT*' }
    const cd = e.match(/^COUNT\s*\(\s*DISTINCT\s+([\s\S]+)\)$/i)
    if (cd) {
      const c = resolveCol(cd[1])
      return c ? { kind: 'agg', fn: 'DISTINCT', table: c.table, column: c.column, distinct: true } : null
    }
    const ag = e.match(/^(SUM|MIN|MAX|AVG|COUNT)\s*\(([\s\S]+)\)$/i)
    if (ag) {
      const c = resolveCol(ag[2])
      return c ? { kind: 'agg', fn: ag[1].toUpperCase(), table: c.table, column: c.column } : null
    }
    const c = resolveCol(e)
    return c ? { kind: 'col', ...c } : null
  }

  // ── SELECT list ──
  const items: SelectItem[] = []
  for (const raw of splitTop(sel ?? '')) {
    const { expr, alias } = splitAlias(raw)
    items.push({ expr, alias: alias ?? unquoteSql(expr).replace(/^.*\./, '') })
  }

  const notes: string[] = []
  const resolved: { item: SelectItem; r: Resolved }[] = []
  for (const item of items) {
    const r = resolve(item.expr)
    if (!r) {
      return {
        ok: false,
        reason: `The expression "${item.expr}" was not recognised.`,
        hint: 'Columns, YEAR/MONTH/DAY of a column, and SUM / MIN / MAX / AVG / COUNT(*) / COUNT(DISTINCT …) are translated.',
      }
    }
    resolved.push({ item, r })
  }

  const aggs = resolved.filter((x) => x.r.kind === 'agg')
  const keys = resolved.filter((x) => x.r.kind !== 'agg')

  if (group && keys.length === 0) {
    return { ok: false, reason: 'GROUP BY is present but no grouping column appears in the SELECT list.' }
  }
  if (group && splitTop(group).length !== keys.length) {
    return {
      ok: false,
      reason: 'The GROUP BY list does not line up with the non-aggregated columns in the SELECT list.',
      hint: 'Group by exactly the columns you select — otherwise the two sides would be at different grains.',
    }
  }
  if (!group && aggs.length > 0 && keys.length > 0) {
    return { ok: false, reason: 'Aggregates are mixed with plain columns but there is no GROUP BY.' }
  }

  // ── Expression writers ──
  const daxOf = (r: Resolved): string => {
    if (r.kind === 'col') {
      return r.viaJoin ? `RELATED ( ${daxCol(r.table, r.column)} )` : daxCol(r.table, r.column)
    }
    if (r.kind === 'datepart') {
      const inner = r.viaJoin ? `RELATED ( ${daxCol(r.table, r.column)} )` : daxCol(r.table, r.column)
      return `${r.fn} ( ${inner} )`
    }
    if (r.fn === 'COUNT*') return `COUNTROWS ( ${daxTable(baseTable)} )`
    const col = daxCol(r.table!, r.column!)
    if (r.fn === 'DISTINCT') return `DISTINCTCOUNTNOBLANK ( ${col} )`
    if (r.fn === 'COUNT') return `COUNTA ( ${col} )`
    return `${r.fn} ( ${col} )`
  }

  if (joins.length > 0) {
    const unverified = joins.filter((j) => !ctx.relationships?.some(
      (rel) => rel.toTable.toLowerCase() === j.table.toLowerCase() &&
        rel.fromTable.toLowerCase() === baseTable.toLowerCase(),
    ))
    notes.push(
      unverified.length === 0
        ? `Each joined column became RELATED(…), which follows the model's active relationship from ${baseTable}.`
        : `Joined columns became RELATED(…). No active relationship from ${baseTable} to ${unverified.map((j) => j.table).join(', ')} was found in the model, so check that path before trusting the result.`,
    )
    notes.push('SQL INNER JOIN drops unmatched rows; RELATED keeps the fact row and returns blank. If keys can be orphaned the two sides will differ for that reason alone.')
  }
  if (resolved.some((x) => x.r.kind === 'agg' && x.r.fn === 'DISTINCT')) {
    notes.push('COUNT(DISTINCT …) became DISTINCTCOUNTNOBLANK, which matches SQL in ignoring NULL — DISTINCTCOUNT would count BLANK as a value and differ by one.')
  }
  if (order) notes.push('ORDER BY was dropped. Row order does not affect the comparison, which matches on keys.')

  // ── WHERE ──
  let filterWrap: string | null = null
  if (where) {
    const conds = where.split(/\s+AND\s+/i).map((c) => c.trim())
    const parts: string[] = []
    for (const c of conds) {
      const cm = c.match(/^([\w.\[\] ]+?)\s*(=|<>|!=|>=|<=|>|<)\s*('[^']*'|-?[\d.]+)$/)
      if (!cm) {
        return {
          ok: false,
          reason: `The WHERE condition "${c}" was not recognised.`,
          hint: 'Only simple "column op value" conditions joined by AND are translated.',
        }
      }
      const col = resolveCol(cm[1])
      if (!col) return { ok: false, reason: `The WHERE column "${cm[1]}" could not be resolved to a table.` }
      const lhs = col.viaJoin ? `RELATED ( ${daxCol(col.table, col.column)} )` : daxCol(col.table, col.column)
      const op = cm[2] === '!=' ? '<>' : cm[2]
      const val = cm[3].startsWith("'") ? `"${cm[3].slice(1, -1).replace(/''/g, "'")}"` : cm[3]
      parts.push(`${lhs} ${op} ${val}`)
    }
    filterWrap = `FILTER (\n        ${daxTable(baseTable)},\n        ${parts.join('\n            && ')}\n    )`
    notes.push('WHERE became a FILTER over the fact table. SQL drops NULLs from a comparison; DAX compares BLANK, so a nullable column can differ here.')
  }

  const source = filterWrap ?? daxTable(baseTable)

  // ── Emit ──
  // Row-level projection: no aggregates at all.
  if (aggs.length === 0) {
    const cols = resolved.map((x) => `    "${x.item.alias}", ${daxOf(x.r)}`).join(',\n')
    return { ok: true, notes, query: `EVALUATE\nSELECTCOLUMNS (\n    ${source},\n${cols}\n)` }
  }

  // Pure scalars: one row.
  if (keys.length === 0) {
    const cols = aggs.map((x) => `    "${x.item.alias}", ${daxOf(x.r)}`).join(',\n')
    const body = filterWrap
      ? aggs.map((x) => `    "${x.item.alias}", CALCULATE ( ${daxOf(x.r)}, ${filterWrap.replace(/\n\s+/g, ' ')} )`).join(',\n')
      : cols
    return { ok: true, notes, query: `EVALUATE\nROW (\n${body}\n)` }
  }

  // Grouped. SUMMARIZECOLUMNS reads better, but only when every key is a plain
  // column of the base table — a derived key or a RELATED one needs the
  // ADDCOLUMNS form so the key exists before SUMMARIZE groups on it.
  const simple = keys.every((x) => x.r.kind === 'col' && !x.r.viaJoin) && !filterWrap
  if (simple) {
    const dims = keys.map((x) => `    ${daxOf(x.r)}`).join(',\n')
    const vals = aggs.map((x) => `    "${x.item.alias}", ${daxOf(x.r)}`).join(',\n')
    return { ok: true, notes, query: `EVALUATE\nSUMMARIZECOLUMNS (\n${dims},\n${vals}\n)` }
  }

  const added = keys.map((x) => `        "${x.item.alias}", ${daxOf(x.r)}`).join(',\n')
  const keyRefs = keys.map((x) => `[${x.item.alias}]`).join(', ')
  const vals = aggs.map((x) => `    "${x.item.alias}", ${daxOf(x.r)}`).join(',\n')
  return {
    ok: true,
    notes,
    query:
      `EVALUATE\nSUMMARIZE (\n    ADDCOLUMNS (\n        ${source},\n${added}\n    ),\n    ${keyRefs},\n${vals}\n)`,
  }
}

// ── DAX → SQL ───────────────────────────────────────────────────────────────

const DAX_UNSUPPORTED: [RegExp, string][] = [
  [/\bVAR\b[\s\S]*\bRETURN\b/i, 'a VAR / RETURN block'],
  [/\bCALCULATE\s*\(/i, 'CALCULATE (its filter arguments change meaning in ways SQL cannot mirror)'],
  [/\bUSERELATIONSHIP\s*\(/i, 'USERELATIONSHIP'],
  [/\bTOPN\s*\(/i, 'TOPN'],
  [/\b(ALL|ALLSELECTED|ALLEXCEPT|REMOVEFILTERS|KEEPFILTERS)\s*\(/i, 'a filter-context function'],
  [/\b(DATESYTD|DATESQTD|DATESMTD|SAMEPERIODLASTYEAR|DATEADD|TOTALYTD)\s*\(/i, 'a time-intelligence function'],
  [/\bGENERATE(ALL)?\s*\(/i, 'GENERATE'],
  [/\bUNION\s*\(/i, 'UNION'],
]

/** `'Table'[Column]` or `[Column]`, plus the common wrappers. */
function daxExprToSql(expr: string, baseTable: string): { sql: string; needsJoinOf?: string } | null {
  const e = expr.trim()

  const dp = e.match(/^(YEAR|MONTH|DAY)\s*\(([\s\S]+)\)$/i)
  if (dp) {
    const inner = daxExprToSql(dp[2], baseTable)
    return inner ? { sql: `${dp[1].toUpperCase()}(${inner.sql})`, needsJoinOf: inner.needsJoinOf } : null
  }
  const rel = e.match(/^RELATED\s*\(([\s\S]+)\)$/i)
  if (rel) {
    const inner = rel[1].trim().match(/^'([^']+)'\[([^\]]+)\]$/)
    if (!inner) return null
    return { sql: `${sqlIdent(inner[1])}.${sqlIdent(inner[2])}`, needsJoinOf: inner[1] }
  }
  const agg = e.match(/^(SUM|MIN|MAX|AVERAGE|COUNTA|DISTINCTCOUNTNOBLANK|DISTINCTCOUNT)\s*\(([\s\S]+)\)$/i)
  if (agg) {
    const inner = daxExprToSql(agg[2], baseTable)
    if (!inner) return null
    const fn = agg[1].toUpperCase()
    const sql =
      fn === 'AVERAGE' ? `AVG(${inner.sql})`
        : fn === 'COUNTA' ? `COUNT(${inner.sql})`
          : fn.startsWith('DISTINCTCOUNT') ? `COUNT(DISTINCT ${inner.sql})`
            : `${fn}(${inner.sql})`
    return { sql, needsJoinOf: inner.needsJoinOf }
  }
  const cr = e.match(/^COUNTROWS\s*\(\s*'?([^')]+?)'?\s*\)$/i)
  if (cr) return { sql: 'COUNT(*)' }

  const qualified = e.match(/^'([^']+)'\[([^\]]+)\]$/)
  if (qualified) {
    const t = qualified[1]
    return t.toLowerCase() === baseTable.toLowerCase()
      ? { sql: `${sqlIdent(t)}.${sqlIdent(qualified[2])}` }
      : { sql: `${sqlIdent(t)}.${sqlIdent(qualified[2])}`, needsJoinOf: t }
  }
  const bare = e.match(/^\[([^\]]+)\]$/)
  if (bare) return { sql: sqlIdent(bare[1]) }
  return null
}

export function daxToSql(dax: string, ctx: TranslateContext = {}): Translation {
  const text = dax.replace(/\/\/[^\n]*/g, ' ').replace(/--[^\n]*/g, ' ').trim()
  if (!text) return { ok: false, reason: 'There is no DAX to translate.' }
  if (!/^EVALUATE\b/i.test(text)) {
    return { ok: false, reason: 'Only a query starting with EVALUATE can be translated.' }
  }
  for (const [re, what] of DAX_UNSUPPORTED) {
    if (re.test(text)) {
      return {
        ok: false,
        reason: `This uses ${what}, which SQL cannot mirror faithfully.`,
        hint: 'Write the SQL side by hand — the comparison does not care how each side was produced.',
      }
    }
  }

  const body = text.replace(/^EVALUATE\s*/i, '').replace(/\s*ORDER\s+BY[\s\S]*$/i, '').trim()
  const schema = ctx.schema ?? 'dbo'
  const notes: string[] = []
  const qualify = (t: string) => `${sqlIdent(schema)}.${sqlIdent(t)}`

  /** "name", expr, "name", expr … */
  const pairs = (s: string): { alias: string; expr: string }[] | null => {
    const parts = splitTop(s)
    const out: { alias: string; expr: string }[] = []
    for (let i = 0; i < parts.length; i += 2) {
      const a = parts[i]?.trim()
      const e = parts[i + 1]
      if (!a?.startsWith('"') || e === undefined) return null
      out.push({ alias: a.slice(1, -1), expr: e.trim() })
    }
    return out
  }

  const joinsFor = (tables: Set<string>, base: string): string => {
    const lines: string[] = []
    for (const t of tables) {
      const rel = ctx.relationships?.find(
        (r) => r.toTable.toLowerCase() === t.toLowerCase() && r.fromTable.toLowerCase() === base.toLowerCase(),
      )
      if (rel) {
        lines.push(`INNER JOIN ${qualify(t)}\n    ON ${sqlIdent(base)}.${sqlIdent(rel.fromColumn)} = ${sqlIdent(t)}.${sqlIdent(rel.toColumn)}`)
      } else {
        lines.push(`INNER JOIN ${qualify(t)}\n    ON /* no active relationship found — supply the join keys */ 1 = 1`)
        notes.push(`No active relationship from ${base} to ${t} was found, so its ON clause is left for you to complete.`)
      }
    }
    return lines.join('\n')
  }

  const finish = (select: string[], base: string, extra: Set<string>, groupBy: string[]) => {
    const join = joinsFor(extra, base)
    let sql = `SELECT\n    ${select.join(',\n    ')}\nFROM ${qualify(base)}`
    if (join) sql += `\n${join}`
    if (groupBy.length) sql += `\nGROUP BY\n    ${groupBy.join(',\n    ')}`
    notes.push('SQL drops rows whose joined key does not match; the DAX side keeps them with a blank. Reconcile orphaned keys separately if that is possible here.')
    return { ok: true as const, notes, query: sql + ';' }
  }

  // ROW ( "a", expr, … )
  const row = body.match(/^ROW\s*\(([\s\S]*)\)$/i)
  if (row) {
    const ps = pairs(row[1])
    if (!ps) return { ok: false, reason: 'The ROW(…) arguments are not "name", expression pairs.' }
    // The base table is one mentioned OUTSIDE a RELATED(…): a related table is
    // by definition the one side of a relationship, so taking the first table
    // seen would pick a dimension as the FROM and invert the query.
    let base = ''
    for (const p of ps) {
      const bare = p.expr.replace(/RELATED\s*\([^)]*\)/gi, ' ').match(/'([^']+)'/)
      if (bare) { base = bare[1]; break }
    }
    const extra = new Set<string>()
    const select: string[] = []
    for (const p of ps) {
      const r = daxExprToSql(p.expr, base)
      if (!r) return { ok: false, reason: `The expression "${p.expr}" was not recognised.` }
      if (r.needsJoinOf && r.needsJoinOf.toLowerCase() !== base.toLowerCase()) extra.add(r.needsJoinOf)
      select.push(`${r.sql} AS ${sqlIdent(p.alias)}`)
    }
    if (!base) return { ok: false, reason: 'No table could be identified in the ROW(…) expressions.' }
    return finish(select, base, extra, [])
  }

  // SELECTCOLUMNS ( 'T', "a", expr, … )
  const selc = body.match(/^SELECTCOLUMNS\s*\(([\s\S]*)\)$/i)
  if (selc) {
    const parts = splitTop(selc[1])
    const base = parts[0]?.trim().replace(/^'|'$/g, '')
    const ps = pairs(parts.slice(1).join(','))
    if (!base || !ps) return { ok: false, reason: 'SELECTCOLUMNS(…) could not be read.' }
    const extra = new Set<string>()
    const select: string[] = []
    for (const p of ps) {
      const r = daxExprToSql(p.expr, base)
      if (!r) return { ok: false, reason: `The expression "${p.expr}" was not recognised.` }
      if (r.needsJoinOf && r.needsJoinOf.toLowerCase() !== base.toLowerCase()) extra.add(r.needsJoinOf)
      select.push(`${r.sql} AS ${sqlIdent(p.alias)}`)
    }
    return finish(select, base, extra, [])
  }

  // SUMMARIZECOLUMNS ( 'T'[a], …, "v", AGG )
  const sc = body.match(/^SUMMARIZECOLUMNS\s*\(([\s\S]*)\)$/i)
  if (sc) {
    const parts = splitTop(sc[1])
    const dims = parts.filter((p) => !p.trim().startsWith('"'))
    const rest = parts.slice(dims.length).join(',')
    const ps = pairs(rest) ?? []
    const base = dims[0]?.match(/'([^']+)'/)?.[1]
    if (!base) return { ok: false, reason: 'SUMMARIZECOLUMNS(…) needs at least one qualified column to identify the table.' }
    const extra = new Set<string>()
    const select: string[] = []
    const groupBy: string[] = []
    for (const d of dims) {
      const r = daxExprToSql(d, base)
      if (!r) return { ok: false, reason: `The grouping column "${d}" was not recognised.` }
      if (r.needsJoinOf && r.needsJoinOf.toLowerCase() !== base.toLowerCase()) extra.add(r.needsJoinOf)
      const alias = d.match(/\[([^\]]+)\]/)?.[1] ?? 'col'
      select.push(`${r.sql} AS ${sqlIdent(alias)}`)
      groupBy.push(r.sql)
    }
    for (const p of ps) {
      const r = daxExprToSql(p.expr, base)
      if (!r) return { ok: false, reason: `The expression "${p.expr}" was not recognised.` }
      if (r.needsJoinOf && r.needsJoinOf.toLowerCase() !== base.toLowerCase()) extra.add(r.needsJoinOf)
      select.push(`${r.sql} AS ${sqlIdent(p.alias)}`)
    }
    return finish(select, base, extra, groupBy)
  }

  // SUMMARIZE ( ADDCOLUMNS ( 'T', "k", expr, … ), [k], …, "v", AGG )
  const sm = body.match(/^SUMMARIZE\s*\(([\s\S]*)\)$/i)
  if (sm) {
    const parts = splitTop(sm[1])
    const first = parts[0]?.trim() ?? ''
    const ac = first.match(/^ADDCOLUMNS\s*\(([\s\S]*)\)$/i)
    if (!ac) {
      return { ok: false, reason: 'Only SUMMARIZE(ADDCOLUMNS(…), …) is translated.', hint: 'A SUMMARIZE straight over a table maps to a plain GROUP BY — write that by hand.' }
    }
    const acParts = splitTop(ac[1])
    const base = acParts[0]?.trim().replace(/^'|'$/g, '')
    const derived = pairs(acParts.slice(1).join(','))
    if (!base || !derived) return { ok: false, reason: 'ADDCOLUMNS(…) could not be read.' }

    const byAlias = new Map(derived.map((d) => [d.alias.toLowerCase(), d.expr]))
    const extra = new Set<string>()
    const select: string[] = []
    const groupBy: string[] = []

    const tail = parts.slice(1)
    const keyRefs = tail.filter((p) => /^\[[^\]]+\]$/.test(p.trim()))
    const valuePairs = pairs(tail.slice(keyRefs.length).join(',')) ?? []

    for (const k of keyRefs) {
      const alias = k.trim().slice(1, -1)
      const expr = byAlias.get(alias.toLowerCase())
      if (!expr) return { ok: false, reason: `The grouping key [${alias}] is not defined in ADDCOLUMNS(…).` }
      const r = daxExprToSql(expr, base)
      if (!r) return { ok: false, reason: `The expression "${expr}" was not recognised.` }
      if (r.needsJoinOf && r.needsJoinOf.toLowerCase() !== base.toLowerCase()) extra.add(r.needsJoinOf)
      select.push(`${r.sql} AS ${sqlIdent(alias)}`)
      groupBy.push(r.sql)
    }
    for (const p of valuePairs) {
      const r = daxExprToSql(p.expr, base)
      if (!r) return { ok: false, reason: `The expression "${p.expr}" was not recognised.` }
      if (r.needsJoinOf && r.needsJoinOf.toLowerCase() !== base.toLowerCase()) extra.add(r.needsJoinOf)
      select.push(`${r.sql} AS ${sqlIdent(p.alias)}`)
    }
    if (select.length === 0) return { ok: false, reason: 'No columns were found to select.' }
    return finish(select, base, extra, groupBy)
  }

  return {
    ok: false,
    reason: 'Only ROW, SELECTCOLUMNS, SUMMARIZECOLUMNS and SUMMARIZE(ADDCOLUMNS(…)) are translated.',
    hint: 'Write the SQL side by hand — the comparison does not care how each side was produced.',
  }
}
