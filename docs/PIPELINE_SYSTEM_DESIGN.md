# DAX Workbench — Delivery Pipeline: How It Works

> **Who this is for:** IT staff, system architects, or anyone who needs to understand how the automated Power BI report generation pipeline is designed, what runs where, how the parts talk to each other, and how to reproduce it reliably.

---

## The Big Idea in One Sentence

You give the system a folder of CSV files, press **Run**, and it works through 11 ordered stages — profiling your data, designing the model, writing DAX measures, planning and building the report — with a live visual cockpit showing exactly where it is and whether each stage passed.

---

## The 3 Pieces and What Each Does

```
┌─────────────────────────┐     HTTP + live stream      ┌────────────────────────────┐
│  DAX Workbench UI        │ ◄──────────────────────►   │  Pipeline Host             │
│  (browser, port 5173)    │                            │  (Node.js, port 5178)      │
│                          │                            │  • owns ALL state          │
│  Shows stage list +      │                            │  • reads/writes            │
│  gate results live       │                            │    .daxwb/pipeline.json    │
│  User: Run/Pause/        │                            │  • broadcasts updates      │
│  Approve/Breakpoint      │                            │    to UI in real time      │
└─────────────────────────┘                            └──────────┬─────────────────┘
                                                                  │ HTTP
                                                                  │
                                                       ┌──────────▼─────────────────┐
                                                       │  AI (Claude) via MCP       │
                                                       │  (runs the actual work)    │
                                                       │  • pipeline_get_plan       │
                                                       │  • pipeline_next           │
                                                       │  • pipeline_report         │
                                                       │  • pipeline_await          │
                                                       │  Asks: "what's next?"      │
                                                       │  Reports: "stage done"     │
                                                       └────────────────────────────┘
```

**Rule of thumb:** the Pipeline Host is the **single source of truth**. The UI reads from it. Claude reads from it and writes results back to it. They never talk to each other directly — everything goes through the Host.

---

## The 11 Stages — What Each One Actually Does

| # | Stage Name | What happens inside | Gate (pass check) |
|---|---|---|---|
| 0 | **Bootstrap** | Reads the project spec. Confirms tools are available. Logs all assumptions it makes. | Environment OK |
| 1 | **Profile** | Reads every CSV. Counts rows, detects column types, finds keys, records control totals (e.g. total Revenue = \$62.8M). These numbers become the "baseline" to check against later. | Profile complete |
| 2 | **Classify & Design** | Decides which tables are facts vs dimensions. Draws the star-schema. Picks the date table strategy. Identifies candidate measures. | Design approved |
| 3 | **Shape (ETL)** | Cleans the data: fixes date formats, deduplicates rows, merges tables, handles currency columns and orphan keys. | Data clean |
| 4 | **Model** | Writes the semantic model as code (TMDL/PBIP): creates tables, columns, relationships, hierarchies, RLS, calculated groups. Exports to a `.pbip` file. | Model passes BPA rules |
| 5 | **Measures** | Writes all DAX measures. Each one is then validated on the live Power BI engine (not just syntax-checked), benchmarked for speed, and storage-analyzed. Reconciles: does `[Revenue]` in the model still return \$62.8M? | All measures validate green |
| 6 | **Plan** | Decides how many report pages, which visuals go on each page, what the drill-through targets are, what filters to use, what insight each page delivers. | Plan approved |
| 7 | **Style** | Applies the visual theme: colours, fonts, background, design tokens. Generates any HTML hero card components. | Theme applied |
| 8 | **Author** | Writes the PBIR report files (pages, visuals, bookmarks, interactions). | Report written |
| 9 | **Integration QA** | Refreshes the model. Scans for visual errors. Re-runs the reconciliation check. Tests RLS. Checks performance and accessibility. | All QA checks green |
| 10 | **Package** | Exports the PBIP, writes a measure catalogue and data dictionary, creates documentation, commits to Git, produces the gate report. | Delivered |

**Total typical run time: 25 – 45 minutes** (varies by data size and number of measures).  
Stage 5 (Measures) is usually the longest — 8–15 min — because each DAX measure is validated on the live engine.

---

## How the Run Loop Works — Step by Step

Think of Claude as a diligent worker following a checklist it can't see in full — it asks "what's next?" before every step:

```
1.  Claude calls  pipeline_next()
2.  Host responds: "Run Stage 5 — Measures — using skill dax-workbench"
    (or: "HOLD — pipeline is paused" / "HOLD — awaiting sign-off")
3.  Claude executes that stage (invokes the right skill, calls the MCP tools)
4.  Claude calls  pipeline_report()  with the result:
      - state = "passed" or "failed"
      - gate = "green" or "red"
      - logs = what happened
      - artifacts = files produced
5.  Host saves this to disk, broadcasts update to the UI
6.  UI instantly shows the new gate colour for that stage
7.  Repeat from step 1 for the next stage
```

If a gate comes back **red**, Claude tries to fix the issue and re-reports. If it still fails after healing, the pipeline stops and the UI shows the failure with the specific check that didn't pass.

---

## Gate Colours — What They Mean

| Colour | Meaning | What to do |
|---|---|---|
| ⚪ Pending | Stage hasn't run yet | Normal — wait for the run to reach it |
| 🔵 Running | Currently executing | Normal — watch the live log |
| ✅ Green | Stage passed all checks | Nothing needed |
| 🔴 Red | A check failed | Expand the stage to see which check failed and why |
| 🚩 Hold | Paused — waiting for human input | Click **Approve & Continue** if it's a sign-off gate, or **Resume** to release a breakpoint |

---

## Where the State Lives — and Why That Matters

The pipeline state is stored in one JSON file:
```
<your project folder>/.daxwb/pipeline.json
```

- **It survives restarts.** If the Pipeline Host is stopped and restarted, it reads this file and picks up where it left off.
- **It survives Claude session resets.** Claude reads the state fresh every time it calls `pipeline_next()`.
- **Multiple people can watch.** The UI opens an SSE (Server-Sent Events) stream — any tab watching the same Host sees live updates instantly.
- **History is kept.** Up to 20 past runs are stored; you can load any of them from the History dropdown to review what happened.

---

## What Are "Skills" — and How Do They Work?

A **skill** is an instruction file that tells Claude exactly how to do a specific task. Each stage has one or more skills assigned to it.

| Skill | What it teaches Claude |
|---|---|
| `profile-data` | How to read CSVs and build control totals |
| `classify-data` | How to detect fact/dim tables and design star schemas |
| `semantic-model-authoring` | How to write a Power BI model as TMDL code |
| `powerbi-modeling-mcp` | How to author tables, columns, relationships via the Modeling MCP server |
| `dax-workbench` | How to write, validate, and benchmark DAX using this app's MCP tools |
| `powerbi-report-planning` | How to plan report pages and visuals |
| `house-report-design` | How to apply your specific visual style (your brand colours, fonts, HTML cards) |
| `powerbi-report-authoring` | How to write PBIR report files |

Skills are files on disk under `.claude/skills/`. You can edit them, add new ones, and in **Custom mode** drag them between stages in the UI.

---

## The Two Modes — Default vs Custom

**Default mode** (recommended for most runs):
- Stages run in the pre-set order (0 → 10)
- Skills are pre-assigned per the best-practice configuration
- Drag-and-drop is disabled; you can only run, pause, step, or jump to a specific stage

**Custom mode** (for advanced users):
- You can drag stages into a different order
- You can drag skills from the Skill Tray onto any stage, or remove skills from stages
- You can add entirely new stages, remove stages, or rename them
- Changes are saved to the state file immediately

Switch between modes with the **Default / Custom** toggle in the top bar.

---

## How Troubleshooting Works

### A gate turned red — where to look

1. In the pipeline list, click the **▶** arrow next to the failed stage to expand it
2. Read the **gate checks** section — it shows each check with:
   - Expected value (from your baseline)
   - Actual value (from the live engine)
   - ✅ or ❌ per check
3. Read the **logs** at the bottom of the card — Claude writes what it tried and why it failed

### Common failure patterns and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| Stage 5 red — measure check failed | A measure returns a different value than the baseline | Expand Stage 5 → click **Verify on engine** to re-run the check fresh |
| Stage 9 red — reconciliation failed | Data was cleaned differently to what was expected | Check Stage 3 logs for ETL decisions |
| "Pipeline Host not running" shown in the UI | The Host service isn't started | Run `node tools/pipeline-host/server.mjs` in a terminal |
| Gate stuck on "hold" | A breakpoint or sign-off gate is blocking | Click **Approve & Continue** on that stage |
| Claude stops responding mid-run | Claude's session was reset | Press **Run** again — Claude re-reads the state and continues from the last passed stage |

### The "Verify on engine" button

This is the most powerful troubleshooting tool. When you click it on a stage, the **Host itself** (not Claude) runs the baseline DAX measures directly against your live Power BI model via the bridge and compares the results. This gives you ground truth — if it passes here, the data is correct.

---

## How the Pieces Start Up — Startup Sequence

```
Step 1:  Open Power BI Desktop with your .pbix file
Step 2:  Start the DAX Workbench bridge
           (already running if you launched the app)
Step 3:  Start the Pipeline Host:
           node tools/pipeline-host/server.mjs
           (runs on port 5178 — this is the state server)
Step 4:  Open DAX Workbench in your browser → click "Pipeline" tab
Step 5:  Set your Source (paste the folder path to your CSVs)
Step 6:  Press Run (or "run to here" on a specific stage)
```

If the Host isn't running, the Pipeline tab shows a spinner and the start command to copy-paste.

---

## Templates — Save and Replay a Working Configuration

Once you've built a pipeline that works for a project type (e.g. "Sales report with 3 KPI pages"), you can save it as a template:

1. Click the 💾 (save) button in the top bar → name it
2. The template is stored as a JSON file under `.daxwb/templates/`

To reuse it on a new project:
1. Select it from the **Templates** dropdown
2. The stages, skills, breakpoints, and sign-off settings are all restored
3. Press Run

---

## What Makes This Replicable

The design choices that make results consistent across runs and across people:

| Design choice | Why it matters |
|---|---|
| **State on disk, not in memory** | A crashed browser / Claude reset doesn't lose progress |
| **Claude reads state before every step** | It never "remembers" the wrong thing — it always checks |
| **Gate checks run on the live engine** | Results are verified, not just asserted — the numbers have to match |
| **Baselines captured at Profile stage** | Every subsequent stage can check against the same ground truth |
| **Skills are text files** | Any change to how Claude does a task is one file edit, instantly reproducible |
| **Templates save the full stage config** | A working setup for one project can be loaded for the next in seconds |
| **SSE live stream** | Every person watching the UI sees the same state at the same time — no ambiguity |

---

## Port Map — Which Service Is Where

| Service | Port | What it is |
|---|---|---|
| DAX Workbench UI | 5173 | The browser app (Vite dev server) |
| DAX Workbench Bridge | 5177 | .NET bridge to Power BI Desktop — handles live DAX evaluation |
| Pipeline Host | 5178 | Node.js state server — the source of truth for the pipeline |

All three must be running for the full pipeline (including gate verification) to work. The UI and Claude will each show clear error messages if any of the three is missing.
