/**
 * APPLICATION — DAX *query* formatting
 *
 * `formatDax` (application/dax/formatter) formats a measure EXPRESSION, which
 * is what the DAX tab works with. The Reconcile pane holds a whole QUERY —
 * `DEFINE … EVALUATE … ORDER BY …` — and those keywords are statements in their
 * own right, so leaving them inline reads as `EVALUATE SUMMARIZE (`, which
 * buries the thing the query actually is.
 *
 * This wraps rather than edits the shared formatter on purpose: the DAX tab
 * depends on it, and a query-shaped concern should not change how a measure is
 * rendered there.
 */
import { formatDax } from '@/application/dax/formatter'

/** Query-level keywords that start their own line. ORDER BY and START AT are
 * two words, so they are matched before their first words would be. */
const QUERY_KEYWORDS = /\b(DEFINE|EVALUATE|ORDER\s+BY|START\s+AT|MEASURE|VAR|RETURN)\b/gi

export function formatDaxQuery(dax: string): string {
  if (!dax.trim()) return dax

  // Only this one rule, and only anchored to the start of a line.
  //
  // An unanchored rule for ORDER BY / START AT was written first and then
  // deleted: it did not mask string literals, so a measure column genuinely
  // named "Order By" would have been split in half. The formatter's whole value
  // is that the query still means what it meant, and a tidier layout is not
  // worth a rule that can corrupt one query in a thousand.
  //
  // Anchoring is what makes this safe. DAX string literals cannot span a
  // newline, so a line that BEGINS with EVALUATE or DEFINE is always the
  // keyword and never text inside quotes.
  return formatDax(dax)
    .replace(/^([ \t]*)(EVALUATE|DEFINE)[ \t]+(?=\S)/gim, '$1$2\n$1')
    .replace(/[ \t]+$/gm, '')
}

export { QUERY_KEYWORDS }
