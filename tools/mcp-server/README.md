# DAX Workbench — MCP server

An [MCP](https://modelcontextprotocol.io) server that gives Claude a live,
**verified** connection to whatever Power BI model you have open. Claude can read
the model, run DAX, benchmark it, and — the point of the whole thing —
**validate a measure against the real engine before it's ever written.**

It's a thin adapter over the DAX Workbench bridge's local HTTP API. The
reference checker (`pbi_validate_measure`) is the *same* code the desktop app
uses (`src/application/dax/validate.ts`, bundled in) — one source of truth, no
drift.

```
Claude  ──MCP/stdio──▶  this server  ──HTTP──▶  DAX Workbench bridge  ──XMLA──▶  Power BI model
```

## Tools

| Tool | What it does | Writes? |
| --- | --- | --- |
| `pbi_list_open_models` | List open Power BI reports (port, tables, measures). Call first. | — |
| `pbi_get_model` | Schema: tables, columns + types, measures + DAX, relationships. | — |
| `pbi_run_dax` | Run a DAX query, return rows. | — |
| **`pbi_validate_measure`** | **Static reference check (catches invented names) + live preview on the engine.** The trust-but-verify tool. | — |
| `pbi_benchmark_dax` | Cold-cache timing, min of N runs — prove a rewrite is faster. | — |
| `pbi_analyze_storage` | VertiPaq footprint: biggest tables + columns (optimization targets). | — |
| `pbi_write_measure` | Create/update a measure. Validates the DAX first, refuses invented names. | guarded |
| `pbi_delete_measure` | Delete a measure. | guarded |
| `pbi_open_project` | Read a PBIP project as code — tables, measures, relationships from TMDL. | — |
| `pbi_read_tmdl` | Raw TMDL for one table (its full DAX). | — |
| `pbi_write_tmdl` | Overwrite a table's TMDL, for repo-wide refactoring. Path-confined to the project. | guarded |
| `pbi_measure_usage` | Which report visuals use a measure/column ("used in 0 visuals" = safe to remove). | — |

The first eight tools work against the **live model** (via the bridge). The last four are **file-based** — they read/write the PBIP project on disk and never touch the running engine, so they work even with Power BI closed.

**Writes are deny-by-default.** `pbi_write_measure` / `pbi_delete_measure` only
act when the server is started with `DAXWB_MCP_ALLOW_WRITE=1`.

## Build

```bash
cd tools/mcp-server
npm install
npm run build      # → dist/index.js (one bundled file)
```

## Wire it into Claude Code

```bash
claude mcp add dax-workbench -- node C:\Users\risha\power-bi-studio\tools\mcp-server\dist\index.js
```

…or drop a `.mcp.json` in your project (see `mcp.json.example`):

```json
{
  "mcpServers": {
    "dax-workbench": {
      "command": "node",
      "args": ["C:\\Users\\risha\\power-bi-studio\\tools\\mcp-server\\dist\\index.js"],
      "env": { "DAXWB_MCP_ALLOW_WRITE": "0" }
    }
  }
}
```

Then open Power BI Desktop, launch **DAX Workbench** from the External Tools
ribbon, and ask Claude to work on your model.

### Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `DAXWB_BRIDGE` | `http://127.0.0.1:5177` | Bridge base URL. |
| `DAXWB_MCP_ALLOW_WRITE` | unset (off) | `1`/`true` to allow measure writes and TMDL writes. |
| `DAXWB_PROJECT` | unset | Default PBIP path, so the project tools can omit `projectPath`. |

## Tests

Integration tests spawn the real server and drive every tool over the MCP
protocol against your **live** model, so open a report first.

```bash
npm run test         # read tools — 14 checks
npm run test:write   # write path (creates + deletes a throwaway measure) — 5 checks
```

The reference-checker itself is unit-tested in the app:
`npx vitest run src/application/dax/validate.test.ts`.

## Why the design is the way it is

- **The validator is shared, not copied.** `pbi_validate_measure` bundles the
  app's `validateReferences` — the same logic the desktop UI uses to flag
  AI-hallucinated names. It catches invented tables, columns *and* measures,
  and never false-flags DAX variables or function names.
- **The bridge speaks XMLA; the browser can't.** That's why the bridge is a
  .NET process and this server is a thin HTTP client over it.
- **Deny-by-default writes** mirror the bridge's own auth stance: a capability
  is off until explicitly enabled, so an AI can't mutate a model by accident.
