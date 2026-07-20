import { useState } from 'react'
import { Zap, Copy, Check, CircleCheck, TriangleAlert, Timer, Loader2 } from 'lucide-react'
import { useApp } from '@/app/store'
import { optimize, sameValue } from '@/application/dax/optimizer'
import type { OptimizerResult } from '@/application/dax/optimizer'
import {
  buildDefineQuery,
  dependencyClosure,
  modelMeasures,
  defineHomeTable,
} from '@/application/dax/live-preview'
import { desktopTimeDax } from '@/infrastructure/desktop/desktop-client'
import type { DaxTiming } from '@/infrastructure/desktop/desktop-client'

/** Five cold runs each side. On a small model a single pair of runs is mostly
 * scheduler noise; five is enough for the median to separate a real difference
 * from jitter without making the button feel slow. */
const RUNS = 5

interface Proof {
  before: DaxTiming
  after: DaxTiming
  /** Did the rewrite return the same value? A "faster" query that answers
   * differently is a bug, not an optimization. */
  equal: boolean
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="opt__copy"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1600)
        })
      }}
      title="Copy this DAX"
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

const pct = (before: number, after: number): number =>
  before <= 0 ? 0 : Math.round(((before - after) / before) * 100)

/** Relative run-to-run jitter, as a percentage of the fastest run. Noise only
 * ever ADDS time (scheduling, other processes), so the minimum is the cleanest
 * estimate of a query's real cost and the spread above it is the noise floor. */
const jitterPct = (t: DaxTiming): number =>
  t.min <= 0 ? 0 : ((Math.max(...t.ms) - t.min) / t.min) * 100

/** Only call a winner when the gap is bigger than the noise that produced it —
 * otherwise the same comparison flips direction between runs and the tool ends
 * up confidently telling you two opposite things. */
function verdictOf(before: DaxTiming, after: DaxTiming): {
  delta: number
  noise: number
  decisive: boolean
} {
  const delta = pct(before.min, after.min)
  const noise = Math.max(jitterPct(before), jitterPct(after))
  return { delta, noise, decisive: Math.abs(delta) > Math.max(12, noise) }
}

/** Optimize the selected measure: deterministic rewrite rules, then a real
 * before/after benchmark on the engine to prove the claim. */
export function DaxOptimizer({
  name,
  expression,
  onApply,
}: {
  name: string
  expression: string
  onApply: (dax: string) => void
}) {
  const model = useApp((s) => s.model)
  const desktop = useApp((s) => s.desktop)

  const [result, setResult] = useState<OptimizerResult | null>(null)
  const [proof, setProof] = useState<Proof | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ranFor, setRanFor] = useState('')

  const stale = ranFor !== expression

  const run = async () => {
    setErr(null)
    setProof(null)
    const r = optimize(expression)
    setResult(r)
    setRanFor(expression)

    // Nothing to prove when nothing changed, or when there's no live engine.
    if (!r.optimized || !desktop.connected) return
    const home = defineHomeTable(model)
    if (!home) return

    setBusy(true)
    try {
      // Both versions are timed the same way: the measure's full dependency
      // chain in a DEFINE block, so we compare like with like.
      // The measure under test is listed FIRST and always defined, so the query
      // times the DAX in front of us — never whatever is already deployed under
      // the same name (buildDefineQuery keeps the first definition of a name).
      const chain = dependencyClosure(modelMeasures(model), name)
      const others = chain.filter((m) => m.name.toLowerCase() !== name.toLowerCase())
      const queryFor = (dax: string) => buildDefineQuery([{ name, dax }, ...others], name, home)

      const before = await desktopTimeDax(queryFor(expression), RUNS, true, desktop.port)
      const after = await desktopTimeDax(queryFor(r.optimized), RUNS, true, desktop.port)
      setProof({ before, after, equal: sameValue(before.value, after.value) })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Benchmark failed')
    } finally {
      setBusy(false)
    }
  }

  const clean = result && !result.optimized && result.findings.length === 0

  return (
    <div className="opt">
      <button className="opt__run" onClick={() => void run()} disabled={busy || !expression.trim()}>
        {busy ? <Loader2 size={14} className="pbs-spin" /> : <Zap size={14} />}
        {busy ? 'Timing on the engine…' : result && !stale ? 'Re-analyse' : 'Analyse this measure'}
      </button>

      {result && stale && (
        <div className="opt__stale">The DAX changed since this ran — analyse again.</div>
      )}

      {clean && (
        <div className="opt__ok">
          <CircleCheck size={16} />
          <div>
            <strong>No change required.</strong>
            <p>
              This measure already uses the shapes the engine handles best — no whole-table FILTER,
              no iterator where an aggregation would do, no unguarded division.
            </p>
          </div>
        </div>
      )}

      {result?.optimized && (
        <>
          <div className="opt__block">
            <div className="opt__blockhead">
              <span className="opt__label">Suggested DAX</span>
              <CopyButton text={result.optimized} />
            </div>
            <pre className="opt__code">{result.optimized}</pre>
            <button className="opt__apply" onClick={() => onApply(result.optimized!)}>
              Replace the measure with this
            </button>
          </div>

          {desktop.connected ? (
            proof ? (
              <div className="opt__proof" data-ok={proof.equal}>
                <div className="opt__proofhead">
                  <Timer size={14} />
                  Measured on your model · {proof.before.cold && proof.after.cold ? 'cold cache' : 'warm cache'} ·
                  fastest of {RUNS}
                </div>
                <div className="opt__bars">
                  <div className="opt__bar">
                    <span className="opt__barlabel">Current</span>
                    <span className="opt__bartrack">
                      <i style={{ width: '100%' }} data-kind="before" />
                    </span>
                    <span className="opt__barms">{proof.before.min.toFixed(0)} ms</span>
                  </div>
                  <div className="opt__bar">
                    <span className="opt__barlabel">Suggested</span>
                    <span className="opt__bartrack">
                      <i
                        style={{
                          width: `${Math.max(
                            2,
                            Math.min(100, (proof.after.min / Math.max(proof.before.min, 0.001)) * 100),
                          )}%`,
                        }}
                        data-kind="after"
                      />
                    </span>
                    <span className="opt__barms">{proof.after.min.toFixed(0)} ms</span>
                  </div>
                </div>
                {proof.equal ? (
                  (() => {
                    const v = verdictOf(proof.before, proof.after)
                    return (
                      <div className="opt__verdict">
                        {!v.decisive ? (
                          <>
                            Same value, but <strong className="opt__tie">too close to call</strong> on this data
                            volume — the run-to-run spread here is ±{Math.round(v.noise)}%, wider than the{' '}
                            {Math.abs(v.delta)}% difference. At this size almost all of the time is fixed
                            overhead. The rewrite is still the shape that stays fast as the table grows.
                          </>
                        ) : v.delta > 0 ? (
                          <>
                            <strong>{v.delta}% faster</strong> and returns the same value.
                          </>
                        ) : (
                          <>
                            Same value, but <strong>{Math.abs(v.delta)}% slower</strong> here — on this model the
                            rewrite does not pay off. Keep your current DAX.
                          </>
                        )}
                      </div>
                    )
                  })()
                ) : (
                  <div className="opt__verdict opt__verdict--bad">
                    <TriangleAlert size={14} /> The rewrite returned a <strong>different value</strong> (
                    {String(proof.before.value)} → {String(proof.after.value)}). Do not apply it — this is a bug
                    in the rule, not an optimization.
                  </div>
                )}
              </div>
            ) : busy ? null : err ? (
              <div className="opt__err">{err}</div>
            ) : null
          ) : (
            <div className="opt__note">
              Connect Power BI Desktop to time the before/after on your real data — the suggestion above is from
              the syntax rules alone.
            </div>
          )}
        </>
      )}

      {result && result.findings.length > 0 && (
        <div className="opt__findings">
          <span className="opt__label">Why</span>
          {result.findings.map((f) => (
            <div key={f.id} className="opt__finding" data-impact={f.impact}>
              <div className="opt__ftitle">
                <em className="opt__impact">{f.impact}</em>
                {f.title}
                {!f.rewrite && <span className="opt__advisory">advisory</span>}
              </div>
              <p className="opt__why">{f.why}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
