/**
 * DESIGN SYSTEM — Runtime accent theming
 * Overrides the accent tokens inline on :root so a template can carry its own
 * accent (and primary chart colour) without a rebuild. Inline styles win over
 * the stylesheet, so this holds across light/dark toggles.
 */

const DEFAULT_ACCENT = '#3b6ef6'

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  }
}

/** Shift a hex colour toward black (negative) or white (positive) by pct. */
function shade(hex: string, pct: number): string {
  const { r, g, b } = hexToRgb(hex)
  const t = pct < 0 ? 0 : 255
  const p = Math.abs(pct) / 100
  const mix = (c: number) => Math.round((t - c) * p + c)
  const to2 = (n: number) => n.toString(16).padStart(2, '0')
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`
}

export function applyAccent(hex: string): void {
  const { r, g, b } = hexToRgb(hex)
  const s = document.documentElement.style
  s.setProperty('--accent', hex)
  s.setProperty('--accent-hover', shade(hex, -8))
  s.setProperty('--accent-active', shade(hex, -16))
  s.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.12)`)
  s.setProperty('--accent-soft-hover', `rgba(${r}, ${g}, ${b}, 0.18)`)
  s.setProperty('--accent-ring', `rgba(${r}, ${g}, ${b}, 0.34)`)
  // Recolour the primary chart series to match the template.
  s.setProperty('--viz-1', hex)
}

export function resetAccent(): void {
  applyAccent(DEFAULT_ACCENT)
}
