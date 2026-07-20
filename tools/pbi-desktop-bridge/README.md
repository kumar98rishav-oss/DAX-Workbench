# Power BI Desktop Bridge

A tiny **local HTTP service** that lets the web Workbench work against the **live
Power BI Desktop model**. No cloud, no AI — just the Workbench ⇄ Desktop link.

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

The Workbench auto-detects the bridge (`/health`) and lights up a **● Connected to
Power BI Desktop** badge — real previews + a **Push to Desktop** button appear.
If the bridge isn't running, the Workbench silently falls back to its in-browser
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

Then open the Workbench (http://localhost:5175) with a `.pbix` open in Desktop —
the DAX Architect's **Power BI Desktop** badge turns green automatically.

## Remote — let another machine's Workbench reach this report

By default the bridge answers **only this machine** (loopback), no token. To let
someone else's Workbench reach the report open here:

1. **Double-click** the downloaded `DAX-Workbench-Bridge.exe`.
2. When it asks *who should be able to use this bridge*, type **`2`** (this
   computer AND someone else's Workbench) and press Enter.
3. It prints an **Address** and a one-time **pairing token** — send both to the
   other person. They paste them into Workbench's *Remote connector* dialog ("The
   report is on another machine?" on the front page).

No terminal needed. If you prefer flags (or are scripting it), `--remote` skips
the question and `--local` forces loopback-only:

```powershell
.\DAX-Workbench-Bridge.exe --remote
```

- **Loopback stays token-free.** Only requests arriving over the network are
  challenged, so nothing about the normal local flow changes.
- **The token is mandatory over the network and regenerates every start.**
  Without the right token, every network request is refused (401); with
  `--remote` off, the network is refused outright (403). Set a fixed one with
  `--token <secret>` or `PBI_BRIDGE_TOKEN`, and change the port with `--port`.
- **Traffic is plain HTTP.** On an untrusted network, don't use `--remote` — use
  an SSH tunnel instead and keep the bridge loopback-only on both ends:
  ```
  ssh -N -L 5177:127.0.0.1:5177 <user>@<their-ip>
  ```
  Then Workbench connects to `127.0.0.1` — encrypted, authenticated by SSH, no
  token, and no browser mixed-content block (a page on `https://` cannot call a
  plain-`http://` address on another machine, but loopback is exempt).

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
- By default everything stays on your machine — the bridge listens on loopback
  only, and no data is sent anywhere. The hosted Workbench is a static page that
  runs in your browser and calls this bridge directly.

### Who is allowed to call it

On **loopback** the bridge is unauthenticated — anything already on this machine
can call it, and the CORS allowlist is what stops an arbitrary web page from
doing so. Keep that list narrow:

- `localhost` / `127.0.0.1` (any port) — the Workbench in dev or preview
- `tauri://` / `file://` — a desktop shell
- `https://pbi-design-studio.onrender.com` — the hosted Workbench

Over the **network** (`--remote`) CORS protects nothing — it's a browser rule,
and `curl` ignores it — so a **pairing token** is required instead, and is the
real gate there. See *Remote* above.

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
