// Phase-A test: drive the PBIP/TMDL + report-impact tools against the REAL
// RVS iGlobal project. Read-only except one idempotent write-back (content
// unchanged), so the project files are left byte-identical.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync } from 'node:fs'

const PROJECT = 'E:\\Data Analyst\\POWER BI\\Dasboards\\RVS iGlobal Report\\RVS iGlobal Report.pbip'
let pass = 0, fail = 0
const out = []
const check = (n, c, d = '') => (c ? (pass++, out.push(`  ✓ ${n}`)) : (fail++, out.push(`  ✗ ${n}${d ? ' — ' + d : ''}`)))
const textOf = (r) => (r.content || []).map((c) => c.text || '').join('\n')

// A TMDL file we can read + write-back-identical safely.
const TMDL_PATH = 'E:\\Data Analyst\\POWER BI\\Dasboards\\RVS iGlobal Report\\RVS iGlobal Report.SemanticModel\\definition\\tables\\_Measures.tmdl'
const before = readFileSync(TMDL_PATH, 'utf8')

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, DAXWB_MCP_ALLOW_WRITE: '1' }, // to exercise the guarded write
})
const client = new Client({ name: 'proj', version: '1.0.0' })
const call = (name, args = {}) => client.callTool({ name, arguments: args })

await client.connect(transport)
try {
  // tools present
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  check('4 project tools registered', ['pbi_open_project', 'pbi_read_tmdl', 'pbi_write_tmdl', 'pbi_measure_usage'].every((n) => names.includes(n)), names.join(','))

  // open project
  let r = await call('pbi_open_project', { projectPath: PROJECT })
  const proj = textOf(r)
  check('open_project lists RVS iGlobal tables', /fct_pnl/.test(proj) && /_Measures/.test(proj) && /RLS_Region/.test(proj))
  check('open_project parsed measures', /_Measures\[Cost \(GBP\)\]/.test(proj), proj.slice(0, 80))
  check('open_project parsed relationships', /→/.test(proj))

  // read TMDL
  r = await call('pbi_read_tmdl', { table: '_Measures', projectPath: PROJECT })
  check('read_tmdl returns real measure DAX', /measure 'Cost \(GBP\)' = SUM/.test(textOf(r)))

  // path-escape rejected
  r = await call('pbi_read_tmdl', { table: '..\\..\\model', projectPath: PROJECT })
  check('read_tmdl rejects path traversal', r.isError === true && /Invalid|escape/i.test(textOf(r)), textOf(r).slice(0, 60))

  // report impact — a measure that IS used
  r = await call('pbi_measure_usage', { name: 'Gross Margin %', projectPath: PROJECT })
  check('measure_usage finds a used measure', /used in \d+ visual/.test(textOf(r)), textOf(r).slice(0, 80))

  // report impact — a made-up measure (0 uses)
  r = await call('pbi_measure_usage', { name: 'Totally Made Up Measure', projectPath: PROJECT })
  check('measure_usage reports 0 for an unused name', /used in 0/.test(textOf(r)))

  // guarded write — idempotent (write the SAME content back)
  r = await call('pbi_write_tmdl', { table: '_Measures', content: before, projectPath: PROJECT })
  check('write_tmdl succeeds (idempotent)', /Wrote _Measures/.test(textOf(r)) && r.isError !== true, textOf(r).slice(0, 80))
} finally {
  await client.close()
}

// Guarantee the file is byte-identical to before.
const after = readFileSync(TMDL_PATH, 'utf8')
check('project file left byte-identical', after === before)

console.log('\n' + out.join('\n'))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
