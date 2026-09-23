// DAX Workbench — Pipeline Host
// Zero-dependency local service holding the delivery-pipeline state.
// The UI (HTTP + SSE) and the MCP server (HTTP) share this one state object.
//
// Skills + templates live on disk as a folder registry the host reads/writes:
//   <regdir>/default/     one <skill>.json per DEFAULT skill (seeded on first run)
//   <regdir>/custom/      one <skill>.json per CUSTOM skill (draggable; house-report-build lives here)
//   <regdir>/templates/   one <name>.json per saved pipeline template
// <regdir> defaults to the folder of the pipeline state file (override: DAXWB_PIPELINE_DIR).
//   Run:  node tools/pipeline-host/server.mjs   ->  http://127.0.0.1:5178
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.DAXWB_PIPELINE_PORT ?? 5178)
const FILE = process.env.DAXWB_PIPELINE_FILE ?? path.join(process.cwd(), '.daxwb', 'pipeline.json')
const REGDIR = process.env.DAXWB_PIPELINE_DIR ?? path.dirname(FILE)
const DIR_DEFAULT = path.join(REGDIR, 'default')
const DIR_CUSTOM = path.join(REGDIR, 'custom')
const DIR_TEMPLATES = path.join(REGDIR, 'templates')
const BRIDGE = (process.env.DAXWB_BRIDGE ?? 'http://127.0.0.1:5177').replace(/\/+$/, '') // DAX Workbench bridge → the LIVE model

const STAGE_DEFS = [
  ['Bootstrap', 'env'], ['Profile', 'profile'], ['Classify & Design', 'design'],
  ['Shape (ETL)', 'etl'], ['Model', 'BPA+refresh'], ['Measures', 'validate+reconcile'],
  ['Plan', 'field-refs'], ['Style', 'theme-schema'], ['Author', 'bindings'],
  ['Integration QA', 'refresh+reconcile'], ['Package', 'export+docs'],
]
const STAGE_ABOUT = {
  0: 'Confirms the environment and reads the project spec. Handles: skills/MCP availability, data location, defaults + assumption log.',
  1: 'Profiles the raw data. Handles: columns, types, grain, keys, cardinality, and control totals (the reconciliation baselines).',
  2: 'Classifies the data and designs the model. Handles: fact-vs-dimension detection, relationships, date table, measure candidates, star-schema design.',
  3: 'Shapes and cleans the data (ETL). Handles: types, date parsing, dedupe, merges, append, unpivot, currency, orphan keys.',
  4: 'Builds the semantic model as code. Handles: tables, relationships, hierarchies, calc groups, field parameters, RLS; exports PBIP.',
  5: 'Authors and verifies DAX. Handles: measures, time intelligence, validate-on-engine, benchmark, storage analysis.',
  6: 'Plans the report. Handles: pages, visuals, fields, filters, drill-through, tooltip, insight-per-page.',
  7: 'Applies the visual style. Handles: theme, design tokens, components (e.g. HTML hero cards).',
  8: 'Authors the report (PBIR). Handles: pages, visuals, interactions, drill-through, tooltip, bookmarks.',
  9: 'Final integration QA. Handles: refresh, visual-error scan, totals reconciliation, RLS test, performance, accessibility.',
  10: 'Packages and hands off. Handles: PBIP export, measure catalogue, data dictionary, docs, Git commit, gate report.',
}
// which DEFAULT skills each stage carries out of the box (the Default pipeline — unchanged)
const DEFAULT_SKILLS = {
  1: ['profile-data'], 2: ['classify-data'], 4: ['semantic-model-authoring', 'powerbi-modeling-mcp'],
  5: ['dax-workbench'], 6: ['powerbi-report-planning'], 7: ['house-report-design'],
  8: ['powerbi-report-authoring'], 9: ['dax-workbench'],
}
const PLG = '~/.claude/plugins/.../powerbi-authoring/skills'
// seeds for the folder registry — written to <regdir>/default and <regdir>/custom on first run
const DEFAULT_SKILL_SEED = [
  { ref: 'profile-data', group: 'Data', kind: 'built-in step', path: '(built-in — no file)', about: 'Profiles source files: columns, types, grain, keys, control totals.' },
  { ref: 'classify-data', group: 'Data', kind: 'built-in step', path: '(built-in — no file)', about: 'Classifies tables as fact/dim, infers relationships, dates and measures.' },
  { ref: 'semantic-model-authoring', group: 'Model', kind: 'plugin skill', path: `${PLG}/semantic-model-authoring/SKILL.md`, about: 'Builds/edits the semantic model via the modeling MCP or TMDL.' },
  { ref: 'powerbi-modeling-mcp', group: 'Model', kind: 'MCP server', path: 'MCP: powerbi-modeling-mcp (no local file)', about: 'Authors the model TOM: tables, columns, relationships, measures, RLS.' },
  { ref: 'dax-workbench', group: 'DAX / Verify', kind: 'MCP (this app)', path: 'tools/mcp-server/src/index.ts', about: 'Validates DAX on the engine, benchmarks, analyzes storage.' },
  { ref: 'powerbi-report-planning', group: 'Report', kind: 'plugin skill', path: `${PLG}/powerbi-report-planning/SKILL.md`, about: 'Plans report pages/visuals from the semantic model.' },
  { ref: 'powerbi-report-design', group: 'Report', kind: 'plugin skill', path: `${PLG}/powerbi-report-design/SKILL.md`, about: 'Visual design guidance before PBIR is written.' },
  { ref: 'house-report-design', group: 'Report', kind: 'project skill', path: '.claude/skills/house-report-design/SKILL.md', about: 'Applies your style packs (default: nexus) + HTML hero cards.' },
  { ref: 'powerbi-report-authoring', group: 'Report', kind: 'plugin skill', path: `${PLG}/powerbi-report-authoring/SKILL.md`, about: 'Writes the PBIR report files (pages/visuals).' },
  { ref: 'powerbi-report-management', group: 'Ops', kind: 'plugin skill', path: `${PLG}/powerbi-report-management/SKILL.md`, about: 'Deploys/manages report items in Fabric.' },
]
const CUSTOM_SKILL_SEED = [
  { ref: 'house-report-build', group: 'Custom', kind: 'project skill', path: '.claude/skills/house-report-build/SKILL.md', about: 'Authors polished PBIR as code with the error playbook + conditional formatting. Drag onto Style + Author in Custom mode.' },
]

// Written into a scaffolded project when <regdir>/project-spec-template.md is absent
// (fresh machine). Blanks are fine: the agent fills gaps with logged assumptions.
const SPEC_FALLBACK = [
  '# Project Spec — <Project Name>', '',
  '> Fill in what you know; anything left blank becomes a logged assumption, not a failure.', '',
  '## 1 · What is this? (one paragraph — audience + the decision it supports)', '',
  '## 2 · Data (files in ./data/ — what each is, grain, keys, known quirks)', '',
  '## 3 · Business questions (these become the report pages)', '1.', '2.', '3.', '',
  '## 4 · Must-have KPIs & measures (name — definition — format — target)', '',
  '## 5 · Report structure (pages, drill-through, tooltip)', '',
  '## 6 · Style (pack: nexus default · brand overrides · avoid-list)', '',
  '## 7 · Rules & constraints (date range, fiscal year, RLS, no-gos)', '',
  '## 8 · Governance (breakpoints — default Measures; sign-off — default Integration QA)', '',
].join('\n')

const clone = (o) => JSON.parse(JSON.stringify(o))
const resetStages = (stages) => clone(stages).map((st) => ({ ...st, state: 'pending', approved: false, gate: { ...st.gate, result: 'pending' }, logs: [], artifacts: [], startedAt: null, endedAt: null }))
const safeName = (n) => String(n).replace(/[^\w.-]+/g, '_').slice(0, 60)

// ---- folder registry ----
const writeJson = (dir, name, obj) => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, safeName(name) + '.json'), JSON.stringify(obj, null, 2)) } catch { /* ignore */ } }
const readFolder = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }).filter(Boolean) } catch { return [] } }
const deleteJson = (dir, name) => { try { fs.unlinkSync(path.join(dir, safeName(name) + '.json')) } catch { /* ignore */ } }
function ensureRegistry() {
  for (const d of [DIR_DEFAULT, DIR_CUSTOM, DIR_TEMPLATES]) { try { fs.mkdirSync(d, { recursive: true }) } catch { /* ignore */ } }
  if (readFolder(DIR_DEFAULT).length === 0) for (const s of DEFAULT_SKILL_SEED) writeJson(DIR_DEFAULT, s.ref, s)
  for (const s of CUSTOM_SKILL_SEED) if (!fs.existsSync(path.join(DIR_CUSTOM, safeName(s.ref) + '.json'))) writeJson(DIR_CUSTOM, s.ref, s)
}
const GROUP_ORDER = ['Data', 'Model', 'DAX / Verify', 'Report', 'Ops', 'Custom']
function skillCatalog() { // groups for the tray — default folder keeps its groups, custom folder → "Custom"
  const groups = {}
  for (const s of readFolder(DIR_DEFAULT)) (groups[s.group || 'Default'] ??= []).push(s.ref)
  for (const s of readFolder(DIR_CUSTOM)) (groups['Custom'] ??= []).push(s.ref)
  return Object.keys(groups).sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99)).map((g) => ({ group: g, skills: groups[g] }))
}
const skillMeta = () => Object.fromEntries([...readFolder(DIR_DEFAULT), ...readFolder(DIR_CUSTOM)].map((s) => [s.ref, { kind: s.kind, path: s.path, about: s.about }]))
const readTemplates = () => readFolder(DIR_TEMPLATES)
const readCustomSkills = () => readFolder(DIR_CUSTOM).map((s) => ({ ref: s.ref, group: s.group || 'Custom' }))

const seedStages = () =>
  STAGE_DEFS.map(([name, gate], id) => ({
    id, name, description: STAGE_ABOUT[id] ?? '', state: 'pending', requiresSignoff: false, approved: false, breakpoint: false, branch: { onFail: null },
    skills: (DEFAULT_SKILLS[id] ?? []).map((ref, order) => ({ ref, order, enabled: true })),
    gate: { type: gate, result: 'pending', checks: [] },
    logs: [], artifacts: [], startedAt: null, endedAt: null,
  }))

const freshState = () => ({
  pipelineId: 'pbi-' + Date.now(), project: process.env.DAXWB_PROJECT ?? 'Untitled', statePath: FILE, registryDir: REGDIR,
  status: 'idle', mode: 'default', currentStage: 0, runToStage: null, bpReleased: [],
  source: { kind: 'data', path: '' },
  reconciliation: { rows: {}, sums: {} }, assumptions: [],
  templates: [], history: [], customSkills: [],
  stages: seedStages(),
})

let state = load()
state.statePath = FILE
state.registryDir = REGDIR
ensureRegistry()
state.templates = readTemplates()
state.customSkills = readCustomSkills()
function load() { try { const s = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { ...freshState(), ...s } } catch { return freshState() } }
function save() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(state, null, 2)) } catch { /* ignore */ } }
const clients = new Set()
function broadcast() { const line = `data: ${JSON.stringify(state)}\n\n`; for (const r of clients) { try { r.write(line) } catch { /* dropped */ } } }
function mutate(fn) { fn(); save(); broadcast() }
const find = (id) => state.stages.find((s) => s.id === id)
const nextId = () => state.stages.reduce((m, s) => Math.max(m, s.id), -1) + 1
function pushHistory(status) { state.history.unshift({ id: 'run-' + Date.now(), at: new Date().toISOString(), status, stages: clone(state.stages) }); state.history = state.history.slice(0, 20) }

// call the DAX Workbench bridge (runs DAX on the live Power BI model) so gates VERIFY instead of trust
function bridgePost(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const u = new URL(BRIDGE)
    const r = http.request({ hostname: u.hostname, port: u.port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (resp) => {
      let d = ''; resp.on('data', (c) => (d += c)); resp.on('end', () => { try { const j = JSON.parse(d || '{}'); if (j && j.error) reject(new Error(String(j.error))); else resolve(j) } catch { reject(new Error('bad bridge response')) } })
    })
    r.on('error', () => reject(new Error(`DAX Workbench bridge not reachable at ${BRIDGE} — is a Power BI model open?`)))
    r.setTimeout(25000, () => r.destroy(new Error('bridge timeout')))
    r.write(data); r.end()
  })
}
// Verify a stage's gate for real: EVALUATE the baseline measures on the engine, compare to the stored baselines.
async function verifyStage(st) {
  const baselines = state.reconciliation.baselines || []
  const checks = []
  let ok = true, err = null
  if (baselines.length === 0) {
    ok = false; err = 'No baselines to verify — report reconciliation.baselines at Profile, e.g. [{"measure":"Revenue","expected":62870822}].'
  } else {
    try {
      const dax = 'EVALUATE ROW(' + baselines.map((x, i) => `"m${i}", [${String(x.measure).replace(/"/g, '')}]`).join(', ') + ')'
      const r = await bridgePost('/dax', { Dax: dax })
      const cols = r.columns || []
      const row = (r.rows && r.rows[0]) || {}
      baselines.forEach((x, i) => {
        const actual = Number(row[cols[i]])
        const tol = x.tol ?? Math.max(1, Math.abs(Number(x.expected)) * 0.001)
        const pass = Number.isFinite(actual) && Math.abs(actual - Number(x.expected)) <= tol
        checks.push({ name: x.measure, expected: Number(x.expected), actual: Number.isFinite(actual) ? actual : null, ok: pass })
        if (!pass) ok = false
      })
    } catch (e) { ok = false; err = String((e && e.message) || e).slice(0, 140) }
  }
  mutate(() => {
    st.gate.result = ok ? 'green' : 'red'
    st.gate.checks = checks
    st.logs.push(`VERIFY (host→engine): ${checks.filter((c) => c.ok).length}/${checks.length} baselines reconcile → gate ${ok ? 'GREEN' : 'RED'}${err ? ' — ' + err : ''}`)
  })
  return { ok, checks, error: err }
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'content-type' }
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', ...CORS }); res.end(JSON.stringify(obj)) }
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch { r({}) } }) })

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/'
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  if (req.method === 'GET' && url === '/pipeline') return json(res, 200, state)
  if (req.method === 'GET' && url === '/skills') return json(res, 200, skillCatalog())
  if (req.method === 'GET' && url === '/skill-meta') return json(res, 200, skillMeta())
  if (req.method === 'GET' && url === '/pipeline/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS })
    res.write(`data: ${JSON.stringify(state)}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return
  }

  if (req.method === 'POST' && url === '/pipeline/report') {
    const b = await readBody(req)
    mutate(() => {
      const st = find(b.stageId); if (!st) return
      if (b.state) st.state = b.state
      if (b.gateResult) st.gate.result = b.gateResult
      if (Array.isArray(b.logs)) st.logs.push(...b.logs)
      if (Array.isArray(b.artifacts)) st.artifacts.push(...b.artifacts)
      if (Array.isArray(b.assumptions)) state.assumptions.push(...b.assumptions)
      if (b.reconciliation) state.reconciliation = { ...state.reconciliation, ...b.reconciliation }
      if (b.state === 'running') { st.startedAt = new Date().toISOString(); state.currentStage = st.id; state.status = 'running' }
      if (b.state === 'passed' || b.state === 'failed') st.endedAt = new Date().toISOString()
      if (b.state === 'failed') state.status = 'failed'
      if (state.stages.length > 0 && state.stages.every((x) => x.state === 'passed')) { state.status = 'done'; pushHistory('done') }
    })
    return json(res, 200, { ok: true })
  }

  if (req.method === 'POST' && url === '/pipeline/control') {
    const b = await readBody(req)
    mutate(() => {
      switch (b.action) {
        // Run = run the WHOLE pipeline: clear a stale run-to limiter so it never silently stalls
        case 'run': state.status = 'running'; state.runToStage = null; break
        case 'pause': state.status = 'paused'; break
        case 'runTo':
        case 'runStage': state.runToStage = b.stageId; state.status = 'running'; break
        case 'reset': if (state.stages.some((s) => s.state !== 'pending')) pushHistory('reset'); { const keep = { templates: state.templates, history: state.history, customSkills: state.customSkills }; state = { ...freshState(), ...keep } } break
        case 'setMode': state.mode = b.mode === 'custom' ? 'custom' : 'default'; if (state.mode === 'default') state.stages.sort((a, c) => a.id - c.id); break
        case 'reorder': if (Array.isArray(b.order)) { const m = new Map(state.stages.map((s) => [s.id, s])); const nx = b.order.map((id) => m.get(id)).filter(Boolean); for (const s of state.stages) if (!b.order.includes(s.id)) nx.push(s); state.stages = nx } break
        case 'toggleSkill': { const sk = find(b.stageId)?.skills.find((k) => k.ref === b.ref); if (sk) sk.enabled = !sk.enabled; break }
        case 'addSkill': { const st = find(b.stageId); if (st && !st.skills.some((k) => k.ref === b.ref)) st.skills.push({ ref: b.ref, order: st.skills.length, enabled: true }); break }
        case 'removeSkill': { const st = find(b.stageId); if (st) st.skills = st.skills.filter((k) => k.ref !== b.ref); break }
        case 'moveSkill': { const from = find(b.fromStageId); const to = find(b.toStageId); if (from && to) { from.skills = from.skills.filter((k) => k.ref !== b.ref); if (!to.skills.some((k) => k.ref === b.ref)) to.skills.push({ ref: b.ref, order: to.skills.length, enabled: true }) } break }
        case 'reorderSkills': { const st = find(b.stageId); if (st && Array.isArray(b.order)) { const m = new Map(st.skills.map((k) => [k.ref, k])); st.skills = b.order.map((r) => m.get(r)).filter(Boolean) } break }
        case 'renameStage': { const st = find(b.stageId); if (st && b.name) st.name = String(b.name).slice(0, 60); break }
        case 'setDescription': { const st = find(b.stageId); if (st) st.description = String(b.text ?? '').slice(0, 400); break }
        case 'setSource': state.source = { kind: b.kind === 'pbip' ? 'pbip' : 'data', path: String(b.path ?? '').slice(0, 400) }; break
        // Scaffold a new project: <root>/data/ + project-spec.md (from the registry template,
        // never overwriting an existing spec), then aim the Source panel at the data folder.
        case 'newProject': {
          try {
            const root = String(b.path ?? '').trim().replace(/["']/g, '')
            if (!root) break
            const dataDir = path.join(root, 'data')
            fs.mkdirSync(dataDir, { recursive: true })
            const specPath = path.join(root, 'project-spec.md')
            if (!fs.existsSync(specPath)) {
              let tpl
              try { tpl = fs.readFileSync(path.join(REGDIR, 'project-spec-template.md'), 'utf8') } catch { tpl = SPEC_FALLBACK }
              fs.writeFileSync(specPath, tpl.replace(/<Project Name>/g, path.basename(root)))
            }
            state.source = { kind: 'data', path: dataDir }
            const st0 = state.stages[0]
            if (st0) st0.logs.push(`New project scaffolded: ${root} (data/ + project-spec.md) — source set`)
          } catch { /* leave state unchanged on FS errors */ }
          break
        }
        case 'setSignoff': { const st = find(b.stageId); if (st) st.requiresSignoff = !!b.value; break }
        case 'setGate': { const st = find(b.stageId); if (st && b.gateType) st.gate.type = String(b.gateType); break }
        case 'approve': { const st = find(b.stageId); if (st) st.approved = true; break }
        // one click instead of approve -> continue -> run: approve the gate, release this stage's
        // breakpoint if armed, clear a stale limiter, and set the pipeline running again
        case 'approveAndContinue': { const st = find(b.stageId); if (st) { st.approved = true; if (st.breakpoint && !state.bpReleased.includes(st.id)) state.bpReleased.push(st.id); if (state.runToStage != null && state.runToStage === st.id) state.runToStage = null; state.status = 'running' } break }
        case 'toggleBreakpoint': { const st = find(b.stageId); if (st) st.breakpoint = !st.breakpoint; break }
        case 'continue': { const nx = state.stages.find((s) => s.state !== 'passed' && s.state !== 'skipped'); if (nx && !state.bpReleased.includes(nx.id)) state.bpReleased.push(nx.id); state.status = 'running'; break }
        case 'setBranch': { const st = find(b.stageId); if (st) st.branch = { onFail: b.onFail == null || b.onFail === '' ? null : Number(b.onFail) }; break }
        case 'addStage': state.stages.push({ id: nextId(), name: b.name ?? 'New stage', description: '', state: 'pending', requiresSignoff: false, approved: false, breakpoint: false, branch: { onFail: null }, skills: [], gate: { type: b.gateType ?? 'custom', result: 'pending', checks: [] }, logs: [], artifacts: [], startedAt: null, endedAt: null }); break
        case 'removeStage': state.stages = state.stages.filter((s) => s.id !== b.stageId); break
        // templates: folder-backed at <regdir>/templates/<name>.json
        case 'saveTemplate': if (b.name) { writeJson(DIR_TEMPLATES, b.name, { name: String(b.name).slice(0, 40), stages: clone(state.stages) }); state.templates = readTemplates() } break
        case 'loadTemplate': { const t = state.templates.find((t) => t.name === b.name); if (t) { state.stages = resetStages(t.stages); state.status = 'idle'; state.currentStage = 0; state.bpReleased = [] } break }
        case 'deleteTemplate': deleteJson(DIR_TEMPLATES, b.name); state.templates = readTemplates(); break
        case 'saveRun': pushHistory('saved'); break
        case 'loadHistory': { const h = state.history.find((x) => x.id === b.id); if (h) { state.stages = resetStages(h.stages); state.status = 'idle'; state.currentStage = 0; state.bpReleased = [] } break }
        // custom skills: folder-backed at <regdir>/custom/<ref>.json
        case 'addCustomSkill': if (b.ref) { writeJson(DIR_CUSTOM, b.ref, { ref: String(b.ref).slice(0, 60), group: b.group ? String(b.group).slice(0, 30) : 'Custom', kind: 'custom skill', path: `.claude/skills/${b.ref}/`, about: 'Custom skill.' }); state.customSkills = readCustomSkills() } break
        case 'removeCustomSkill': deleteJson(DIR_CUSTOM, b.ref); state.customSkills = readCustomSkills(); break
      }
    })
    return json(res, 200, state)
  }

  if (req.method === 'POST' && url === '/pipeline/verify') {
    const b = await readBody(req)
    const st = find(b.stageId)
    if (!st) return json(res, 404, { error: 'no such stage' })
    const out = await verifyStage(st)
    return json(res, 200, out)
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => console.log(`Pipeline Host on http://127.0.0.1:${PORT}\n  state:     ${FILE}\n  registry:  ${REGDIR}  (default/ custom/ templates/)`))
