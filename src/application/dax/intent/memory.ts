/**
 * APPLICATION — DAX suggestion learning memory (local, no server)
 * Remembers which pattern the user picked for a given *intent signature* and
 * which descriptive words led there, then nudges ranking next time. Persisted
 * to localStorage so it survives reloads. This is the "gets smarter" loop.
 */
interface Memory {
  /** signature → patternId → pick count */
  picks: Record<string, Record<string, number>>
  /** descriptive token → patternId → co-occurrence count (learned synonyms) */
  syn: Record<string, Record<string, number>>
}

const KEY = 'pbistudio.dax.intent.memory.v1'
const EMPTY: Memory = { picks: {}, syn: {} }

function load(): Memory {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { picks: {}, syn: {} }
    const m = JSON.parse(raw) as Memory
    return { picks: m.picks ?? {}, syn: m.syn ?? {} }
  } catch {
    return { picks: {}, syn: {} }
  }
}

function save(m: Memory): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m))
  } catch {
    /* storage unavailable — degrade to no learning */
  }
}

/** Score bonus for a pattern given the current signature + descriptive tokens. */
export function memoryBonus(signature: string, patternId: string, tokens: string[]): number {
  const m = load()
  let bonus = 0
  const picked = m.picks[signature]?.[patternId] ?? 0
  bonus += Math.min(0.3, 0.1 * picked) // strong: you've chosen this for this shape before
  for (const tok of tokens) {
    const co = m.syn[tok]?.[patternId] ?? 0
    if (co) bonus += Math.min(0.15, 0.05 * co) // soft: this word tends to mean this pattern
  }
  return bonus
}

/** Record that the user committed `patternId` for this signature + wording. */
export function recordPick(signature: string, patternId: string, tokens: string[]): void {
  const m = load()
  const bySig = (m.picks[signature] ??= {})
  bySig[patternId] = (bySig[patternId] ?? 0) + 1
  for (const tok of tokens) {
    const byTok = (m.syn[tok] ??= {})
    byTok[patternId] = (byTok[patternId] ?? 0) + 1
  }
  save(m)
}

export function resetMemory(): void {
  save({ ...EMPTY })
}
