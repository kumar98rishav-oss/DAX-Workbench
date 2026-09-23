# Pipeline Cockpit — Build Guide (MVP)
*Add a visual, gated delivery-pipeline cockpit to DAX Workbench: watch Claude work stage-by-stage,
pause/resume/run-to, and swap skills. Tailored to this repo (React + Zustand UI · Node MCP server ·
.NET bridge). Build MVP first; V2/V3 noted.*

> **Honest scope:** the full canvas (drag-drop, marketplace, branching) is a multi-week feature. The
> **MVP below** — shared state + 4 MCP tools + a live Pipeline panel with Run/Pause/Run-to — is the
> demoable slice and the whole vision in miniature.

## Architecture — where each piece lives
```
 React UI (Zustand)                .NET bridge (5177)               Node MCP server (stdio)
 src/presentation/pipeline/  ──►   PIPELINE HOST                ◄── tools/mcp-server/src/
 PipelinePanel.tsx           HTTP  • state (.daxwb/pipeline.json)  HTTP  • pipeline_get_plan/next/
 src/app/pipeline-store.ts   +SSE  • GET /pipeline · POST control        report/await  (new tools)
                                   • SSE /pipeline/stream          • gates reuse validate/benchmark/analyze
        ▲ user: run/pause/run-to/edit         ▲ single source of truth            ▲ Claude executes
```
**Rule:** the bridge owns the state; UI and Claude both read/write it; Claude **reads before every step**.
*(Faster alt if you want to avoid C# for the MVP: run the Pipeline Host as a tiny Express service inside
`tools/mcp-server` on port 5178 — `express` is already a dependency. Same API.)*

---

## Part A — Pipeline Host (state + API)  ·  in the bridge (or the Express sidecar)
**State model** (persist to `.daxwb/pipeline.json`; mirror `PowerBI_Pipeline.md`):
```ts
interface PipelineState {
  pipelineId: string; project: string;
  status: 'idle'|'running'|'paused'|'held'|'done'|'failed';
  currentStage: number; runToStage: number | null;
  reconciliation: { rows: Record<string,number>; sums: Record<string,number> };
  assumptions: string[];
  stages: Stage[];
}
interface Stage {
  id: number; name: string;
  state: 'pending'|'running'|'passed'|'failed'|'skipped'|'paused';
  requiresSignoff: boolean;
  skills: { ref: string; order: number; enabled: boolean }[];
  gate: { type: string; result: 'green'|'red'|'hold'|'pending'; checks?: unknown[] };
  logs: string[]; artifacts: string[]; startedAt?: string; endedAt?: string;
}
```
**Endpoints** (the contract both sides use):
| Method / path | Caller | Purpose |
|---|---|---|
| `GET /pipeline` | UI + MCP | read full state |
| `POST /pipeline/report` | MCP | update a stage (state, gate, logs, artifacts) → broadcast SSE |
| `POST /pipeline/control` | UI | `{action: run\|pause\|step\|runTo\|reorderSkill\|toggleSkill\|addStage\|removeStage, ...}` |
| `GET /pipeline/stream` | UI | **SSE** — push state on every change |
| `POST /pipeline/seed` | UI/MCP | load a pipeline definition (from `PowerBI_Pipeline.md` stages) |

Seed the default 11 stages (0–10) from `PowerBI_Pipeline.md`. State is in-memory + written to `.daxwb/pipeline.json` on every mutation so it survives restarts and Claude sessions.

---

## Part B — MCP tools  ·  `tools/mcp-server/src/`
**New client** `tools/mcp-server/src/pipeline.ts` (mirror `bridge.ts` — a thin HTTP client to the Host):
```ts
const HOST = process.env.DAXWB_PIPELINE_URL ?? 'http://127.0.0.1:5177'
export const pipeline = {
  getPlan: () => fetch(`${HOST}/pipeline`).then(r => r.json()),
  report:  (b: unknown) => fetch(`${HOST}/pipeline/report`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(b) }).then(r => r.json()),
}
```
**Register 4 tools** in `tools/mcp-server/src/index.ts` — same shape as `pbi_validate_measure`:
```ts
server.registerTool('pipeline_get_plan',
  { title:'Get the pipeline plan', description:'Return the full pipeline state — stages, assigned skills, flags, gate results, live status.', inputSchema:{} },
  () => guard(async () => ok(JSON.stringify(await pipeline.getPlan(), null, 2))))

server.registerTool('pipeline_next',
  { title:'Next pipeline action', description:'Return the next stage to run (skills + gate spec), honoring pause / skip / run-to / sign-off. Returns {action:"hold"} when the user paused or a gate needs approval.', inputSchema:{} },
  () => guard(async () => {
    const s = await pipeline.getPlan()
    const next = computeNext(s)               // first non-passed, enabled stage <= runToStage, unless paused/held
    return ok(JSON.stringify(next))
  }))

server.registerTool('pipeline_report',
  { title:'Report a stage result', description:'Write a stage status + gate result + logs + artifacts. Drives the live cockpit.', inputSchema:{
      stageId: z.number().int(), state: z.string(),
      gateResult: z.enum(['green','red','hold','pending']),
      logs: z.array(z.string()).optional(), artifacts: z.array(z.string()).optional() } },
  (b) => guard(async () => ok(JSON.stringify(await pipeline.report(b)))))

server.registerTool('pipeline_await',
  { title:'Wait for the user', description:'Return the current hold/resume status for a stage. Call this when pipeline_next returns hold; re-call until state != paused/held.', inputSchema:{ stageId: z.number().int() } },
  ({ stageId }) => guard(async () => {
    const s = await pipeline.getPlan()
    const st = s.stages.find((x:any)=>x.id===stageId)
    return ok(st?.state === 'paused' ? 'HOLD' : 'RESUME')
  }))
```
`computeNext(state)` = first stage whose `state !== 'passed'`, `enabled`, `id <= (runToStage ?? ∞)`, unless `status==='paused'` or the stage `requiresSignoff` and isn't approved → `{action:'hold', reason}`. Gates **reuse your existing** `validate_measure` / `benchmark_dax` / `analyze_storage`.

---

## Part C — UI  ·  React + Zustand
**1. Client** `src/infrastructure/desktop/pipeline-client.ts` (reuse the bridge base URL from `desktop-client.ts`):
```ts
import { LOCAL_BRIDGE } from './desktop-client'
export const getPipeline = () => fetch(`${LOCAL_BRIDGE}/pipeline`).then(r => r.json())
export const controlPipeline = (body: unknown) =>
  fetch(`${LOCAL_BRIDGE}/pipeline/control`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) })
export const streamPipeline = (onState: (s: any) => void) => {
  const es = new EventSource(`${LOCAL_BRIDGE}/pipeline/stream`)
  es.onmessage = (e) => onState(JSON.parse(e.data)); return () => es.close()
}
```
**2. Store** `src/app/pipeline-store.ts` (matches your `create` pattern in `store.ts`):
```ts
import { create } from 'zustand'
import { getPipeline, controlPipeline, streamPipeline } from '@/infrastructure/desktop/pipeline-client'
interface PipelineStore {
  state: PipelineState | null; connected: boolean;
  connect(): void; run(): void; pause(): void; runTo(id: number): void;
  toggleSkill(stageId: number, ref: string): void;
}
export const usePipeline = create<PipelineStore>((set) => ({
  state: null, connected: false,
  connect() { getPipeline().then(s => set({ state: s, connected: true }));
              streamPipeline(s => set({ state: s })) },
  run()      { controlPipeline({ action: 'run' }) },
  pause()    { controlPipeline({ action: 'pause' }) },
  runTo(id)  { controlPipeline({ action: 'runTo', stageId: id }) },
  toggleSkill(stageId, ref) { controlPipeline({ action: 'toggleSkill', stageId, ref }) },
}))
```
**3. Panel** `src/presentation/pipeline/PipelinePanel.tsx` + `pipeline.css` — use your design-system primitives + lucide icons:
```tsx
import { useEffect } from 'react'
import { Card, Badge, Button, IconButton } from '@/design-system/components'
import { Play, Pause, StepForward, Flag, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { usePipeline } from '@/app/pipeline-store'

const gateIcon = { green: CheckCircle2, red: XCircle, hold: Flag, pending: Loader2 }

export function PipelinePanel() {
  const { state, connect, run, pause, runTo } = usePipeline()
  useEffect(connect, [])
  if (!state) return <Card>Connect Power BI + launch the bridge to start the pipeline.</Card>
  return (
    <div className="pipeline">
      <header className="pipeline__bar">
        <Button onClick={run}><Play size={14}/> Run</Button>
        <IconButton onClick={pause}><Pause size={16}/></IconButton>
        <IconButton onClick={() => runTo(state.currentStage + 1)}><StepForward size={16}/></IconButton>
      </header>
      <ol className="pipeline__dag">
        {state.stages.map(st => {
          const Icon = gateIcon[st.gate.result] ?? Loader2
          return (
            <li key={st.id} className={`node node--${st.state}`}>
              <div className="node__head">
                <span className="node__n">{st.id}</span>{st.name}
                <Icon size={14} className={`gate gate--${st.gate.result}`} />
              </div>
              <div className="node__skills">
                {st.skills.map(sk => (
                  <Badge key={sk.ref} tone={sk.enabled ? 'accent' : 'muted'}>{sk.ref}</Badge>
                ))}
              </div>
              <button className="node__runto" onClick={() => runTo(st.id)}>run&nbsp;to&nbsp;here</button>
            </li>
          )
        })}
      </ol>
      <section className="pipeline__log">{state.stages.flatMap(s => s.logs).slice(-12).map((l,i)=><div key={i}>{l}</div>)}</section>
    </div>
  )
}
```
**4. Wire into the shell:**
- Add a nav item in `src/presentation/shell/LeftSidebar.tsx` (a lucide `Workflow` icon → "Pipeline").
- Render `<PipelinePanel/>` as a view/route in `src/presentation/shell/AppShell.tsx` (follow how `DaxView` / `ModelView` are switched).
- Register a command in `src/app/commands.tsx` ("Open Pipeline") so it's in the command palette.

---

## Part D — Skills ↔ your plugin registry
A stage's `skills[].ref` is either a **built-in plugin id** (from `src/application/plugins/registry.ts`) or an **external Claude skill name** (e.g. `powerbi-report-planning`, `house-report-design`). For the **skill tray** (V2), list built-ins via the registry and Claude skills from a config; drag one onto a stage = a `control({action:'addSkill', stageId, ref})`. "Upload a skill" = write the folder under the project's `.claude/skills/` and add its `ref` — Claude runs it; the tool just references it.

---

## Part E — The conductor loop (how Claude drives it)
In the build chat, Claude runs:
```
loop: n = pipeline_next()
      if n.action=='hold': pipeline_await(n.stageId); continue
      run n.stage using n.skills            // invoke skill / modeling MCP
      gate = validate/benchmark/analyze per n.gateSpec
      pipeline_report({stageId, state, gateResult, logs, artifacts})
      if gate red: heal → re-report; still red → stop
      if n.stage == runToStage: stop
```
The stage/gate definitions come from **`PowerBI_Pipeline.md`** — seed them into the Host at `/pipeline/seed`.

---

## Build order & tests
1. **Host** (Part A) — state + `GET /pipeline` + `POST /report` + SSE. Seed the 11 stages.
2. **MCP tools** (Part B) — 4 tools + `pipeline.ts`. Test with `pipeline_get_plan` from Claude.
3. **UI** (Part C) — client + store + panel + shell wiring. Watch it update live as Claude reports.
4. **Controls** — Run/Pause/Run-to via `/control`.
- **Vitest** (you already use it): unit-test `computeNext(state)` (respects paused / runTo / disabled / signoff) and the reducer for `/control` actions — these are the correctness core.

## MVP → V2 → V3
- **MVP:** state + 4 tools + live panel + Run/Pause/Run-to.  ✅ demoable
- **V2:** drag-drop **skill tray**, reorder, enable/pause per skill, add/remove stage.
- **V3:** skill **library**, per-stage **breakpoints**, **branching**, run **history/replay**, team **templates**.
