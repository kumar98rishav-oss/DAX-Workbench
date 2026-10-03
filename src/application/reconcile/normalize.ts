/**
 * APPLICATION — Key normalization (the trap layer)
 *
 * Two engines return "the same" key in different shapes. Before anything can be
 * joined, every key value passes through here — one normalizer, one place, so a
 * fix lands on both sides at once.
 *
 * What this exists to survive:
 *  - SQL Server pads CHAR(n) columns with spaces:  'ABC       ' vs 'ABC'
 *  - DATE vs DATETIME:                             2024-01-01 vs 2024-01-01T00:00:00
 *  - Numeric drift:                                1 vs "1" vs 1.0
 *  - Collation:                                    'ABC' vs 'abc'
 *  - bit vs boolean:                               1 vs true
 *
 * Every normalized value carries a TYPE TAG so a null cannot be confused with
 * the literal string "null", and a numeric 1 cannot be confused with the string
 * "1" unless we deliberately decided they are the same key.
 */

export interface NormalizeOptions {
  /** Fold case. Defaults true because SQL Server's default collation is
   * case-insensitive; `/sql/test` reports the real collation so the UI can set
   * this correctly per connection. */
  caseInsensitive: boolean
  /** Trim whitespace. Defaults true — CHAR padding would otherwise break every
   * join on a fixed-width column. */
  trim: boolean
  /** 'date' compares calendar days and ignores any time component. */
  dateGranularity: 'date' | 'datetime'
}

export const DEFAULT_NORMALIZE: NormalizeOptions = {
  caseInsensitive: true,
  trim: true,
  dateGranularity: 'date',
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * Canonical numeric form, or null when the text should stay a string.
 *
 * A LEADING ZERO means the value is an identifier, not a number: product code
 * "007" must not collapse onto 7, or two different products reconcile as one.
 * This is the one place where being clever would lose data.
 */
export function canonicalNumber(text: string): string | null {
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null
  if (/^-?0\d/.test(text)) return null // "007", "-012" — an identifier
  const n = Number(text)
  if (!Number.isFinite(n)) return null
  return String(n) // "1.0" → "1", "1.50" → "1.5"
}

/** Pad a number to two digits without pulling in a date library. */
const p2 = (n: number) => String(n).padStart(2, '0')

/**
 * A Date's parts, read in UTC.
 *
 * UTC rather than local on purpose: engine values reach us as JSON, where a
 * date is serialized with a Z. Reading those back with local getters would
 * shift every row to the previous day in any negative-offset timezone — a
 * whole-day reconciliation error caused purely by where the user is sitting.
 */
function canonicalDate(d: Date, granularity: NormalizeOptions['dateGranularity']): string {
  const day = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
  if (granularity === 'date') return day
  return `${day}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
}

/**
 * One key value → a tagged canonical string.
 *
 * Tags: `n` null · `d` number · `t` date · `s` string
 */
export function normalizeKeyValue(value: unknown, opts: NormalizeOptions = DEFAULT_NORMALIZE): string {
  if (value === null || value === undefined) return 'n:'

  // bit vs boolean: SQL may hand back 1/0, the model true/false. Canonicalize
  // both to the numeric form so they join.
  if (typeof value === 'boolean') return `d:${value ? 1 : 0}`

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'n:' : `t:${canonicalDate(value, opts.dateGranularity)}`
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'n:'
    return `d:${String(value)}`
  }

  let text = String(value)
  if (opts.trim) text = text.trim()

  // Date-shaped text, from either engine's serialization. Parts are read
  // straight out of the string whenever it carries no timezone — handing a
  // naive datetime to `new Date()` would reinterpret it as local time and can
  // move a row to the adjacent day.
  if (ISO_DATE.test(text)) {
    return `t:${opts.dateGranularity === 'date' ? text : `${text}T00:00:00`}`
  }
  const dt = text.match(ISO_DATETIME)
  if (dt) {
    const [, y, mo, d, h, mi, s, , tz] = dt
    if (!tz) {
      return `t:${opts.dateGranularity === 'date' ? `${y}-${mo}-${d}` : `${y}-${mo}-${d}T${h}:${mi}:${s}`}`
    }
    const parsed = new Date(text)
    if (!Number.isNaN(parsed.getTime())) return `t:${canonicalDate(parsed, opts.dateGranularity)}`
  }

  const num = canonicalNumber(text)
  if (num !== null) return `d:${num}`

  if (opts.caseInsensitive) text = text.toLowerCase()
  return `s:${text}`
}

/**
 * Join normalized parts into one collision-proof key.
 *
 * Length-prefixing is what makes this safe. A plain delimiter cannot work:
 * OrderID=1 + Line=23 and OrderID=12 + Line=3 both concatenate to "123" — two
 * different rows reconciling as one. With lengths the boundary is unambiguous
 * and no escaping is needed:
 *
 *   ["d:1", "d:23"] → "3:d:1|4:d:23"
 *   ["d:12", "d:3"] → "4:d:12|3:d:3"
 */
export function compositeKey(parts: string[]): string {
  return parts.map((p) => `${p.length}:${p}`).join('|')
}

/** Strip the type tag for display. */
export function displayKeyPart(normalized: string): string {
  const i = normalized.indexOf(':')
  if (i < 0) return normalized
  const tag = normalized.slice(0, i)
  const rest = normalized.slice(i + 1)
  return tag === 'n' ? '(blank)' : rest
}

/**
 * A value being compared, as a number.
 *
 * Returns null for anything non-numeric: a value column that is not a number is
 * a configuration mistake, and silently coercing it to 0 would manufacture a
 * clean reconciliation out of nonsense.
 */
export function toComparableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  const text = String(value).trim()
  if (text === '') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}
