import { useEffect, useRef } from 'react'

interface Layer {
  rgb: [number, number, number]
  base: number // baseline as a fraction of height (>1 = below the fold)
  amp: number // how far a full swell rises
  speed: number // swells per second (periods of 12–33s)
  cx: number // where along the shore it lands, 0..1
  cxDrift: number
  width: number // swell spread
  rip: number // ripple frequency along the crest
  ripSpeed: number
  phase: number
}

// Four layers on unrelated periods so the composition never visibly repeats:
// purple from the left, blue from the right, a wide slow magenta, a cyan shimmer.
const LAYERS: Layer[] = [
  { rgb: [124, 92, 255], base: 1.06, amp: 0.62, speed: 0.055, cx: 0.16, cxDrift: 0.05, width: 0.34, rip: 7.0, ripSpeed: 0.45, phase: 0.0 },
  { rgb: [62, 140, 255], base: 1.08, amp: 0.55, speed: 0.042, cx: 0.86, cxDrift: 0.06, width: 0.3, rip: 9.0, ripSpeed: -0.35, phase: 2.2 },
  { rgb: [190, 80, 255], base: 1.12, amp: 0.34, speed: 0.03, cx: 0.52, cxDrift: 0.1, width: 0.75, rip: 5.0, ripSpeed: 0.22, phase: 4.1 },
  { rgb: [90, 200, 255], base: 1.1, amp: 0.28, speed: 0.07, cx: 0.35, cxDrift: 0.12, width: 0.22, rip: 12.0, ripSpeed: 0.6, phase: 1.1 },
]

// Rise fast, recede slow — the asymmetry is what reads as "ocean" rather
// than "screensaver".
const swell = (t: number, speed: number, phase: number): number =>
  Math.pow((Math.sin(2 * Math.PI * speed * t + phase) + 1) / 2, 1.6)

/** The living aurora-ocean behind the landing hero. Renders at 1/3 resolution
 * and lets the browser upscale — that's most of the blur for free, and it keeps
 * the whole sea under a millisecond a frame. */
export function WaveSea() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let W = 0
    let H = 0
    const resize = () => {
      W = canvas.width = Math.max(2, Math.ceil(window.innerWidth / 3))
      H = canvas.height = Math.max(2, Math.ceil(window.innerHeight / 3))
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = (t: number) => {
      ctx.clearRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'lighter'
      ctx.filter = 'blur(5px)' // at 1/3 res ≈ 15px on screen

      for (const L of LAYERS) {
        const breath = swell(t, L.speed, L.phase)
        const cx = L.cx + L.cxDrift * Math.sin(t * 0.05 + L.phase)
        const [r, g, b] = L.rgb
        const glow = 0.22 + 0.45 * breath // brighter as it hits

        const grad = ctx.createLinearGradient(0, H * 0.3, 0, H * 1.08)
        grad.addColorStop(0, `rgba(${r},${g},${b},0)`)
        grad.addColorStop(0.55, `rgba(${r},${g},${b},${(glow * 0.35).toFixed(3)})`)
        grad.addColorStop(1, `rgba(${r},${g},${b},${glow.toFixed(3)})`)
        ctx.fillStyle = grad

        ctx.beginPath()
        ctx.moveTo(-8, H + 20)
        const step = Math.max(3, W / 160)
        for (let x = -8; x <= W + 8; x += step) {
          const u = x / W
          const crest = Math.exp(-Math.pow(u - cx, 2) / (2 * L.width * L.width))
          const ripple = 0.75 + 0.25 * Math.sin(u * L.rip + t * L.ripSpeed * 2 * Math.PI)
          ctx.lineTo(x, H * (L.base - L.amp * breath * crest * ripple))
        }
        ctx.lineTo(W + 8, H + 20)
        ctx.closePath()
        ctx.fill()
      }
      ctx.filter = 'none'
      ctx.globalCompositeOperation = 'source-over'
    }

    // Paint the first frame synchronously: rAF is throttled or paused in
    // background/occluded tabs, and the hero must never open on a black void.
    draw(3.8)

    let raf = 0
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      let start: number | undefined
      const loop = (now: number) => {
        if (start === undefined) start = now
        draw(3.8 + (now - start) / 1000)
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <>
      <canvas ref={ref} className="pbs-sea" aria-hidden="true" />
      <div className="pbs-sea__dots" aria-hidden="true" />
      <div className="pbs-sea__vignette" aria-hidden="true" />
    </>
  )
}
