// End-to-end test: spawn the built MCP server, do the real MCP handshake over
// stdio, and drive every tool against the LIVE finance model. Prints PASS/FAIL.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

let pass = 0, fail = 0
const results = []
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✓ ${name}`) }
  else { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const textOf = (r) => (r.content || []).map((c) => c.text || '').join('\n')

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env }, // writes stay disabled (DAXWB_MCP_ALLOW_WRITE unset)
})
const client = new Client({ name: 'e2e', version: '1.0.0' })

try {
  await client.connect(transport)

  // 1. tools/list
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  check('handshake + lists 8 tools', tools.length === 8, `got ${tools.length}: ${names.join(',')}`)
  check('has pbi_validate_measure', names.includes('pbi_validate_measure'))
  check('has guarded pbi_write_measure', names.includes('pbi_write_measure'))

  const call = (name, args = {}) => client.callTool({ name, arguments: args })

  // 2. list models
  let r = await call('pbi_list_open_models')
  check('list_open_models finds the model', /port \d+/.test(textOf(r)), textOf(r).slice(0, 80))

  // 3. get model
  r = await call('pbi_get_model')
  const modelText = textOf(r)
  check('get_model returns fct_Billing + _Measures', /fct_Billing/.test(modelText) && /_Measures/.test(modelText))

  // 4. validate GOOD
  r = await call('pbi_validate_measure', { expression: 'SUM ( fct_Billing[Revenue] )' })
  check('validate GOOD → ✓ VALID + preview', /✓ VALID/.test(textOf(r)) && /Preview value/.test(textOf(r)), textOf(r).slice(0, 90))
  check('validate GOOD not flagged as error', r.isError !== true)

  // 5. validate BAD table (the hole we fixed)
  r = await call('pbi_validate_measure', { expression: 'CALCULATE ( SUM ( fct_Billing[Revenue] ), ALL ( Dates ) )' })
  check('validate BAD table → catches invented "Dates"', /NOT VALID/.test(textOf(r)) && /Dates/.test(textOf(r)), textOf(r).slice(0, 90))
  check('validate BAD table flagged isError', r.isError === true)

  // 6. validate BAD column
  r = await call('pbi_validate_measure', { expression: 'SUM ( fct_Billing[Profit] )' })
  check('validate BAD column → catches fct_Billing[Profit]', /fct_Billing\[Profit\]/.test(textOf(r)))

  // 7. run dax
  r = await call('pbi_run_dax', { dax: 'EVALUATE ROW ( "r", SUM ( fct_Billing[Revenue] ) )' })
  check('run_dax returns rows', /Columns:/.test(textOf(r)) && r.isError !== true, textOf(r).slice(0, 80))

  // 8. benchmark
  r = await call('pbi_benchmark_dax', { dax: 'EVALUATE ROW ( "r", SUM ( fct_Billing[Revenue] ) )', runs: 3 })
  check('benchmark_dax reports timing', /min \d+(\.\d+)? ms/.test(textOf(r)), textOf(r).slice(0, 80))

  // 9. storage
  r = await call('pbi_analyze_storage')
  check('analyze_storage summarises tables + columns', /Model size/.test(textOf(r)) && /Biggest columns/.test(textOf(r)) && r.isError !== true)
  results.push('    storage sample: ' + textOf(r).split('\n').slice(0, 4).join(' | '))

  // 10. write refused (deny-by-default)
  r = await call('pbi_write_measure', { table: '_Measures', name: 'ZZ Test', dax: 'SUM ( fct_Billing[Revenue] )' })
  check('write refused when DAXWB_MCP_ALLOW_WRITE unset', /disabled/i.test(textOf(r)) && r.isError === true, textOf(r).slice(0, 80))

  await client.close()
} catch (e) {
  console.error('HARNESS ERROR:', e)
  fail++
}

console.log('\n' + results.join('\n'))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
