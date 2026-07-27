/**
 * APPLICATION — DAX preview evaluator (subset, pure)
 * A small DAX interpreter over the in-memory data. Supports aggregations,
 * arithmetic, VAR/RETURN, measure refs, DIVIDE/ROUND/ABS, CALCULATE with
 * same-table filters (incl. FILTER(...) predicates), the row iterators
 * SUMX/AVERAGEX/MINX/MAXX/COUNTX (with RELATED across a relationship), and the
 * scalar logic IF/SWITCH/SELECTEDVALUE/COALESCE and the IN operator. Anything
 * outside the subset returns a friendly note rather than throwing.
 */
import type { QueryCtx, Agg, Predicate } from '@/application/query/query-engine'
import { scalar, scalarWhere } from '@/application/query/query-engine'
import type { Table } from '@/domain/model'

export type EvalResult = { ok: true; value: number } | { ok: false; note: string }

type Val = number | string | null

type Tok =
  | { t: 'num'; v: number }
  | { t: 'ident'; v: string }
  | { t: 'table'; v: string }
  | { t: 'col'; v: string }
  | { t: 'str'; v: string }
  | { t: 'op'; v: string }
  | { t: 'punc'; v: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) throw new Error('Unterminated table name')
      out.push({ t: 'table', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (c === '"') {
      const end = src.indexOf('"', i + 1)
      if (end < 0) throw new Error('Unterminated string')
      out.push({ t: 'str', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (c === '[') {
      const end = src.indexOf(']', i + 1)
      if (end < 0) throw new Error('Unterminated column reference')
      out.push({ t: 'col', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (/[0-9.]/.test(c)) {
      // Digits and dots only — DAX literals have no thousands separators, and
      // consuming ',' here swallowed the argument separator after a number
      // (broke every IF(x > 0, a, b)-shaped call).
      let j = i + 1
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      out.push({ t: 'num', v: Number(src.slice(i, j)) })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++
      out.push({ t: 'ident', v: src.slice(i, j) })
      i = j
      continue
    }
    if (c === '&' && src[i + 1] === '&') { out.push({ t: 'op', v: '&&' }); i += 2; continue }
    if (c === '&') { out.push({ t: 'op', v: '&' }); i++; continue }
    if (c === '|' && src[i + 1] === '|') { out.push({ t: 'op', v: '||' }); i += 2; continue }
    if (c === '<' && src[i + 1] === '>') { out.push({ t: 'op', v: '<>' }); i += 2; continue }
    if (c === '<' || c === '>' || c === '=') {
      let op = c
      if (src[i + 1] === '=') { op += '='; i++ }
      out.push({ t: 'op', v: op })
      i++
      continue
    }
    if ('+-*/'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue }
    if ('(),{}'.includes(c)) { out.push({ t: 'punc', v: c }); i++; continue }
    throw new Error(`Unexpected character "${c}"`)
  }
  return out
}

const AGG: Record<string, Agg> = {
  SUM: 'sum', AVERAGE: 'avg', AVG: 'avg', MIN: 'min', MAX: 'max',
  COUNT: 'count', COUNTA: 'count', DISTINCTCOUNT: 'distinctCount',
}

interface FilterPred extends Predicate {
  tableId: string
}

interface RowBinding {
  table: Table
  row: unknown[]
}

const asNum = (v: Val): number => {
  if (v == null) return NaN
  if (typeof v === 'number') return v
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

class Parser {
  private pos = 0
  constructor(
    private toks: Tok[],
    private ctx: QueryCtx,
    private scope: Record<string, Val> = {},
    private depth = 0,
    private filters: FilterPred[] = [],
    private rowCtx: Record<string, RowBinding> = {},
  ) {}

  private peek(o = 0): Tok | undefined { return this.toks[this.pos + o] }
  private next(): Tok | undefined { return this.toks[this.pos++] }
  private expect(t: string, v?: string) {
    const tok = this.next()
    if (!tok || tok.t !== t || (v !== undefined && tok.v !== v)) throw new Error(`Expected ${v ?? t}`)
    return tok
  }
  private isKw(w: string): boolean {
    const t = this.peek()
    return t?.t === 'ident' && (t.v as string).toUpperCase() === w
  }

  // ---- top-level ----
  parseProgram(): number {
    return asNum(this.parseValueProgram())
  }
  run(): Val {
    return this.parseValueProgram()
  }
  private parseValueProgram(): Val {
    while (this.isKw('VAR')) {
      this.next()
      const name = this.expect('ident').v as string
      this.expect('op', '=')
      this.scope[name] = this.parseValue()
      if (this.isKw('RETURN')) break
    }
    if (this.isKw('RETURN')) this.next()
    return this.parseValue()
  }

  // ---- value expression (arithmetic) ----
  private parseValue(): Val { return this.parseConcat() }
  private parseConcat(): Val {
    let left = this.parseAdd()
    while (this.peek()?.t === 'op' && (this.peek() as { v: string }).v === '&') {
      this.next()
      const right = this.parseAdd()
      left = String(left ?? '') + String(right ?? '')
    }
    return left
  }
  private parseAdd(): Val {
    let left = this.parseMul()
    while (this.peek()?.t === 'op' && '+-'.includes((this.peek() as { v: string }).v)) {
      const op = (this.next() as { v: string }).v
      const right = this.parseMul()
      left = op === '+' ? asNum(left) + asNum(right) : asNum(left) - asNum(right)
    }
    return left
  }
  private parseMul(): Val {
    let left = this.parseUnary()
    while (this.peek()?.t === 'op' && '*/'.includes((this.peek() as { v: string }).v)) {
      const op = (this.next() as { v: string }).v
      const right = this.parseUnary()
      const r = asNum(right)
      left = op === '*' ? asNum(left) * r : r === 0 ? 0 : asNum(left) / r
    }
    return left
  }
  private parseUnary(): Val {
    const tok = this.peek()
    if (tok?.t === 'op' && tok.v === '-') { this.next(); return -asNum(this.parseUnary()) }
    return this.parseFactor()
  }

  private parseFactor(): Val {
    const tok = this.peek()
    if (!tok) throw new Error('Unexpected end of expression')
    if (tok.t === 'num') { this.next(); return tok.v }
    if (tok.t === 'str') { this.next(); return tok.v }
    if (tok.t === 'punc' && tok.v === '(') { this.next(); const v = this.parseValue(); this.expect('punc', ')'); return v }
    // function call
    if (tok.t === 'ident' && this.peek(1)?.t === 'punc' && (this.peek(1) as { v: string }).v === '(') {
      return this.parseCall(tok.v.toUpperCase())
    }
    // column reference:  Table[Col]  or  'Table'[Col]
    if ((tok.t === 'table' || tok.t === 'ident') && this.peek(1)?.t === 'col') {
      const ref = this.readColumnRef()
      return this.columnValue(ref)
    }
    // bare [Measure]
    if (tok.t === 'col') { this.next(); return this.evalMeasure(tok.v) }
    // VAR reference
    if (tok.t === 'ident' && tok.v in this.scope) { this.next(); return this.scope[tok.v] }
    if (tok.t === 'ident') { this.next(); if (['TRUE', 'FALSE', 'BLANK'].includes(tok.v.toUpperCase())) return tok.v.toUpperCase() === 'TRUE' ? 1 : tok.v.toUpperCase() === 'FALSE' ? 0 : null; throw new Error(`Unknown identifier "${tok.v}"`) }
    throw new Error('Unsupported expression')
  }

  private aggFor(tableId: string, columnId: string, agg: Agg): number {
    const preds = this.filters.filter((f) => f.tableId === tableId)
    if (preds.length) return scalarWhere(this.ctx, { tableId, columnId, agg }, preds.map((p) => ({ columnIndex: p.columnIndex, op: p.op, value: p.value })))
    return scalar(this.ctx, { tableId, columnId, agg })
  }

  private parseCall(name: string): Val {
    this.next() // ident
    this.expect('punc', '(')

    if (name in AGG) {
      const ref = this.readColumnRef()
      this.expect('punc', ')')
      return this.aggFor(ref.tableId, ref.columnId, AGG[name])
    }
    if (name === 'COUNTROWS') {
      const src = this.readRowSource()
      this.expect('punc', ')')
      if (src.rowsExplicit) return src.rows.length
      return this.aggFor(src.table.id, '', 'count')
    }
    if (name === 'DIVIDE') {
      const a = asNum(this.parseValue()); this.expect('punc', ',')
      const b = asNum(this.parseValue())
      let alt = 0
      if (this.commaAhead()) { this.next(); alt = asNum(this.parseValue()) }
      this.expect('punc', ')')
      return b === 0 || !Number.isFinite(b) ? alt : a / b
    }
    if (name === 'CALCULATE') {
      const start = this.pos
      this.skipArg()
      const end = this.pos
      const preds: FilterPred[] = []
      while (this.commaAhead()) {
        this.next()
        this.collectPredicates(preds)
      }
      this.expect('punc', ')')
      const sub = new Parser(this.toks.slice(start, end), this.ctx, this.scope, this.depth + 1, [...this.filters, ...preds], this.rowCtx)
      return sub.parseValue()
    }
    if (name === 'SUMX' || name === 'AVERAGEX' || name === 'MINX' || name === 'MAXX' || name === 'COUNTX') {
      const src = this.readRowSource()
      this.expect('punc', ',')
      const start = this.pos; this.skipArg(); const end = this.pos
      this.expect('punc', ')')
      const vals: number[] = []
      for (const row of src.rows) {
        const rc = { ...this.rowCtx, [src.table.id]: { table: src.table, row } }
        const v = new Parser(this.toks.slice(start, end), this.ctx, this.scope, this.depth + 1, this.filters, rc).parseValue()
        const n = asNum(v)
        if (name === 'COUNTX') { if (v != null && v !== '') vals.push(1) }
        else if (Number.isFinite(n)) vals.push(n)
      }
      if (name === 'COUNTX') return vals.length
      if (name === 'SUMX') return vals.reduce((a, b) => a + b, 0)
      if (vals.length === 0) return 0
      if (name === 'AVERAGEX') return vals.reduce((a, b) => a + b, 0) / vals.length
      if (name === 'MINX') return Math.min(...vals)
      return Math.max(...vals)
    }
    if (name === 'RELATED') {
      const ref = this.readColumnRef()
      this.expect('punc', ')')
      return this.related(ref)
    }
    if (name === 'IF') {
      const cond = this.parseCondition(); this.expect('punc', ',')
      const t = this.captureArg()
      let f: Tok[] = []
      if (this.commaAhead()) { this.next(); f = this.captureArg() }
      this.expect('punc', ')')
      const branch = cond ? t : f
      return branch.length ? new Parser(branch, this.ctx, this.scope, this.depth + 1, this.filters, this.rowCtx).parseValue() : null
    }
    if (name === 'SWITCH') {
      const isTrue = this.isKw('TRUE') || (this.peek()?.t === 'ident' && String(this.peek()?.t === 'ident' && (this.peek() as { v: string }).v).toUpperCase() === 'TRUE')
      let selector: Val = null
      if (isTrue) { this.skipArg() } else { selector = this.parseValue() }
      this.expect('punc', ',')
      let result: Val = null
      let matched = false
      while (!this.rparenAhead()) {
        const cond = this.captureArg()
        if (this.commaAhead()) {
          this.next()
          const res = this.captureArg()
          if (!matched) {
            const hit = isTrue
              ? this.evalConditionToks(cond)
              : asNum(new Parser(cond, this.ctx, this.scope, this.depth + 1, this.filters, this.rowCtx).parseValue()) === asNum(selector)
            if (hit) { result = res.length ? new Parser(res, this.ctx, this.scope, this.depth + 1, this.filters, this.rowCtx).parseValue() : null; matched = true }
          }
          if (this.commaAhead()) this.next()
        } else {
          // trailing default
          if (!matched) result = cond.length ? new Parser(cond, this.ctx, this.scope, this.depth + 1, this.filters, this.rowCtx).parseValue() : null
        }
      }
      this.expect('punc', ')')
      return result
    }
    if (name === 'SELECTEDVALUE') {
      const ref = this.readColumnRef()
      let alt: Val = null
      if (this.commaAhead()) { this.next(); alt = this.parseValue() }
      this.expect('punc', ')')
      return this.selectedValue(ref, alt)
    }
    if (name === 'COALESCE') {
      let result: Val = null
      let done = false
      while (!this.rparenAhead()) {
        const v = this.parseValue()
        if (!done && v != null && v !== '') { result = v; done = true }
        if (this.commaAhead()) this.next()
      }
      this.expect('punc', ')')
      return result
    }
    if (name === 'ABS' || name === 'INT' || name === 'SQRT') {
      const v = asNum(this.parseValue()); this.expect('punc', ')')
      return name === 'ABS' ? Math.abs(v) : name === 'INT' ? Math.trunc(v) : Math.sqrt(v)
    }
    if (name === 'ROUND') {
      const v = asNum(this.parseValue()); this.expect('punc', ',')
      const d = asNum(this.parseValue()); this.expect('punc', ')')
      const f = 10 ** d
      return Math.round(v * f) / f
    }
    if (name === 'TRUE') { this.expect('punc', ')'); return 1 }
    if (name === 'FALSE') { this.expect('punc', ')'); return 0 }
    if (name === 'BLANK') { this.expect('punc', ')'); return null }
    throw new Error(`${name}() — live preview not available`)
  }

  // ---- row sources for iterators / COUNTROWS ----
  private readRowSource(): { table: Table; rows: unknown[][]; rowsExplicit: boolean } {
    const t = this.peek()
    if (t?.t === 'ident' && this.peek(1)?.t === 'punc' && (this.peek(1) as { v: string }).v === '(') {
      const fn = t.v.toUpperCase()
      if (fn === 'FILTER') {
        this.next(); this.expect('punc', '(')
        const base = this.readRowSource()
        this.expect('punc', ',')
        const start = this.pos; this.skipArg(); const end = this.pos
        this.expect('punc', ')')
        const condToks = this.toks.slice(start, end)
        const rows = base.rows.filter((row) => {
          const rc = { ...this.rowCtx, [base.table.id]: { table: base.table, row } }
          return new Parser(condToks, this.ctx, this.scope, this.depth + 1, this.filters, rc).parseCondition()
        })
        return { table: base.table, rows, rowsExplicit: true }
      }
      if (fn === 'ALL' || fn === 'VALUES' || fn === 'ALLSELECTED' || fn === 'DISTINCT') {
        this.next(); this.expect('punc', '(')
        const base = this.readRowSource()
        this.skipToClose()
        return { table: base.table, rows: base.rows, rowsExplicit: false }
      }
    }
    const tableId = this.readTableRef()
    const table = this.ctx.model.tables.find((x) => x.id === tableId)!
    const rows = this.ctx.byId[tableId]?.rows ?? []
    return { table, rows, rowsExplicit: false }
  }

  // ---- conditions (FILTER / IF) ----
  parseCondition(): boolean {
    let left = this.parseOr()
    return left
  }
  private parseOr(): boolean {
    let left = this.parseAnd()
    while ((this.peek()?.t === 'op' && (this.peek() as { v: string }).v === '||') || this.isKw('OR')) {
      this.next()
      const right = this.parseAnd()
      left = left || right
    }
    return left
  }
  private parseAnd(): boolean {
    let left = this.parseCmp()
    while ((this.peek()?.t === 'op' && (this.peek() as { v: string }).v === '&&') || this.isKw('AND')) {
      this.next()
      const right = this.parseCmp()
      left = left && right
    }
    return left
  }
  private parseCmp(): boolean {
    if (this.peek()?.t === 'punc' && (this.peek() as { v: string }).v === '(') {
      this.next(); const v = this.parseOr(); this.expect('punc', ')'); return v
    }
    const left = this.parseValue()
    const t = this.peek()
    if (t?.t === 'ident' && t.v.toUpperCase() === 'IN') {
      this.next(); this.expect('punc', '{')
      const set: Val[] = []
      while (!(this.peek()?.t === 'punc' && (this.peek() as { v: string }).v === '}')) {
        const vt = this.next()
        if (vt?.t === 'str') set.push(vt.v)
        else if (vt?.t === 'num') set.push(vt.v)
        else if (vt?.t === 'ident') set.push(vt.v)
        if (this.commaAhead()) this.next()
      }
      this.expect('punc', '}')
      return set.some((s) => String(s) === String(left))
    }
    if (t?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
      this.next()
      const right = this.parseValue()
      return cmp(left, t.v, right)
    }
    // bare truthy
    return left != null && left !== 0 && left !== ''
  }
  private evalConditionToks(toks: Tok[]): boolean {
    return new Parser(toks, this.ctx, this.scope, this.depth + 1, this.filters, this.rowCtx).parseCondition()
  }

  // ---- CALCULATE predicate collection (incl. FILTER unwrap) ----
  private collectPredicates(out: FilterPred[]) {
    // FILTER(table, col op val [&& ...]) → predicate(s); or a bare col op val.
    if (this.isKw('FILTER')) {
      this.next(); this.expect('punc', '(')
      const src = this.readRowSource()
      this.expect('punc', ',')
      // read simple "col op val" chained by && as same-table predicates
      this.readSimplePredicates(src.table.id, out)
      this.skipToClose()
      return
    }
    const before = this.pos
    const p = this.parsePredicate()
    if (p) out.push(p)
    else { this.pos = before; this.skipArg() }
  }
  private readSimplePredicates(tableId: string, out: FilterPred[]) {
    for (;;) {
      const before = this.pos
      const p = this.parsePredicate()
      if (p) out.push(p)
      else { this.pos = before; break }
      if (this.peek()?.t === 'op' && (this.peek() as { v: string }).v === '&&') { this.next(); continue }
      break
    }
  }

  private parsePredicate(): FilterPred | null {
    try {
      const ref = this.readColumnRef()
      const opTok = this.peek()
      // IN {..}
      if (opTok?.t === 'ident' && opTok.v.toUpperCase() === 'IN') {
        this.next(); this.expect('punc', '{')
        const first = this.next()
        const value = first?.t === 'str' ? first.v : first?.t === 'num' ? first.v : String(first?.v ?? '')
        // consume the rest of the set (preview approximates IN by its first member)
        while (!(this.peek()?.t === 'punc' && (this.peek() as { v: string }).v === '}')) this.next()
        this.expect('punc', '}')
        const columnIndex = this.colIndexOf(ref.tableId, ref.columnId)
        if (columnIndex < 0) return null
        return { tableId: ref.tableId, columnIndex, op: '=', value }
      }
      if (!opTok || opTok.t !== 'op') return null
      this.next()
      const valTok = this.next()
      let value: string | number
      if (valTok?.t === 'num') value = valTok.v
      else if (valTok?.t === 'str') value = valTok.v
      else if (valTok?.t === 'ident') value = String(valTok.v)
      else return null
      const columnIndex = this.colIndexOf(ref.tableId, ref.columnId)
      if (columnIndex < 0) return null
      return { tableId: ref.tableId, columnIndex, op: opTok.v, value }
    } catch {
      return null
    }
  }

  // ---- helpers ----
  private commaAhead(): boolean { return this.peek()?.t === 'punc' && (this.peek() as { v: string }).v === ',' }
  private rparenAhead(): boolean { return this.peek()?.t === 'punc' && (this.peek() as { v: string }).v === ')' }

  private captureArg(): Tok[] {
    const start = this.pos
    this.skipArg()
    return this.toks.slice(start, this.pos)
  }
  private skipArg() {
    let depth = 0
    while (this.pos < this.toks.length) {
      const t = this.toks[this.pos]
      if (t.t === 'punc' && (t.v === '(' || t.v === '{')) depth++
      else if (t.t === 'punc' && (t.v === ')' || t.v === '}')) { if (depth === 0) break; depth-- }
      else if (t.t === 'punc' && t.v === ',' && depth === 0) break
      this.pos++
    }
  }
  private skipToClose() {
    let depth = 0
    while (this.pos < this.toks.length) {
      const t = this.toks[this.pos]
      if (t.t === 'punc' && (t.v === '(' || t.v === '{')) depth++
      else if (t.t === 'punc' && (t.v === ')' || t.v === '}')) { if (depth === 0) { this.pos++; return }; depth-- }
      this.pos++
    }
  }

  private colIndexOf(tableId: string, columnId: string): number {
    const t = this.ctx.model.tables.find((x) => x.id === tableId)
    return t ? t.columns.findIndex((c) => c.id === columnId) : -1
  }

  private columnValue(ref: { tableId: string; columnId: string }): Val {
    const b = this.rowCtx[ref.tableId]
    if (b) {
      const idx = b.table.columns.findIndex((c) => c.id === ref.columnId)
      const cell = idx >= 0 ? b.row[idx] : null
      return (cell ?? null) as Val
    }
    throw new Error('Column reference needs a row context (SUMX/AVERAGEX/FILTER)')
  }

  private related(ref: { tableId: string; columnId: string }): Val {
    // Follow a many→one relationship from a table in the current row context.
    const rel = this.ctx.model.relationships.find((r) => this.rowCtx[r.fromTable] && r.toTable === ref.tableId)
    if (!rel) throw new Error('RELATED needs an active relationship in row context')
    const from = this.rowCtx[rel.fromTable]
    const fromIdx = from.table.columns.findIndex((c) => c.id === rel.fromColumn)
    const fkVal = String(from.row[fromIdx] ?? '')
    const target = this.ctx.model.tables.find((t) => t.id === ref.tableId)!
    const keyIdx = target.columns.findIndex((c) => c.id === rel.toColumn)
    const valIdx = target.columns.findIndex((c) => c.id === ref.columnId)
    const rows = this.ctx.byId[ref.tableId]?.rows ?? []
    const hit = rows.find((r) => String(r[keyIdx] ?? '') === fkVal)
    return hit ? ((hit[valIdx] ?? null) as Val) : null
  }

  private selectedValue(ref: { tableId: string; columnId: string }, alt: Val): Val {
    const idx = this.colIndexOf(ref.tableId, ref.columnId)
    const rows = this.ctx.byId[ref.tableId]?.rows ?? []
    const seen = new Set<string>()
    let last: Val = null
    for (const r of rows) {
      const c = r[idx]
      seen.add(String(c))
      last = (c ?? null) as Val
      if (seen.size > 1) return alt
    }
    return seen.size === 1 ? last : alt
  }

  private readColumnRef(): { tableId: string; columnId: string } {
    let tableName: string | null = null
    const t = this.peek()
    if (t?.t === 'table' || t?.t === 'ident') tableName = String((this.next() as { v: string | number }).v)
    const col = String(this.expect('col').v)
    const model = this.ctx.model
    const table = tableName
      ? model.tables.find((x) => x.name.toLowerCase() === tableName!.toLowerCase())
      : model.tables.find((x) => x.columns.some((c) => c.name === col))
    if (!table) throw new Error(`Table "${tableName ?? '?'}" not found`)
    const column = table.columns.find((c) => c.name.toLowerCase() === col.toLowerCase())
    if (!column) throw new Error(`Column "${col}" not found in ${table.name}`)
    return { tableId: table.id, columnId: column.id }
  }

  private readTableRef(): string {
    const t = this.next()
    if (!t || (t.t !== 'table' && t.t !== 'ident')) throw new Error('Expected a table')
    const name = String(t.v)
    const table = this.ctx.model.tables.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!table) throw new Error(`Table "${name}" not found`)
    return table.id
  }

  private evalMeasure(name: string): Val {
    if (this.depth > 12) throw new Error('Measure recursion too deep')
    for (const t of this.ctx.model.tables) {
      const m = t.measures.find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (m) return new Parser(tokenize(m.expression), this.ctx, {}, this.depth + 1, this.filters, this.rowCtx).parseValueProgram()
    }
    throw new Error(`Measure "${name}" not found`)
  }
}

function cmp(a: Val, op: string, b: Val): boolean {
  const bothNum = typeof a === 'number' && (typeof b === 'number' || (typeof b === 'string' && b !== '' && Number.isFinite(Number(b))))
  const A = bothNum ? asNum(a) : String(a ?? '')
  const B = bothNum ? asNum(b) : String(b ?? '')
  switch (op) {
    case '=': return A === B
    case '<>': return A !== B
    case '<': return A < B
    case '>': return A > B
    case '<=': return A <= B
    case '>=': return A >= B
    default: return false
  }
}

export function evaluateDax(expression: string, ctx: QueryCtx): EvalResult {
  try {
    const toks = tokenize(expression)
    if (toks.length === 0) return { ok: false, note: 'Empty expression' }
    const value = new Parser(toks, ctx).run()
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value }
    // Text-valued measures (RAG labels, dynamic titles) — show the text.
    if (typeof value === 'string' && value !== '') return { ok: false, note: `“${value}”` }
    return { ok: false, note: 'No single value in this context' }
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : 'Could not evaluate' }
  }
}
