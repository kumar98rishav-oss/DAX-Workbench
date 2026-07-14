/**
 * APPLICATION — DAX preview evaluator (subset, pure)
 * Evaluates a useful subset of DAX against the in-memory data: aggregations,
 * DIVIDE, arithmetic, VAR/RETURN, measure refs, and CALCULATE(...) with
 * same-table equality/comparison filters. Anything outside the subset returns
 * a friendly note instead of failing.
 */
import type { QueryCtx, Agg, Predicate } from '@/application/query/query-engine'
import { scalar, scalarWhere } from '@/application/query/query-engine'

export type EvalResult = { ok: true; value: number } | { ok: false; note: string }

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
      let j = i + 1
      while (j < src.length && /[0-9.,]/.test(src[j])) j++
      out.push({ t: 'num', v: Number(src.slice(i, j).replace(/,/g, '')) })
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
    if (c === '<' && src[i + 1] === '>') { out.push({ t: 'op', v: '<>' }); i += 2; continue }
    if ((c === '<' || c === '>' || c === '=') ) {
      let op = c
      if (src[i + 1] === '=') { op += '='; i++ }
      out.push({ t: 'op', v: op })
      i++
      continue
    }
    if ('+-*/'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue }
    if ('(),'.includes(c)) { out.push({ t: 'punc', v: c }); i++; continue }
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

class Parser {
  private pos = 0
  constructor(
    private toks: Tok[],
    private ctx: QueryCtx,
    private scope: Record<string, number> = {},
    private depth = 0,
    private filters: FilterPred[] = [],
  ) {}

  private peek(): Tok | undefined { return this.toks[this.pos] }
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

  parseProgram(): number {
    while (this.isKw('VAR')) {
      this.next()
      const name = this.expect('ident').v as string
      this.expect('op', '=')
      this.scope[name] = this.parseExpr()
      if (this.isKw('RETURN')) break
    }
    if (this.isKw('RETURN')) this.next()
    return this.parseExpr()
  }

  parseExpr(): number {
    let left = this.parseTerm()
    while (this.peek()?.t === 'op' && '+-'.includes((this.peek() as { v: string }).v)) {
      const op = (this.next() as { v: string }).v
      const right = this.parseTerm()
      left = op === '+' ? left + right : left - right
    }
    return left
  }
  parseTerm(): number {
    let left = this.parseFactor()
    while (this.peek()?.t === 'op' && '*/'.includes((this.peek() as { v: string }).v)) {
      const op = (this.next() as { v: string }).v
      const right = this.parseFactor()
      left = op === '*' ? left * right : right === 0 ? 0 : left / right
    }
    return left
  }
  parseFactor(): number {
    const tok = this.peek()
    if (!tok) throw new Error('Unexpected end of expression')
    if (tok.t === 'op' && tok.v === '-') { this.next(); return -this.parseFactor() }
    if (tok.t === 'num') { this.next(); return tok.v }
    if (tok.t === 'punc' && tok.v === '(') { this.next(); const v = this.parseExpr(); this.expect('punc', ')'); return v }
    if (tok.t === 'col') { this.next(); return this.evalMeasure(tok.v) }
    if (tok.t === 'ident') {
      const name = tok.v.toUpperCase()
      if (this.toks[this.pos + 1]?.t === 'punc' && (this.toks[this.pos + 1] as { v: string }).v === '(') return this.parseCall(name)
      if (tok.v in this.scope) { this.next(); return this.scope[tok.v] }
      throw new Error(`Unknown identifier "${tok.v}"`)
    }
    throw new Error('Unsupported expression')
  }

  private aggFor(tableId: string, columnId: string, agg: Agg): number {
    const preds = this.filters.filter((f) => f.tableId === tableId)
    if (preds.length) return scalarWhere(this.ctx, { tableId, columnId, agg }, preds.map((p) => ({ columnIndex: p.columnIndex, op: p.op, value: p.value })))
    return scalar(this.ctx, { tableId, columnId, agg })
  }

  private parseCall(name: string): number {
    this.next() // ident
    this.expect('punc', '(')

    if (name in AGG) {
      const ref = this.readColumnRef()
      this.expect('punc', ')')
      return this.aggFor(ref.tableId, ref.columnId, AGG[name])
    }
    if (name === 'COUNTROWS') {
      const tableId = this.readTableRef()
      this.expect('punc', ')')
      return this.aggFor(tableId, '', 'count')
    }
    if (name === 'DIVIDE') {
      const a = this.parseExpr(); this.expect('punc', ',')
      const b = this.parseExpr()
      let alt = 0
      if (this.peek()?.t === 'punc' && (this.peek() as { v: string }).v === ',') { this.next(); alt = this.parseExpr() }
      this.expect('punc', ')')
      return b === 0 ? alt : a / b
    }
    if (name === 'CALCULATE') {
      const start = this.pos
      this.skipArg()
      const end = this.pos
      const preds: FilterPred[] = []
      while (this.peek()?.t === 'punc' && (this.peek() as { v: string }).v === ',') {
        this.next()
        const p = this.parsePredicate()
        if (p) preds.push(p)
        else this.skipArg() // unsupported filter — ignore
      }
      this.expect('punc', ')')
      const sub = new Parser(this.toks.slice(start, end), this.ctx, this.scope, this.depth + 1, [...this.filters, ...preds])
      return sub.parseExpr()
    }
    if (name === 'ABS' || name === 'INT' || name === 'SQRT') {
      const v = this.parseExpr(); this.expect('punc', ')')
      return name === 'ABS' ? Math.abs(v) : name === 'INT' ? Math.trunc(v) : Math.sqrt(v)
    }
    if (name === 'ROUND') {
      const v = this.parseExpr(); this.expect('punc', ',')
      const d = this.parseExpr(); this.expect('punc', ')')
      const f = 10 ** d
      return Math.round(v * f) / f
    }
    throw new Error(`${name}() is not supported in the preview`)
  }

  private skipArg() {
    let depth = 0
    while (this.pos < this.toks.length) {
      const t = this.toks[this.pos]
      if (t.t === 'punc' && t.v === '(') depth++
      else if (t.t === 'punc' && t.v === ')') { if (depth === 0) break; depth-- }
      else if (t.t === 'punc' && t.v === ',' && depth === 0) break
      this.pos++
    }
  }

  private parsePredicate(): FilterPred | null {
    try {
      const ref = this.readColumnRef()
      const opTok = this.next()
      if (!opTok || opTok.t !== 'op') return null
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

  private colIndexOf(tableId: string, columnId: string): number {
    const t = this.ctx.model.tables.find((x) => x.id === tableId)
    return t ? t.columns.findIndex((c) => c.id === columnId) : -1
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

  private evalMeasure(name: string): number {
    if (this.depth > 8) throw new Error('Measure recursion too deep')
    for (const t of this.ctx.model.tables) {
      const m = t.measures.find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (m) return new Parser(tokenize(m.expression), this.ctx, {}, this.depth + 1, this.filters).parseProgram()
    }
    throw new Error(`Measure "${name}" not found`)
  }
}

export function evaluateDax(expression: string, ctx: QueryCtx): EvalResult {
  try {
    const toks = tokenize(expression)
    if (toks.length === 0) return { ok: false, note: 'Empty expression' }
    const value = new Parser(toks, ctx).parseProgram()
    if (!Number.isFinite(value)) return { ok: false, note: 'Result is not a finite number' }
    return { ok: true, value }
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : 'Could not evaluate' }
  }
}
