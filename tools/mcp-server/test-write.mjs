// Write-path test (writes ENABLED). Proves: an invalid measure is refused
// BEFORE writing; a valid one is created; and it can be deleted again.
// Creates a clearly-named throwaway measure and removes it in a finally block,
// so the live model is left exactly as it was.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

let pass = 0, fail = 0
const out = []
const check = (n, c, d = '') => (c ? (pass++, out.push(`  ✓ ${n}`)) : (fail++, out.push(`  ✗ ${n}${d ? ' — ' + d : ''}`)))
const textOf = (r) => (r.content || []).map((c) => c.text || '').join('\n')

const TEST_TABLE = '_Measures'
const TEST_NAME = '_MCP Smoke Test'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, DAXWB_MCP_ALLOW_WRITE: '1' },
})
const client = new Client({ name: 'e2e-write', version: '1.0.0' })
const call = (name, args = {}) => client.callTool({ name, arguments: args })

await client.connect(transport)
try {
  // 1. invalid write must be refused by the validation gate (no mutation)
  let r = await call('pbi_write_measure', { table: TEST_TABLE, name: TEST_NAME, dax: 'SUM ( fct_Billing[DoesNotExist] )' })
  check('invalid write refused by validation gate', /Refused/.test(textOf(r)) && r.isError === true, textOf(r).slice(0, 80))

  // 2. valid write creates
  r = await call('pbi_write_measure', { table: TEST_TABLE, name: TEST_NAME, dax: 'SUM ( fct_Billing[Revenue] )', formatString: '#,0' })
  check('valid write created', /created|updated/.test(textOf(r)) && r.isError !== true, textOf(r).slice(0, 80))

  // 3. it now exists — validating a bare ref to it should pass
  r = await call('pbi_validate_measure', { expression: `[${TEST_NAME}] * 1` })
  check('created measure is now referenceable', /✓ VALID/.test(textOf(r)), textOf(r).slice(0, 80))

  // 4. delete it
  r = await call('pbi_delete_measure', { table: TEST_TABLE, name: TEST_NAME })
  check('delete succeeded', /Deleted/.test(textOf(r)) && r.isError !== true, textOf(r).slice(0, 80))

  // 5. it's gone — a ref to it is now an unknown measure
  r = await call('pbi_validate_measure', { expression: `[${TEST_NAME}] * 1` })
  check('deleted measure no longer referenceable', /NOT VALID/.test(textOf(r)) && new RegExp(TEST_NAME).test(textOf(r)), textOf(r).slice(0, 80))
} finally {
  // Safety net: ensure the throwaway measure is gone even if something threw.
  try { await call('pbi_delete_measure', { table: TEST_TABLE, name: TEST_NAME }) } catch {}
  await client.close()
}

console.log('\n' + out.join('\n'))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
