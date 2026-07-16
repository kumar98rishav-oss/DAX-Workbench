# Power BI MCP Bridge

A local **Model Context Protocol** server that connects to the **live Power BI
Desktop model** (its embedded Analysis Services engine). This is what turns the
web Studio's limits into a real, local tool — the same door Tabular Editor and
DAX Studio use.

With it, the Studio **and Claude** can:

| Tool | What it does |
|---|---|
| `discover_powerbi` | list open Desktop models (db + port) |
| `get_model` | read tables, columns, measures, relationships (ground the AI) |
| `list_measures` | every measure + its DAX |
| `run_dax` | run `EVALUATE …` against the **real data** → rows |
| `preview_measure` | evaluate a scalar/measure → the real value |
| `create_or_update_measure` | write a measure into the live model (appears in Desktop instantly) |
| `delete_measure` | remove a measure |

No synthetic data, no "not supported" — the real engine computes everything.

## Requirements

- **Windows** (local Analysis Services is Windows-only)
- **Power BI Desktop** open with your `.pbix`
- **.NET SDK 8+** — https://dotnet.microsoft.com/download

## Build

```powershell
cd tools\pbi-mcp-bridge
dotnet restore
dotnet build -c Release
```

> If NuGet can't resolve a package version, bump `ModelContextProtocol` to the
> newest preview and the `Microsoft.AnalysisServices.*.NetCore` packages to the
> latest, then `dotnet restore` again.

The server runs over **stdio** (that's how MCP clients launch it):

```powershell
dotnet run -c Release
```

## Use it from Claude (Claude Desktop / Claude Code)

Add to your MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "powerbi": {
      "command": "dotnet",
      "args": ["run", "-c", "Release", "--project", "C:\\Users\\risha\\power-bi-studio\\tools\\pbi-mcp-bridge"]
    }
  }
}
```

Then, with a `.pbix` open in Desktop, ask Claude things like:

- *"Read my model and build the full time-intelligence suite for Sales (YoY %, MoM %, YTD, rolling 3-month), verify each with real data, and deploy them."*
- *"What's the actual value of `[Total Sales]` right now?"* → runs `preview_measure`
- *"Add a `Denial Rate %` measure to `_Measure` and confirm it returns a sensible %."*

Claude reads the real schema, drafts DAX, **runs it to verify the number**, then
**creates the measure live in Desktop**.

## Use it from the Studio

Point the Studio's DAX engine at the bridge: our NL→DAX drafts the measure,
`run_dax` gives a **real** preview (replacing the JS evaluator), and
`create_or_update_measure` adds a **"Push to Desktop"** button. Same UI, real
model.

## How it connects

Power BI Desktop hosts a local AS instance on a dynamic port. The bridge finds
it by reading `msmdsrv.port.txt` under
`…\Microsoft\Power BI Desktop\AnalysisServicesWorkspaces\<workspace>\Data\`
(both classic and Store/MSIX install paths), connects with **TOM** (read/write
the model) and **ADOMD** (run DAX), and auto-selects the model when only one
file is open.

## Notes / safety

- Writing measures via TOM is exactly what external tools do — supported and
  reversible (undo in Desktop, or `delete_measure`).
- Everything stays on your machine; nothing is sent anywhere.
- `run_dax` caps results at 10,000 rows for safety.
