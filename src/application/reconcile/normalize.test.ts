/**
 * L3 — Normalizer trap tests.
 *
 * One named test per way the two engines disagree about "the same" key. These
 * are the failures that make a reconciliation tool quietly wrong, so each is
 * pinned here rather than left to be rediscovered against a real warehouse.
 */
import { describe, it, expect } from 'vitest'
import {
  canonicalNumber,
  compositeKey,
  displayKeyPart,
  normalizeKeyValue,
  toComparableNumber,
  DEFAULT_NORMALIZE,
} from './normalize'

const n = (v: unknown, opts = DEFAULT_NORMALIZE) => normalizeKeyValue(v, opts)

describe('trap: CHAR(n) padding', () => {
  it('a space-padded CHAR value joins to its trimmed equivalent', () => {
    expect(n('ABC       ')).toBe(n('ABC'))
  })
  it('leading whitespace too', () => {
    expect(n('  ABC')).toBe(n('ABC'))
  })
  it('padding is kept when trimming is switched off', () => {
    const noTrim = { ...DEFAULT_NORMALIZE, trim: false }
    expect(n('ABC  ', noTrim)).not.toBe(n('ABC', noTrim))
  })
})

describe('trap: DATE vs DATETIME', () => {
  it('a bare date joins to the same day with a midnight time', () => {
    expect(n('2024-01-01')).toBe(n('2024-01-01T00:00:00'))
  })
  it('time of day is ignored at date granularity', () => {
    expect(n('2024-01-01T13:45:00')).toBe(n('2024-01-01'))
  })
  it('time of day is significant at datetime granularity', () => {
    const dt = { ...DEFAULT_NORMALIZE, dateGranularity: 'datetime' as const }
    expect(n('2024-01-01T13:45:00', dt)).not.toBe(n('2024-01-01T09:00:00', dt))
  })
  it('a naive datetime is NOT shifted by the local timezone', () => {
    // Reading '2024-01-01T00:00:00' through `new Date()` would reinterpret it
    // as local time; in a negative-offset zone that lands on 2023-12-31.
    expect(n('2024-01-01T00:00:00')).toBe('t:2024-01-01')
  })
  it('a UTC-serialized Date object keeps its UTC day', () => {
    expect(n(new Date('2024-01-01T00:00:00Z'))).toBe('t:2024-01-01')
  })
  it('an invalid date is treated as blank, not as a string', () => {
    expect(n(new Date('nonsense'))).toBe('n:')
  })
})

describe('trap: numeric drift', () => {
  it('number 1, string "1" and "1.0" are the same key', () => {
    expect(n(1)).toBe(n('1'))
    expect(n('1.0')).toBe(n(1))
    expect(n('1.50')).toBe(n(1.5))
  })
  it('a leading zero means an identifier and must NOT become a number', () => {
    // Product code "007" collapsing onto 7 would reconcile two different
    // products as one — the costliest possible kind of silent success.
    expect(n('007')).not.toBe(n(7))
    expect(n('007')).toBe('s:007')
  })
  it('canonicalNumber rejects leading zeros and non-numerics', () => {
    expect(canonicalNumber('1.0')).toBe('1')
    expect(canonicalNumber('-2.50')).toBe('-2.5')
    expect(canonicalNumber('007')).toBeNull()
    expect(canonicalNumber('-012')).toBeNull()
    expect(canonicalNumber('1,000')).toBeNull()
    expect(canonicalNumber('abc')).toBeNull()
  })
})

describe('trap: collation / case', () => {
  it('case is folded by default, matching SQL Server default collation', () => {
    expect(n('ABC')).toBe(n('abc'))
  })
  it('case is significant when the connection is case-sensitive', () => {
    const cs = { ...DEFAULT_NORMALIZE, caseInsensitive: false }
    expect(n('ABC', cs)).not.toBe(n('abc', cs))
  })
})

describe('trap: bit vs boolean', () => {
  it('SQL bit 1/0 joins to model true/false', () => {
    expect(n(true)).toBe(n(1))
    expect(n(false)).toBe(n(0))
  })
})

describe('blank handling', () => {
  it('null and undefined are the same blank key', () => {
    expect(n(null)).toBe(n(undefined))
  })
  it('a blank is distinguishable from the literal text "null"', () => {
    expect(n(null)).not.toBe(n('null'))
  })
  it('a blank is distinguishable from an empty string', () => {
    expect(n(null)).not.toBe(n(''))
  })
  it('NaN and Infinity are treated as blank, never as 0', () => {
    expect(n(Number.NaN)).toBe('n:')
    expect(n(Number.POSITIVE_INFINITY)).toBe('n:')
  })
})

describe('trap: composite key collision', () => {
  it('(1, 23) and (12, 3) are DIFFERENT keys', () => {
    // Plain concatenation makes both "123" — two rows reconciling as one.
    expect(compositeKey([n(1), n(23)])).not.toBe(compositeKey([n(12), n(3)]))
  })
  it('a part containing the delimiter cannot forge another key', () => {
    expect(compositeKey([n('a|b'), n('c')])).not.toBe(compositeKey([n('a'), n('b|c')]))
  })
  it('a part containing a length prefix cannot forge another key', () => {
    expect(compositeKey([n('3:x'), n('y')])).not.toBe(compositeKey([n('x'), n('3:y')]))
  })
  it('a part containing a TYPE TAG cannot forge another key', () => {
    // Found by mutation testing. The type tags ("s:", "d:") make plain
    // concatenation look safe for ordinary data, so the earlier cases above
    // passed even against a naive join('') — they were not actually proving
    // anything. This pair collides under concatenation (both "s:as:bs:c") and
    // is the case that makes length-prefixing necessary rather than decorative.
    expect(compositeKey([n('as:b'), n('c')])).not.toBe(compositeKey([n('a'), n('bs:c')]))
  })
  it('length-prefixes each part', () => {
    expect(compositeKey(['d:1', 'd:23'])).toBe('3:d:1|4:d:23')
  })
  it('is stable for identical input', () => {
    expect(compositeKey([n('ABC '), n(1)])).toBe(compositeKey([n('abc'), n('1')]))
  })
})

describe('displayKeyPart', () => {
  it('strips the type tag', () => {
    expect(displayKeyPart('s:east')).toBe('east')
    expect(displayKeyPart('d:42')).toBe('42')
    expect(displayKeyPart('t:2024-01-01')).toBe('2024-01-01')
  })
  it('renders a blank readably', () => {
    expect(displayKeyPart('n:')).toBe('(blank)')
  })
})

describe('toComparableNumber', () => {
  it('passes numbers through and parses numeric text', () => {
    expect(toComparableNumber(42)).toBe(42)
    expect(toComparableNumber('42.5')).toBe(42.5)
  })
  it('returns null for blanks and non-numeric text, never 0', () => {
    // Coercing a text column to 0 would manufacture a clean reconciliation out
    // of a configuration mistake.
    expect(toComparableNumber(null)).toBeNull()
    expect(toComparableNumber('')).toBeNull()
    expect(toComparableNumber('East')).toBeNull()
  })
})
