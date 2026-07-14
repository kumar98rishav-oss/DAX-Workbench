/**
 * APPLICATION — Template data generator
 * Materialises a template's schema into a denormalised CSV so it flows through
 * the normal import → auto-model → auto-dashboard pipeline. Column names are
 * chosen so the KPI engine infers currency / quantity / ratio kinds.
 */
import type { GenKind, TemplateDef } from './catalog'

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/** Per-kind synthetic value. Ratios are biased so "good" metrics read high. */
function valueFor(name: string, kind: GenKind): string {
  if (kind === 'currency') return String(Math.round((80 + Math.random() * 5900) * 100) / 100)
  if (kind === 'quantity') return String(1 + Math.floor(Math.random() * 800))
  if (kind === 'generic') return String(1 + Math.floor(Math.random() * 120))
  // ratio — bias by semantic of the metric name
  const low = /(churn|denial|leak|no.?show|cancel|abandon|error|scrap|attrition|idle|readmission|void|damage|stockout|variance)/i
  const hi = /(accuracy|clean|retention|occupancy|conversion|approval|yield|graduation|collection|success|freshness|throughput|utilization|win|csat|satisfaction|response|attainment|oee|acceptance|forecast|admit)/i
  let v: number
  if (low.test(name)) v = 0.02 + Math.random() * 0.28
  else if (hi.test(name)) v = 0.62 + Math.random() * 0.36
  else v = 0.2 + Math.random() * 0.6
  return String(Math.round(v * 1000) / 1000)
}

export function generateTemplateCsv(def: TemplateDef): string {
  const header = ['RecordID', 'Date', ...def.dims.map((d) => d.name), ...def.measures.map((m) => m.name)]
  const lines: string[] = [header.join(',')]

  const base = new Date(2024, 0, 1)
  for (let i = 0; i < def.rows; i++) {
    const d = new Date(base)
    d.setDate(d.getDate() + Math.floor(Math.random() * 640))
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    const row = [
      String(100000 + i),
      date,
      ...def.dims.map((dm) => pick(dm.values)),
      ...def.measures.map((m) => valueFor(m.name, m.kind)),
    ]
    lines.push(row.join(','))
  }
  return lines.join('\n')
}

export function makeTemplateFile(def: TemplateDef): File {
  return new File([generateTemplateCsv(def)], `${def.name}.csv`, { type: 'text/csv' })
}
