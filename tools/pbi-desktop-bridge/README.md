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
- `/dax` caps results at 10,000 rows.
- Everything stays on your machine. The bridge only ever listens on loopback,
  and no data is sent anywhere — the hosted Studio is a static page that runs
  in your browser and calls this bridge directly.

### Who is allowed to call it

The bridge is **unauthenticated**: anything that can call it can read your whole
model and write measures into it. The CORS allowlist is the only gate, so it is
deliberately narrow:

- `localhost` / `127.0.0.1` (any port) — the Studio in dev or preview
- `tauri://` / `file://` — a desktop shell
- `https://pbi-design-studio.onrender.com` — the hosted Studio

Add your own with a comma-separated env var:

```bat
set PBI_BRIDGE_ORIGINS=https://studio.example.com,https://staging.example.com
```

Two rules worth keeping:

- **Exact origins only — never a wildcard suffix** like `*.onrender.com`. Anyone
  can deploy to a shared host, and every one of them would then reach a running
  bridge.
- **Remove an origin as soon as it stops being yours.** A subdomain you release
  can be registered by someone else, and it would inherit your allowlist entry.

Chrome's Private Network Access preflight is answered with
`Access-Control-Allow-Private-Network: true`, so a public page reaching loopback
keeps working as that rolls out.
