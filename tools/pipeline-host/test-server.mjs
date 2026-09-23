// Integration test for the Pipeline Host reducer (the POST /pipeline/control
// switch). Spawns the REAL server.mjs against a throwaway temp state file on a
// test port, drives control actions over HTTP, and asserts the resulting state.
// The real .daxwb/pipeline.json is never touched.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 5199
const BASE = `http://127.0.0.1:${PORT}`
const dir = mkdtempSync(join(tmpdir(), 'plhost-'))
const file = join(dir, 'pipeline.json')

let pass = 0, fail = 0
const out = []
const check = (n, c, d = '') => (c ? (pass++, out.push(`  ✓ ${n}`)) : (fail++, out.push(`  ✗ ${n}${d ? ' — ' + d : ''}`)))

const get = () => fetch(`${BASE}/pipeline`).then((r) => r.json())
const control = (body) =>
  fetch(`${BASE}/pipeline/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())

const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: HERE,
  env: { ...process.env, DAXWB_PIPELINE_PORT: String(PORT), DAXWB_PIPELINE_FILE: file, DAXWB_PIPELINE_DIR: dir },
  stdio: ['ignore', 'ignore', 'inherit'],
})

async function waitReady(ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/pipeline`)
      if (r.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('Pipeline Host did not become ready')
}

try {
  await waitReady()

  // seeded state
  let s = await get()
  check('host seeds a stage list', Array.isArray(s.stages) && s.stages.length >= 5, `${s.stages?.length} stages`)

  // run / pause / runTo
  await control({ action: 'run' })
  s = await get()
  check('run → status running, runToStage cleared', s.status === 'running' && s.runToStage === null, `status=${s.status}`)

  await control({ action: 'pause' })
  s = await get()
  check('pause → status paused', s.status === 'paused', `status=${s.status}`)

  await control({ action: 'runTo', stageId: 3 })
  s = await get()
  check('runTo → runToStage set + running', s.runToStage === 3 && s.status === 'running', `runTo=${s.runToStage} status=${s.status}`)

  // toggleSkill on a stage that actually has one
  const withSkill = s.stages.find((st) => st.skills && st.skills.length > 0)
  check('found a stage with a skill to toggle', !!withSkill)
  if (withSkill) {
    const ref = withSkill.skills[0].ref
    const before = withSkill.skills[0].enabled
    await control({ action: 'toggleSkill', stageId: withSkill.id, ref })
    s = await get()
    const after = s.stages.find((st) => st.id === withSkill.id).skills.find((k) => k.ref === ref).enabled
    check('toggleSkill flips enabled', after === !before, `${before} → ${after}`)
  }

  // addSkill / removeSkill round-trip on stage 0
  const s0 = s.stages[0].id
  await control({ action: 'addSkill', stageId: s0, ref: '_probe_skill' })
  s = await get()
  check('addSkill adds it', s.stages[0].skills.some((k) => k.ref === '_probe_skill'))
  await control({ action: 'removeSkill', stageId: s0, ref: '_probe_skill' })
  s = await get()
  check('removeSkill removes it', !s.stages[0].skills.some((k) => k.ref === '_probe_skill'))

  // renameStage
  await control({ action: 'renameStage', stageId: s0, name: 'Renamed Stage' })
  s = await get()
  check('renameStage renames', s.stages[0].name === 'Renamed Stage', s.stages[0].name)

  // reset returns every stage to pending
  await control({ action: 'reset' })
  s = await get()
  check('reset → all stages pending', s.stages.every((st) => st.state === 'pending'))
} catch (e) {
  fail++
  out.push(`  ✗ harness error — ${e.message}`)
} finally {
  // Wait for the child to actually exit before we go, so Windows/libuv doesn't
  // assert on a still-closing handle. Fall back after 1.5s.
  await new Promise((resolve) => {
    srv.once('exit', resolve)
    srv.kill()
    setTimeout(resolve, 1500)
  })
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log('\n' + out.join('\n'))
console.log(`\n${pass} passed, ${fail} failed`)
// exitCode (not exit) lets Node drain handles cleanly.
process.exitCode = fail === 0 ? 0 : 1
