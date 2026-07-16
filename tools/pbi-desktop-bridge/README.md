# Power BI Desktop Bridge

A tiny **local HTTP service** that lets the web Studio work against the **live
Power BI Desktop model**. No cloud, no AI — just the Studio ⇄ Desktop link.

The browser can't speak Analysis Services' protocol, so this helper does it for
it: it finds the open Desktop model, reads the real schema, runs DAX against the
**real data**, and writes measures straight into Desktop (via TOM/ADOMD — the
same libraries Tabular Editor and DAX Studio use).

## Endpoints (on `http://127.0.0.1:5177`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | is the bridge running? |
| GET | `/discover` | open Desktop models (db + port) |
| GET | `/model` | tables, columns, measures, relationships |
| POST | `/dax` | `{ dax }` → run `EVALUATE …` on real data |
| POST | `/preview` | `{ expression }` → the real scalar value |
| POST | `/measure` | `{ table, name, dax, formatString?, displayFolder? }` → create/update live |

The Studio auto-detects the bridge (`/health`) and lights up a **● Connected to
Power BI Desktop** badge — real previews + a **Push to Desktop** button appear.
If the bridge isn't running, the Studio silently falls back to its in-browser
(sample-data) mode.

## Requirements

- **Windows** (local Analysis Services is Windows-only)
- **Power BI Desktop** open with your `.pbix`
- **.NET SDK 8+** — https://dotnet.microsoft.com/download

## Run

Easiest — double-click **`run.cmd`** (it builds a self-contained `.exe` on first
run, then launches it). Leave the window open.

Or manually:

```powershell
cd tools\pbi-desktop-bridge
# self-contained x64 build — works even with the 32-bit .NET SDK
dotnet publish -c Release -r win-x64 --self-contained true -o publish
.\publish\pbi-desktop-bridge.exe
# → listening on http://127.0.0.1:5177
```

> **Why publish instead of `dotnet run`?** The Analysis Services libraries are
> x64-only. If you have the **x64** .NET SDK you can just `dotnet run -c Release`.
> With the **x86** SDK, `dotnet run` can't launch an x64 app — so we publish a
> self-contained x64 `.exe` and run that (or grab the x64 SDK).

Then open the Studio (http://localhost:5175) with a `.pbix` open in Desktop —
the DAX Architect's **Power BI Desktop** badge turns green automatically.

## How it connects

Power BI Desktop hosts a local Analysis Services instance on a dynamic port. The
bridge reads that port from `msmdsrv.port.txt` under
`…\Microsoft\Power BI Desktop\AnalysisServicesWorkspaces\<workspace>\Data\`
(both classic and **Store/MSIX** install paths), then uses **TOM** to read/write
the model and **ADOMD** to run DAX.

## Notes / safety

- Writing measures via TOM is standard external-tool behaviour — reversible
  (undo in Desktop, or overwrite/remove).
- CORS is restricted to `localhost` / `127.0.0.1` / Tauri origins.
- `/dax` caps results at 10,000 rows.
- Everything stays on your machine.
