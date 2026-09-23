/**
 * The privacy page (public/privacy.html) shows the user the exact byte count of
 * the payload the AI would receive for the model they have open. To do that it
 * has to serialise the model itself — it is a static asset served by the bridge
 * and cannot import this module.
 *
 * Duplicated logic drifts, and here the cost of drift is a *wrong privacy
 * number shown to a user* — worse than showing nothing. So this test extracts
 * the port straight out of the HTML and asserts it is byte-identical to the
 * real function across the cases that actually differ: hidden objects, the
 * column and measure caps, names that need quoting, and multi-line expressions.
 *
 * If you change modelToSchemaPrompt, this fails until the port is updated too.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { modelToSchemaPrompt } from './nl-to-dax'
import type { SemanticModel, Table, Column, Measure } from '@/domain/model'

// ---------------------------------------------------------------------------
// Pull the ported implementation out of the shipped page.
// ---------------------------------------------------------------------------
const html = readFileSync(join(process.cwd(), 'public', 'privacy.html'), 'utf8')
// PORT-BEGIN sits inside a banner comment; skip to that comment's close, then
// capture everything up to the PORT-END marker.
const between = html.match(/PORT-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* PORT-END \*\//)

if (!between) {
  throw new Error('privacy.html no longer contains a PORT-BEGIN/PORT-END block — the privacy page cannot compute payload size.')
}

const ported = new Function(`${between[1]}; return modelToSchemaPrompt;`)() as (
  m: SemanticModel,
) => string

// ---------------------------------------------------------------------------
// Model builders
// ---------------------------------------------------------------------------
function col(name: string, dataType = 'string', isHidden = false): Column {
  return { id: name, name, dataType, role: 'unknown', isHidden } as Column
}
function measure(name: string, expression: string): Measure {
  return { id: name, name, expression } as Measure
}
function table(name: string, columns: Column[], measures: Measure[] = [], isHidden = false): Table {
  return { id: name, name, role: 'unknown', columns, measures, isHidden } as Table
}
function model(tables: Table[]): SemanticModel {
  return { tables } as SemanticModel
}

// ---------------------------------------------------------------------------
const CASES: [string, SemanticModel][] = [
  [
    'plain fact + dimension',
    model([
      table('Sales', [col('Amount', 'decimal'), col('OrderDate', 'dateTime')], [measure('Revenue', 'SUM ( Sales[Amount] )')]),
      table('Customer', [col('CustomerId', 'integer'), col('Name')]),
    ]),
  ],
  [
    'hidden table is skipped entirely',
    model([
      table('Visible', [col('A', 'integer')]),
      table('SecretTable', [col('Salary', 'decimal')], [], true),
    ]),
  ],
  [
    'hidden column is dropped but its table stays',
    model([table('T', [col('Public', 'integer'), col('SSN', 'string', true)])]),
  ],
  [
    'every column hidden — the no-visible-columns branch',
    model([table('AllHidden', [col('X', 'integer', true), col('Y', 'string', true)])]),
  ],
  [
    'table with no columns at all',
    model([table('Empty', [])]),
  ],
  [
    'over the 30-column cap — exercises the “… more columns” line',
    model([table('Wide', Array.from({ length: 47 }, (_, i) => col(`c${i}`, i % 2 ? 'integer' : 'string')))]),
  ],
  [
    'exactly 30 columns — boundary, must NOT emit the overflow line',
    model([table('Exact', Array.from({ length: 30 }, (_, i) => col(`c${i}`)))]),
  ],
  [
    'over the 50-measure cap',
    model([
      table(
        'M',
        [col('A', 'integer')],
        Array.from({ length: 73 }, (_, i) => measure(`m${i}`, `SUM ( M[A] ) + ${i}`)),
      ),
    ]),
  ],
  [
    'names that need quoting',
    model([
      table('Fact Sales 2026', [col('Unit Price', 'decimal'), col("Customer's Name")], [measure('Gross Margin %', 'DIVIDE ( 1, 2 )')]),
    ]),
  ],
  [
    'multi-line and over-long expressions get first line, 120 chars',
    model([
      table('T', [col('A', 'integer')], [
        measure('Multi', 'VAR x = 1\nVAR y = 2\nRETURN x + y'),
        measure('Long', `CALCULATE ( ${'A'.repeat(400)} )`),
      ]),
    ]),
  ],
  [
    'every data type maps the same way',
    model([
      table('Types', [
        col('a', 'Whole Number'), col('b', 'Int64'), col('c', 'Decimal Number'),
        col('d', 'Double'), col('e', 'Fixed Decimal'), col('f', 'Currency'),
        col('g', 'Boolean'), col('h', 'DateTime'), col('i', 'Date'),
        col('j', 'Text'), col('k', undefined as unknown as string),
      ]),
    ]),
  ],
  ['no tables at all', model([])],
]

describe('privacy.html schema port', () => {
  it.each(CASES)('matches modelToSchemaPrompt byte-for-byte: %s', (_label, m) => {
    expect(ported(m)).toBe(modelToSchemaPrompt(m))
  })

  it('reports the same byte length, which is the number the page shows', () => {
    for (const [, m] of CASES) {
      const real = Buffer.byteLength(modelToSchemaPrompt(m), 'utf8')
      const shown = Buffer.byteLength(ported(m), 'utf8')
      expect(shown).toBe(real)
    }
  })

  it('never emits a value that came out of a cell', () => {
    // sampleValues is the one field on Column that can hold real data. The page
    // must not surface it even if a future import path populates it.
    const withSamples = model([
      table('T', [{ ...col('Secret'), sampleValues: ['ACME Corp', 42, 'patient-001'] } as Column]),
    ])
    const out = ported(withSamples)
    expect(out).not.toContain('ACME Corp')
    expect(out).not.toContain('patient-001')
    expect(out).toBe(modelToSchemaPrompt(withSamples))
  })
})
