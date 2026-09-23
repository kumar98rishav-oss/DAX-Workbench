/**
 * APPLICATION — DAX Autocomplete Engine (pure logic, no DOM/React)
 *
 * Given the raw DAX text, the cursor position, and the semantic model,
 * determines what kind of completion the user needs and returns a ranked
 * list of suggestions — functions, tables, columns, or measures.
 *
 * Context detection mirrors how Power BI Desktop's formula bar works:
 *   'Tab..  → table names
 *   'Table'[  or Table[  → columns of that table
 *   [  (bare)  → measures
 *   letters  → DAX functions + table names
 */
import type { SemanticModel } from '@/domain/model'
import { searchDax, DAX_BY_NAME } from './functions'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CompletionKind = 'function' | 'table' | 'column' | 'measure'

export interface DaxCompletion {
  kind: CompletionKind
  /** Display label in the popup. */
  label: string
  /** Text to splice into the textarea. */
  insertText: string
  /** Secondary text — syntax signature or data type. */
  detail: string
  /** Byte offset in the original text where the replacement starts. */
  replaceFrom: number
  /** Byte offset in the original text where the replacement ends (= cursor). */
  replaceTo: number
}

export interface SignatureHelp {
  name: string
  syntax: string
  description: string
}

export interface CompletionResult {
  items: DaxCompletion[]
  /** The prefix the user has typed so far (used for highlighting). */
  prefix: string
  /** The function we are currently inside, for showing syntax help. */
  signatureHelp?: SignatureHelp
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ITEMS = 12

// ---------------------------------------------------------------------------
// Context detection helpers
// ---------------------------------------------------------------------------

/** Walk backwards from `pos` collecting word characters. */
function wordBefore(text: string, pos: number): { word: string; start: number } {
  let i = pos - 1
  while (i >= 0 && /[A-Za-z0-9_.]/.test(text[i])) i--
  return { word: text.slice(i + 1, pos), start: i + 1 }
}

/** Find the table name in a `'Table'[` or `Table[` pattern ending at `pos`. */
function tableBefore(text: string, bracketPos: number): string | null {
  const before = text.slice(0, bracketPos)
  // 'Quoted Table Name'[
  const quoted = before.match(/'([^']+)'\s*$/)
  if (quoted) return quoted[1]
  // UnquotedTable[
  const bare = before.match(/([A-Za-z_]\w*)\s*$/)
  if (bare) return bare[1]
  return null
}

/** Are we inside an unclosed single quote? (i.e. typing a table name) */
function inUnclosedQuote(text: string, pos: number): { yes: boolean; start: number } {
  let count = 0
  let lastQuote = -1
  for (let i = 0; i < pos; i++) {
    if (text[i] === "'") {
      count++
      lastQuote = i
    }
  }
  return { yes: count % 2 === 1, start: lastQuote }
}

/** Find which function we are inside, based on unclosed parentheses. */
function getActiveFunction(text: string, pos: number): SignatureHelp | undefined {
  let parens = 0
  let i = pos - 1
  let inString = false
  while (i >= 0) {
    const char = text[i]
    if (char === '"') inString = !inString
    else if (!inString) {
      if (char === ')') parens++
      else if (char === '(') {
        parens--
        if (parens < 0) {
          // Found the open parenthesis for our current scope
          const { word } = wordBefore(text, i)
          if (word) {
            const fn = DAX_BY_NAME[word.toUpperCase()]
            if (fn) return { name: fn.name, syntax: fn.syntax, description: fn.description }
          }
          parens = 0 // reset and keep looking for outer scope if this wasn't a valid function? No, usually we just take the first match.
        }
      }
    }
    i--
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Compute completions for the given cursor position.
 * Returns an empty array when nothing is appropriate (no popup).
 */
export function getCompletions(
  text: string,
  cursorPos: number,
  model: SemanticModel,
): CompletionResult {
  const sigHelp = getActiveFunction(text, cursorPos)
  const empty: CompletionResult = { items: [], prefix: '', signatureHelp: sigHelp }
  if (!text || cursorPos <= 0) return empty

  const charBefore = text[cursorPos - 1]

  // -----------------------------------------------------------------------
  // 1) '[' after a table name → column completions
  // -----------------------------------------------------------------------
  if (charBefore === '[') {
    const tblName = tableBefore(text, cursorPos - 1)
    if (tblName) {
      const tbl = model.tables.find(
        (t) => t.name.toLowerCase() === tblName.toLowerCase(),
      )
      if (tbl) {
        const items: DaxCompletion[] = tbl.columns
          .filter((c) => !c.isHidden)
          .map((c) => ({
            kind: 'column' as const,
            label: c.name,
            insertText: `${c.name}]`,
            detail: c.dataType,
            replaceFrom: cursorPos,
            replaceTo: cursorPos,
          }))
        return { items: items.slice(0, MAX_ITEMS), prefix: '', signatureHelp: sigHelp }
      }
    }

    // Bare '[' with no table → measure completions
    const measures = model.tables.flatMap((t) =>
      t.measures
        .filter((m) => !m.isAutoGenerated)
        .map((m) => ({
          kind: 'measure' as const,
          label: m.name,
          insertText: `${m.name}]`,
          detail: truncateExpr(m.expression),
          replaceFrom: cursorPos,
          replaceTo: cursorPos,
        })),
    )
    return { items: measures.slice(0, MAX_ITEMS), prefix: '', signatureHelp: sigHelp }
  }

  // -----------------------------------------------------------------------
  // 2) Inside '[...' — column or measure, with partial text typed
  // -----------------------------------------------------------------------
  const lastBracket = text.lastIndexOf('[', cursorPos - 1)
  if (lastBracket >= 0) {
    const segment = text.slice(lastBracket + 1, cursorPos)
    if (!segment.includes(']')) {
      const prefix = segment.toLowerCase()

      const tblName = tableBefore(text, lastBracket)
      if (tblName) {
        const tbl = model.tables.find(
          (t) => t.name.toLowerCase() === tblName.toLowerCase(),
        )
        if (tbl) {
          const items: DaxCompletion[] = tbl.columns
            .filter(
              (c) =>
                !c.isHidden && c.name.toLowerCase().includes(prefix),
            )
            .map((c) => ({
              kind: 'column' as const,
              label: c.name,
              insertText: `${c.name}]`,
              detail: c.dataType,
              replaceFrom: lastBracket + 1,
              replaceTo: cursorPos,
            }))
          if (items.length > 0) {
            return { items: items.slice(0, MAX_ITEMS), prefix: segment, signatureHelp: sigHelp }
          }
        }
      } else {
        const measures = model.tables.flatMap((t) =>
          t.measures
            .filter(
              (m) =>
                !m.isAutoGenerated &&
                m.name.toLowerCase().includes(prefix),
            )
            .map((m) => ({
              kind: 'measure' as const,
              label: m.name,
              insertText: `${m.name}]`,
              detail: truncateExpr(m.expression),
              replaceFrom: lastBracket + 1,
              replaceTo: cursorPos,
            })),
        )
        if (measures.length > 0) {
          return { items: measures.slice(0, MAX_ITEMS), prefix: segment, signatureHelp: sigHelp }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // 3) Inside an unclosed single quote → table name completion
  // -----------------------------------------------------------------------
  const quote = inUnclosedQuote(text, cursorPos)
  if (quote.yes) {
    const typed = text.slice(quote.start + 1, cursorPos)
    const prefix = typed.toLowerCase()
    const items: DaxCompletion[] = model.tables
      .filter(
        (t) => !t.isHidden && t.name.toLowerCase().includes(prefix),
      )
      .map((t) => ({
        kind: 'table' as const,
        label: t.name,
        insertText: `${t.name}'`,
        detail: `${t.columns.length} cols · ${t.measures.length} measures`,
        replaceFrom: quote.start + 1,
        replaceTo: cursorPos,
      }))
    return { items: items.slice(0, MAX_ITEMS), prefix: typed, signatureHelp: sigHelp }
  }

  // -----------------------------------------------------------------------
  // 4) Word prefix or empty space → DAX functions, tables, measures
  // -----------------------------------------------------------------------
  const { word, start } = wordBefore(text, cursorPos)
  const prefix = word.toLowerCase()

  // If no word and not right after a trigger character (like space or parenthesis), we might still want to show all.
  // Actually, Power BI shows completions on Ctrl+Space or after certain tokens. We'll show them if they type.
  // If word is empty, we only show completions if explicitly requested or we just opened a parenthesis, but for now we can just return a default list if they type a letter.
  
  const fns: DaxCompletion[] = searchDax(prefix, MAX_ITEMS).map((fn) => ({
    kind: 'function' as const,
    label: fn.name,
    insertText: `${fn.name}(`,
    detail: fn.syntax,
    replaceFrom: start,
    replaceTo: cursorPos,
  }))

  const tables: DaxCompletion[] = model.tables
    .filter(
      (t) =>
        !t.isHidden &&
        t.name.toLowerCase().includes(prefix)
    )
    .map((t) => {
      // If table name has spaces or special chars, quote it
      const needsQuotes = /[^a-zA-Z0-9_]/.test(t.name)
      const insert = needsQuotes ? `'${t.name}'` : t.name
      return {
        kind: 'table' as const,
        label: t.name,
        insertText: insert,
        detail: `${t.columns.length} columns`,
        replaceFrom: start,
        replaceTo: cursorPos,
      }
    })

  const measures: DaxCompletion[] = model.tables.flatMap((t) =>
    t.measures
      .filter(
        (m) =>
          !m.isAutoGenerated &&
          m.name.toLowerCase().includes(prefix),
      )
      .map((m) => ({
        kind: 'measure' as const,
        label: m.name,
        insertText: `[${m.name}]`,
        detail: truncateExpr(m.expression),
        replaceFrom: start,
        replaceTo: cursorPos,
      }))
  )

  const combined = [...measures, ...fns, ...tables].slice(0, MAX_ITEMS)

  if (
    combined.length === 1 &&
    combined[0].kind === 'function' &&
    combined[0].label.toLowerCase() === prefix
  ) {
    return empty
  }

  // Only return if there's actually a word typed, or if we want to show it on empty (maybe limit to 10)
  if (word.length === 0) {
    // If we want to show suggestions on empty word (e.g. right after '('), we can, but let's avoid popping up on every space.
    // If the char before is '(' or ',' or a space after those, it's a good place.
    const beforeCursor = text.slice(0, cursorPos).trimEnd()
    const lastChar = beforeCursor[beforeCursor.length - 1]
    if (lastChar !== '(' && lastChar !== ',') {
      return empty
    }
  }

  return { items: combined, prefix: word, signatureHelp: sigHelp }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateExpr(expr: string): string {
  const line = (expr ?? '').split('\n')[0].trim()
  return line.length > 50 ? line.slice(0, 47) + '…' : line
}
